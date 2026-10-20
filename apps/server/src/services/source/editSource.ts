import type { ImageSource, UpdateImageBody } from '@emaki/shared';
import { z } from 'zod';
import { parse } from '../../http/validate.ts';
import { parseSource } from './parseSource.ts';

export const sourceEditSchema = z.union([
  z.object({
    url: z.string().trim().min(1).max(4000).refine(value => {
      try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }
      catch { return false; }
    }, '请输入不含登录凭证的 HTTP 或 HTTPS 来源链接'),
    artist: z.string().trim().max(200).optional(),
  }), z.null(), z.literal('auto'),
]);

/** Metadata only: saving a URL never makes a network request. */
export function editedSource(value: NonNullable<UpdateImageBody['source']> | null, relPath: string): { source: ImageSource | null; manual: boolean } {
  const { source: edit } = parse(z.object({ source: sourceEditSchema }), { source: value });
  if (edit === 'auto') return { source: parseSource(relPath), manual: false };
  if (edit === null) return { source: null, manual: true };
  const u = new URL(edit.url), host = u.hostname.toLowerCase();
  let site: ImageSource['site'] = 'other', postId: string | undefined;
  if (host === 'pixiv.net' || host === 'www.pixiv.net') {
    site = 'pixiv'; postId = /^\/(?:[a-z]{2}\/)?artworks\/(\d+)\/?$/.exec(u.pathname)?.[1];
    if (u.pathname === '/member_illust.php' && /^\d+$/.test(u.searchParams.get('illust_id') ?? '')) postId = u.searchParams.get('illust_id')!;
  } else if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(host)) {
    site = 'twitter'; postId = /\/(?:status|statuses)\/(\d+)(?:\/|$)/.exec(u.pathname)?.[1];
  } else if (host === 'danbooru.donmai.us') {
    site = 'danbooru'; postId = /^\/posts\/(\d+)\/?$/.exec(u.pathname)?.[1];
  } else if (host === 'fanbox.cc' || host.endsWith('.fanbox.cc')) {
    site = 'fanbox'; postId = /\/posts\/(\d+)\/?$/.exec(u.pathname)?.[1];
  }
  return { manual: true, source: { site, url: site === 'pixiv' && postId ? `https://www.pixiv.net/artworks/${postId}` : u.href,
    ...(postId ? { postId } : {}), ...(edit.artist ? { artist: edit.artist } : {}) } };
}
