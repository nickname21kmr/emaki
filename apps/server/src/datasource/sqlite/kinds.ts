/**
 * 手动改内容类型（T27 第 9 条）：bulk { type: 'kind' } 和 PATCH /images/:id { kind } 共用。
 * - 设成某一类：manual=1（归类模块的标记）、source='manual'，自动判断永远不覆盖；
 * - 'auto'：清掉 manual，按规则当场重算（查这张图的标签）；
 * - 最终类型变了就声明 image.kindChanged：自动关联由反应 reevaluateAuto 按新类型重新评估（和自动改类型同一条路，附录 #3）。
 * 全部可撤销。
 */
import { CONTENT_KINDS, type ContentKind } from '@emaki/shared';
import { BadRequestError } from '../../http/errors.ts';
import { backfillClassification } from '../../services/classify/backfill.ts';
import type { CharacterCatalog } from '../../domain/catalog/characterCatalog.ts';
import { setKindManual } from '../../domain/curation/kinds.ts';
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

/** 批量操作要用的角色目录（按标签归类、建「原创」作品） */
export interface KindDeps {
  catalog: () => CharacterCatalog;
}

/** 在 ctx.mutate 里调用；返回 toast 文案 */
export function setKindInTx(ctx: SqliteContext, u: UndoRecorder, ids: number[], value: ContentKind | 'auto'): string {
  const db = ctx.db;
  const json = JSON.stringify(ids);
  const kinds = () => new Map((db.prepare('SELECT id, content_kind FROM images WHERE id IN (SELECT value FROM json_each(?))').all(json) as { id: number; content_kind: string }[]).map((r) => [r.id, r.content_kind]));
  const before = kinds();
  u.columns('images', ['content_kind', 'content_kind_source', 'content_kind_evidence', 'content_kind_version', 'theme', 'art_score'], ids);
  setKindManual(ctx, u, ids, value !== 'auto');
  if (value === 'auto') {
    backfillClassification(db, { ids });
  } else {
    db.prepare(
      `UPDATE images SET content_kind = ?, content_kind_source = 'manual', content_kind_evidence = NULL
       WHERE id IN (SELECT value FROM json_each(?))`,
    ).run(value, json);
  }
  // 最终类型变了就声明（自动关联的重新评估、合集、Pixiv 资格由反应处理）
  const after = kinds();
  ctx.changed({ type: 'image.kindChanged', ids: ids.filter((id) => before.get(id) !== after.get(id)) });
  const n = ids.length;
  return value === 'auto' ? `已恢复自动判断（${n} 张）` : `已把 ${n} 张图标为「${KIND_LABEL[value]}」`;
}
