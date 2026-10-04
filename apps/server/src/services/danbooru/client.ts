/**
 * Danbooru API 客户端：只用 GET；自定义 UA（默认 UA 会被 Cloudflare 拦）；串行限速；网络错误 / 429 / 5xx 退避重试；
 * Cloudflare 挑战立刻失败不重试。API key 只放 Authorization 头，不进 URL（会进日志）。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { z } from 'zod';
import { config } from '../../config.ts';
import { diagnose } from '../../net/diagnose.ts';
import { defaultFetchLike, type FetchLike, type HttpResponse } from '../../net/http.ts';
import { RateLimiter } from './rateLimiter.ts';
import {
  AliasSchema,
  ArtistSchema,
  AutocompleteSchema,
  RelatedSchema,
  TAG_ONLY,
  TagSchema,
  WikiSchema,
  type DbAlias,
  type DbArtist,
  type DbAutocomplete,
  type DbRelated,
  type DbTag,
  type DbWiki,
} from './types.ts';

export type DanbooruErrorKind = 'network' | 'blocked' | 'auth' | 'http' | 'parse';

export class DanbooruError extends Error {
  constructor(
    message: string,
    readonly kind: DanbooruErrorKind,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface DanbooruClientOptions {
  baseUrl?: string;
  login?: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  limiter?: RateLimiter;
  timeoutMs?: number;
  maxRetries?: number;
}

const BATCH = 100;

/** 名字里含逗号的标签不能放进 *_comma 参数 */
function splitComma(names: string[]): { batches: string[][]; singles: string[] } {
  const plain = [...new Set(names)].filter((n) => !n.includes(','));
  const singles = [...new Set(names)].filter((n) => n.includes(','));
  const batches: string[][] = [];
  for (let i = 0; i < plain.length; i += BATCH) batches.push(plain.slice(i, i + BATCH));
  return { batches, singles };
}

export class DanbooruClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly headers: Record<string, string>;

  constructor(o: DanbooruClientOptions = {}) {
    this.baseUrl = o.baseUrl ?? config.danbooruBaseUrl;
    this.fetchImpl = o.fetchImpl ?? defaultFetchLike;
    this.limiter = o.limiter ?? new RateLimiter();
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.maxRetries = o.maxRetries ?? 3;
    this.headers = {
      'User-Agent': `Emaki/${config.appVersion} (+${config.appRepoUrl})${o.login ? `; user ${o.login}` : ''}`,
      Accept: 'application/json',
      ...(o.login && o.apiKey ? { Authorization: `Basic ${Buffer.from(`${o.login}:${o.apiKey}`).toString('base64')}` } : {}),
    };
  }

  async request<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      await this.limiter.wait(signal);
      let res: HttpResponse;
      try {
        res = await this.fetchImpl(url.href, { headers: this.headers, signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) });
      } catch (err) {
        if (signal.aborted) throw err;
        if (attempt < this.maxRetries) {
          await sleep(2000 * 2 ** attempt, undefined, { signal });
          continue;
        }
        const { reason, hint } = diagnose(err, 'Danbooru');
        throw new DanbooruError(`${reason}，这次先用本地词库整理。${hint ? `${hint}。` : ''}设置 → Danbooru 里可以「检测网络」`, 'network');
      }
      // 先 text() 再解析：挑战页是 HTML，直接 json() 会抛语法错误
      const body = await res.text();
      if (res.status === 403 && (res.headers.get('cf-mitigated') === 'challenge' || body.includes('Just a moment'))) {
        throw new DanbooruError('被 Cloudflare 拦截：检查代理 / 换个网络 / 稍后再试', 'blocked', 403);
      }
      if (res.status === 401) throw new DanbooruError('Danbooru 用户名或 API Key 无效', 'auth', 401);
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(ra > 0 ? ra * 1000 : 2000 * 2 ** attempt, undefined, { signal });
        continue;
      }
      if (res.status !== 200) throw new DanbooruError(`Danbooru 返回 HTTP ${res.status}`, 'http', res.status);
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        throw new DanbooruError('Danbooru 返回的不是 JSON', 'parse');
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new DanbooruError(`Danbooru 响应格式变了：${parsed.error.message}`, 'parse');
      return parsed.data;
    }
  }

  async tagsByNames(names: string[], signal: AbortSignal): Promise<DbTag[]> {
    const { batches, singles } = splitComma(names);
    const out: DbTag[] = [];
    const schema = TagSchema.array();
    // 必须传 limit：不传默认只回 20 条且不报错
    for (const b of batches) {
      out.push(...(await this.request('/tags.json', { 'search[name_comma]': b.join(','), limit: String(b.length), only: TAG_ONLY }, schema, signal)));
    }
    for (const s of singles) out.push(...(await this.request('/tags.json', { 'search[name]': s, limit: '1', only: TAG_ONLY }, schema, signal)));
    return out;
  }

  async aliasesByAntecedents(names: string[], signal: AbortSignal): Promise<DbAlias[]> {
    const { batches } = splitComma(names);
    const out: DbAlias[] = [];
    for (const b of batches) {
      out.push(
        ...(await this.request(
          '/tag_aliases.json',
          { 'search[antecedent_name_comma]': b.join(','), 'search[status]': 'active', limit: String(b.length), only: 'antecedent_name,consequent_name' },
          AliasSchema.array(),
          signal,
        )),
      );
    }
    return out;
  }

  /** 画师资料（其他名字、社团、主页链接） */
  async artistsByNames(names: string[], signal: AbortSignal): Promise<DbArtist[]> {
    const { batches } = splitComma(names);
    const out: DbArtist[] = [];
    const only = 'name,other_names,group_name,is_deleted,urls[url,is_active]';
    for (const b of batches) {
      out.push(...(await this.request('/artists.json', { 'search[name_comma]': b.join(','), limit: String(b.length), only }, ArtistSchema.array(), signal)));
    }
    return out;
  }

  async wikiByTitles(titles: string[], signal: AbortSignal): Promise<DbWiki[]> {
    const { batches, singles } = splitComma(titles);
    const out: DbWiki[] = [];
    const only = 'title,other_names,is_deleted';
    for (const b of batches) {
      out.push(...(await this.request('/wiki_pages.json', { 'search[title_comma]': b.join(','), limit: String(b.length), only }, WikiSchema.array(), signal)));
    }
    for (const s of singles) out.push(...(await this.request('/wiki_pages.json', { 'search[title]': s, limit: '1', only }, WikiSchema.array(), signal)));
    return out;
  }

  relatedCopyrights(tag: string, signal: AbortSignal): Promise<DbRelated> {
    return this.request('/related_tag.json', { query: tag, category: 'copyright', limit: '10' }, RelatedSchema, signal);
  }

  autocomplete(query: string, signal: AbortSignal): Promise<DbAutocomplete[]> {
    return this.request('/autocomplete.json', { 'search[query]': query, 'search[type]': 'tag_query', limit: '10' }, AutocompleteSchema.array(), signal);
  }
}
