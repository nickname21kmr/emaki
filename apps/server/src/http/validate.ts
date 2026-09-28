import { z } from 'zod';
import { BadRequestError } from './errors.ts';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    throw new BadRequestError(`参数错误：${first ? `${first.path.join('.') || '(root)'} ${first.message}` : '无效输入'}`);
  }
  return result.data;
}

/** 查询串里的数字 */
export const qNumber = z.coerce.number().int();
/** 查询串里的布尔值：true/false/1/0 */
export const qBool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');
/** 查询串里逗号分隔的列表：rating=general,sensitive */
export const qList = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(item));

export const idParam = z.object({ id: z.string().min(1) });

export const ratingSchema = z.enum(['general', 'sensitive', 'questionable', 'explicit']);

export const kindSchema = z.enum(['illustration', 'comic', 'screenshot', 'text', 'photo', 'meme', 'animated']);
/** 查询串里的类型：kind=all 或 kind=comic,screenshot；有未知值返回 400 */
export const qKinds = z.union([z.literal('all'), qList(kindSchema)]);
