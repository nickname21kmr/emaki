/** 把请求里的 id 换成库里的整数 id，不存在就 NotFoundError。各模块共用 */
import type { ID } from '@emaki/shared';
import { NotFoundError } from '../../http/errors.ts';
import type { SqliteContext } from './context.ts';
import { parseId } from './sql.ts';

/** 可见的图（在 v_images 里，包括被排除的）；有一张不可见或不存在就 NotFoundError('图片') */
export function requireVisibleImages(ctx: SqliteContext, ids: ID[]): number[] {
  const nums = ids.map(parseId);
  if (nums.some((n) => n === null)) throw new NotFoundError('图片');
  const found = new Set(
    ctx.db
      .prepare('SELECT id FROM v_images WHERE id IN (SELECT value FROM json_each(?))')
      .pluck()
      .all(JSON.stringify(nums)) as number[],
  );
  if (nums.some((n) => !found.has(n!))) throw new NotFoundError('图片');
  return nums as number[];
}

export function requireCharacterId(ctx: SqliteContext, id: ID): number {
  const n = parseId(id);
  if (n === null || !ctx.stmt('SELECT 1 FROM characters WHERE id = ?').get(n)) throw new NotFoundError('角色');
  return n;
}
