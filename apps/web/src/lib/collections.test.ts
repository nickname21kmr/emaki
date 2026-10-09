import type { CollectionSummary } from '@emaki/shared';
import { expect, it } from 'vitest';
import { toShelfUnits } from './collections';

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
