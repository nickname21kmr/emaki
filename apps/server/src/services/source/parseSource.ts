/**
 * 从文件名（必要时参考父目录名）推断图片来源。纯函数，扫描器插入 / 移动图片时调用。
 * 改了规则就把 SOURCE_PARSER_VERSION 加 1，启动时 backfillSources 会重算全部行。
 */
import type { ImageSource } from '@emaki/shared';

export const SOURCE_PARSER_VERSION = 1;

const EXT = /\.[^.]+$/; // 包括 .jpg_large
const COPY_SUFFIX = /(\s*\(\d+\)|\s*-\s*(副本|复制|copy)(\s*\(\d+\))?)$/i;

const DANBOORU_DL = /^__(.+?)__(?:sample-)?([0-9a-f]{32})$/i;
const DRAWN_BY = /_drawn_by_(.+)$/; // 作者标签本身可能带下划线，取后面全部
const GDL_BOORU = /^(danbooru|gelbooru|safebooru|yandere|konachan)_(\d+)_[0-9a-f]{32}$/i;
const YANDERE_DL = /^yande\.re (\d+)(?: |$)/i;
const KONACHAN_DL = /^Konachan\.com - (\d+)(?: |$)/i;
const TMD = /^([A-Za-z0-9_]{1,15})-(\d{15,20})-\d{8}_\d{6}-(?:img|vid|gif)\d+$/;
const GDL_TWITTER = /^(\d{15,20})_(\d{1,2})$/;
const GDL_FANBOX = /^(\d{4,9})_(\d{1,3})$/;
// 不用 \b：下划线是单词字符
const PIXIV = /(?<!\d)(\d{4,10})_(?:p\d{1,4}|ugoira\d*)(?!\d)/;
const PIXIV_APP = /^illust_(\d{4,10})(?:_|$)/i;
const PIXIVUTIL_DIR = /^(.+) \((\d+)\)$/;
const GDL_PIXIV_DIR = /^(\d+) (.+)$/;
const TWITTER_MEDIA = /^[A-Za-z0-9_-]{15}$/;
const NOT_TWITTER_MEDIA = /^[A-Za-z]+[_-]?\d+$/; // Screenshot_2024 之类

const BOORU_URL: Record<string, string> = {
  yandere: 'https://yande.re/post/show/',
  konachan: 'https://konachan.com/post/show/',
  gelbooru: 'https://gelbooru.com/index.php?page=post&s=view&id=',
  safebooru: 'https://safebooru.org/index.php?page=post&s=view&id=',
};

const withArtist = (artist: string | undefined) => (artist ? { artist } : {});

/** relPath 用正斜杠，包含目录（目录名是作者名的线索） */
export function parseSource(relPath: string): ImageSource | null {
  const parts = relPath.split('/');
  const base = parts.at(-1)!;
  const dirs = parts.slice(0, -1);
  const lowerDirs = dirs.map((d) => d.toLowerCase());
  const parent = dirs.at(-1) ?? '';
  const grandparent = lowerDirs.at(-2);
  const stem = base.replace(EXT, '').replace(COPY_SUFFIX, '');

  // 1. Danbooru 站内下载名
  let m = DANBOORU_DL.exec(stem);
  if (m) {
    const artist = DRAWN_BY.exec(m[1]!)?.[1];
    return { site: 'danbooru', ...withArtist(artist), url: `https://danbooru.donmai.us/posts?md5=${m[2]!.toLowerCase()}` };
  }

  // 2. gallery-dl 的 booru 格式
  m = GDL_BOORU.exec(stem);
  if (m) {
    const site = m[1]!.toLowerCase();
    const postId = m[2]!;
    if (site === 'danbooru') return { site: 'danbooru', postId, url: `https://danbooru.donmai.us/posts/${postId}` };
    return { site: 'other', postId, url: BOORU_URL[site] + postId };
  }

  // 3. yande.re / Konachan 站内下载名
  m = YANDERE_DL.exec(stem);
  if (m) return { site: 'other', postId: m[1]!, url: BOORU_URL.yandere + m[1]! };
  m = KONACHAN_DL.exec(stem);
  if (m) return { site: 'other', postId: m[1]!, url: BOORU_URL.konachan + m[1]! };

  // 4. Twitter Media Downloader
  m = TMD.exec(stem);
  if (m) return { site: 'twitter', artist: m[1]!, postId: m[2]!, url: `https://x.com/${m[1]!}/status/${m[2]!}` };

  // 5. gallery-dl twitter：目录 twitter/{user}
  m = GDL_TWITTER.exec(stem);
  if (m) {
    const postId = m[1]!;
    const artist = grandparent === 'twitter' || grandparent === 'x' ? parent : undefined;
    return {
      site: 'twitter',
      postId,
      ...withArtist(artist),
      url: artist ? `https://x.com/${artist}/status/${postId}` : `https://x.com/i/status/${postId}`,
    };
  }

  // 6. gallery-dl fanbox：目录 fanbox/{creatorId}
  if (grandparent === 'fanbox') {
    m = GDL_FANBOX.exec(stem);
    if (m) return { site: 'fanbox', postId: m[1]!, artist: parent, url: `https://${parent}.fanbox.cc/posts/${m[1]!}` };
  }

  // 7 / 8. pixiv 原图名、手机 App 保存名
  m = PIXIV.exec(stem) ?? PIXIV_APP.exec(stem);
  if (m) {
    const postId = m[1]!;
    const artist =
      PIXIVUTIL_DIR.exec(parent)?.[1] ?? (grandparent === 'pixiv' ? GDL_PIXIV_DIR.exec(parent)?.[2] : undefined);
    return { site: 'pixiv', postId, url: `https://www.pixiv.net/artworks/${postId}`, ...withArtist(artist) };
  }

  // 9. 推特媒体原名（低置信度）
  if (TWITTER_MEDIA.test(stem) && /[A-Z]/.test(stem) && /[a-z]/.test(stem) && !NOT_TWITTER_MEDIA.test(stem)) {
    return { site: 'twitter' };
  }

  return null;
}
