/**
 * 把引擎输出写进 SQLite。规则（以 TASKS.md T10「规则」表为准）：
 *   general ≥ 阈值 → image_tags；character ≥ autoAccept → image_characters（没有就新建角色）；
 *   characterThreshold ≤ 分数 < autoAccept → character_suggestions（每图最多 5 条），建议角色的主作品已存在时挂 image_copyrights；
 *   rating 取 argmax（手动改过的不动）；DECODE / UNSUPPORTED 也标记已处理；ENOENT 不写，留给扫描器标 missing。
 * 重打标签时 image_tags / suggestions / image_copyrights 先删后写，image_characters 只增不删。
 * T27：写完标签后按标签重算内容类型、主题和 art_score（manual 只保护类型）；截图、文字、照片、表情、动图上的
 * 未知角色不新建，只进建议（BI-15），已有角色照常关联。
 */
import type { Db, Statement } from '../../db/connection.ts';
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
  /** T17：在同一个事务里对本批图应用排除规则 */
  afterBatchInTx?: (imageIds: number[]) => void;
  now?: () => number;
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
      delSuggestions: db.prepare('DELETE FROM character_suggestions WHERE image_id = ?'),
      insSuggestion: db.prepare('INSERT OR REPLACE INTO character_suggestions (image_id, danbooru_tag, score) VALUES (?, ?, ?)'),
      // 只删识别器写的（score 非空）；用户「归为原创」手动挂的 score 为 NULL，重打标签不能删
      delImageCopyrights: db.prepare('DELETE FROM image_copyrights WHERE image_id = ? AND score IS NOT NULL'),
      insImageCopyright: db.prepare(`INSERT INTO image_copyrights (image_id, work_id, score) VALUES (@imageId, @workId, @score)
        ON CONFLICT(image_id, work_id) DO UPDATE SET score = MAX(score, excluded.score)`),
      workByTag: db.prepare('SELECT id FROM works WHERE danbooru_tag = ?'),
      linkedIds: db.prepare('SELECT character_id FROM image_characters WHERE image_id = ?').pluck(),
      insImageChar: db.prepare(`INSERT INTO image_characters (image_id, character_id, origin, score, added_at)
        VALUES (@imageId, @characterId, 'tagger', @score, @now) ON CONFLICT(image_id, character_id) DO NOTHING`),
      updRating: db.prepare('UPDATE images SET rating = ? WHERE id = ? AND rating_manual = 0'),
      markTagged: db.prepare('UPDATE images SET tagged_at = ?, tagger_model = ?, retag = 0 WHERE id = ?'),
      // 只提升插画和漫画上的建议：别册里的未知角色永远只是建议（BI-15 ①）
      promotable: db.prepare(`SELECT cs.image_id AS imageId, cs.danbooru_tag AS tag, cs.score AS score
        FROM character_suggestions cs JOIN images i ON i.id = cs.image_id
        WHERE cs.score >= ? AND i.trashed_at IS NULL AND i.content_kind IN ('illustration','comic')`),
      classRow: db.prepare(`SELECT ${CLASS_COLS} FROM images WHERE id = ?`),
      kindOf: db.prepare('SELECT content_kind FROM images WHERE id = ?').pluck(),
      delSuggestion: db.prepare('DELETE FROM character_suggestions WHERE image_id = ? AND danbooru_tag = ?'),
    };
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
    return this.db.transaction(() => {
      const ids: number[] = [];
      for (const r of results) {
        const id = this.writeOne(r, now);
        if (id !== null) ids.push(id);
      }
      if (ids.length) this.o.afterBatchInTx?.(ids);
      return ids;
    })();
  }

  private writeOne(r: HostItemResult, now: string): number | null {
    const { s, o, stats, catalog } = this;
    if (!r.ok) {
      if (r.code === 'ENOENT') {
        stats.missing++;
        return null;
      }
      s.markTagged!.run(now, o.repo, r.id);
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
    const art = ['illustration', 'comic'].includes(s.kindOf!.get(r.id) as string);

    // 角色标签规范化 + 去重（取最高分）
    const chars = new Map<string, number>();
    for (const [raw, score] of r.character) {
      const t = catalog.normalizeTag(raw);
      chars.set(t, Math.max(chars.get(t) ?? 0, score));
    }
    const sorted = [...chars].sort((a, b) => b[1] - a[1]);
    s.delSuggestions!.run(r.id);
    s.delImageCopyrights!.run(r.id);

    const pending = new Set<string>(); // 别册图上的未知高分角色：留作建议
    for (const [tag, score] of sorted) {
      if (score < o.autoAcceptThreshold) continue;
      if (!art && catalog.resolveCharacterId(tag) === null) {
        pending.add(tag);
        continue;
      }
      const { id, created } = catalog.ensureCharacter(tag, now);
      if (created) stats.createdCharacters++;
      if (s.insImageChar!.run({ imageId: r.id, characterId: id, score, now }).changes) stats.linked++;
    }

    const linked = new Set(s.linkedIds!.all(r.id) as number[]);
    let n = 0;
    for (const [tag, score] of sorted) {
      if ((score >= o.autoAcceptThreshold && !pending.has(tag)) || score < o.characterThreshold || n >= (o.maxSuggestions ?? 5)) continue;
      const cid = catalog.resolveCharacterId(tag);
      if (cid !== null && linked.has(cid)) continue; // 已经归到这个角色了（包括手动归的、合并后的重定向）
      s.insSuggestion!.run(r.id, tag, score);
      n++;
      // 建议角色的主作品：只挂已存在的作品，不新建
      const primary = this.copyrights.copyrights(tag)[0];
      const w = primary ? (s.workByTag!.get(primary) as { id: number } | undefined) : undefined;
      if (w) s.insImageCopyright!.run({ imageId: r.id, workId: w.id, score });
    }
    stats.suggestions += n;
    if (r.rating) s.updRating!.run(pickRating(r.rating), r.id);
    s.markTagged!.run(now, o.repo, r.id);
    stats.tagged++;
    return r.id;
  }

  /** 阶段 0：分数已达到（可能被调低的）自动采纳阈值的建议，直接提升为角色关联 */
  promoteSuggestions(): number {
    const now = this.nowIso();
    return this.db.transaction(() => {
      let n = 0;
      for (const row of this.s.promotable!.all(this.o.autoAcceptThreshold) as { imageId: number; tag: string; score: number }[]) {
        const { id, created } = this.catalog.ensureCharacter(row.tag, now);
        if (created) this.stats.createdCharacters++;
        this.s.insImageChar!.run({ imageId: row.imageId, characterId: id, score: row.score, now });
        this.s.delSuggestion!.run(row.imageId, row.tag);
        n++;
      }
      return n;
    })();
  }
}
