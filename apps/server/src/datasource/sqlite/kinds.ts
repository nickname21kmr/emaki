/**
 * 手动改内容类型（T27 第 9 条）：bulk { type: 'kind' } 和 PATCH /images/:id { kind } 共用。
 * - 设成某一类：manual=1、source='manual'，自动判断永远不覆盖；
 * - 'auto'：清掉 manual，按规则当场重算（查这张图的标签）；
 * - 改成插画或漫画后，把这些图上分数 ≥ autoAccept 的建议当场提升为角色关联（BI-15 ②），否则角色张数要等下次识别才补上。
 * 全部可撤销。
 */
import { CONTENT_KINDS, type ContentKind } from '@emaki/shared';
import { BadRequestError } from '../../http/errors.ts';
import { backfillClassification } from '../../services/classify/backfill.ts';
import type { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import { insertDanbooruCharacter } from './characters.ts';
import type { SqliteContext } from './context.ts';
import { applyExclusionRules } from './exclusions.ts';
import { iso } from './sql.ts';
import type { UndoRecorder } from './undo.ts';

export const KIND_LABEL: Record<ContentKind, string> = {
  illustration: '插画',
  comic: '漫画',
  screenshot: '截图',
  text: '文字',
  photo: '照片',
  meme: '表情',
  animated: '动图',
};

export function assertKindValue(v: unknown): asserts v is ContentKind | 'auto' {
  if (v !== 'auto' && !CONTENT_KINDS.includes(v as ContentKind)) throw new BadRequestError(`未知的图片类型：${String(v)}`);
}

export interface KindDeps {
  catalog: () => CharacterCatalog;
  autoAcceptThreshold: () => number;
}

/** 在 ctx.mutate 里调用；返回 toast 文案 */
export function setKindInTx(ctx: SqliteContext, u: UndoRecorder, ids: number[], value: ContentKind | 'auto', deps: KindDeps): string {
  const db = ctx.db;
  const json = JSON.stringify(ids);
  u.columns(
    'images',
    ['content_kind', 'content_kind_source', 'content_kind_evidence', 'content_kind_manual', 'content_kind_version', 'theme', 'art_score'],
    ids,
  );
  if (value === 'auto') {
    db.prepare('UPDATE images SET content_kind_manual = 0 WHERE id IN (SELECT value FROM json_each(?))').run(json);
    backfillClassification(db, { ids });
  } else {
    db.prepare(
      `UPDATE images SET content_kind = ?, content_kind_source = 'manual', content_kind_evidence = NULL, content_kind_manual = 1
       WHERE id IN (SELECT value FROM json_each(?))`,
    ).run(value, json);
  }
  promoteSuggestions(ctx, u, ids, deps);
  const n = ids.length;
  return value === 'auto' ? `已恢复自动判断（${n} 张）` : `已把 ${n} 张图标为「${KIND_LABEL[value]}」`;
}

function promoteSuggestions(ctx: SqliteContext, u: UndoRecorder, ids: number[], deps: KindDeps): void {
  const db = ctx.db;
  const rows = db
    .prepare(
      `SELECT cs.image_id AS imageId, cs.danbooru_tag AS tag, cs.score FROM character_suggestions cs JOIN images i ON i.id = cs.image_id
       WHERE cs.image_id IN (SELECT value FROM json_each(?)) AND cs.score >= ? AND i.content_kind IN ('illustration','comic')`,
    )
    .all(JSON.stringify(ids), deps.autoAcceptThreshold()) as { imageId: number; tag: string; score: number }[];
  if (!rows.length) return;
  const catalog = deps.catalog();
  const now = iso(ctx.clock());
  for (const r of rows) {
    const { id } = insertDanbooruCharacter(u, catalog, r.tag, { now });
    const ins = db
      .prepare("INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, 'tagger', ?, ?)")
      .run(r.imageId, id, r.score, now);
    if (ins.changes === 1) u.sql('DELETE FROM image_characters WHERE image_id = ? AND character_id = ?', [r.imageId, id]);
    u.set('character_suggestions', 'image_id = ? AND danbooru_tag = ?', [r.imageId, r.tag]);
    db.prepare('DELETE FROM character_suggestions WHERE image_id = ? AND danbooru_tag = ?').run(r.imageId, r.tag);
  }
  applyExclusionRules(ctx, { imageIds: [...new Set(rows.map((r) => r.imageId))] });
}
