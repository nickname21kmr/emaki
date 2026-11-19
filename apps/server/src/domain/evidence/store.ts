/**
 * 证据的存储（docs/core-architecture.md 第 2.1 节，P3b）：某个来源对一张图给出的角色候选、作品候选和原创信号，
 * 按「图片 × 来源」整体替换。image_evidence / character_evidence / work_evidence 只在这里写（单一写入者测试检查）。
 *
 * - 写完声明 evidence.changed { provider }，只对真的替换过（或去掉了）证据的图声明；
 *   由反应 reevaluateAuto 按新证据重新评估自动决定（第 4.2 节），证据不再支持的自动关联在那里撤回（D2）。
 * - 证据本身不改变图库：建议是派生视图 v_character_suggestions（证据里还没关联、也没被否决的候选），作品证据不算进图的作品。
 * - 来源：tagger（识别模型）、pixiv（投稿标签）；以后的插件来源记成 plugin:<id>，用法一样。
 */
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { stmt, type DomainTx } from '../tx.ts';

/** 给角色候选的证据来源 */
export type CharacterEvidenceProvider = 'tagger' | 'pixiv' | `plugin:${string}`;

/** 一个角色候选 */
export interface CharacterCandidate {
  /** 规范化后的标签；Pixiv 对上自建角色时是占位标签 emaki:character:<id> */
  tag: string;
  /** 自建角色（占位标签对应的真引用）；其余为空，按标签找角色 */
  characterId?: number | null;
  /** 置信度：模型分数；Pixiv 确认的是 1、待确认的是 0（见 services/pixiv/evidence.ts） */
  score: number;
}

/** 一个作品候选：作品的 Danbooru 标签（不要求作品已经建档） */
export interface WorkCandidate {
  tag: string;
  score: number;
}

/** 一个来源对一张图给出的全部证据 */
export interface ImageEvidence {
  imageId: number;
  /** 证据产生的时间 */
  at: string;
  /** 原创信号（Pixiv 投稿标了原创） */
  original?: boolean;
  characters: CharacterCandidate[];
  works?: WorkCandidate[];
}

/** 读出来的一份证据（reevaluateAuto 用） */
export interface StoredEvidence {
  provider: CharacterEvidenceProvider;
  at: string | null;
  original: boolean;
  candidates: { tag: string; characterId: number | null; score: number }[];
}

const SCOPE = 'provider = ? AND image_id IN (SELECT value FROM json_each(?))';

/**
 * 整体替换这些图上这个来源的证据（每张图一份）；u 不为空时记撤销。
 * 同一张图里重复的候选（同一个标签、同一部作品）取最高分
 */
export function replaceEvidence(tx: DomainTx, u: UndoRecorder | null, provider: CharacterEvidenceProvider, items: ImageEvidence[]): void {
  if (!items.length) return;
  const db = tx.db;
  const ids = [...new Set(items.map((x) => x.imageId))];
  const json = JSON.stringify(ids);
  snapshot(u, provider, json);
  clear(db, provider, json);
  stmt(db, 'INSERT INTO image_evidence (image_id, provider, at, original) SELECT value ->> 0, ?, value ->> 1, value ->> 2 FROM json_each(?)').run(
    provider,
    JSON.stringify(items.map((x) => [x.imageId, x.at, x.original ? 1 : 0])),
  );
  const chars = items.flatMap((x) => x.characters.map((c) => [x.imageId, c.tag, c.characterId ?? null, c.score]));
  if (chars.length) {
    stmt(
      db,
      `INSERT INTO character_evidence (image_id, provider, tag, character_id, score)
       SELECT value ->> 0, ?, value ->> 1, value ->> 2, value ->> 3 FROM json_each(?) WHERE true
       ON CONFLICT (image_id, provider, tag) DO UPDATE SET score = MAX(score, excluded.score), character_id = COALESCE(character_id, excluded.character_id)`,
    ).run(provider, JSON.stringify(chars));
  }
  const works = items.flatMap((x) => (x.works ?? []).map((w) => [x.imageId, w.tag, w.score]));
  if (works.length) {
    stmt(
      db,
      `INSERT INTO work_evidence (image_id, provider, tag, score)
       SELECT value ->> 0, ?, value ->> 1, value ->> 2 FROM json_each(?) WHERE true
       ON CONFLICT (image_id, provider, tag) DO UPDATE SET score = MAX(score, excluded.score)`,
    ).run(provider, JSON.stringify(works));
  }
  tx.changed({ type: 'evidence.changed', provider, ids });
}

/**
 * 去掉这些图上这个来源的证据（来源失效：换了投稿、投稿不在了……）；u 不为空时记撤销。
 * 返回真的有证据被去掉的图（只对它们声明 evidence.changed）
 */
export function dropEvidence(tx: DomainTx, u: UndoRecorder | null, provider: CharacterEvidenceProvider, imageIds: number[]): number[] {
  if (!imageIds.length) return [];
  const db = tx.db;
  const had = stmt(
    db,
    `SELECT image_id FROM image_evidence WHERE ${SCOPE}
     UNION SELECT image_id FROM character_evidence WHERE ${SCOPE}`,
  )
    .pluck()
    .all(provider, JSON.stringify(imageIds), provider, JSON.stringify(imageIds)) as number[];
  if (!had.length) return [];
  const json = JSON.stringify(had);
  snapshot(u, provider, json);
  clear(db, provider, json);
  tx.changed({ type: 'evidence.changed', provider, ids: had });
  return had;
}

function snapshot(u: UndoRecorder | null, provider: string, json: string): void {
  u?.set('image_evidence', SCOPE, [provider, json]);
  u?.set('character_evidence', SCOPE, [provider, json]);
  u?.set('work_evidence', SCOPE, [provider, json]);
}

function clear(db: Db, provider: string, json: string): void {
  stmt(db, `DELETE FROM image_evidence WHERE ${SCOPE}`).run(provider, json);
  stmt(db, `DELETE FROM character_evidence WHERE ${SCOPE}`).run(provider, json);
  stmt(db, `DELETE FROM work_evidence WHERE ${SCOPE}`).run(provider, json);
}

/** 这些图的全部角色证据（按图、按来源） */
export function loadEvidence(db: Db, imageIds: number[]): Map<number, StoredEvidence[]> {
  const out = new Map<number, StoredEvidence[]>();
  if (!imageIds.length) return out;
  const json = JSON.stringify(imageIds);
  const of = (imageId: number, provider: CharacterEvidenceProvider): StoredEvidence => {
    let list = out.get(imageId);
    if (!list) out.set(imageId, (list = []));
    let e = list.find((x) => x.provider === provider);
    if (!e) list.push((e = { provider, at: null, original: false, candidates: [] }));
    return e;
  };
  const heads = stmt(db, 'SELECT image_id, provider, at, original FROM image_evidence WHERE image_id IN (SELECT value FROM json_each(?)) ORDER BY image_id, provider').all(
    json,
  ) as { image_id: number; provider: CharacterEvidenceProvider; at: string; original: number }[];
  for (const h of heads) Object.assign(of(h.image_id, h.provider), { at: h.at, original: h.original === 1 });
  const rows = stmt(
    db,
    `SELECT image_id, provider, tag, character_id, score FROM character_evidence WHERE image_id IN (SELECT value FROM json_each(?))
     ORDER BY image_id, provider, score DESC, tag`,
  ).all(json) as { image_id: number; provider: CharacterEvidenceProvider; tag: string; character_id: number | null; score: number }[];
  for (const r of rows) of(r.image_id, r.provider).candidates.push({ tag: r.tag, characterId: r.character_id, score: r.score });
  return out;
}

/** 证据里提到这些标签或这些自建角色的图（编目合并、绑定变了之后要重新评估的） */
export function imagesWithCandidates(db: Db, tags: string[], characterIds: number[]): number[] {
  if (!tags.length && !characterIds.length) return [];
  return stmt(
    db,
    `SELECT image_id FROM character_evidence WHERE tag IN (SELECT value FROM json_each(?))
     UNION SELECT image_id FROM character_evidence WHERE character_id IN (SELECT value FROM json_each(?))`,
  )
    .pluck()
    .all(JSON.stringify(tags), JSON.stringify(characterIds)) as number[];
}

/**
 * 角色合并（编目调用）：自建角色 from 的候选改指向目标——目标有 Danbooru 标签就写那个标签（character_id 留空），
 * 没有就写目标的占位标签。图上同一个来源已经有目标的候选就不搬（删 from 时级联删掉）。
 * 必须在删掉 from、记它的撤销快照之前调用（撤销逆序：先插回角色，再还原这里的快照）
 */
export function moveCharacterEvidence(db: Db, u: UndoRecorder | null, from: number, to: { id: number; tag: string | null }): void {
  const p = { from, to: to.id, tag: to.tag ?? `emaki:character:${to.id}`, cid: to.tag ? null : to.id };
  const moved = JSON.stringify(
    stmt(
      db,
      `SELECT e.image_id, e.provider FROM character_evidence e WHERE e.character_id = @from AND NOT EXISTS (
         SELECT 1 FROM character_evidence t WHERE t.image_id = e.image_id AND t.provider = e.provider AND (t.character_id = @to OR t.tag = @tag))`,
    )
      .raw()
      .all(p),
  );
  u?.set('character_evidence', 'character_id = ?', [from]);
  u?.sql(
    'DELETE FROM character_evidence WHERE tag = ? AND (image_id, provider) IN (SELECT value ->> 0, value ->> 1 FROM json_each(?))',
    [p.tag, moved],
  );
  stmt(
    db,
    `UPDATE character_evidence SET tag = @tag, character_id = @cid
     WHERE character_id = @from AND (image_id, provider) IN (SELECT value ->> 0, value ->> 1 FROM json_each(@moved))`,
  ).run({ ...p, moved });
}

