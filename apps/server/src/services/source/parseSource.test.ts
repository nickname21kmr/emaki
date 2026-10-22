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
    ['144506494_キス魔な山賊に襲われたミミちゃん４_3.jpg', pixiv('144506494')],
    ['downloads/144506494_标题_包含_下划线_12 (1).png', pixiv('144506494')],
    ['144506494_A summer day_0.jpg', pixiv('144506494')],
    ['144506494_标题里有98765432_p0_3.jpg', pixiv('144506494')],
    ['104714967_３人で奉仕.jpg', pixiv('104714967')],
    ['108301050_ヘルモルト姉妹丼　その３.jpg', pixiv('108301050')],
    ['144506494_标题.jpg', pixiv('144506494')],
    ['144506494_标题_12345.jpg', pixiv('144506494')],
    ['downloads/104714967_A title_with underscores (1).png', pixiv('104714967')],
    ['104714967_标题里有98765432_p0.jpg', pixiv('104714967')],
    ['102298332_master1200.jpg', pixiv('102298332')],
    ['illust_98765432_20240101_123456.jpg', pixiv('98765432')],
    ['sub/123456789_p0 (1).png', pixiv('123456789')],
    ['147888074-793357d9c084fa59acaba10b6b552ff7_p0.jpg', pixiv('147888074')],
    ['147194731-a43ba74e1434ae6ed317cb7671cc2574_p45.jpg', pixiv('147194731')],
    [`downloads/98765432-${MD5.toUpperCase()}_p12_master1200 (1).png`, pixiv('98765432')],
    [`98765432-${MD5}_ugoira0.jpg`, pixiv('98765432')],
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
    expect(parseSource(relPath, 'broad')).toEqual(expected);
  });

  it.each([
    `${MD5}.jpg`,
    'IMG_00012.png',
    '2024-01-01 123456.png',
    'wallpaper_1920x1080.png',
    'Screenshot_2024.png',
    '20250618_001222.jpg',
    '20250618_001222_3.jpg',
    '1280_1024_1(CUnet)(noise_scale)(Level2)(height 1440).png',
    '144506494__3.jpg',
    '1234567890123_标题_3.jpg',
    '1234567890123_标题.jpg',
    '104714967_12345.jpg',
    `144506494_${MD5}.jpg`,
    `144506494_${MD5}_3.jpg`,
    '144506494_p12345.jpg',
    '1234567890123_p0.png',
    `${MD5}_p0.jpg`,
    '147888074-793357d9c084fa59acaba10b6b5522574_p0.jpg',
    `1234567890123-${MD5}_p0.jpg`,
    `147888074-${MD5}_p12345.jpg`,
  ])('%s → null', (relPath) => {
    expect(parseSource(relPath, 'broad')).toBeNull();
  });

  it.each([
    '104714967_３人で奉仕.jpg',
    '108301050_ヘルモルト姉妹丼　その３.jpg',
    '144506494_标题_3.jpg',
    '104714967_标题里有98765432_p0.jpg',
    '104714967_Abcde.jpg',
    '102298332_master1200.jpg',
  ])('strict mode skips downloader title %s by default', (name) => {
    expect(parseSource(name)).toBeNull();
    expect(parseSource(name, 'broad')?.postId).toBe(name.split('_')[0]);
  });

  it.each(['98765432_p0.jpg', '98765432_ugoira.jpg', '98765432_ugoira0.jpg',
    `98765432-${MD5}_p0.png`, 'illust_98765432_20240101.jpg',
  ])('strict mode retains distinctive Pixiv filename %s', (name) => {
    expect(parseSource(name)).toEqual(pixiv('98765432'));
  });
});
