/**
 * 设置：读写、切换 Pixiv 投稿号识别方式（可撤销，有缓存的投稿马上本地重新匹配）、把达标的建议归到角色。
 * 从 SqliteDataSource 拆出来；它只负责把请求转过来。
 */
import type { MutationResult, PromotableSuggestions, Settings, SourceModePreview, UpdateSettingsBody } from '@emaki/shared';
import type { JobContext } from '../../core/jobs.ts';
import { done } from '../../core/undo.ts';
import type { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import type { CollectionsHook } from '../../services/collections/CollectionService.ts';
import type { DanbooruCatalog } from '../../services/danbooru/catalog.ts';
import type { Pipeline } from '../../services/pipeline.ts';
import { queuePixivImages, syncPixivCharacters } from '../../services/pixiv/sync.ts';
import { applySourceChanges, diffSources, markSourcesCurrent, type SourceChange } from '../../services/source/backfill.ts';
import type { SqliteContext } from './context.ts';
import { countPromotable, promoteSuggestionsInTx, type KindDeps } from './kinds.ts';
import type { LibraryRoots } from './libraryRoots.ts';
import { applySettingsPatch, readSettings } from './settings.ts';

export type MakeCatalog = () => { catalog: CharacterCatalog; copyrights: DanbooruCatalog };

export class SettingsOps {
  constructor(
    private readonly ctx: SqliteContext,
    private readonly pipeline: Pipeline,
    private readonly roots: LibraryRoots,
    private readonly kindDeps: KindDeps,
    private readonly collectionsHook: CollectionsHook,
    /** 角色目录在 open() 组装完才有；之前（构造时）是 undefined */
    private readonly makeCatalog: () => MakeCatalog | undefined,
  ) {}

  async getSettings(): Promise<Settings> {
    return {
      libraryRoots: this.roots.list(),
      ...readSettings(this.ctx.db),
    };
  }

  /** 切换 Pixiv 投稿号识别方式前先数：多少张来源会变、多少张先去掉 Pixiv 建议、多少张要重新补（有缓存的不联网） */
  async previewSourceMode(mode: 'strict' | 'broad'): Promise<SourceModePreview> {
    const changes = diffSources(this.ctx.db, mode);
    const requeue = changes.filter((c) => c.newPixivPost !== null);
    const cached = new Set(
      this.ctx.db.prepare('SELECT post_id FROM pixiv_artwork_cache WHERE post_id IN (SELECT value FROM json_each(?))').pluck()
        .all(JSON.stringify([...new Set(requeue.map((c) => c.newPixivPost))])) as string[],
    );
    const hasPixivSug = this.ctx.db.prepare("SELECT 1 FROM character_suggestions WHERE image_id = ? AND source = 'pixiv' LIMIT 1");
    return {
      mode,
      changed: changes.length,
      suggestionsDropped: changes.filter((c) => c.before.site === 'pixiv' && c.pixivPostChanged && hasPixivSug.get(c.id)).length,
      requeued: requeue.length,
      cached: requeue.filter((c) => cached.has(c.newPixivPost!)).length,
    };
  }

  /**
   * 来源变了的图：投稿号换了的重新登记 Pixiv 补充（删掉旧的检查记录再登记，切回原来的投稿号也会重查）。
   * 在事务里调用；返回重新登记的图
   */
  requeuePixivAfterSourceChange(changes: SourceChange[]): number[] {
    const ids = changes.filter((c) => c.newPixivPost !== null).map((c) => c.id);
    if (!ids.length) return [];
    this.ctx.db.prepare('DELETE FROM pixiv_character_checks WHERE image_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids));
    queuePixivImages(this.ctx, ids);
    return ids;
  }

  /** 有缓存的投稿马上在本地重新匹配（不联网）；返回找回了 Pixiv 建议或关联的张数 */
  private async rematchCachedPixiv(ids: number[]): Promise<number> {
    const makeCatalog = this.makeCatalog();
    if (!ids.length || !makeCatalog) return 0;
    const cachedIds = this.ctx.db
      .prepare(
        `SELECT i.id FROM images i JOIN pixiv_character_checks p ON p.image_id = i.id AND p.checked_at IS NULL
         WHERE i.id IN (SELECT value FROM json_each(?)) AND i.source_post_id IN (SELECT post_id FROM pixiv_artwork_cache)`,
      )
      .pluck()
      .all(JSON.stringify(ids)) as number[];
    if (!cachedIds.length) return 0;
    const controller = new AbortController();
    const job: JobContext = {
      signal: controller.signal,
      setTotal: () => {},
      advance: () => {},
      setMessage: () => {},
      shouldYield: () => false,
      requeue: () => {},
      yielded: false,
    };
    // 只挑有缓存的图，client 不会被调用；万一调用了也不联网
    const offline = { artwork: async () => { throw new Error('离线重新匹配不联网'); } };
    try {
      await syncPixivCharacters(this.ctx, job, makeCatalog, offline, 0, undefined, { imageIds: cachedIds });
    } catch (error) {
      console.warn(`[pixiv-tags] 切换识别方式后本地重新匹配失败：${String(error)}`);
      return 0;
    }
    return this.ctx.db
      .prepare(
        `SELECT COUNT(DISTINCT i.id) FROM images i WHERE i.id IN (SELECT value FROM json_each(?)) AND (
           EXISTS (SELECT 1 FROM character_suggestions cs WHERE cs.image_id = i.id AND cs.source = 'pixiv')
           OR EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id))`,
      )
      .pluck()
      .get(JSON.stringify(cachedIds)) as number;
  }

  /**
   * 切换 Pixiv 投稿号识别方式（设置 → 识别）：报告影响了多少张，可撤销（来源、Pixiv 建议、补充记录、设置一起回去）。
   * 投稿号真的变了的才去掉 Pixiv 建议；切回原来的投稿号时有缓存的马上找回，没缓存的等补充 Pixiv 角色
   */
  async setSourceMode(mode: 'strict' | 'broad'): Promise<MutationResult> {
    const db = this.ctx.db;
    const before = readSettings(db).tagger.pixivFilenameMode;
    const label = mode === 'broad' ? '宽泛' : '严格';
    if (mode === before) return done(`已经是${label}了`);
    let requeued: number[] = [];
    let changed = 0;
    let dropped = 0;
    const result = this.ctx.mutate((u) => {
      const changes = diffSources(db, mode);
      changed = changes.length;
      const ids = JSON.stringify(changes.map((c) => c.id));
      u.columns('images', ['source_site', 'source_post_id', 'source_artist', 'source_url'], changes.map((c) => c.id));
      u.set('character_suggestions', "source = 'pixiv' AND image_id IN (SELECT value FROM json_each(?))", [ids]);
      u.set('pixiv_character_checks', 'image_id IN (SELECT value FROM json_each(?))', [ids]);
      // 设置只改回这一项，期间改的其他设置不动
      u.sql("UPDATE settings SET value = json_set(value, '$.pixivFilenameMode', ?) WHERE key = 'tagger'", [before]);
      u.sql("INSERT INTO settings (key, value) VALUES ('sourceParserMode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(before)]);
      dropped = db.prepare("SELECT COUNT(DISTINCT image_id) FROM character_suggestions WHERE source = 'pixiv' AND image_id IN (SELECT value FROM json_each(?))").pluck().get(
        JSON.stringify(changes.filter((c) => c.before.site === 'pixiv' && c.pixivPostChanged).map((c) => c.id)),
      ) as number;
      applySettingsPatch(db, { tagger: { pixivFilenameMode: mode } });
      applySourceChanges(db, changes);
      markSourcesCurrent(db, mode);
      requeued = this.requeuePixivAfterSourceChange(changes);
      return { message: `已改为${label}：${changed} 张图的来源变了` };
    });
    const found = await this.rematchCachedPixiv(requeued);
    const left = requeued.length - found;
    const notes = [
      dropped && `${dropped} 张的 Pixiv 建议先去掉了（投稿号变了，切回来能找回）`,
      found && `${found} 张从缓存找回了 Pixiv 角色`,
      left > 0 && `${left} 张等「补充 Pixiv 角色」时再查`,
    ].filter(Boolean);
    if (left > 0) this.pipeline.requestPixiv();
    return { ...result, message: `${result.message}${notes.length ? `；${notes.join('，')}` : ''}` };
  }


  async updateSettings(body: UpdateSettingsBody): Promise<Settings> {
    const beforeArtists = readSettings(this.ctx.db).tagger.artists;
    const beforePixiv = readSettings(this.ctx.db).tagger.pixiv;
    const beforeMode = readSettings(this.ctx.db).tagger.pixivFilenameMode;
    const { pixivFilenameMode, ...taggerRest } = body.tagger ?? {};
    // 换识别方式走 setSourceMode（报告影响、可撤销），其余照常保存
    applySettingsPatch(this.ctx.db, { ...body, ...(body.tagger && { tagger: taggerRest }) } as Parameters<typeof applySettingsPatch>[1]);
    if (pixivFilenameMode !== undefined && pixivFilenameMode !== beforeMode) await this.setSourceMode(pixivFilenameMode);
    const settings = await this.getSettings();
    // 调低自动采纳阈值不在保存时动已有建议：设置页显示有多少达标，用户点按钮才归（promoteSuggestions，可撤销）
    // 刚打开「识别画师」：给已识别的图补跑（任务在显卡道里排在识别后面，可以随时取消）
    if (body.tagger?.artists === true && !beforeArtists) {
      this.pipeline.noteManualStart('artists');
      this.ctx.jobs.enqueue('artists');
    }
    // 关掉：正在跑和排队中的补跑一起停（关了开关，设置页的进度和取消按钮也没了）
    if (body.tagger?.artists === false && beforeArtists) {
      for (const j of this.ctx.jobs.list()) if (j.kind === 'artists' && (j.status === 'queued' || j.status === 'running')) this.ctx.jobs.cancel(j.id);
    }
    // 刚打开自动查 Pixiv：把关着时登记下来的图补上
    if (body.tagger?.pixiv === true && !beforePixiv) this.pipeline.requestPixiv();
    // 关掉：停掉自动排上的（排队中和正在跑的）；用户在「未识别」页手动点的照常跑完
    if (body.tagger?.pixiv === false && beforePixiv && !this.pipeline.isPixivManual()) {
      for (const j of this.ctx.jobs.list()) if (j.kind === 'pixiv-tags' && (j.status === 'queued' || j.status === 'running')) this.ctx.jobs.cancel(j.id);
    }
    this.ctx.touch();
    return settings;
  }

  /** 已有建议里分数达到现在的自动采纳阈值的（调低阈值后才会有） */
  async promotableSuggestions(): Promise<PromotableSuggestions> {
    const threshold = readSettings(this.ctx.db).tagger.autoAcceptThreshold;
    return { ...countPromotable(this.ctx.db, threshold), threshold };
  }

  /** 用户点按钮：把达标的建议归到角色，可撤销 */
  async promoteSuggestions(): Promise<MutationResult> {
    return this.ctx.mutate((u) => {
      const ids = promoteSuggestionsInTx(this.ctx, u, null, this.kindDeps);
      if (ids.length) this.collectionsHook(u, ids);
      return { message: ids.length ? `已把 ${ids.length} 张图按达标的建议归到角色` : '没有达标的建议了' };
    });
  }
}
