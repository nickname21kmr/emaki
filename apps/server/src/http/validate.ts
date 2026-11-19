import type { z } from 'zod';
import { BadRequestError } from './errors.ts';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    throw new BadRequestError(`参数错误：${first ? `${first.path.join('.') || '(root)'} ${first.message}` : '无效输入'}`);
  }
  return result.data;
}

// 请求参数的 schema 和查询串工具都在 shared（类型从它们推出来，前后端一份）
export { idParam, qBool, qNumber } from '@emaki/shared/schemas';
