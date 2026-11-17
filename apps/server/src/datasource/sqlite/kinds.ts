/**
 * 手动改内容类型（T27 第 9 条）：bulk { type: 'kind' } 和 PATCH /images/:id { kind } 共用。
 * - 设成某一类：manual=1、source='manual'，自动判断永远不覆盖；
 * - 'auto'：清掉 manual，按规则当场重算（查这张图的标签）；
 * - 类型变更后，按新类型重新判断已有的高分模型建议（归类模块的补采纳，domain/curation/auto.ts）。
 * 全部可撤销。
 */
import { CONTENT_KINDS, type ContentKind } from '@emaki/shared';
import { BadRequestError } from '../../http/errors.ts';
import { backfillClassification } from '../../services/classify/backfill.ts';
import { promoteSuggestions, type PromoteDeps } from '../../domain/curation/auto.ts';
import type { SqliteContext } from './context.ts';
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

/** 改类型之后补采纳要用的（角色目录、当前阈值） */
export type KindDeps = PromoteDeps;

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
  promoteSuggestions(ctx, u, ids, deps);
  const n = ids.length;
  return value === 'auto' ? `已恢复自动判断（${n} 张）` : `已把 ${n} 张图标为「${KIND_LABEL[value]}」`;
}
