/**
 * 前后端共用的展示规则（P5，附录 #27、#30、#38）。网页和服务端都调这些函数，规则只写一份。
 */
import { describe, expect, it } from 'vitest';
import type { ContentKind, Rating } from './domain.ts';
import {
  blurLabel,
  blurReason,
  bookBlurContext,
  collectionTitle,
  formatEta,
  isSensitive,
  normalizeExclusionTag,
  organizeFolderName,
  queueAfterKindChange,
  showcaseQuery,
  triageQueue,
  volumeUnit,
  type BlurPrefs,
  type TriageFacts,
} from './rules.ts';

const P: BlurPrefs = { blurSensitive: true, blurLevel: 'questionable', blurPhoto: true, blurText: false };
const s = (rating: Rating, extra: { kind?: ContentKind; rated?: boolean } = {}) => ({ rating, ...extra });

describe('能否不打码显示：一套判断，按场合分支（附录 #30）', () => {
  it('browse：没识别的图按存的分级（默认全年龄），不然刚导入的图满屏都是糊的', () => {
    expect(blurReason(s('general', { rated: false }), P)).toBeNull();
    expect(blurReason(s('questionable'), P)).toBe('rating');
    expect(blurReason(s('sensitive'), P)).toBeNull();
    expect(blurReason(s('general', { kind: 'photo' }), P)).toBe('photo');
  });

  it('cautious（本子的封面和页）：分级不可信就打码，角标写「未识别」', () => {
    expect(blurReason(s('general', { rated: false }), P, 'cautious')).toBe('unrated');
    expect(blurLabel('unrated', 'general')).toBe('未识别');
    expect(blurReason(s('general', { rated: true }), P, 'cautious')).toBeNull();
    expect(blurReason(s('explicit', { rated: true }), { ...P, blurLevel: 'explicit' }, 'cautious')).toBe('rating');
    expect(bookBlurContext('doujin')).toBe('cautious');
    expect(bookBlurContext('artbook')).toBe('browse');
    expect(bookBlurContext('group')).toBe('browse');
  });

  it('showcase（今日一枚、放映、书的底页）：开着模糊时只放分级可信的全年龄图，「轻微」也不放', () => {
    expect(blurReason(s('general', { rated: true }), P, 'showcase')).toBeNull();
    expect(blurReason(s('sensitive', { rated: true }), P, 'showcase')).toBe('rating');
    expect(blurReason(s('general', { rated: false }), P, 'showcase')).toBe('unrated');
    // 服务端挑图的条件和这个分支一致
    expect(showcaseQuery(true)).toEqual({ rating: ['general'], rated: true });
    expect(showcaseQuery(false)).toEqual({});
  });

  it('总开关关着：任何场合都不打码', () => {
    for (const c of ['browse', 'cautious', 'showcase'] as const) expect(blurReason(s('explicit', { rated: false, kind: 'photo' }), { ...P, blurSensitive: false }, c)).toBeNull();
  });

  it('敏感分级只有一份（服务端「没认出」的敏感主题也用它）', () => {
    expect((['general', 'sensitive', 'questionable', 'explicit'] as const).filter(isSensitive)).toEqual(['questionable', 'explicit']);
  });
});

describe('在哪个待处理队列（附录 #27）', () => {
  const base: TriageFacts = { kind: 'illustration', counted: true, characterCount: 0, original: false, shelved: false, inBook: false, inComicArea: false, comicInQueue: true };
  it.each([
    ['没认出的插画', {}, 'art'],
    ['放下的', { shelved: true }, 'shelved'],
    ['截图', { kind: 'screenshot' }, 'annex'],
    ['本子里的页', { inBook: true }, 'book'],
    ['漫画区的页', { kind: 'comic', inComicArea: true }, null],
    ['关掉漫画设置时的漫画', { kind: 'comic', comicInQueue: false }, null],
    ['开着漫画设置时的漫画', { kind: 'comic' }, 'art'],
    ['有角色', { characterCount: 2 }, null],
    ['原创', { original: true }, null],
    ['被排除', { counted: false }, null],
  ] as const)('%s', (_n, patch, want) => expect(triageQueue({ ...base, ...patch })).toBe(want));

  it('改类型之后：截图离开「插画 · 漫画」，漫画看设置（以前假定漫画一定留在队列）', () => {
    expect(queueAfterKindChange('art', 'screenshot', true)).toBe('annex');
    expect(queueAfterKindChange('art', 'comic', true)).toBe('art');
    expect(queueAfterKindChange('art', 'comic', false)).toBeNull();
    expect(queueAfterKindChange('shelved', 'illustration', true)).toBe('shelved');
    expect(queueAfterKindChange('annex', 'meme', true)).toBe('annex');
  });
});

describe('合集的显示、排除目标、剩余时间（附录 #38）', () => {
  it('话 / 册', () => {
    expect(volumeUnit('第3话')).toBe('话');
    expect(volumeUnit('第12話 出会い')).toBe('话');
    expect(volumeUnit('Chapter 7')).toBe('话');
    expect(volumeUnit('Vol.03')).toBe('册');
    expect(volumeUnit('某漫画')).toBe('册');
  });

  it('无题时的显示名只有一种写法', () => {
    expect(collectionTitle({ title: '标题', folderName: 'abc' })).toBe('标题');
    expect(collectionTitle({ title: null, folderName: '0123456789abcdef' })).toBe('无题 #012345');
    expect(collectionTitle({ title: null, folderName: '' })).toBe('无题');
    expect(collectionTitle({ title: null })).toBe('无题');
  });

  it('排除标签的归一化', () => expect(normalizeExclusionTag('  Some  Tag ')).toBe('some_tag'));

  it('组图整理的文件夹名', () => {
    expect(organizeFolderName('a?b*c')).toBe('a_b_c');
    expect(organizeFolderName('  ')).toBe('组图');
    expect(organizeFolderName('x'.repeat(80))).toHaveLength(70);
  });

  it('剩余时间的写法；不知道时 null', () => {
    expect(formatEta(42.2)).toBe('43 秒');
    expect(formatEta(600)).toBe('10 分钟');
    expect(formatEta(5400)).toBe('1.5 小时');
    expect(formatEta(null)).toBeNull();
    expect(formatEta(Infinity)).toBeNull();
  });
});
