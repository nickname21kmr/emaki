import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { config } from '../../config.ts';
import { defaultFetchLike, type FetchLike, type HttpResponse } from '../../net/http.ts';

export const PixivArtworkSchema = z.object({
  id: z.string(),
  pageCount: z.number().int().positive(),
  // 独立原创开关；作者也可能只通过 tags.tags 标记原创。
  isOriginal: z.boolean().optional(),
  tags: z.object({ tags: z.array(z.object({ tag: z.string().min(1), translation: z.record(z.string(), z.string()).optional() })) }),
});
export type PixivArtwork = z.infer<typeof PixivArtworkSchema>;

const ORIGINAL_TAGS = new Set(['オリジナル', '原创', '原創', 'original']);
/** Pixiv 的原创开关与原创标签独立；只认完整原文标签，不匹配包含关系或机器译名。 */
export function isOriginalArtwork(artwork: PixivArtwork): boolean {
  return artwork.isOriginal === true || artwork.tags.tags.some(
    ({ tag }) => ORIGINAL_TAGS.has(tag.normalize('NFKC').trim().toLowerCase()),
  );
}

export class PixivAccessError extends Error {}
/** Pixiv 对这一个投稿明确拒绝（400 这类 4xx、200+error）：重试同一投稿没用，跳过它接着查下一个。 */
export class PixivPostError extends Error {}

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
          headers: { Referer: 'https://www.pixiv.net/', 'User-Agent': `Emaki/${config.appVersion} (+${config.appRepoUrl})`, Accept: 'application/json' },
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
      if (response.status === 404) {
        // 只有 Pixiv 自己的 {error:true} 才算作品不存在；改版、网关等别的 404 按失败处理，保留队列
        let pixiv = false;
        try { pixiv = (JSON.parse(text) as { error?: unknown } | null)?.error === true; } catch { /* 不是 JSON */ }
        if (pixiv) return null;
        throw new Error('Pixiv 返回了无法识别的 404，保留队列以便重试');
      }
      if (response.status >= 500 && attempt < 2) {
        await sleep(1000 * 2 ** attempt, undefined, { signal });
        continue;
      }
      if (response.status >= 400 && response.status < 500) throw new PixivPostError(`Pixiv 拒绝了这个投稿（${response.status}）`);
      if (response.status !== 200) throw new Error(`Pixiv 请求失败（${response.status}）`);
      const envelope = z.object({ error: z.boolean(), body: z.unknown() }).parse(JSON.parse(text));
      // 200 + error 不能证明作品不存在，不进 404 缓存；按这个投稿被拒处理，手动补跑时重试。
      if (envelope.error) throw new PixivPostError('Pixiv 返回业务错误，手动补跑时重试');
      const body = PixivArtworkSchema.parse(envelope.body);
      if (body.id !== id) throw new Error('Pixiv 返回的作品 ID 不匹配');
      return body;
    }
  }
}
