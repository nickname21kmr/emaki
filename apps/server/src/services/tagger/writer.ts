/**
 * 把引擎输出写进 SQLite。规则（以 TASKS.md T10「规则」表为准）：
 *   general ≥ 阈值 → image_tags；character ≥ autoAccept → image_characters（没有就新建角色）；
 *   characterThreshold ≤ 分数 < autoAccept → character_suggestions（每图最多 5 条），建议角色的主作品已存在时挂 image_copyrights；
 *   rating 取 argmax（手动改过的不动）；DECODE / UNSUPPORTED 也标记已处理；ENOENT 不写，留给扫描器标 missing；
 *   IO（文件暂时读不了）也不写，下次识别再试。
 * 重打标签时 image_tags / suggestions / image_copyrights 先删后写，角色关联只增不删。
 * 角色关联经归类模块写入（domain/curation：能不能自动关联由 judgeAutoLink 判断，link 带 auto / auto-accept@1 来历，一批写一次）；
 * 用户从图上去掉过的角色（否决）不再加回，也不再作为建议。
 * T27：写完标签后按标签重算内容类型、主题和 art_score（manual 只保护类型）；截图、文字、照片、表情上的
 * 未知角色不新建，只进建议（BI-15），已有角色照常关联。
 */
import type { ContentKind } from '@emaki/shared';
import type { Db, Statement } from '../../db/connection.ts';
import { judgeAutoLink } from '../../domain/curation/auto.ts';
import { collectingTx, linkEach, vetoChecker, type LinkItem } from '../../domain/curation/links.ts';
import { auto, RULES } from '../../domain/curation/provenance.ts';
import { currentActor } from '../../propagation/actor.ts';
import type { Change } from '../../propagation/changes.ts';
import { writeArtists } from './artists.ts';
import type { CharacterCatalog } from '../catalog/characterCatalog.ts';
import type { CopyrightSource } from '../catalog/copyrights.ts';
import { CLASS_COLS, classificationStatements, computeClassification, writeClassification, type ClassRow } from '../classify/backfill.ts';
import { pickRating } from './postprocess.ts';
import type { HostItemResult } from './protocol.ts';

export interface WriterOptions {
  repo: string;
  generalThreshold: number;
  characterThreshold: number;
  autoAcceptThreshold: number;
  maxSuggestions?: number;
  /**
   * 每批写完、在同一个事务里调用：imageIds 是这批处理过的图，changes 是归类模块写关联时声明的变化。
   * 引擎里交给 declareTagged（ctx.apply 声明变化，排除规则、Pixiv 排队等由反应做）；测试不传就不做连带处理
   */
  afterBatchInTx?: (imageIds: number[], changes: Change[]) => void;
  now?: () => number;
  /**
   * 这次识别顺便解码了画师（开着「识别画师」、模型能出画师）：识别失败的图也标画师跑过，
   * 免得画师补跑再单独跑它（会弄崩子进程的图要重开、降级好几次才放弃）
   */
  artists?: boolean;
}

export interface WriteStats {
  tagged: number;
  linked: number;
  createdCharacters: number;
  suggestions: number;
  failed: number;
  missing: number;
}

export class TagResultWriter {
  readonly stats: WriteStats = { tagged: 0, linked: 0, createdCharacters: 0, suggestions: 0, failed: 0, missing: 0 };
  private readonly tagIds = new Map<string, number>();
  private readonly s: Record<string, Statement>;
  private readonly cls: { auto: Statement; manual: Statement };
  private readonly vetoed: (imageId: number, characterId: number) => boolean;
  /** 这一批要自动关联的（批末一次交给归类模块写） */
  private batchLinks: LinkItem[] = [];

  constructor(
    private readonly db: Db,
    private readonly catalog: CharacterCatalog,
    private readonly copyrights: CopyrightSource,
    private readonly o: WriterOptions,
  ) {
    this.s = {
      upsertTag: db.prepare('INSERT INTO tags (name, category) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id'),
      delImageTags: db.prepare('DELETE FROM image_tags WHERE image_id = ?'),
      insImageTag: db.prepare('INSERT OR REPLACE INTO image_tags (image_id, tag_id, score) VALUES (?, ?, ?)'),
      delSuggestions: db.prepare("DELETE FROM character_suggestions WHERE image_id = ? AND source = 'tagger'"),
      insSuggestion: db.prepare(`INSERT INTO character_suggestions (image_id, danbooru_tag, score) VALUES (?, ?, ?)
        ON CONFLICT(image_id, danbooru_tag) DO UPDATE SET score=excluded.score, source='tagger'`),
      // 只删识别器写的（score 非空）；用户「归为原创」手动挂的 score 为 NULL，重打标签不能删
      delImageCopyrights: db.prepare('DELETE FROM image_copyrights WHERE image_id = ? AND score IS NOT NULL'),
      insImageCopyright: db.prepare(`INSERT INTO image_copyrights (image_id, work_id, score) VALUES (@imageId, @workId, @score)
        ON CONFLICT(image_id, work_id) DO UPDATE SET score = MAX(score, excluded.score)`),
      workByTag: db.prepare('SELECT id FROM works WHERE danbooru_tag = ?'),
      linkedIds: db.prepare('SELECT character_id FROM image_characters WHERE image_id = ?').pluck(),
      updRating: db.prepare('UPDATE images SET rating = ? WHERE id = ? AND rating_manual = 0'),
      markTagged: db.prepare('UPDATE images SET tagged_at = ?, tagger_model = ?, retag = 0 WHERE id = ?'),
      classRow: db.prepare(`SELECT ${CLASS_COLS} FROM images WHERE id = ?`),
      acceptance: db.prepare('SELECT content_kind AS kind, shelved_at IS NULL AND original_at IS NULL AS allowed FROM images WHERE id = ?'),
    };
    // 用户从这张图上去掉过这个角色：不再加回，也不再作为建议
    this.vetoed = vetoChecker(db);
    this.cls = classificationStatements(db);
  }

  private nowIso(): string {
    return new Date(this.o.now?.() ?? Date.now()).toISOString();
  }

  private tagId(name: string, category: 'general' | 'character'): number {
    let id = this.tagIds.get(name);
    if (id === undefined) {
      id = (this.s.upsertTag!.get(name, category) as { id: number }).id;
      this.tagIds.set(name, id);
    }
    return id;
  }

  /** 一个事务写一批；返回被标记为已处理的 imageId */
  writeBatch(results: HostItemResult[]): number[] {
    const now = this.nowIso();
    // 两批之间用户可能合并、采纳、撤销了角色：缓存只在一批（一个事务）里有效
    this.catalog.clearCache();
    return this.db.transaction(() => {
      const ids: number[] = [];
      this.batchLinks = [];
      for (const r of results) {
        const id = this.writeOne(r, now);
        if (id !== null) ids.push(id);
      }
      // 自动关联经归类模块一次写完（来历、否决、建议、变化都由它处理）
      const tx = collectingTx(this.db);
      this.stats.linked += linkEach(tx, null, this.batchLinks).linked.length;
      this.batchLinks = [];
      if (ids.length) this.o.afterBatchInTx?.(ids, tx.changes);
      return ids;
    })();
  }

  private writeOne(r: HostItemResult, now: string): number | null {
    const { s, o, stats, catalog } = this;
    if (!r.ok) {
      if (r.code === 'ENOENT' || r.code === 'IO') {
        stats.missing++;
        return null;
      }
      s.markTagged!.run(now, o.repo, r.id);
      if (o.artists) writeArtists(this.db, r.id, [], now);
      // 识别失败也算「识别过」：没有标签，按空标签写主题和质量分（保持 tagged_at 与 theme 同时为空 / 非空）
      const failedRow = s.classRow!.get(r.id) as ClassRow | undefined;
      if (failedRow) writeClassification(this.cls, failedRow, computeClassification({ ...failedRow, tagged_at: now }, []));
      stats.failed++;
      return r.id;
    }
    s.delImageTags!.run(r.id);
    for (const [name, score] of r.general) s.insImageTag!.run(r.id, this.tagId(name, 'general'), score);
    for (const [name, score] of r.character) s.insImageTag!.run(r.id, this.tagId(name, 'character'), score);

    // 按新标签重判类型、主题、质量分（同一事务）
    const row = s.classRow!.get(r.id) as ClassRow | undefined;
    if (row) writeClassification(this.cls, row, computeClassification({ ...row, tagged_at: now }, r.general));
    const { kind, allowed } = s.acceptance!.get(r.id) as { kind: ContentKind; allowed: number };

    // 角色标签按图库身份去重，保留得分最高的一条。
    const chars = new Map<string | number, { tag: string; score: number }>();
    for (const [raw, score] of r.character) {
      const tag = catalog.normalizeTag(raw);
      const id = catalog.resolveCharacterId(raw);
      const key = id ?? tag;
      if (score > (chars.get(key)?.score ?? -1)) chars.set(key, { tag: id === null ? tag : raw, score });
    }
    const sorted = [...chars.values()].sort((a, b) => b.score - a.score);
    s.delSuggestions!.run(r.id);
    s.delImageCopyrights!.run(r.id);

    const pending = new Set<string>();
    const linked = new Set(s.linkedIds!.all(r.id) as number[]);
    const actor = currentActor();
    for (const { tag, score } of sorted) {
      if (score < o.autoAcceptThreshold) continue;
      const known = catalog.resolveCharacterId(tag);
      if (known !== null && this.vetoed(r.id, known)) continue;
      if (!judgeAutoLink({ entry: 'recognize', kind, allowed: !!allowed, characterId: known })) {
        pending.add(tag);
        continue;
      }
      const { id, created } = catalog.ensureCharacter(tag, now);
      if (created) stats.createdCharacters++;
      if (linked.has(id)) continue;
      linked.add(id);
      this.batchLinks.push({
        imageId: r.id,
        characterId: id,
        provenance: auto(RULES.autoAccept, now, { provider: 'tagger', tag: catalog.normalizeTag(tag), score }, actor),
      });
    }

    let n = 0;
    for (const { tag, score } of sorted) {
      if ((score >= o.autoAcceptThreshold ? !pending.has(tag) : score < o.characterThreshold) || n >= (o.maxSuggestions ?? 5)) continue;
      const cid = catalog.resolveCharacterId(tag);
      if (cid !== null && linked.has(cid)) continue; // 已经归到这个角色了（包括手动归的、合并后的重定向）
      if (cid !== null && this.vetoed(r.id, cid)) continue; // 用户去掉过的不再建议
      s.insSuggestion!.run(r.id, tag, score);
      n++;
      // 建议角色的主作品：只挂已存在的作品，不新建
      const primary = this.copyrights.copyrights(tag)[0];
      const w = primary ? (s.workByTag!.get(primary) as { id: number } | undefined) : undefined;
      if (w) s.insImageCopyright!.run({ imageId: r.id, workId: w.id, score });
    }
    stats.suggestions += n;
    if (r.rating) s.updRating!.run(pickRating(r.rating), r.id);
    // 能认画师的模型（PixAI）顺便给出画师；WD 没有这一项，留给「识别画师」任务补
    if (r.artist) writeArtists(this.db, r.id, r.artist, now);
    s.markTagged!.run(now, o.repo, r.id);
    stats.tagged++;
    return r.id;
  }
}
