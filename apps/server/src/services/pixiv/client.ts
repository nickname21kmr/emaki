import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { defaultFetchLike, type FetchLike, type HttpResponse } from '../../net/http.ts';

export const PixivArtworkSchema = z.object({
  id: z.string(),
  pageCount: z.number().int().positive(),
  // 页面“原创”标记是独立字段，不在 tags.tags 中。
  isOriginal: z.boolean().optional(),
  tags: z.object({ tags: z.array(z.object({ tag: z.string().min(1), translation: z.record(z.string(), z.string()).optional() })) }),
});
export type PixivArtwork = z.infer<typeof PixivArtworkSchema>;

export class PixivAccessError extends Error {}

/** 只读公开作品元数据；沿用应用代理。删除、私密作品跳过，访问受限时停止整批。 */
export class PixivClient {
  constructor(private readonly fetchImpl: FetchLike = defaultFetchLike) {}

  async artwork(id: string, signal: AbortSignal): Promise<PixivArtwork | null> {
    if (!/^\d{1,12}$/.test(id)) throw new Error('无效的 Pixiv 作品 ID');
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response: HttpResponse;
      let text: string;
      try {
        response = await this.fetchImpl(`https://www.pixiv.net/ajax/illust/${id}`, {
          headers: { Referer: 'https://www.pixiv.net/', 'User-Agent': 'Emaki', Accept: 'application/json' },
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
        text = await response.text();
      } catch (error) {
        // 连接、超时和响应体中途断开共用重试预算；用户取消立即退出。
        signal.throwIfAborted();
        if (attempt >= 2) throw error;
        await sleep(1000 * 2 ** attempt, undefined, { signal });
        continue;
      }
      signal.throwIfAborted();
      if ([401, 403, 429].includes(response.status)) throw new PixivAccessError(`Pixiv 访问受限（${response.status}），请稍后重试`);
      if (response.status === 404) return null;
      if (response.status >= 500 && attempt < 2) {
        await sleep(1000 * 2 ** attempt, undefined, { signal });
        continue;
      }
      if (response.status !== 200) throw new Error(`Pixiv 请求失败（${response.status}）`);
      const envelope = z.object({ error: z.boolean(), body: z.unknown() }).parse(JSON.parse(text));
      // 200 + error 不能证明作品不存在，保留为可重试失败；只有明确 404 返回 null。
      if (envelope.error) throw new Error('Pixiv 返回业务错误，保留队列以便重试');
      const body = PixivArtworkSchema.parse(envelope.body);
      if (body.id !== id) throw new Error('Pixiv 返回的作品 ID 不匹配');
      return body;
    }
  }
}
