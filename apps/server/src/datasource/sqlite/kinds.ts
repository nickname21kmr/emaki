/**
 * 手动改内容类型（T27 第 9 条）：bulk { type: 'kind' } 和 PATCH /images/:id { kind } 共用。
 * - 设成某一类：manual=1、source='manual'，自动判断永远不覆盖；
 * - 'auto'：清掉 manual，按规则当场重算（查这张图的标签）；
 * - 类型变更后，按新类型重新判断已有的高分模型建议。
 * 全部可撤销。
 */
import { CONTENT_KINDS, type ContentKind } from '@emaki/shared';
import { BadRequestError } from '../../http/errors.ts';
import { backfillClassification } from '../../services/classify/backfill.ts';
import { IN_COMIC } from '../../services/classify/comicAreas.ts';
import { canAutoAcceptCharacter } from '../../services/tagger/characterAcceptance.ts';
import type { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import { insertDanbooruCharacter } from './characters.ts';
import type { SqliteContext } from './context.ts';
import { iso, UNRECOGNIZED } from './sql.ts';
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
  const kinds = () => new Map((db.prepare('SELECT id, content_kind FROM images WHERE id IN (SELECT value FROM json_each(?))').all(json) as { id: number; content_kind: string }[]).map((r) => [r.id, r.content_kind]));
  const before = kinds();
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
  // 最终类型变了就声明（合集、Pixiv 资格由反应处理）
  const after = kinds();
  ctx.changed({ type: 'image.kindChanged', ids: ids.filter((id) => before.get(id) !== after.get(id)) });
  promoteSuggestionsInTx(ctx, u, ids, deps);
  const n = ids.length;
  return value === 'auto' ? `已恢复自动判断（${n} 张）` : `已把 ${n} 张图标为「${KIND_LABEL[value]}」`;
}

interface Candidate {
  imageId: number;
  tag: string;
  score: number;
  kind: ContentKind;
}

/** 预览和执行共用一份计划。同批能建档的角色也可以被其他图片复用。 */
function planPromotions(ctx: SqliteContext, ids: number[] | null, deps: KindDeps, kind?: ContentKind) {
  const rows = ctx.stmt(`SELECT cs.image_id AS imageId, cs.danbooru_tag AS tag, cs.score, i.content_kind AS kind
    FROM character_suggestions cs JOIN v_counted_images i ON i.id = cs.image_id
    WHERE cs.source = 'tagger' AND cs.score >= @threshold AND cs.danbooru_tag NOT LIKE 'emaki:%'
      AND i.shelved_at IS NULL AND i.original_at IS NULL AND NOT ${IN_COMIC('i')}
      AND (@ids IS NULL OR i.id IN (SELECT value FROM json_each(@ids)))
      AND (@kind IS NULL OR (i.content_kind = @kind AND ${UNRECOGNIZED}))
    ORDER BY cs.score DESC, cs.image_id, cs.danbooru_tag`)
    .all({ ids: ids === null ? null : JSON.stringify(ids), threshold: deps.autoAcceptThreshold(), kind: kind ?? null }) as Candidate[];
  const catalog = deps.catalog();
  const linked = ctx.stmt('SELECT 1 FROM image_characters WHERE image_id = ? AND character_id = ?');
  const vetoed = vetoChecker(ctx.db);
  const candidates = rows.map(row => ({ ...row, characterId: catalog.resolveCharacterId(row.tag), normalized: catalog.normalizeTag(row.tag) }));
  const newTags = new Set(candidates.filter(row => row.characterId === null && canAutoAcceptCharacter(row.kind, null)).map(row => row.normalized));
  const additions: typeof candidates = [];
  const remove: Candidate[] = [];
  const seen = new Set<string>();
  for (const row of candidates) {
    const { imageId, characterId, normalized } = row;
    if (!canAutoAcceptCharacter(row.kind, characterId) && !newTags.has(normalized)) continue;
    remove.push(row);
    if (characterId !== null && (linked.get(imageId, characterId) || vetoed(imageId, characterId))) continue;
    const key = JSON.stringify([imageId, characterId ?? normalized]);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(row);
  }
  return { catalog, additions, remove };
}

export function countPromotable(ctx: SqliteContext, deps: KindDeps, kind?: ContentKind): { images: number; suggestions: number } {
  const { additions } = planPromotions(ctx, null, deps, kind);
  return { images: new Set(additions.map(row => row.imageId)).size, suggestions: additions.length };
}

/** 复用保存过的模型分数，在一个可撤销事务里写角色关联。 */
export function promoteSuggestionsInTx(ctx: SqliteContext, u: UndoRecorder, ids: number[] | null, deps: KindDeps, kind?: ContentKind): number[] {
  const { catalog, additions, remove } = planPromotions(ctx, ids, deps, kind);
  if (!remove.length) return [];
  const now = iso(ctx.clock());
  const link = ctx.stmt("INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, 'tagger', ?, ?)");
  const drop = ctx.stmt('DELETE FROM character_suggestions WHERE image_id = ? AND danbooru_tag = ?');
  const linked = new Set<number>();
  for (const row of additions) {
    const id = row.characterId ?? insertDanbooruCharacter(u, catalog, row.normalized, { now }).id;
    if (link.run(row.imageId, id, row.score, now).changes) {
      u.sql("DELETE FROM image_characters WHERE image_id = ? AND character_id = ? AND origin = 'tagger' AND added_at = ?", [row.imageId, id, now]);
      linked.add(row.imageId);
    }
  }
  for (const r of remove) {
    u.set('character_suggestions', 'image_id = ? AND danbooru_tag = ?', [r.imageId, r.tag]);
    drop.run(r.imageId, r.tag);
  }
  // 新关联的角色可能命中「角色」排除规则：反应重新判定，撤销时重放同一条变化，排除自然放出来
  ctx.changed({ type: 'curation.charactersChanged', ids: [...linked] });
  return [...linked];
}
