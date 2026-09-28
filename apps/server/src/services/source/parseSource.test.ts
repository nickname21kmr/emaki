import { describe, expect, it } from 'vitest';
import { parseSource } from './parseSource.ts';

const MD5 = '0123456789abcdef0123456789abcdef';
const pixiv = (postId: string, artist?: string) => ({
  site: 'pixiv',
  postId,
  url: `https://www.pixiv.net/artworks/${postId}`,
  ...(artist ? { artist } : {}),
});

describe('parseSource', () => {
  it.each([
    ['pixiv/123456789_p0.png', pixiv('123456789')],
    ['pixiv/98765432 someuser/98765432_p0.jpg', pixiv('98765432', 'someuser')],
    ['PixivUtil/絵師名 (1234567)/98765432_p0 - タイトル.png', pixiv('98765432', '絵師名')],
    ['98765432_p0_master1200.jpg', pixiv('98765432')],
    ['98765432_ugoira0.jpg', pixiv('98765432')],
    ['illust_98765432_20240101_123456.jpg', pixiv('98765432')],
    ['sub/123456789_p0 (1).png', pixiv('123456789')],
    [
      'twitter/someartist/1789012345678901234_1.jpg',
      { site: 'twitter', postId: '1789012345678901234', artist: 'someartist', url: 'https://x.com/someartist/status/1789012345678901234' },
    ],
    ['downloads/1789012345678901234_2.png', { site: 'twitter', postId: '1789012345678901234', url: 'https://x.com/i/status/1789012345678901234' }],
    [
      'someartist-1789012345678901234-20250101_120000-img1.jpg',
      { site: 'twitter', artist: 'someartist', postId: '1789012345678901234', url: 'https://x.com/someartist/status/1789012345678901234' },
    ],
    ['GJnJQvHbwAAoY3S.jpg_large', { site: 'twitter' }],
    ['GJnJQvHbwAAoY3S (1).jpg', { site: 'twitter' }],
    [
      `__hatsune_miku_vocaloid_drawn_by_foo_bar__${MD5}.jpg`,
      { site: 'danbooru', artist: 'foo_bar', url: `https://danbooru.donmai.us/posts?md5=${MD5}` },
    ],
    [`__original__sample-${MD5}.jpg`, { site: 'danbooru', url: `https://danbooru.donmai.us/posts?md5=${MD5}` }],
    [`danbooru_7654321_${MD5}.png`, { site: 'danbooru', postId: '7654321', url: 'https://danbooru.donmai.us/posts/7654321' }],
    [`yandere_1027894_${MD5}.jpg`, { site: 'other', postId: '1027894', url: 'https://yande.re/post/show/1027894' }],
    ['yande.re 1027894 animal_ears dress.jpg', { site: 'other', postId: '1027894', url: 'https://yande.re/post/show/1027894' }],
    ['Konachan.com - 312345 blue_eyes.jpg', { site: 'other', postId: '312345', url: 'https://konachan.com/post/show/312345' }],
    [
      `gelbooru_9876543_${MD5}.jpg`,
      { site: 'other', postId: '9876543', url: 'https://gelbooru.com/index.php?page=post&s=view&id=9876543' },
    ],
    [
      'fanbox/creator123/5123456_1.png',
      { site: 'fanbox', postId: '5123456', artist: 'creator123', url: 'https://creator123.fanbox.cc/posts/5123456' },
    ],
  ])('%s', (relPath, expected) => {
    expect(parseSource(relPath)).toEqual(expected);
  });

  it.each([
    `${MD5}.jpg`,
    'IMG_00012.png',
    '2024-01-01 123456.png',
    'wallpaper_1920x1080.png',
    'Screenshot_2024.png',
    '1234567890123_p0.png',
  ])('%s → null', (relPath) => {
    expect(parseSource(relPath)).toBeNull();
  });
});
