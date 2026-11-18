import type { CollectionSummary } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { displayTitle, shouldCloth, showUnderPage, toShelfUnits, unitWord } from './collections';

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
