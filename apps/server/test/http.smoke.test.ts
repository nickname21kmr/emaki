/**
 * T24 第 9 步：HTTP 冒烟。buildApp(MockDataSource) + app.inject，每个路由请求一次，断言状态码与 JSON 结构，
 * 确认路由、zod 校验、错误处理接线正确。数据用契约夹具（固定 NOW，id 是 i1 / c1 / w1 这种 mock id）。
 * 最后一条用例从 src/app.ts、src/routes/*.ts 里扫出全部路由，确保这里每个都测到了（新增路由忘了补冒烟会失败）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { EventBus } from '../src/core/events.ts';
import { MockDataSource } from '../src/datasource/mock/MockDataSource.ts';
import { NOW } from './contract/harness.ts';
import { buildContractDb } from './fixtures/contract-db.ts';

// 真实实现会弹出 Windows 的选择文件夹对话框，测试里换成固定返回值
vi.mock('../src/system/pickFolder.ts', () => ({ pickFolder: async () => 'D:/Picked' }));
// 检测网络会真的联网
vi.mock('../src/net/check.ts', () => ({
  checkNetwork: async () => ({ proxy: { url: null, source: null, note: null }, targets: [], summary: '测试' }),
}));

const SRC = path.resolve(import.meta.dirname, '../src');
const prevLogLevel = process.env.EMAKI_LOG_LEVEL;
process.env.EMAKI_LOG_LEVEL = 'silent';
afterAll(() => {
  if (prevLogLevel === undefined) delete process.env.EMAKI_LOG_LEVEL;
  else process.env.EMAKI_LOG_LEVEL = prevLogLevel;
});

let app: FastifyInstance;
let ds: MockDataSource;
let bus: EventBus;
beforeEach(async () => {
  bus = new EventBus();
  ds = new MockDataSource(bus, { db: buildContractDb(NOW), now: NOW });
  app = await buildApp(ds, bus);
});
afterEach(async () => {
  // 别让模拟的后台任务在用例之间继续跑
  for (const job of await ds.listJobs()) if (job.status === 'queued' || job.status === 'running') await ds.cancelJob(job.id);
  await app.close();
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function call(method: Method, url: string, payload?: unknown) {
  // 和前端 api.ts 一样：POST 没有参数时也发 {}（T23：POST 必须是 JSON）
  if (payload === undefined && method === 'POST') payload = {};
  const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
  const json = res.headers['content-type']?.toString().startsWith('application/json') ? res.json() : undefined;
  return { status: res.statusCode, json, res };
}

const mutation = { ok: true, message: expect.any(String) };
const withUndo = { ...mutation, undoToken: expect.any(String) };
const apiError = (code: string) => ({ ok: false, error: expect.any(String), code });
const page = { items: expect.any(Array), total: expect.any(Number) };

/** 本文件覆盖到的路由（「METHOD 路径模板」），和源码里扫出来的比对 */
const covered = new Set<string>();
function route(key: string, body: () => Promise<void>) {
  covered.add(key);
  it(key, body);
}

describe('统计、作品、角色、搜索（routes/library.ts）', () => {
  route('GET /api/stats', async () => {
    const { status, json } = await call('GET', '/api/stats');
    expect(status).toBe(200);
    expect(json).toMatchObject({ imageCount: 32, characterCount: 7, workCount: 3, unrecognizedCount: 7, excludedCount: 4 });
  });

  route('GET /api/content-kinds', async () => {
    const { status, json } = await call('GET', '/api/content-kinds');
    expect(status).toBe(200);
    expect(json[0]).toMatchObject({ kind: 'illustration', count: expect.any(Number), recentCount: expect.any(Number) });
  });

  route('GET /api/works', async () => {
    const { status, json } = await call('GET', '/api/works?sort=imageCount');
    expect(status).toBe(200);
    expect(json.map((w: { id: string }) => w.id)).toEqual(['w1', 'w2', 'w3']);
    expect((await call('GET', '/api/works?sort=bogus')).status).toBe(400);
  });

  route('GET /api/works/:id', async () => {
    const ok = await call('GET', '/api/works/w1');
    expect([ok.status, ok.json.id, ok.json.name]).toEqual([200, 'w1', '蔚蓝档案']);
    const missing = await call('GET', '/api/works/w999');
    expect([missing.status, missing.json]).toEqual([404, apiError('not_found')]);
  });

  route('GET /api/characters', async () => {
    const { status, json } = await call('GET', '/api/characters?limit=2&sort=imageCount');
    expect(status).toBe(200);
    expect(json).toMatchObject({ ...page, total: 7, otherOnlyCount: 0 });
    expect(json.items).toHaveLength(2);
    expect(json.nextCursor).toEqual(expect.any(String));
    const bad = await call('GET', '/api/characters?limit=0');
    expect([bad.status, bad.json]).toEqual([400, apiError('bad_request')]);
  });

  route('GET /api/characters/top', async () => {
    const { status, json } = await call('GET', '/api/characters/top?limit=3');
    expect(status).toBe(200);
    expect(json.map((c: { id: string }) => c.id)).toEqual(['c1', 'c4', 'c2']);
  });

  route('GET /api/characters/:id', async () => {
    const { status, json } = await call('GET', '/api/characters/c1');
    expect(status).toBe(200);
    expect(json).toMatchObject({ character: { id: 'c1', name: '圣园未花' }, works: [{ id: 'w1' }], related: expect.any(Array) });
    expect((await call('GET', '/api/characters/c999')).status).toBe(404);
  });

  route('GET /api/characters/:id/cover-candidates', async () => {
    const { status, json } = await call('GET', '/api/characters/c1/cover-candidates?limit=3');
    expect(status).toBe(200);
    expect(json.items.map((x: { id: string }) => x.id)).toEqual(['i1', 'i2', 'i5']);
    expect(json.items[0]).toMatchObject({ id: 'i1', coverScore: expect.any(Number), characterIds: ['c1'] });
    expect((await call('GET', '/api/characters/c1/cover-candidates')).json.items).toHaveLength(8);
    expect((await call('GET', '/api/characters/c1/cover-candidates?limit=0')).status).toBe(400);
    expect((await call('GET', '/api/characters/c999/cover-candidates')).status).toBe(404);
  });

  route('POST /api/characters', async () => {
    const { status, json } = await call('POST', '/api/characters', { name: '新角色', workIds: ['w3'] });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ...withUndo, character: { name: '新角色', source: 'custom' } });
    expect((await call('POST', '/api/characters', { name: '' })).status).toBe(400);
  });

  route('PATCH /api/characters/:id', async () => {
    const { status, json } = await call('PATCH', '/api/characters/c2', { pinned: true, coverFocus: { x: 0.5, y: 0.5 } });
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('PATCH', '/api/characters/c2', { coverFocus: { x: 2, y: 0 } })).status).toBe(400);
  });

  route('POST /api/characters/:id/seen', async () => {
    const { status, json } = await call('POST', '/api/characters/c1/seen');
    expect([status, json]).toEqual([200, { ok: true }]);
  });

  route('POST /api/characters/:id/merge', async () => {
    const { status, json } = await call('POST', '/api/characters/c5/merge', { targetId: 'c4' });
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('POST', '/api/characters/c1/merge', {})).status).toBe(400);
  });

  route('GET /api/search', async () => {
    const { status, json } = await call('GET', '/api/search?q=ミカ&limit=5');
    expect(status).toBe(200);
    expect(json).toEqual([{ type: 'character', character: expect.objectContaining({ id: 'c1' }), workName: '蔚蓝档案' }]);
    expect((await call('GET', '/api/search?limit=99')).status).toBe(400);
  });

  route('GET /api/tags', async () => {
    const { status, json } = await call('GET', '/api/tags?q=thigh&limit=5');
    expect(status).toBe(200);
    expect(json).toEqual([{ tag: 'thighhighs', name: expect.any(String), count: 1 }]);
    expect((await call('GET', '/api/tags')).json[0]).toMatchObject({ tag: '1girl' });
    expect((await call('GET', '/api/tags?limit=99')).status).toBe(400);
  });
});

describe('合集（routes/collections.ts）', () => {
  const create = async () => (await call('POST', '/api/collections', { fromImageId: 'i1', kind: 'artbook' })).json.collection.id as string;

  route('GET /api/collections', async () => {
    const { status, json } = await call('GET', '/api/collections?pending=true');
    expect([status, json]).toEqual([200, []]);
    expect((await call('GET', '/api/collections?kind=manga')).status).toBe(400);
  });

  route('POST /api/collections', async () => {
    const { status, json } = await call('POST', '/api/collections', { fromImageId: 'i1', kind: 'artbook' });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ...withUndo, collection: { id: expect.any(String), kind: 'artbook', pageCount: 25 } });
    expect((await call('POST', '/api/collections', { fromImageId: 'i1', kind: 'artbook' })).status).toBe(409);
  });

  route('GET /api/collections/:id', async () => {
    const id = await create();
    const { status, json } = await call('GET', `/api/collections/${id}`);
    expect(status).toBe(200);
    expect(json).toMatchObject({ collection: { id }, pages: expect.any(Array), cast: expect.any(Array), works: expect.any(Array) });
    expect((await call('GET', '/api/collections/nope')).status).toBe(404);
  });

  route('PATCH /api/collections/:id', async () => {
    const id = await create();
    const { status, json } = await call('PATCH', `/api/collections/${id}`, { title: '测试本', reviewed: true });
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('PATCH', `/api/collections/${id}`, { pageOrder: 'size' })).status).toBe(400);
  });

  route('DELETE /api/collections/:id', async () => {
    const id = await create();
    const { status, json } = await call('DELETE', `/api/collections/${id}`);
    expect([status, json]).toEqual([200, withUndo]);
  });

  route('POST /api/collections/bulk', async () => {
    const id = await create();
    const { status, json } = await call('POST', '/api/collections/bulk', { ids: [id], action: { type: 'addCharacter', characterId: 'c7' } });
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('POST', '/api/collections/bulk', { ids: [], action: { type: 'review' } })).status).toBe(400);
  });
});

describe('图片、未识别、重复、排除（routes/images.ts）', () => {
  route('GET /api/images', async () => {
    const { status, json } = await call('GET', '/api/images?rating=general,sensitive&sort=addedAt&order=desc&limit=5&favorite=false');
    expect(status).toBe(200);
    expect(json).toMatchObject(page);
    expect(json.items).toHaveLength(5);
    expect((await call('GET', '/api/images?tags=thighhighs,glasses')).json.total).toBe(1);
    expect((await call('GET', '/api/images?tagsAll=1girl,thighhighs&tagsNone=glasses')).json.total).toBe(1);
    expect(json.items[0]).toMatchObject({ id: expect.any(String), relPath: expect.any(String), width: expect.any(Number) });
    expect((await call('GET', '/api/images?kind=bogus')).status).toBe(400);
    expect((await call('GET', '/api/images?limit=500')).status).toBe(400);
  });

  route('POST /api/images/bulk', async () => {
    const { status, json } = await call('POST', '/api/images/bulk', { ids: ['i1', 'i2'], action: { type: 'rating', value: 'sensitive' } });
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('POST', '/api/images/bulk', { ids: ['i1'], action: { type: 'explode' } })).status).toBe(400);
    const artist = await call('POST', '/api/images/bulk', { ids: ['i1'], action: { type: 'artist', mode: 'set', artists: ['kantoku'] } });
    expect([artist.status, artist.json]).toEqual([200, withUndo]);
    expect((await call('GET', '/api/images/i1')).json).toMatchObject({ artists: [{ tag: 'kantoku', name: 'kantoku', tags: ['kantoku'] }], artistsManual: true });
    expect((await call('POST', '/api/images/bulk', { ids: ['i1'], action: { type: 'artist', mode: 'bogus', artists: [] } })).status).toBe(400);
    expect((await call('POST', '/api/images/bulk', { ids: ['i1'], action: { type: 'artist-auto' } })).status).toBe(200);
  });

  route('POST /api/images/move', async () => {
    // mock 只改记录，不碰文件
    const { status, json } = await call('POST', '/api/images/move', { characterId: 'c1', rootId: 'root1', dir: '角色/未花' });
    expect([status, json]).toEqual([200, withUndo]);
    expect(json.message).toMatch(/^已移动 \d+ 张到 D:\/Pics\/角色\/未花/);
    expect((await call('POST', '/api/images/move', { ids: ['i1'], characterId: 'c1', rootId: 'root1', dir: '' })).status).toBe(400);
    expect((await call('POST', '/api/images/move', { ids: ['i1'], rootId: 'root1', dir: 'a:b' })).status).toBe(400);
  });

  route('GET /api/images/:id', async () => {
    const { status, json } = await call('GET', '/api/images/i1');
    expect(status).toBe(200);
    expect(json).toMatchObject({ id: 'i1', favorite: true, characterIds: ['c1'], tags: expect.any(Array), characterSuggestions: [] });
    expect((await call('GET', '/api/images/i999')).status).toBe(404);
  });

  route('PATCH /api/images/:id', async () => {
    const { status, json } = await call('PATCH', '/api/images/i2', { favorite: true, rating: 'general' });
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('PATCH', '/api/images/i2', { rating: 'nsfw' })).status).toBe(400);
  });

  route('GET /api/images/:id/thumb', async () => {
    const { status, res } = await call('GET', '/api/images/i1/thumb?w=300');
    expect(status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.body).toContain('<svg');
    expect((await call('GET', '/api/images/i999/thumb')).status).toBe(404);
  });

  route('GET /api/images/:id/file', async () => {
    const { status, res } = await call('GET', '/api/images/i1/file');
    expect(status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
  });

  route('POST /api/images/:id/reveal', async () => {
    const { status, json } = await call('POST', '/api/images/i1/reveal');
    expect([status, json]).toEqual([200, { ok: true }]);
  });

  route('GET /api/unrecognized', async () => {
    const { status, json } = await call('GET', '/api/unrecognized?limit=3');
    expect(status).toBe(200);
    expect(json).toMatchObject({ ...page, total: 7, suggestedCount: expect.any(Number), unsureCount: expect.any(Number) });
    expect(json.items[0]).toMatchObject({ image: { id: expect.any(String) }, suggestions: expect.any(Array), tagged: expect.any(Boolean) });
    expect((await call('GET', '/api/unrecognized?area=nowhere')).status).toBe(400);
  });

  route('GET /api/unrecognized/summary', async () => {
    const { status, json } = await call('GET', '/api/unrecognized/summary');
    expect(status).toBe(200);
    expect(json).toMatchObject({ art: { total: expect.any(Number), themes: expect.any(Object) }, annex: { total: expect.any(Number), kinds: expect.any(Object) } });
  });

  route('POST /api/unrecognized/retag', async () => {
    const { status, json } = await call('POST', '/api/unrecognized/retag');
    expect(status).toBe(200);
    expect(json).toMatchObject({ marked: expect.any(Number) });
  });

  route('POST /api/unrecognized/:id/accept', async () => {
    const { status, json } = await call('POST', '/api/unrecognized/i26/accept', { danbooruTag: 'mika_(blue_archive)' });
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('POST', '/api/unrecognized/i26/accept', { danbooruTag: '' })).status).toBe(400);
  });

  route('GET /api/duplicates', async () => {
    const open = await call('GET', '/api/duplicates');
    expect(open.status).toBe(200);
    expect(open.json).toEqual([expect.objectContaining({ id: 'd1', kind: 'similar', suggestedKeepId: 'i15', images: expect.any(Array) })]);
    expect((await call('GET', '/api/duplicates?resolved=true')).json.map((g: { id: string }) => g.id)).toContain('d2');
  });

  route('POST /api/duplicates/:id/resolve', async () => {
    const { status, json } = await call('POST', '/api/duplicates/d1/resolve', { keepIds: ['i15'] });
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('POST', '/api/duplicates/d1/resolve', { keepIds: [] })).status).toBe(400);
  });

  route('POST /api/duplicates/:id/ignore', async () => {
    const { status, json } = await call('POST', '/api/duplicates/d1/ignore');
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('POST', '/api/duplicates/d999/ignore')).status).toBe(404);
  });

  route('GET /api/exclusions', async () => {
    const { status, json } = await call('GET', '/api/exclusions');
    expect(status).toBe(200);
    expect(json.map((x: { id: string; kind: string }) => [x.id, x.kind])).toEqual(
      expect.arrayContaining([
        ['x1', 'folder'],
        ['x2', 'tag'],
      ]),
    );
  });

  route('POST /api/exclusions', async () => {
    const { status, json } = await call('POST', '/api/exclusions', { kind: 'tag', target: 'thighhighs' });
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('POST', '/api/exclusions', { kind: 'color', target: 'red' })).status).toBe(400);
  });

  route('DELETE /api/exclusions/:id', async () => {
    const { status, json } = await call('DELETE', '/api/exclusions/x1');
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('DELETE', '/api/exclusions/x999')).status).toBe(404);
  });
});

describe('设置、文件夹、任务、SSE、撤销（routes/system.ts、app.ts）', () => {
  route('GET /api/health', async () => {
    const { status, json } = await call('GET', '/api/health');
    expect(status).toBe(200);
    // keepAwake 只在 sqlite 下有（防休眠状态）
    expect(json).toMatchObject({ ok: true, dataSource: expect.any(String), version: expect.any(String), dataDir: expect.any(String) });
  });

  route('POST /api/system/pick-folder', async () => {
    const { status, json } = await call('POST', '/api/system/pick-folder');
    expect([status, json]).toEqual([200, { path: 'D:/Picked' }]);
  });

  route('POST /api/artists/links', async () => {
    const r = await call('POST', '/api/artists/links', { tags: ['a_tag'], mode: 'split' });
    expect([r.status, r.json]).toEqual([200, withUndo]);
    expect((await call('POST', '/api/artists/links', { tags: [], mode: 'split' })).status).toBe(400);
    expect((await call('POST', '/api/artists/links', { tags: ['a_tag'], mode: 'merge' })).status).toBe(400);
    expect((await call('POST', '/api/artists/links', { tags: ['a_tag'], mode: 'auto' })).status).toBe(200);
  });

  route('GET /api/artists', async () => {
    const { status, json } = await call('GET', '/api/artists');
    expect([status, json]).toEqual([200, []]); // 演示数据没有画师
    expect((await call('GET', '/api/images?artist=kantoku')).status).toBe(200);
  });

  route('POST /api/system/network-check', async () => {
    const { status, json } = await call('POST', '/api/system/network-check');
    expect([status, json]).toMatchObject([200, { proxy: { url: null }, targets: [], summary: expect.any(String) }]);
  });

  route('GET /api/tagger/models', async () => {
    const { status, json } = await call('GET', '/api/tagger/models');
    expect(status).toBe(200);
    expect(json).toEqual(expect.arrayContaining([expect.objectContaining({ repo: expect.any(String), isDefault: true })]));
  });

  route('GET /api/settings', async () => {
    const { status, json } = await call('GET', '/api/settings');
    expect(status).toBe(200);
    expect(json).toMatchObject({ libraryRoots: [{ id: 'root1' }, { id: 'root2' }], tagger: expect.any(Object), ui: { theme: 'system' } });
  });

  route('PUT /api/settings', async () => {
    const { status, json } = await call('PUT', '/api/settings', { ui: { theme: 'dark' }, dedupe: { hammingThreshold: 10 } });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ui: { theme: 'dark' }, dedupe: { hammingThreshold: 10 } });
    expect((await call('PUT', '/api/settings', { dedupe: { hammingThreshold: 100 } })).status).toBe(400);
    expect((await call('PUT', '/api/settings', { tagger: { legacyBefore: '2024/03/01' } })).status).toBe(400);
    const theme = { id: 't1', name: '丝袜', tags: ['thighhighs'] };
    expect((await call('PUT', '/api/settings', { browse: { customThemes: [theme] } })).json.browse).toEqual({ customThemes: [theme] });
    expect((await call('PUT', '/api/settings', { browse: { customThemes: [{ ...theme, tags: [] }] } })).status).toBe(400);
    expect((await call('PUT', '/api/settings', { browse: { customThemes: [{ ...theme, name: '一二三四五六七八九十一二三' }] } })).status).toBe(400);
    // 必含 / 不含：只有「不含」不行；三组合计不超过 20
    const strict = { id: 't2', name: '白丝', tags: [], all: ['thighhighs', 'white_thighhighs'], none: ['comic'] };
    expect((await call('PUT', '/api/settings', { browse: { customThemes: [strict] } })).json.browse).toEqual({ customThemes: [strict] });
    expect((await call('PUT', '/api/settings', { browse: { customThemes: [{ ...strict, all: [] }] } })).status).toBe(400);
    const many = Array.from({ length: 11 }, (_, k) => `t${k}`);
    expect((await call('PUT', '/api/settings', { browse: { customThemes: [{ ...theme, tags: many, none: many.map((t) => `x${t}`) }] } })).status).toBe(400);
  });

  route('POST /api/library-roots', async () => {
    const { status, json } = await call('POST', '/api/library-roots', { path: 'F:/NewPics' });
    expect([status, json]).toMatchObject([200, mutation]);
    expect((await call('POST', '/api/library-roots', { path: '' })).status).toBe(400);
    const comic = await call('POST', '/api/library-roots', { path: 'F:/Manga', mode: 'comic', comicRating: 'questionable' });
    expect(comic.status).toBe(200);
    expect((await call('GET', '/api/settings')).json.libraryRoots.find((r: { path: string }) => r.path === 'F:/Manga')).toMatchObject({ mode: 'comic', comicRating: 'questionable' });
    expect((await call('POST', '/api/library-roots', { path: 'F:/Manga2', mode: 'manga' })).status).toBe(400);
  });

  route('PATCH /api/library-roots/:id', async () => {
    const { status, json } = await call('PATCH', '/api/library-roots/root2', { enabled: true });
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('PATCH', '/api/library-roots/root2', { enabled: 'yes' })).status).toBe(400);
    const comic = await call('PATCH', '/api/library-roots/root1', { mode: 'comic', comicRating: 'sensitive' });
    expect([comic.status, comic.json]).toEqual([200, withUndo]);
    expect((await call('PATCH', '/api/library-roots/root1', { mode: 'auto' })).status).toBe(200);
    expect((await call('PATCH', '/api/library-roots/root1', {})).status).toBe(400);
    expect((await call('PATCH', '/api/library-roots/root1', { comicRating: 'nsfw' })).status).toBe(400);
  });

  route('DELETE /api/library-roots/:id', async () => {
    const { status, json } = await call('DELETE', '/api/library-roots/root2');
    expect([status, json]).toEqual([200, withUndo]);
  });

  route('GET /api/jobs', async () => {
    const { status, json } = await call('GET', '/api/jobs');
    expect([status, json]).toEqual([200, expect.any(Array)]);
  });

  route('POST /api/jobs', async () => {
    const { status, json } = await call('POST', '/api/jobs', { kind: 'dedupe' });
    expect(status).toBe(200);
    expect(json).toMatchObject({ id: expect.any(String), kind: 'dedupe', status: expect.stringMatching(/^(queued|running)$/) });
    expect((await call('POST', '/api/jobs', { kind: 'format-c' })).status).toBe(400);
  });

  route('DELETE /api/jobs/:id', async () => {
    const job = (await call('POST', '/api/jobs', { kind: 'scan' })).json as { id: string };
    const { status, json } = await call('DELETE', `/api/jobs/${job.id}`);
    expect([status, json]).toEqual([200, { ok: true }]);
  });

  route('POST /api/undo/:id', async () => {
    const token = (await call('POST', '/api/images/bulk', { ids: ['i3'], action: { type: 'favorite', value: true } })).json.undoToken as string;
    const { status, json } = await call('POST', `/api/undo/${token}`);
    expect([status, json]).toMatchObject([200, mutation]);
    expect((await call('GET', '/api/images/i3')).json.favorite).toBe(false);
    const again = await call('POST', `/api/undo/${token}`);
    expect([again.status, again.json]).toEqual([404, apiError('not_found')]);
  });

  // SSE 会 hijack 响应、一直不结束，inject 等不到结果：真的监听一个随机端口（只在 127.0.0.1），读到第一个事件就断开
  route('GET /api/events', async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const ac = new AbortController();
    try {
      const res = await fetch(`${address}/api/events`, { signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      // 先读到 retry 行，确认订阅已建立，再发一个事件
      while (!text.includes('retry:')) text += decoder.decode((await reader.read()).value);
      await ds.updateImage('i4', { favorite: true });
      while (!text.includes('"type":"library-changed"')) text += decoder.decode((await reader.read()).value);
      expect(text).toMatch(/^retry: 3000\n\n/);
    } finally {
      ac.abort();
    }
  });

  it('未知接口 → 404', async () => {
    expect((await call('GET', '/api/no-such-route')).status).toBe(404);
  });
});

describe('本机安全（T23）', () => {
  it('非本机 Host → 403（防 DNS rebinding）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example' } });
    expect([res.statusCode, res.json()]).toEqual([403, apiError('bad_request')]);
    for (const host of ['127.0.0.1:5174', 'localhost:5173', '[::1]:5174']) {
      expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host } })).statusCode).toBe(200);
    }
  });

  it('POST 不是 JSON → 415（防跨站表单 / text/plain）', async () => {
    const bare = await app.inject({ method: 'POST', url: '/api/characters/c1/seen' });
    expect([bare.statusCode, bare.json()]).toEqual([415, apiError('bad_request')]);
    const text = await app.inject({ method: 'POST', url: '/api/undo/x', headers: { 'content-type': 'text/plain' }, payload: 'x' });
    expect(text.statusCode).toBe(415);
  });
});

describe('路由清单', () => {
  it('源码里的每个路由都有冒烟用例', () => {
    const files = [path.join(SRC, 'app.ts'), ...readdirSync(path.join(SRC, 'routes')).map((f) => path.join(SRC, 'routes', f))];
    const declared = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
        declared.add(`${m[1]!.toUpperCase()} ${m[2]}`);
      }
    }
    expect(declared.size).toBeGreaterThan(40);
    expect([...declared].filter((r) => !covered.has(r)).sort()).toEqual([]);
    expect([...covered].filter((r) => !declared.has(r)).sort()).toEqual([]);
  });
});
