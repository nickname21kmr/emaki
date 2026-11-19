/**
 * 演示数据灌入要完整（附录 #31：以前会丢掉合集、手动标记、否决、画师关联、各节设置、图库文件夹的导入方式）。
 * 在契约夹具上补齐所有可选字段，灌进真实引擎后从接口（必要时从表里）读回来。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { EventBus } from '../core/events.ts';
import { SqliteDataSource } from '../../test/helpers/client.ts';
import { buildContractDb } from '../../test/fixtures/contract-db.ts';
import { makeTmpDir } from '../../test/helpers/tmp.ts';
import type { DemoDb } from './fixtures.ts';
import { seedDemoDb, type IdMap } from './seed.ts';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW - days * DAY).toISOString();

/** 契约夹具 + 所有可选字段都填上 */
function fullDemo(): DemoDb {
  const demo = buildContractDb(NOW);
  const img = (id: string) => demo.images.get(id)!;
  // 手动分级、手动来源、否决、放下、原创、画师（手动）
  Object.assign(img('i2'), { ratingManual: true, rating: 'questionable' });
  Object.assign(img('i3'), { sourceManual: true, source: { site: 'pixiv', postId: '98785437', artist: 'Killy', url: 'https://www.pixiv.net/artworks/98785437' } });
  img('i26').vetoedCharacterIds = ['c1'];
  img('i27').shelvedAt = at(1);
  img('i28').originalAt = at(2);
  Object.assign(img('i4'), { artists: [{ tag: 'kantoku', score: 1 }], artistsManual: true });
  // 画师手动拆开 / 合并
  demo.artistLinks = new Map([
    ['kantoku', null],
    ['kantoku_(artist)', 'kantoku'],
  ]);
  // 角色：手动改过名、封面不是手动设的
  demo.characters.get('c1')!.nameLocked = true;
  demo.characters.get('c4')!.coverManual = false;
  // 图库文件夹：导入时间、按漫画导入、里面的漫画子文件夹
  const [r1, r2] = demo.settings.libraryRoots;
  Object.assign(r1!, { importedAt: at(200), comicFolders: [{ relDir: 'memes', comicRating: 'sensitive' }] });
  Object.assign(r2!, { importedAt: at(300), mode: 'comic', comicRating: 'questionable' });
  // 各节设置
  Object.assign(demo.settings.tagger, { autoAcceptThreshold: 0.9, comicInUnrecognized: false });
  Object.assign(demo.settings.danbooru, { enabled: true, username: 'demo', lastSyncAt: at(5) });
  Object.assign(demo.settings.dedupe, { hammingThreshold: 10, lastRunAt: at(1) });
  Object.assign(demo.settings.ui, { theme: 'dark' });
  demo.settings.browse = { customThemes: [{ id: 't1', name: '丝袜', tags: ['thighhighs'] }] };
  // 一个手选的合集：手动标题、封面、手动加的角色和作品；成员带页码
  demo.collections.set('col1', {
    id: 'col1',
    membership: 'selection',
    rootId: 'root1',
    relDir: '@selection/demo',
    kind: 'group',
    kindSource: 'manual',
    kindManual: true,
    title: '雨天组图',
    titleManual: true,
    event: null,
    circle: null,
    artist: null,
    parody: null,
    translator: null,
    seriesKey: null,
    volumeNo: null,
    seriesManual: false,
    pageOrder: 'name',
    coverImageId: 'i10',
    origin: 'manual',
    state: 'active',
    evidence: null,
    reviewedAt: at(1),
    createdAt: at(3),
    updatedAt: at(3),
    manualCharacterIds: ['c7'],
    manualWorkIds: ['w3'],
  });
  for (const [id, page] of [
    ['i9', 1],
    ['i10', 2],
    ['i11', 3],
  ] as const) Object.assign(img(id), { collectionId: 'col1', pageNo: page, collectionDetached: true });
  return demo;
}

let ds: SqliteDataSource;
let map: IdMap;
let dir: string;
beforeEach(async () => {
  dir = makeTmpDir('demo-seed');
  ds = await SqliteDataSource.open(new EventBus(), dir, {
    memory: true,
    clock: () => NOW,
    autoJobs: false,
    importDict: false,
    seed: (db) => {
      map = seedDemoDb(db, fullDemo(), { now: NOW });
    },
  });
});
afterEach(async () => {
  await ds.close();
  rmSync(dir, { recursive: true, force: true });
});
const id = (kind: keyof IdMap, key: string) => String(map[kind].get(key));
const db = () => ds.ctx.db;

it('图库文件夹：导入时间、导入方式、漫画子文件夹', async () => {
  const roots = (await ds.getSettings()).libraryRoots;
  expect(roots.map((r) => ({ path: r.path, importedAt: r.importedAt, mode: r.mode, comicRating: r.comicRating, comicFolders: r.comicFolders }))).toEqual([
    { path: 'D:/Pics', importedAt: at(200), mode: 'auto', comicRating: 'general', comicFolders: [{ relDir: 'memes', comicRating: 'sensitive' }] },
    { path: 'E:/Old', importedAt: at(300), mode: 'comic', comicRating: 'questionable', comicFolders: [] },
  ]);
});

it('各节设置', async () => {
  const s = await ds.getSettings();
  expect(s.tagger).toMatchObject({ autoAcceptThreshold: 0.9, comicInUnrecognized: false });
  expect(s.danbooru).toEqual({ enabled: true, username: 'demo', lastSyncAt: at(5), hasApiKey: false });
  expect(s.dedupe).toEqual({ hammingThreshold: 10, lastRunAt: at(1) });
  expect(s.ui.theme).toBe('dark');
  expect(s.browse.customThemes).toEqual([{ id: 't1', name: '丝袜', tags: ['thighhighs'] }]);
});

it('合集：成员、页码、标题、封面、手动加的角色和作品，经过启动时的合集重算还在', async () => {
  const cid = id('collections', 'col1');
  const c = (await ds.getCollection(cid))!;
  expect(c.collection).toMatchObject({ kind: 'group', title: '雨天组图', membership: 'selection', origin: 'manual', pageCount: 3 });
  expect(c.pages.map((p) => [p.imageId, p.pageNo])).toEqual([
    [id('images', 'i9'), 1],
    [id('images', 'i10'), 2],
    [id('images', 'i11'), 3],
  ]);
  expect(c.collection.covers[0]?.imageId).toBe(id('images', 'i10'));
  expect(db().prepare('SELECT character_id FROM collection_characters WHERE collection_id = ?').pluck().all(Number(cid))).toEqual([
    Number(id('characters', 'c7')),
  ]);
  expect(db().prepare('SELECT work_id FROM collection_works WHERE collection_id = ?').pluck().all(Number(cid))).toEqual([Number(id('works', 'w3'))]);
  expect(db().prepare('SELECT collection_detached FROM images WHERE id = ?').pluck().get(Number(id('images', 'i9')))).toBe(1);
});

it('手动标记：分级、来源、放下、原创、画师', async () => {
  const i2 = (await ds.getImage(id('images', 'i2')))!;
  expect(i2.rating).toBe('questionable');
  expect(db().prepare('SELECT rating_manual FROM images WHERE id = ?').pluck().get(Number(i2.id))).toBe(1);
  expect(await ds.getImage(id('images', 'i3'))).toMatchObject({ sourceManual: true, source: { site: 'pixiv', postId: '98785437', artist: 'Killy' } });
  const stats = await ds.getStats();
  expect(stats.shelvedCount).toBe(1);
  expect(stats.originalCount).toBe(1);
  expect((await ds.getImage(id('images', 'i28')))!.original).toBe(true);
  expect((await ds.listImages({ workId: stats.originalWorkId! })).items.map((x) => x.id)).toEqual([id('images', 'i28')]);
  expect(await ds.getImage(id('images', 'i4'))).toMatchObject({ artistsManual: true, artists: [expect.objectContaining({ tag: 'kantoku' })] });
});

it('否决：去掉过的角色不会被补采纳加回', async () => {
  // i26 的 mika 建议 0.7；阈值调到 0.65 后本来能归，但用户去掉过 c1
  await ds.updateSettings({ tagger: { autoAcceptThreshold: 0.65 } });
  expect((await ds.promotableSuggestions()).images).toBe(0);
  expect(db().prepare('SELECT COUNT(*) FROM character_vetoes').pluck().get()).toBe(1);
});

it('画师的手动拆开、合并', () => {
  expect(db().prepare('SELECT tag, group_tag FROM artist_links ORDER BY tag').all()).toEqual([
    { tag: 'kantoku', group_tag: null },
    { tag: 'kantoku_(artist)', group_tag: 'kantoku' },
  ]);
});

it('角色：手动改过的名字锁住；没手动设的封面交给自动选图', () => {
  const row = (c: string) => db().prepare('SELECT name_locked, cover_manual FROM characters WHERE id = ?').get(Number(id('characters', c)));
  expect(row('c1')).toEqual({ name_locked: 1, cover_manual: 1 });
  expect(row('c4')).toEqual({ name_locked: 0, cover_manual: 0 });
});
