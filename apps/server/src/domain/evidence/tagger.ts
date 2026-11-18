/**
 * 识别模型的证据提供者（docs/core-architecture.md 第 2.1、4.2 节，P3b）：把引擎输出写成证据。规则（以 TASKS.md T10「规则」表为准）：
 *   general ≥ 阈值 → image_tags；character（达到建议阈值或自动阈值中较低的那个，引擎已经筛过）→ 全部记成角色证据（tagger），
 *   包括分数达到自动阈值、会变成关联的那些——D2 要靠它判断某条自动关联现在还有没有证据支持；
 *   候选角色的主作品记成作品证据（按标签，不再算进图的作品，附录 #8）；
 *   rating 取 argmax（手动改过的不动，归类模块的 setAutoRating）；DECODE / UNSUPPORTED 也标记已处理（证据不动）；
 *   ENOENT 不写，留给扫描器标 missing；IO（文件暂时读不了）也不写，下次识别再试。
 * 这里不做决定：能不能自动关联、要不要建档、证据不再支持的自动关联撤不撤，都由反应 reevaluateAuto（domain/curation/reevaluate.ts）
 * 按 decideAuto 决定。证据的替换由 store.ts 声明 evidence.changed，afterBatchInTx 把这批的变化交给变更传播。
 * 建议是派生的（v_character_suggestions）：证据里还没关联、没被否决的候选，看的时候每张最多列 5 条。
 * T27：写完标签后，同一个事务里交给分析模块（analyze）按新标签重算内容类型、主题和 art_score（manual 只保护类型）；
 * 类型真的变了由分析模块声明 image.kindChanged，和证据的变化一起交给 afterBatchInTx。
 */
import type { Db, Statement } from '../../db/connection.ts';
import type { Change } from '../../propagation/changes.ts';
import { writeArtists } from '../../services/tagger/artists.ts';
import type { CharacterCatalog } from '../catalog/characterCatalog.ts';
import type { CopyrightSource } from '../../services/catalog/copyrights.ts';
import { analyze } from '../analysis/analyze.ts';
import { pickRating } from '../../services/tagger/postprocess.ts';
import type { HostItemResult } from '../../services/tagger/protocol.ts';
import { setAutoRating } from '../curation/marks.ts';
import { collectingTx } from '../tx.ts';
import { replaceEvidence, type CharacterCandidate, type ImageEvidence, type WorkCandidate } from './store.ts';

export interface WriterOptions {
  repo: string;
  generalThreshold: number;
  /**
   * 每批写完、在同一个事务里调用：imageIds 是这批处理过的图，changes 是这批声明的变化（证据模块的 evidence.changed、分析模块的 image.kindChanged）。
   * 引擎里交给 declareTagged（ctx.apply 声明变化，自动决定、排除规则、Pixiv 排队等由反应做）；不传就只写证据
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
  /** 这批之后新加的角色关联（自动决定做的） */
  linked: number;
  createdCharacters: number;
  /** 这批图上的建议条数（派生的） */
  suggestions: number;
  failed: number;
  missing: number;
}

export class TagResultWriter {
  readonly stats: WriteStats = { tagged: 0, linked: 0, createdCharacters: 0, suggestions: 0, failed: 0, missing: 0 };
  private readonly tagIds = new Map<string, number>();
  private readonly s: Record<string, Statement>;

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
      markTagged: db.prepare('UPDATE images SET tagged_at = ?, tagger_model = ?, retag = 0 WHERE id = ?'),
      characters: db.prepare('SELECT COUNT(*) FROM characters').pluck(),
      links: db.prepare('SELECT COUNT(*) FROM image_characters WHERE image_id IN (SELECT value FROM json_each(?))').pluck(),
      suggestions: db.prepare('SELECT COUNT(*) FROM v_character_suggestions WHERE image_id IN (SELECT value FROM json_each(?))').pluck(),
    };
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
      const evidence: ImageEvidence[] = [];
      for (const r of results) {
        const id = this.writeOne(r, now, evidence);
        if (id !== null) ids.push(id);
      }
      // 识别成功的图整体替换模型证据（失败的证据不动）；自动决定由 afterBatchInTx 交给的反应做
      const tx = collectingTx(this.db);
      replaceEvidence(tx, null, 'tagger', evidence);
      // 按新标签重判类型、主题、质量分（识别失败的图也算识别过：按它现在的标签判，没有标签就是空的）
      analyze(tx, ids);
      const json = JSON.stringify(ids);
      const before = { characters: this.s.characters!.get() as number, links: this.s.links!.get(json) as number };
      if (ids.length) this.o.afterBatchInTx?.(ids, tx.changes);
      this.stats.createdCharacters += (this.s.characters!.get() as number) - before.characters;
      this.stats.linked += Math.max(0, (this.s.links!.get(json) as number) - before.links);
      this.stats.suggestions += this.s.suggestions!.get(json) as number;
      return ids;
    })();
  }

  private writeOne(r: HostItemResult, now: string, evidence: ImageEvidence[]): number | null {
    const { s, o, stats, catalog } = this;
    if (!r.ok) {
      if (r.code === 'ENOENT' || r.code === 'IO') {
        stats.missing++;
        return null;
      }
      s.markTagged!.run(now, o.repo, r.id);
      if (o.artists) writeArtists(this.db, r.id, [], now);
      // 识别失败也算「识别过」：批后由分析模块写主题和质量分（保持 tagged_at 与 theme 同时为空 / 非空）
      stats.failed++;
      return r.id;
    }
    s.delImageTags!.run(r.id);
    for (const [name, score] of r.general) s.insImageTag!.run(r.id, this.tagId(name, 'general'), score);
    for (const [name, score] of r.character) s.insImageTag!.run(r.id, this.tagId(name, 'character'), score);

    // 角色候选按图库身份去重，保留得分最高的一条；标签记规范化之后的写法
    const chars = new Map<string | number, CharacterCandidate>();
    for (const [raw, score] of r.character) {
      const tag = catalog.normalizeTag(raw);
      const key = catalog.resolveCharacterId(raw) ?? tag;
      if (score > (chars.get(key)?.score ?? -1)) chars.set(key, { tag, score });
    }
    const characters = [...chars.values()].sort((a, b) => b.score - a.score);
    // 候选角色的主作品（按标签记，不建档）
    const works = new Map<string, WorkCandidate>();
    for (const c of characters) {
      const primary = this.copyrights.copyrights(c.tag)[0];
      if (primary && c.score > (works.get(primary)?.score ?? -1)) works.set(primary, { tag: primary, score: c.score });
    }
    evidence.push({ imageId: r.id, at: now, characters, works: [...works.values()] });
    if (r.rating) setAutoRating(this.db, r.id, pickRating(r.rating));
    // 能认画师的模型（PixAI）顺便给出画师；WD 没有这一项，留给「识别画师」任务补
    if (r.artist) writeArtists(this.db, r.id, r.artist, now);
    s.markTagged!.run(now, o.repo, r.id);
    stats.tagged++;
    return r.id;
  }
}
