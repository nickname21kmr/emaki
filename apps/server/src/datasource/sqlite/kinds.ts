/**
 * 手动改内容类型（T27 第 9 条）：bulk { type: 'kind' } 和 PATCH /images/:id { kind } 共用。
 * - 设成某一类：manual=1（归类模块的标记）、source='manual'，自动判断永远不覆盖；
 * - 'auto'：清掉 manual，按规则当场重算（查这张图的标签）；
 * - 最终类型变了就声明 image.kindChanged：自动关联由反应 reevaluateAuto 按新类型重新评估（和自动改类型同一条路，附录 #3）。
 * 全部可撤销。
 */
import { CONTENT_KINDS, type ContentKind } from '@emaki/shared';
import { BadRequestError } from '../../http/errors.ts';
import { setManualKind } from '../../domain/analysis/analyze.ts';
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
};

export function assertKindValue(v: unknown): asserts v is ContentKind | 'auto' {
  if (v === 'animated') throw new BadRequestError('「动图」不是类型了：是不是动图按帧数自动判断，不能手动改');
  if (v !== 'auto' && !CONTENT_KINDS.includes(v as ContentKind)) throw new BadRequestError(`未知的图片类型：${String(v)}`);
}

/** 批量操作要用的角色目录（按标签归类、建「原创」作品） */
export interface KindDeps {
  catalog: () => CharacterCatalog;
}

/**
 * 在 ctx.mutate 里调用；返回 toast 文案。手动标记（content_kind_manual）是归类的决定（curation/kinds.ts），
 * 最终类型由分析模块写（设成某一类就是它，改回自动当场按规则重算），变了由它声明 image.kindChanged
 */
export function setKindInTx(ctx: SqliteContext, u: UndoRecorder, ids: number[], value: ContentKind | 'auto'): string {
  setKindManual(ctx, u, ids, value !== 'auto');
  setManualKind(ctx, u, ids, value);
  const n = ids.length;
  return value === 'auto' ? `已恢复自动判断（${n} 张）` : `已把 ${n} 张图标为「${KIND_LABEL[value]}」`;
}
