import { z } from 'zod';
import { BadRequestError } from '../http/errors.ts';
import { httpFetch } from '../net/http.ts';
import type { PrivateSettings } from './store.ts';

export const apiModelsInput = z.object({
  baseUrl: z.url().refine(v => /^https?:\/\//.test(v)),
  api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
  apiKey: z.string().max(10000).optional(),
});
const modelPage = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1).max(500), display_name: z.string().optional(), name: z.string().optional() })),
  has_more: z.boolean().optional(), last_id: z.string().optional(),
});

/** Read the draft connection without saving settings or restarting any conversation. */
export async function fetchApiModels(input: z.infer<typeof apiModelsInput>, saved: PrivateSettings) {
  const url = new URL(input.baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new BadRequestError('请填写 API 基础地址，密钥填在 API Key 中');
  let key = input.apiKey;
  if (key === undefined && saved.apiKey) {
    if (!saved.pi.baseUrl || new URL(saved.pi.baseUrl).origin !== url.origin) throw new BadRequestError('API 地址已更换，请填写对应的 API Key');
    key = saved.apiKey;
  }
  const basePath = url.pathname.replace(/\/+$/, '');
  if (/\/(responses|chat\/completions|messages|models)$/.test(basePath)) throw new BadRequestError('请填写 API 基础地址，例如 https://api.openai.com/v1');
  const anthropic = input.api === 'anthropic-messages';
  url.pathname = `${basePath}${anthropic && !basePath.endsWith('/v1') ? '/v1' : ''}/models`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (anthropic) headers['anthropic-version'] = '2023-06-01';
  if (key) headers[anthropic ? 'x-api-key' : 'Authorization'] = anthropic ? key : `Bearer ${key}`;
  if (anthropic) url.searchParams.set('limit', '100');
  const signal = AbortSignal.timeout(15000), models = new Map<string, { id: string; name: string }>();
  const cursors = new Set<string>();
  try {
    for (let page = 0; page < 20; page++) {
      // Local model servers do not need the application's outbound proxy.
      const fetcher = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? fetch : httpFetch;
      const response = await fetcher(url.href, { headers, signal, redirect: 'error' });
      if (response.status === 401 || response.status === 403) throw new BadRequestError('模型列表鉴权失败，请检查 API Key 和该服务的访问权限');
      if (response.status === 404 || response.status === 405) throw new BadRequestError('该地址未提供模型列表，请核对 API 基础地址，或手动填写模型 ID');
      if (response.status !== 200) throw new BadRequestError(`读取模型列表失败（HTTP ${response.status}），请稍后重试`);
      const parsed = modelPage.safeParse(JSON.parse(await response.text()));
      if (!parsed.success) throw new BadRequestError('服务返回的模型列表格式不兼容，可以手动填写模型 ID');
      for (const model of parsed.data.data) models.set(model.id, { id: model.id, name: model.display_name || model.name || model.id });
      if (!parsed.data.has_more) return [...models.values()];
      const cursor = parsed.data.last_id ?? parsed.data.data.at(-1)?.id;
      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor); url.searchParams.set('after_id', cursor);
    }
    throw new BadRequestError('模型列表分页未完成，请稍后重试或手动填写模型 ID');
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    // Upstream error bodies may contain credentials; keep them out of API responses.
    throw new BadRequestError(signal.aborted ? '读取模型列表超时，请检查连接后重试' : '无法读取模型列表，请检查地址、连接和服务是否支持模型列表');
  }
}
