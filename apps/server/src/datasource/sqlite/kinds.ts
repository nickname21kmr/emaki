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
import { applyExclusionRulesTracked, revertNewlyExcluded } from './exclusions.ts';
import { iso } from './sql.ts';
import type { UndoRecorder } from './undo.ts';
import { vetoChecker } from './vetoes.ts';

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
  promoteSuggestionsInTx(ctx, u, ids, deps);
  const n = ids.length;
  return value === 'auto' ? `已恢复自动判断（${n} 张）` : `已把 ${n} 张图标为「${KIND_LABEL[value]}」`;
}

// 能提升的建议：识别器给的、分数达标、插画或漫画上的；ids 为空时看全库（没删、文件夹没停用 / 移除的图）
const PROMOTABLE = (scoped: boolean) => `FROM character_suggestions cs JOIN images i ON i.id = cs.image_id
  WHERE ${scoped ? 'cs.image_id IN (SELECT value FROM json_each(@ids))' : 'i.trashed_at IS NULL AND i.root_id IN (SELECT id FROM library_roots WHERE enabled = 1 AND removed_at IS NULL)'}
    AND cs.source = 'tagger' AND cs.score >= @threshold AND i.content_kind IN ('illustration','comic')`;

// 计数时跳过：图上已经有这个角色的、用户去掉过这个角色的
const NOT_LINKED_OR_VETOED = `
    AND NOT EXISTS (SELECT 1 FROM image_characters ic JOIN characters c ON c.id = ic.character_id WHERE ic.image_id = cs.image_id AND c.danbooru_tag = cs.danbooru_tag)
    AND NOT EXISTS (SELECT 1 FROM character_vetoes v JOIN characters c ON c.id = v.character_id WHERE v.image_id = cs.image_id AND c.danbooru_tag = cs.danbooru_tag)`;

/** 全库已有建议里分数达到阈值、提升后真会新归到角色的（调低自动采纳阈值后给设置页看） */
export function countPromotable(db: SqliteContext['db'], threshold: number): { images: number; suggestions: number } {
  return db
    .prepare(`SELECT COUNT(DISTINCT cs.image_id) AS images, COUNT(*) AS suggestions ${PROMOTABLE(false)} ${NOT_LINKED_OR_VETOED}`)
    .get({ threshold }) as { images: number; suggestions: number };
}

/**
 * 把分数已达自动采纳阈值的建议提升为角色关联（BI-15 ②；调低阈值后用户点按钮时对全库，ids = null）。在 ctx.mutate 里调用，可撤销。
 * 用户去掉过的角色不加回，那条建议直接删掉。返回新归到角色的图片 id
 */
export function promoteSuggestionsInTx(ctx: SqliteContext, u: UndoRecorder, ids: number[] | null, deps: KindDeps): number[] {
  const db = ctx.db;
  const rows = db
    .prepare(`SELECT cs.image_id AS imageId, cs.danbooru_tag AS tag, cs.score ${PROMOTABLE(ids !== null)}`)
    .all({ ids: JSON.stringify(ids ?? []), threshold: deps.autoAcceptThreshold() }) as { imageId: number; tag: string; score: number }[];
  if (!rows.length) return [];
  const catalog = deps.catalog();
  const now = iso(ctx.clock());
  const vetoed = vetoChecker(db);
  const link = db.prepare("INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, 'tagger', ?, ?)");
  const drop = db.prepare('DELETE FROM character_suggestions WHERE image_id = ? AND danbooru_tag = ?');
  const linked = new Set<number>();
  for (const r of rows) {
    const known = catalog.resolveCharacterId(r.tag);
    if (known === null || !vetoed(r.imageId, known)) {
      const { id } = insertDanbooruCharacter(u, catalog, r.tag, { now });
      const ins = link.run(r.imageId, id, r.score, now);
      if (ins.changes === 1) {
        u.sql('DELETE FROM image_characters WHERE image_id = ? AND character_id = ?', [r.imageId, id]);
        linked.add(r.imageId);
      }
    }
    u.set('character_suggestions', 'image_id = ? AND danbooru_tag = ?', [r.imageId, r.tag]);
    drop.run(r.imageId, r.tag);
  }
  // 新角色可能命中「角色」排除规则；撤销时角色关联去掉了，这条排除也要跟着放出来
  const excluded = applyExclusionRulesTracked(ctx, [...linked]);
  if (excluded.length) u.onUndo(() => db.transaction(() => revertNewlyExcluded(ctx, excluded))());
  return [...linked];
}
