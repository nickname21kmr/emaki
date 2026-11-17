/**
 * 图 ↔ 角色的唯一写入者（docs/core-architecture.md 第 2.4、4.1 节，P3a）。image_characters 和 character_vetoes 只在这个目录里写。
 *
 * 命令：
 * - link / linkEach：加关联，每条带来历（provenance.ts）。已经有关联的不动原来的来历；
 *   遇到否决：用户手动加的清掉否决（D3），自动的跳过；搬已有决定的（合并、查重合并、撤回移动）一律尊重否决。
 * - unlink / unlinkEach：去掉关联，可以只去掉满足条件的（按来历精确删除，附录 #6）；用户去掉的记否决。
 * - replaceCharacters：整组替换（看图器 PATCH characterIds）= 去掉不在列表里的 + 手动加上新的。
 * - moveCharacterLinks：角色合并时把关联和否决搬到目标角色上。
 * - carryLinks：查重合并时把副本的关联搬到保留的图上（手动的还是手动，自动的记成 dedupe-merge）。
 *
 * 每个命令都：写来历；清掉对应的建议（证据模块的 dropSuggestionsForLinks）；声明 curation.charactersChanged / vetoesChanged
 * （排除规则、合集、Pixiv 排队等由反应做）；有撤销记录器时记下撤销。
 * 调用方在 ctx.mutate / ctx.apply 里调用（tx 就是 ctx）；反应里传 { db, changed: emit }；
 * 识别写入这种自己开事务的，传一个收集变化的 tx，批后再交给 ctx.apply 声明。
 */
import type { Db, Statement } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { dismissPixivCharacterChecks } from '../../datasource/sqlite/pixivChecks.ts';
import { currentActor } from '../../propagation/actor.ts';
import type { Change } from '../../propagation/changes.ts';
import { dropSuggestionsForLinks } from '../evidence/suggestions.ts';
import { fromRow, RULES, toColumns, type LinkRow, type Provenance } from './provenance.ts';

/** 写归类事实需要的：数据库 + 声明变化 */
export interface CurationTx {
  readonly db: Db;
  changed(c: Change): void;
}

/** 收集变化的 tx：自己开事务的写入（识别写入）先收着，批后交给 ctx.apply 声明 */
export function collectingTx(db: Db): CurationTx & { changes: Change[] } {
  const changes: Change[] = [];
  return { db, changes, changed: (c) => void changes.push(c) };
}

const cache = new WeakMap<Db, Map<string, Statement>>();
export function stmt(db: Db, sql: string): Statement {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

/** json_each 里的 [图, 角色] 对 */
const PAIRS = '(image_id, character_id) IN (SELECT value ->> 0, value ->> 1 FROM json_each(?))';
const pairsJson = (xs: { imageId: number; characterId: number }[]) => JSON.stringify(xs.map((x) => [x.imageId, x.characterId]));
const uniqueImages = (xs: { imageId: number }[]) => [...new Set(xs.map((x) => x.imageId))];

export interface LinkItem {
  imageId: number;
  characterId: number;
  provenance: Provenance;
}

export interface LinkOptions {
  /**
   * 遇到否决怎么办：
   * - 'decision'（默认）：手动的清掉否决再加（D3：用户手动加回），自动的跳过；
   * - 'respect'：一律跳过（搬已有的决定，不是用户这次对这一对做的决定：角色合并、查重合并、撤回移动）
   */
  vetoes?: 'decision' | 'respect';
}

export interface LinkResult {
  /** 新加的 */
  linked: LinkItem[];
  /** 本来就有关联的（原来的来历不动） */
  existing: LinkItem[];
  /** 被否决挡住的 */
  vetoed: LinkItem[];
  /** 加的时候清掉了否决的（也在 linked 里） */
  unvetoed: LinkItem[];
  /** 图或角色已经不在了 */
  missing: LinkItem[];
}

/** 加关联：同一对只取第一条（调用方按分数从高到低排好） */
export function linkEach(tx: CurationTx, u: UndoRecorder | null, items: LinkItem[], opts: LinkOptions = {}): LinkResult {
  const out: LinkResult = { linked: [], existing: [], vetoed: [], unvetoed: [], missing: [] };
  const seen = new Set<string>();
  const list = items.filter((x) => {
    const k = `${x.imageId}:${x.characterId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!list.length) return out;
  const db = tx.db;
  const state = stmt(
    db,
    `SELECT CAST(j.key AS INTEGER) AS k,
       EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = j.value ->> 0 AND ic.character_id = j.value ->> 1) AS linked,
       EXISTS (SELECT 1 FROM character_vetoes v WHERE v.image_id = j.value ->> 0 AND v.character_id = j.value ->> 1) AS vetoed,
       EXISTS (SELECT 1 FROM images i WHERE i.id = j.value ->> 0) AND EXISTS (SELECT 1 FROM characters c WHERE c.id = j.value ->> 1) AS alive
     FROM json_each(?) j`,
  ).all(pairsJson(list)) as { k: number; linked: number; vetoed: number; alive: number }[];
  for (const s of state) {
    const it = list[s.k]!;
    if (!s.alive) out.missing.push(it);
    else if (s.linked) out.existing.push(it);
    else if (s.vetoed && (opts.vetoes === 'respect' || it.provenance.decision === 'auto')) out.vetoed.push(it);
    else {
      if (s.vetoed) out.unvetoed.push(it);
      out.linked.push(it);
    }
  }
  if (out.unvetoed.length) {
    const json = pairsJson(out.unvetoed);
    u?.set('character_vetoes', PAIRS, [json]);
    stmt(db, `DELETE FROM character_vetoes WHERE ${PAIRS}`).run(json);
  }
  if (out.linked.length) {
    const ins = stmt(
      db,
      `INSERT INTO image_characters (image_id, character_id, decision, actor, rule, evidence_provider, evidence_tag, evidence_score, added_at)
       VALUES (@image_id, @character_id, @decision, @actor, @rule, @evidence_provider, @evidence_tag, @evidence_score, @added_at)`,
    );
    for (const it of out.linked) ins.run({ image_id: it.imageId, character_id: it.characterId, ...toColumns(it.provenance) });
    // 撤销只删这次加的（同一对、同一个时间），之后别的入口再加的不动
    u?.sql('DELETE FROM image_characters WHERE (image_id, character_id, added_at) IN (SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each(?))', [
      JSON.stringify(out.linked.map((x) => [x.imageId, x.characterId, x.provenance.at])),
    ]);
  }
  // 关联上了的角色不再作为这张图的建议
  dropSuggestionsForLinks(
    db,
    u,
    [...out.linked, ...out.existing].map((x) => ({ imageId: x.imageId, characterId: x.characterId, tag: x.provenance.evidence?.tag })),
  );
  tx.changed({ type: 'curation.charactersChanged', ids: uniqueImages(out.linked) });
  tx.changed({ type: 'curation.vetoesChanged', ids: uniqueImages(out.unvetoed) });
  return out;
}

/** 加关联：这些图 × 这些角色，同一个来历 */
export function link(tx: CurationTx, u: UndoRecorder | null, images: number[], characters: number[], provenance: Provenance, opts?: LinkOptions): LinkResult {
  return linkEach(
    tx,
    u,
    images.flatMap((imageId) => characters.map((characterId) => ({ imageId, characterId, provenance }))),
    opts,
  );
}

export interface UnlinkOptions {
  /** 记成否决：以后自动规则不再加回，也不再作为建议（用户去掉的、撤回自动改动去掉的） */
  veto: boolean;
  /** 同时把 Pixiv 补充标成「用户处理过」：补跑时不再采纳这张图的其他旧建议（用户去掉角色时） */
  dismissPixiv?: boolean;
  /** 只去掉满足条件的（按来历精确删除）；不给 = 不论来历 */
  only?: (row: LinkRow) => boolean;
  /** 否决和 Pixiv 标记的时间（veto、dismissPixiv 时必须给） */
  at?: string;
}

/** 去掉关联；返回去掉的行（去掉之前的样子） */
export function unlinkEach(tx: CurationTx, u: UndoRecorder | null, pairs: { imageId: number; characterId: number }[], opts: UnlinkOptions): LinkRow[] {
  if (!pairs.length) return [];
  const db = tx.db;
  const rows = (
    stmt(
      db,
      `SELECT ic.* FROM json_each(?) j JOIN image_characters ic ON ic.image_id = j.value ->> 0 AND ic.character_id = j.value ->> 1`,
    ).all(pairsJson(pairs)) as LinkRow[]
  ).filter((r) => !opts.only || opts.only(r));
  if (!rows.length) return [];
  if ((opts.veto || opts.dismissPixiv) && !opts.at) throw new Error('记否决要给时间');
  const at = opts.at ?? '';
  const removed = rows.map((r) => ({ imageId: r.image_id, characterId: r.character_id }));
  const json = pairsJson(removed);
  const images = uniqueImages(removed);
  u?.set('image_characters', PAIRS, [json]);
  if (opts.dismissPixiv) dismissPixivCharacterChecks(db, u, images, at);
  let vetoed: { imageId: number; characterId: number }[] = [];
  if (opts.veto) {
    vetoed = (
      stmt(
        db,
        `SELECT j.value ->> 0 AS imageId, j.value ->> 1 AS characterId FROM json_each(?) j
         WHERE NOT EXISTS (SELECT 1 FROM character_vetoes v WHERE v.image_id = j.value ->> 0 AND v.character_id = j.value ->> 1)`,
      ).all(json) as { imageId: number; characterId: number }[]
    );
    if (vetoed.length) {
      const vj = pairsJson(vetoed);
      u?.sql(`DELETE FROM character_vetoes WHERE ${PAIRS}`, [vj]);
      stmt(db, 'INSERT INTO character_vetoes (image_id, character_id, created_at) SELECT value ->> 0, value ->> 1, ? FROM json_each(?)').run(at, vj);
    }
  }
  stmt(db, `DELETE FROM image_characters WHERE ${PAIRS}`).run(json);
  tx.changed({ type: 'curation.charactersChanged', ids: images });
  tx.changed({ type: 'curation.vetoesChanged', ids: uniqueImages(vetoed) });
  return rows;
}

/** 去掉关联：这些图 × 这些角色 */
export function unlink(tx: CurationTx, u: UndoRecorder | null, images: number[], characters: number[], opts: UnlinkOptions): LinkRow[] {
  return unlinkEach(
    tx,
    u,
    images.flatMap((imageId) => characters.map((characterId) => ({ imageId, characterId }))),
    opts,
  );
}

/** 用户去掉角色（批量移除、整组替换里去掉的）：记否决，Pixiv 补充不再采纳这张图的旧建议 */
export function unlinkByUser(tx: CurationTx, u: UndoRecorder | null, images: number[], characters: number[], at: string): LinkRow[] {
  return unlink(tx, u, images, characters, { veto: true, dismissPixiv: true, at });
}

/**
 * 整组替换一张图的角色（看图器 PATCH characterIds）：不在列表里的按用户去掉处理（记否决），新的手动加上（清掉否决），
 * 本来就有的保持原来的来历
 */
export function replaceCharacters(tx: CurationTx, u: UndoRecorder | null, imageId: number, characterIds: number[], provenance: Provenance): { added: LinkItem[]; removed: LinkRow[] } {
  const current = stmt(tx.db, 'SELECT character_id FROM image_characters WHERE image_id = ?').pluck().all(imageId) as number[];
  const keep = new Set(characterIds);
  const removed = unlinkByUser(
    tx,
    u,
    [imageId],
    current.filter((c) => !keep.has(c)),
    provenance.at,
  );
  const added = link(tx, u, [imageId], characterIds.filter((c) => !current.includes(c)), provenance).linked;
  return { added, removed };
}

/**
 * 角色合并：把 from 的关联和否决搬到 to 上，然后去掉 from 的（附录 #39）。
 * - 关联：to 在这张图上已有关联的保持 to 自己的；否则按原来的来历加给 to，to 在这张图上被否决过就不加（否决是用户对这一对的决定）；
 * - 否决：to 在这张图上没有关联、也没有否决的搬过去，免得按 to 的名字又被识别加回。
 * 必须在删掉 from 这个角色、记它的撤销快照之前调用（撤销逆序：先插回角色，再还原这里的快照）。返回涉及的图
 */
export function moveCharacterLinks(tx: CurationTx, u: UndoRecorder | null, from: number, to: number): number[] {
  const db = tx.db;
  const rows = stmt(db, 'SELECT * FROM image_characters WHERE character_id = ? ORDER BY added_at, image_id').all(from) as LinkRow[];
  u?.set('image_characters', 'character_id = ?', [from]);
  u?.set('character_vetoes', 'character_id = ?', [from]);
  linkEach(
    tx,
    u,
    rows.map((r) => ({ imageId: r.image_id, characterId: to, provenance: fromRow(r) })),
    { vetoes: 'respect' },
  );
  const vetoes = stmt(
    db,
    `SELECT v.image_id FROM character_vetoes v WHERE v.character_id = @from
       AND NOT EXISTS (SELECT 1 FROM character_vetoes t WHERE t.image_id = v.image_id AND t.character_id = @to)
       AND NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = v.image_id AND ic.character_id = @to)`,
  )
    .pluck()
    .all({ from, to }) as number[];
  if (vetoes.length) {
    const vj = JSON.stringify(vetoes);
    u?.sql('DELETE FROM character_vetoes WHERE character_id = ? AND image_id IN (SELECT value FROM json_each(?))', [to, vj]);
    stmt(
      db,
      `INSERT INTO character_vetoes (image_id, character_id, created_at)
       SELECT image_id, @to, created_at FROM character_vetoes WHERE character_id = @from AND image_id IN (SELECT value FROM json_each(@ids))`,
    ).run({ from, to, ids: vj });
  }
  stmt(db, 'DELETE FROM image_characters WHERE character_id = ?').run(from);
  stmt(db, 'DELETE FROM character_vetoes WHERE character_id = ?').run(from);
  const images = [...new Set(rows.map((r) => r.image_id))];
  tx.changed({ type: 'curation.charactersChanged', ids: images });
  tx.changed({ type: 'curation.vetoesChanged', ids: vetoes });
  return images;
}

/**
 * 查重合并（附录 #12）：副本上的关联搬到保留的图上。手动的还是手动（来历照搬）；自动的记成自动、规则 dedupe-merge，
 * 证据照搬副本的，actor 是做合并的人。保留的图上已有的不动，被否决过的不搬。返回新加的
 */
export function carryLinks(tx: CurationTx, u: UndoRecorder | null, keep: number[], gone: number[]): LinkItem[] {
  if (!keep.length || !gone.length) return [];
  const rows = stmt(tx.db, 'SELECT * FROM image_characters WHERE image_id IN (SELECT value FROM json_each(?)) ORDER BY added_at, image_id, character_id').all(
    JSON.stringify(gone),
  ) as LinkRow[];
  const actor = currentActor();
  const items = keep.flatMap((imageId) =>
    rows.map((r) => {
      const p = fromRow(r);
      return { imageId, characterId: r.character_id, provenance: p.decision === 'manual' ? p : { ...p, rule: RULES.dedupeMerge, actor } };
    }),
  );
  return linkEach(tx, u, items, { vetoes: 'respect' }).linked;
}

/** 这些图上的自动关联（撤销快照用：漫画区同步会去掉它们） */
export function snapshotAutoLinks(u: UndoRecorder, imageIds: number[]): void {
  if (!imageIds.length) return;
  u.set('image_characters', "decision = 'auto' AND image_id IN (SELECT value FROM json_each(?))", [JSON.stringify(imageIds)]);
}

/** 这张图上的这个角色被用户去掉过 */
export function vetoChecker(db: Db): (imageId: number, characterId: number) => boolean {
  const st = stmt(db, 'SELECT 1 FROM character_vetoes WHERE image_id = ? AND character_id = ?').pluck();
  return (imageId, characterId) => st.get(imageId, characterId) !== undefined;
}
