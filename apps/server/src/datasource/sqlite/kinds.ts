/**
 * 手动改内容类型（T27 第 9 条）：命令 curation.setKind（单张、批量同一个命令，P6）。
 * - 设成某一类：manual=1（归类模块的标记）、source='manual'，自动判断永远不覆盖；
 * - 'auto'：清掉 manual，按规则当场重算（查这张图的标签）；
 * - 最终类型变了就声明 image.kindChanged：自动关联由反应 reevaluateAuto 按新类型重新评估（和自动改类型同一条路，附录 #3）。
 * 全部可撤销。
 */
import { KIND_LABEL, type ContentKind } from '@emaki/shared';
import { setManualKind } from '../../domain/analysis/analyze.ts';
import { setKindManual } from '../../domain/curation/kinds.ts';
import type { SqliteContext } from './context.ts';
import type { UndoRecorder } from './undo.ts';

/** 类型名在 packages/shared（KIND_LABEL），和网页同一份 */
export { KIND_LABEL };

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
