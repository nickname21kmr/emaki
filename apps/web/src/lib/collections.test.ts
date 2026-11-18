import type { CollectionSummary } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import {
  compareGroups,
  displayTitle,
  PICKER_LIMIT,
  pickerGroups,
  POSTS_INLINE,
  shelfPlan,
  shouldCloth,
  showUnderPage,
  toShelfUnits,
  unitWord,
} from './collections';

const book = (id: string, pageCount: number, extra: Partial<CollectionSummary> = {}) =>
  ({ id, title: '示例连载', pageCount, seriesKey: null, volumeNo: null, ...extra }) as CollectionSummary;

const ids = (list: CollectionSummary[], opts?: { keepOrder?: boolean }) =>
  toShelfUnits(list, opts).map((u) => (u.type === 'single' ? u.c.id : `s:${u.key}`));

it('书架默认按页数从多到少', () => {
  expect(ids([book('a', 16), book('b', 18)])).toEqual(['b', 'a']);
});

it('keepOrder：系列页按第几话排好的顺序不被页数打乱', () => {
  const vols = [book('col2', 16, { volumeNo: 1 }), book('col3', 18, { volumeNo: 2 }), book('col4', 30, { volumeNo: 3 })];
  expect(ids(vols, { keepOrder: true })).toEqual(['col2', 'col3', 'col4']);
});

it('同一系列 ≥ 2 本合成一张系列卡，卷内按第几话', () => {
  const units = toShelfUnits([
    book('v2', 18, { seriesKey: 'S', volumeNo: 2 }),
    book('v1', 16, { seriesKey: 'S', volumeNo: 1 }),
    book('x', 5, { title: '别的' }),
  ]);
  expect(units[0]).toMatchObject({ type: 'series', key: 'S' });
  expect(units[0]!.type === 'series' && units[0]!.items.map((c) => c.id)).toEqual(['v1', 'v2']);
});

const PREFS = { blurSensitive: true, blurLevel: 'questionable', blurPhoto: true, blurText: false } as const;
const cover = (rating: CollectionSummary['covers'][number]['rating']) => ({ imageId: '1', rating, color: null, focus: null });

describe('合集的显示（共用规则，附录 #30、#38）', () => {
  it('布面：本子封面没识别过（分级不可信）换布面，画集不看识别', () => {
    expect(shouldCloth({ kind: 'doujin', coverTagged: false, covers: [cover('general')] }, PREFS)).toBe(true);
    expect(shouldCloth({ kind: 'doujin', coverTagged: true, covers: [cover('general')] }, PREFS)).toBe(false);
    expect(shouldCloth({ kind: 'artbook', coverTagged: false, covers: [cover('general')] }, PREFS)).toBe(false);
    expect(shouldCloth({ kind: 'artbook', coverTagged: true, covers: [cover('explicit')] }, PREFS)).toBe(true);
    expect(shouldCloth({ kind: 'artbook', coverTagged: true, covers: [] }, PREFS)).toBe(true);
    expect(shouldCloth({ kind: 'doujin', coverTagged: false, covers: [] }, { ...PREFS, blurSensitive: false })).toBe(false);
  });
  it('底页：开着模糊时只露识别过的全年龄页', () => {
    expect(showUnderPage({ coverTagged: true }, { rating: 'general' }, PREFS)).toBe(true);
    expect(showUnderPage({ coverTagged: true }, { rating: 'sensitive' }, PREFS)).toBe(false);
    expect(showUnderPage({ coverTagged: false }, { rating: 'general' }, PREFS)).toBe(false);
    expect(showUnderPage({ coverTagged: false }, { rating: 'explicit' }, { ...PREFS, blurSensitive: false })).toBe(true);
  });
  it('话 / 册、无题', () => {
    expect(unitWord([{ folderName: 'Vol.1' }, { folderName: '第2话' }])).toBe('话');
    expect(unitWord([{ folderName: 'Vol.1' }])).toBe('册');
    expect(displayTitle({ title: null, folderName: 'deadbeef00' })).toBe('无题 #deadbe');
  });
});

describe('合集页拉哪几份列表（大库上同一投稿的组图有几千组，不再一次全拉）', () => {
  it('「全部」：同一投稿的超过 POSTS_INLINE 组收成一行、不拉；点「显示」才拉', () => {
    expect(POSTS_INLINE).toBe(12);
    expect(shelfPlan(null, 3509, false)).toEqual({ books: true, groups: true, posts: false, fetchPosts: false, folded: true });
    expect(shelfPlan(null, 13, false)).toMatchObject({ posts: false, folded: true });
    expect(shelfPlan(null, 3509, true)).toEqual({ books: true, groups: true, posts: true, fetchPosts: true, folded: false });
  });
  it('「全部」：不超过 POSTS_INLINE 组照样摆出来（多拉一次）；没有就不拉；数目还没回来先不拉', () => {
    expect(shelfPlan(null, 12, false)).toEqual({ books: true, groups: true, posts: true, fetchPosts: true, folded: false });
    expect(shelfPlan(null, 1, false)).toMatchObject({ posts: true, folded: false });
    expect(shelfPlan(null, 0, false)).toMatchObject({ posts: false, fetchPosts: false, folded: false });
    expect(shelfPlan(null, undefined, false)).toMatchObject({ books: true, groups: true, posts: false, folded: false });
  });
  it('数目还是上一次搜索的：照旧显示上一次的结果，但先不发请求（刚清空搜索框时不会照旧的数目把几千组拉回来）', () => {
    expect(shelfPlan(null, 5, false, false)).toMatchObject({ posts: true, fetchPosts: false });
    expect(shelfPlan(null, 5, true, false)).toMatchObject({ posts: true, fetchPosts: true });
  });
  it('「组图」拉手动收集的和同一投稿的；「本子」「画集」只拉本子、画集；「画师」都不拉', () => {
    for (const n of [0, 5, 3509]) {
      expect(shelfPlan('group', n, false)).toEqual({ books: false, groups: true, posts: true, fetchPosts: true, folded: false });
      expect(shelfPlan('doujin', n, false)).toEqual({ books: true, groups: false, posts: false, fetchPosts: false, folded: false });
      expect(shelfPlan('artbook', n, true)).toMatchObject({ books: true, groups: false, posts: false });
      expect(shelfPlan('artist', n, true)).toEqual({ books: false, groups: false, posts: false, fetchPosts: false, folded: false });
    }
  });
});

describe('组图的顺序、「收进组图」弹窗的候选', () => {
  const group = (id: string, membership: CollectionSummary['membership'], lastAddedAt: string) =>
    ({ id, kind: 'group', membership, lastAddedAt, title: id, pageCount: 2, seriesKey: null }) as CollectionSummary;
  it('手动收集的在前，再按最近加图', () => {
    const list = [group('p1', 'post', '2026-11-03'), group('m1', 'selection', '2026-11-01'), group('f1', 'folder', '2026-11-02')];
    expect([...list].sort(compareGroups).map((c) => c.id)).toEqual(['f1', 'm1', 'p1']);
  });
  it('两份请求合起来取前 50 组、不列当前所在的组图；手动收集的多到 50 组时同一投稿的排不进来', () => {
    const at = (i: number) => `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
    const manual = Array.from({ length: 3 }, (_, i) => group(`m${i}`, 'selection', at(i)));
    const posts = Array.from({ length: PICKER_LIMIT + 1 }, (_, i) => group(`p${i}`, 'post', at(i + 3)));
    const picked = pickerGroups(manual, posts, 'm1');
    expect(picked).toHaveLength(PICKER_LIMIT);
    expect(picked.slice(0, 2).map((c) => c.id)).toEqual(['m2', 'm0']);
    expect(picked.some((c) => c.id === 'm1')).toBe(false);
    expect(picked.slice(2).every((c) => c.membership === 'post')).toBe(true);
    const many = Array.from({ length: PICKER_LIMIT + 1 }, (_, i) => group(`m${i}`, 'selection', at(i)));
    expect(pickerGroups(many, posts).every((c) => c.membership === 'selection')).toBe(true);
    expect(pickerGroups([], [])).toEqual([]);
  });
});
