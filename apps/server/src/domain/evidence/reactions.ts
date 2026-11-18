/**
 * 证据的反应（docs/core-architecture.md 第 5.2 节 reparseSource、queuePixivCheck；附录 #13、#19）。
 *
 * - reparseSource：图移动了（扫描发现、应用内移动、整理到子文件夹、撤回移动都一样），没手动确认来源的按新路径重新解析；
 *   来源变了就声明 image.sourceChanged。
 * - dropStalePixivEvidence：来源变了的图，Pixiv 证据和检查记录是按旧投稿号查的就去掉（换了投稿就不再是这张图的证据，来源失效）。
 *   所有改来源的路径（改识别方式、手动改来源、扫描、查重合并、启动修补）都走这里，不再各做各的。
 *   去掉证据声明 evidence.changed（pixiv），依据它的自动决定由 reevaluateAuto 撤回（D2）。
 * - staleFileEvidence：文件内容变了（D1，扫描发现和用户替换一样）：这份文件版本的模型证据过期、排队重新识别，画师识别也重来；
 *   手动的决定都不动，自动决定等新证据到了由 reevaluateAuto 按 D2 处理。要排在分析的 analyze 之前（主题、画质分看识别时间）。
 * - queuePixivCheck：影响 Pixiv 补充资格的变化（来源、类型、放下、原创、角色、排除、识别结果、漫画设置）之后重新登记待查。
 *   登记（pixiv_character_checks）就是持久化的队列；要不要马上开一轮补充，由提交后的排队反应决定（propagation/engine.ts）。
 */
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { readSettings } from '../../datasource/sqlite/settings.ts';
import type { Change } from '../../propagation/changes.ts';
import type { Reaction } from '../../propagation/registry.ts';
import { parseSource } from '../../services/source/parseSource.ts';
import { queuePixivImages } from './pixiv.ts';
import { markFileEvidenceStale } from './retag.ts';
import { dropEvidence } from './store.ts';

export const reparseSourceReaction: Reaction = {
  name: 'reparseSource',
  on: ['image.moved'],
  phase: 'tx',
  emits: ['image.sourceChanged'],
  run({ ctx, changes, emit }) {
    const rows = ctx.db
      .prepare(
        `SELECT id, rel_path, source_site, source_post_id, source_artist, source_url FROM images
         WHERE source_manual = 0 AND id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(changes.ids())) as {
      id: number;
      rel_path: string;
      source_site: string | null;
      source_post_id: string | null;
      source_artist: string | null;
      source_url: string | null;
    }[];
    if (!rows.length) return;
    const mode = readSettings(ctx.db).tagger.pixivFilenameMode;
    const upd = ctx.stmt('UPDATE images SET source_site = @site, source_post_id = @postId, source_artist = @artist, source_url = @url WHERE id = @id');
    const changed: number[] = [];
    for (const r of rows) {
      const s = parseSource(r.rel_path, mode);
      const next = { site: s?.site ?? null, postId: s?.postId ?? null, artist: s?.artist ?? null, url: s?.url ?? null };
      if (next.site === r.source_site && next.postId === r.source_post_id && next.artist === r.source_artist && next.url === r.source_url) continue;
      upd.run({ id: r.id, ...next });
      changed.push(r.id);
    }
    emit({ type: 'image.sourceChanged', ids: changed });
  },
};

export const staleFileEvidenceReaction: Reaction = {
  name: 'staleFileEvidence',
  on: ['image.fileChanged'],
  phase: 'tx',
  run({ ctx, changes, undo }) {
    markFileEvidenceStale(ctx.db, undo, changes.ids());
  },
};

export const dropStalePixivEvidenceReaction: Reaction = {
  name: 'dropStalePixivEvidence',
  on: ['image.sourceChanged'],
  phase: 'tx',
  emits: ['evidence.changed'],
  run({ ctx, changes, undo, emit }) {
    const json = JSON.stringify(changes.ids());
    // 检查记录对应的投稿不是现在的了：去掉，切回原来的投稿号时重新登记、从缓存找回（以前是删了再登记）
    const staleChecks = ctx.db
      .prepare(
        `SELECT p.image_id FROM pixiv_character_checks p JOIN images i ON i.id = p.image_id
         WHERE p.image_id IN (SELECT value FROM json_each(?)) AND NOT (i.source_site IS 'pixiv' AND p.post_id IS i.source_post_id)`,
      )
      .pluck()
      .all(json) as number[];
    // Pixiv 证据对应的投稿 = 检查记录里的投稿号；和现在的来源对不上（或者已经不是 Pixiv）就是过期的（来源失效）
    const stale = ctx.db
      .prepare(
        `SELECT i.id FROM images i WHERE i.id IN (SELECT value FROM json_each(?))
           AND (EXISTS (SELECT 1 FROM image_evidence e WHERE e.image_id = i.id AND e.provider = 'pixiv')
             OR EXISTS (SELECT 1 FROM character_evidence e WHERE e.image_id = i.id AND e.provider = 'pixiv'))
           AND NOT EXISTS (SELECT 1 FROM pixiv_character_checks p WHERE p.image_id = i.id AND i.source_site = 'pixiv' AND p.post_id = i.source_post_id)`,
      )
      .pluck()
      .all(json) as number[];
    if (staleChecks.length) {
      const sj = JSON.stringify(staleChecks);
      undo?.set('pixiv_character_checks', 'image_id IN (SELECT value FROM json_each(?))', [sj]);
      ctx.db.prepare('DELETE FROM pixiv_character_checks WHERE image_id IN (SELECT value FROM json_each(?))').run(sj);
    }
    // 去掉过期的 Pixiv 证据（声明 evidence.changed pixiv）：依据它的自动关联、自动原创由 reevaluateAuto 撤回（D2）
    dropEvidence({ db: ctx.db, changed: emit }, undo, 'pixiv', stale);
  },
};

export const queuePixivCheckReaction: Reaction = {
  name: 'queuePixivCheck',
  on: [
    'image.sourceChanged',
    'image.kindChanged',
    'curation.shelvedChanged',
    'curation.originalChanged',
    'curation.autoOriginalChanged',
    'curation.charactersChanged',
    'visibility.changed',
    'evidence.changed',
    'root.modeChanged',
    'collections.changed',
  ],
  phase: 'tx',
  run({ ctx, changes, undo }) {
    const ids = changes.ids();
    if (!ids.length) return;
    undo?.set('pixiv_character_checks', 'image_id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)]);
    queuePixivImages(ctx.db, ids);
  },
};

/**
 * 识别任务写完一批（在 writer 的事务里调用）：changes 是这批声明的变化——证据模块替换模型证据（只有识别成功的图），
 * 分析模块按新标签重判类型时真变了的（image.kindChanged），原样转交。
 * 自动关联（reevaluateAuto）、套排除规则、登记 Pixiv 补充、合集（任务结束时全量）都由反应做
 */
export function declareTagged(ctx: SqliteContext, _ids: number[], changes: readonly Change[] = []): void {
  ctx.apply(() => {
    for (const c of changes) ctx.changed(c);
  });
}
