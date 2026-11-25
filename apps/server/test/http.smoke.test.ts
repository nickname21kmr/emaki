/**
 * T24 第 9 步：HTTP 冒烟。buildApp(真实引擎) + app.inject，每个路由请求一次，断言状态码与 JSON 结构，
 * 确认路由、zod 校验、错误处理接线正确。
 * 引擎用演示模式的部件（demo/engine.ts：占位图、不碰文件、假任务）+ 契约夹具（固定 NOW）。用例里照旧写夹具 id
 * （i1 / c1 / w1 …），call() 负责把请求里的夹具 id 换成库里的 id、把响应里的 id 换回夹具 id。
 * 最后一条用例列出全部路由（命令 / 查询注册表里的地址，加上 src/app.ts、src/http/*.ts 里手写的），确保这里每个都测到了（新增路由忘了补冒烟会失败）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SCOPES } from '@emaki/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { EventBus } from '../src/core/events.ts';
import { openDemoEngine, SqliteDataSource } from './helpers/client.ts';
import { DEFINITIONS } from '../src/commands/index.ts';
import type { IdMap } from '../src/demo/seed.ts';
import { NOW } from './contract/harness.ts';
import { buildContractDb } from './fixtures/contract-db.ts';
import { patchSettingsInternal } from '../src/datasource/sqlite/settings.ts';
import { makeTmpDir } from './helpers/tmp.ts';
import { makeZip } from './helpers/zip.ts';
import { ensurePoseClasses } from '../src/services/pose/job.ts';

// 真实实现会弹出 Windows 的选择文件夹对话框，测试里换成固定返回值
vi.mock('../src/system/pickFolder.ts', () => ({ pickFolder: async () => 'D:/Picked' }));
// 检测网络会真的联网
vi.mock('../src/net/check.ts', () => ({
  checkNetwork: async () => ({ proxy: { url: null, source: null, note: null }, targets: [], summary: '测试' }),
}));
// buildApp 会在 dataDir/assistant 下建目录、改写会话和设置，换成临时目录，不碰真实的 data/
const dataState = vi.hoisted(() => ({ dir: '' }));
vi.mock('../src/config.ts', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { config } = await importOriginal<typeof import('../src/config.ts')>();
  dataState.dir = mkdtempSync(join(tmpdir(), 'emaki-smoke-'));
  return { config: { ...config, dataDir: dataState.dir, libraryDir: dataState.dir } };
});

const SRC = path.resolve(import.meta.dirname, '../src');
const prevLogLevel = process.env.EMAKI_LOG_LEVEL;
process.env.EMAKI_LOG_LEVEL = 'silent';
afterAll(() => {
  if (prevLogLevel === undefined) delete process.env.EMAKI_LOG_LEVEL;
  else process.env.EMAKI_LOG_LEVEL = prevLogLevel;
  if (dataState.dir) rmSync(dataState.dir, { recursive: true, force: true, maxRetries: 4 });
});

let app: FastifyInstance;
let ds: SqliteDataSource;
let bus: EventBus;
let map: IdMap;
beforeEach(async () => {
  bus = new EventBus();
  ({ ds, map } = await openDemoEngine(bus, { dir: path.join(dataState.dir, 'library'), memory: true, data: buildContractDb(NOW), now: NOW, clock: () => NOW }));
  app = await buildApp(ds, bus);
});
afterEach(async () => {
  // 别让模拟的后台任务在用例之间继续跑
  for (const job of await ds.listJobs()) if (job.status === 'queued' || job.status === 'running') await ds.cancelJob(job.id);
  await app.close();
  await ds.close();
});

/** 夹具 id 的前缀 → 映射表 */
const KINDS: Record<string, keyof IdMap> = { i: 'images', c: 'characters', w: 'works', x: 'exclusions', d: 'duplicates', root: 'roots' };
const FIXTURE_ID = /^(i|c|w|x|d|root)\d+$/;
/** 夹具 id → 库里的 id；夹具里没有的（i999 这种）原样返回，引擎会当成不存在 */
const id = (fixtureId: string): string => {
  const m = FIXTURE_ID.exec(fixtureId);
  const n = m ? map[KINDS[m[1]!]!].get(fixtureId) : undefined;
  return n === undefined ? fixtureId : String(n);
};
const reverse = () => {
  const out = new Map<string, Map<string, string>>();
  for (const key of Object.values(KINDS)) out.set(key, new Map([...map[key]].map(([f, n]) => [String(n), f])));
  return out;
};
/** 请求体里的夹具 id 换成库里的 id */
const toEngine = (v: unknown): unknown =>
  typeof v === 'string' ? id(v) : Array.isArray(v) ? v.map(toEngine) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toEngine(x)])) : v;
/** 响应里的 id 换回夹具 id（按对象形状认是哪种 id，同 contract/harness.ts 的 canon） */
function toFixture(v: unknown, back = reverse()): unknown {
  if (Array.isArray(v)) return v.map((x) => toFixture(x, back));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const fields: Record<string, keyof IdMap> =
    'relPath' in o ? { id: 'images', libraryRootId: 'roots', characterIds: 'characters', workIds: 'works' }
    : 'characterCount' in o ? { id: 'works', coverImageId: 'images' }
    : 'source' in o && 'danbooruTag' in o && 'workIds' in o ? { id: 'characters', workIds: 'works', coverImageId: 'images' }
    : 'path' in o && 'enabled' in o ? { id: 'roots' }
    : 'label' in o && 'target' in o ? { id: 'exclusions', previewImageIds: 'images' }
    : 'suggestedKeepId' in o ? { id: 'duplicates', suggestedKeepId: 'images' }
    : 'characterId' in o && 'danbooruTag' in o ? { characterId: 'characters' }
    : {};
  const one = (key: keyof IdMap, x: unknown) => (typeof x === 'string' ? (back.get(key)!.get(x) ?? x) : x);
  return Object.fromEntries(
    Object.entries(o).map(([k, x]) => {
      const key = fields[k];
      if (key) return [k, Array.isArray(x) ? x.map((y) => one(key, y)) : one(key, x)];
      return [k, toFixture(x, back)];
    }),
  );
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function call(method: Method, url: string, payload?: unknown) {
  // 和前端 api.ts 一样：POST 没有参数时也发 {}（T23：POST 必须是 JSON）
  if (payload === undefined && method === 'POST') payload = {};
  const target = url.replace(/([/=,])((?:i|c|w|x|d|root)\d+)(?=$|[/?&,])/g, (_m, sep: string, x: string) => sep + id(x));
  const res = await app.inject({ method, url: target, ...(payload === undefined ? {} : { payload: toEngine(payload) as object }) });
  const json = res.headers['content-type']?.toString().startsWith('application/json') ? toFixture(res.json()) as any : undefined;
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

describe('统计、作品、角色、搜索（注册表：统计、作品、角色、搜索的查询和命令）', () => {
  route('POST /api/images/:id/replace', async () => {
    expect((await call('POST','/api/images/img1/replace',{})).status).toBe(400);
    const response=await call('POST','/api/images/img1/replace',{path:'D:/download.png'});
    expect(response.status).toBe(400);expect(response.json.error).toContain('演示数据不支持');
  });
  route('POST /api/images/import', async () => {
    expect((await call('POST','/api/images/import',{rootId:'root1',files:[]})).status).toBe(400);
    const response=await call('POST','/api/images/import',{rootId:'root1',files:[{path:'D:/download.png'}]});
    expect(response.status).toBe(400);
    expect(response.json.error).toContain('演示数据不支持');
  });

  route('GET /api/library-roots', async () => {
    const {status,json}=await call('GET','/api/library-roots');
    expect(status).toBe(200);expect(json).toEqual(toFixture((await ds.getSettings()).libraryRoots));
  });
  route('GET /api/stats', async () => {
    const { status, json } = await call('GET', '/api/stats');
    expect(status).toBe(200);
    expect(json).toMatchObject({ imageCount: 32, characterCount: 7, workCount: 3, unrecognizedCount: 7, excludedCount: 4 });
  });

  route('GET /api/summary', async () => {
    const { status, json } = await call('GET', '/api/summary');
    expect(status).toBe(200);
    const stats = (await call('GET', '/api/stats')).json;
    // 汇总接口的数和 /api/stats 对得上（逐项的对账在 readmodel/summary.test.ts）
    expect(json.images).toMatchObject({ total: stats.imageCount, illustrations: stats.kindCounts.illustration });
    expect(json.triage.images + json.triage.books).toBe(json.triage.total);
    expect(json).toMatchObject({ characters: 7, works: 3, recognition: { scope: expect.any(Number) } });
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

  route('GET /api/characters/danbooru-matches', async () => {
    const { status, json } = await call('GET', '/api/characters/danbooru-matches');
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
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

  route('POST /api/characters/verification', async () => {
    await app.close();
    const sqlite = await SqliteDataSource.open(bus, dataState.dir, { memory: true, autoJobs: false, importDict: false });
    app = await buildApp(sqlite, bus);
    app.addHook('onClose', () => sqlite.close());
    const { id } = sqlite.makeCatalog().catalog.ensureCharacter('sample_character', new Date(NOW).toISOString());
    const body = { type: 'name', tag: 'sample_character', name: '常用名', sources: ['https://example.com/character'], evidence: '发行方角色介绍' };
    expect((await call('POST', '/api/characters/verification', { ...body, sources: [] })).status).toBe(400);
    const { status, json } = await call('POST', '/api/characters/verification', body);
    expect([status, json]).toEqual([200, withUndo]);
    expect((await call('GET', `/api/characters/${id}`)).json.character.name).toBe('常用名');
    expect((await call('POST', `/api/undo/${json.undoToken}`)).status).toBe(200);
    expect((await call('GET', `/api/characters/${id}`)).json.character.name).toBe('Sample Character');
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

  route('GET /api/search/phrase', async () => {
    const { status, json } = await call('GET', `/api/search/phrase?q=${encodeURIComponent('穿 thighhighs 的 宇宙飞船')}`);
    expect(status).toBe(200);
    expect(json).toEqual({ tags: [{ tag: 'thighhighs', name: expect.any(String), count: 1 }], rest: '宇宙飞船', total: 1 });
    expect((await call('GET', `/api/search/phrase?q=${'x'.repeat(101)}`)).status).toBe(400);
  });
});

describe('合集（注册表：collections.*）', () => {
  const create = async () => (await call('POST', '/api/collections', { fromImageId: 'i1', kind: 'artbook' })).json.collection.id as string;

  route('GET /api/collections', async () => {
    const { status, json } = await call('GET', '/api/collections?pending=true');
    expect([status, json]).toEqual([200, []]);
    expect((await call('GET', '/api/collections?kind=manga')).status).toBe(400);
    // 类型、成员来源可多选（逗号分隔，和前端 api.ts 拼数组的写法一样）；sort、limit
    const id = await create();
    const many = await call('GET', '/api/collections?kind=doujin,artbook&membership=folder,selection&sort=recent&limit=5');
    expect([many.status, many.json.map((c: { id: string }) => c.id)]).toEqual([200, [id]]);
    expect((await call('GET', '/api/collections?membership=post')).json).toEqual([]);
    expect((await call('GET', '/api/collections?membership=book')).status).toBe(400);
    expect((await call('GET', '/api/collections?sort=size')).status).toBe(400);
    expect((await call('GET', '/api/collections?limit=0')).status).toBe(400);
  });

  route('GET /api/collections/counts', async () => {
    await create();
    // 不会被当成 /api/collections/:id
    const { status, json } = await call('GET', '/api/collections/counts');
    expect(status).toBe(200);
    const none = { count: 0, units: 0, pages: 0 };
    const one = { count: 1, units: 1, pages: 25 };
    expect(json.artbook).toEqual({ ...one, membership: { folder: one, selection: none, post: none } });
    expect(json.group).toEqual({ ...none, membership: { folder: none, selection: none, post: none } });
    expect((await call('GET', '/api/collections/counts?q=没有这本')).json.artbook.count).toBe(0);
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

describe('图片、未识别、重复、排除（注册表：images.*、curation.*，兼容层 http/compat.ts）', () => {
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
    // 演示部件不碰文件：参数校验通过后拒绝
    const { status, json } = await call('POST', '/api/images/move', { characterId: 'c1', rootId: 'root1', dir: '角色/未花' });
    expect([status, json]).toEqual([400, apiError('bad_request')]);
    expect(json.error).toBe('演示数据不支持移动文件');
    expect((await call('POST', '/api/images/move', { ids: ['i1'], characterId: 'c1', rootId: 'root1', dir: '' })).status).toBe(400);
    expect((await call('POST', '/api/images/move', { ids: ['i1'], rootId: 'root1', dir: 'a:b' })).status).toBe(400);
  });

  route('POST /api/images/move/preview', async () => {
    const { status, json } = await call('POST', '/api/images/move/preview', { characterId: 'c1', rootId: 'root1', dir: '角色/未花' });
    expect(status).toBe(200);
    expect(json).toEqual({ ids: expect.any(Array), alreadyThere: expect.any(Number), inCollection: expect.any(Number), otherCharacters: expect.any(Number) });
    expect(json.ids.length).toBeGreaterThan(0);
    // 预览可以 ids + characterId 一起给（选中的图里有几张还属于别的角色）
    expect((await call('POST', '/api/images/move/preview', { ids: ['i1'], characterId: 'c1', rootId: 'root1', dir: '' })).status).toBe(200);
    expect((await call('POST', '/api/images/move/preview', { rootId: 'root1', dir: '' })).status).toBe(400);
  });

  // 只读的预览用 GET（第 9 节）：选中的图不多时 ids 放在查询串里
  route('GET /api/images/move/preview', async () => {
    const byCharacter = await call('GET', `/api/images/move/preview?characterId=c1&rootId=root1&dir=${encodeURIComponent('角色/未花')}`);
    expect(byCharacter.status).toBe(200);
    expect(byCharacter.json.ids.length).toBeGreaterThan(0);
    const byIds = await call('GET', '/api/images/move/preview?ids=i1,i2&rootId=root1&dir=');
    expect([byIds.status, byIds.json]).toEqual([200, { ids: expect.any(Array), alreadyThere: expect.any(Number), inCollection: expect.any(Number), otherCharacters: expect.any(Number) }]);
    expect((await call('GET', '/api/images/move/preview?rootId=root1&dir=')).status).toBe(400);
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
    expect([status, json]).toEqual([400, apiError('bad_request')]);
    expect(json.error).toBe('演示数据不支持在资源管理器中显示文件');
    expect((await call('POST', '/api/images/i999/reveal')).status).toBe(404);
  });

  route('GET /api/unrecognized', async () => {
    const { status, json } = await call('GET', '/api/unrecognized?limit=3');
    expect(status).toBe(200);
    expect(json).toMatchObject({ ...page, total: 7, suggestedCount: expect.any(Number), unsureCount: expect.any(Number) });
    expect(json.items[0]).toMatchObject({ image: { id: expect.any(String) }, suggestions: expect.any(Array), tagged: expect.any(Boolean) });
    expect((await call('GET', '/api/unrecognized?area=nowhere')).status).toBe(400);
    expect((await call('GET', '/api/unrecognized?artKind=comic')).json).toMatchObject({ items: [], total: 0 });
    expect((await call('GET', '/api/unrecognized?artKind=photo')).status).toBe(400);
  });

  route('GET /api/unrecognized/summary', async () => {
    const { status, json } = await call('GET', '/api/unrecognized/summary');
    expect(status).toBe(200);
    expect(json).toMatchObject({ art: { total: expect.any(Number), themes: expect.any(Object) }, annex: { total: expect.any(Number), kinds: expect.any(Object) } });
    expect(json.art.kinds).toMatchObject({ illustration: { total: 7 }, comic: { total: 0 } });
    expect((await call('GET', '/api/unrecognized/summary?artKind=illustration')).json.art.total).toBe(7);
    expect((await call('GET', '/api/unrecognized/summary?artKind=x')).status).toBe(400);
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
    // 一次采纳多条
    const many = await call('POST', '/api/unrecognized/i24/accept', { danbooruTags: ['mika_(blue_archive)', 'yuuka_(blue_archive)'] });
    expect([many.status, many.json]).toEqual([200, withUndo]);
    expect((await call('POST', '/api/unrecognized/i24/accept', { danbooruTags: [] })).status).toBe(400);
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

describe('设置、文件夹、任务、SSE、撤销（注册表：settings.*、library.*Root、jobs.*、history.*；http/events.ts、app.ts）', () => {
  route('GET /api/health', async () => {
    const { status, json } = await call('GET', '/api/health');
    expect(status).toBe(200);
    // keepAwake 只在 sqlite 下有（防休眠状态）
    expect(json).toMatchObject({
      ok: true,
      dataSource: expect.any(String),
      version: expect.any(String),
      dataDir: expect.any(String),
      bootId: expect.any(String),
    });
    // 助手的会话和设置写在临时目录里，不是仓库的 data/
    expect(json.dataDir).toBe(dataState.dir);
    // 引擎是真实的；配置里没开演示模式（是测试直接用了演示部件）
    expect(json.dataSource).toBe('sqlite');
    // 助手关着时启动不建目录、不写文件
    expect(existsSync(path.join(dataState.dir, 'assistant'))).toBe(false);
  });

  route('GET /api/me', async () => {
    // 本机入口：local，全部范围（局域网入口上的见 test/access/lan.test.ts）
    const { status, json } = await call('GET', '/api/me');
    expect([status, json]).toEqual([200, { kind: 'local', scopes: Object.keys(SCOPES) }]);
  });

  route('GET /api/settings/source-mode', async () => {
    const { status, json } = await call('GET', '/api/settings/source-mode?mode=broad');
    expect([status, json]).toEqual([200, { mode: 'broad', changed: 0, suggestionsDropped: 0, requeued: 0, cached: 0 }]);
    expect((await call('GET', '/api/settings/source-mode?mode=x')).status).toBe(400);
  });

  route('POST /api/settings/source-mode', async () => {
    const { status, json } = await call('POST', '/api/settings/source-mode', { mode: 'broad' });
    expect([status, json]).toEqual([200, withUndo]);
    expect(json.message).toBe('已改为宽泛：0 张图的来源变了');
    expect((await call('GET', '/api/settings')).json.tagger.pixivFilenameMode).toBe('broad');
    expect((await call('POST', '/api/settings/source-mode', { mode: 'nope' })).status).toBe(400);
  });

  /** 记一条「移到文件夹」的改动，库里的路径也改成移动之后的（演示部件不让真的移动，直接写记录） */
  const recordMove = () => {
    const i1 = Number(id('i1'));
    const at = new Date(NOW).toISOString();
    const item = { id: i1, from: { rootId: Number(id('root1')), rootPath: 'D:/Pics', rel: '角色/i1.png' }, to: { rootId: Number(id('root1')), rootPath: 'D:/Pics', rel: '别处/i1.png' } };
    const payload = { where: 'D:/Pics/别处', items: [item], charSnap: [], retagSnap: [], excluded: [] };
    ds.ctx.db.prepare("INSERT INTO change_log (kind, summary, payload, created_at) VALUES ('move', '1 张移到 D:/Pics/别处', ?, ?)").run(JSON.stringify(payload), at);
    ds.ctx.db.prepare("UPDATE images SET rel_path = '别处/i1.png' WHERE id = ?").run(i1);
  };

  route('GET /api/changes', async () => {
    expect(await call('GET', '/api/changes?group=auto')).toMatchObject({ status: 200, json: [] });
    recordMove();
    const { status, json } = await call('GET', '/api/changes?group=move');
    expect(status).toBe(200);
    expect(json).toEqual([expect.objectContaining({ kind: 'move', count: 1, revertable: true })]);
    expect((await call('GET', '/api/changes?group=x')).status).toBe(400);
  });

  route('POST /api/changes/:id/revert', async () => {
    recordMove();
    const [entry] = (await call('GET', '/api/changes?group=move')).json;
    // 移回原处要动文件：演示部件拒绝
    const r = await call('POST', `/api/changes/${entry.id}/revert`);
    expect([r.status, r.json]).toEqual([400, apiError('bad_request')]);
    expect(r.json.error).toBe('演示数据不支持移回文件');
    expect((await call('POST', '/api/changes/nope/revert')).status).toBe(404);
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

  // 只读的预览用 GET（第 9 节）；POST 留作兼容
  route('GET /api/system/network-check', async () => {
    const { status, json } = await call('GET', '/api/system/network-check');
    expect([status, json]).toMatchObject([200, { proxy: { url: null }, targets: [], summary: expect.any(String) }]);
  });

  route('GET /api/tagger/models', async () => {
    const { status, json } = await call('GET', '/api/tagger/models');
    expect(status).toBe(200);
    expect(json).toEqual(expect.arrayContaining([expect.objectContaining({ repo: expect.any(String), isDefault: true })]));
  });

  route('GET /api/tagger/promotable', async () => {
    const { status, json } = await call('GET', '/api/tagger/promotable');
    expect([status, json]).toEqual([200, { images: expect.any(Number), suggestions: expect.any(Number), threshold: expect.any(Number) }]);
  });

  route('POST /api/tagger/promote', async () => {
    const { status, json } = await call('POST', '/api/tagger/promote');
    expect([status, json]).toMatchObject([200, mutation]);
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
    // 未识别里也列出漫画页：默认开；关掉后漫画页离开未识别的列表、汇总和统计
    expect((await call('GET', '/api/settings')).json.tagger.comicInUnrecognized).toBe(true);
    expect((await call('PUT', '/api/settings', { tagger: { comicInUnrecognized: 'no' } })).status).toBe(400);
    await call('POST', '/api/images/bulk', { ids: ['i25'], action: { type: 'kind', value: 'comic' } });
    expect((await call('GET', '/api/unrecognized/summary')).json.art.kinds.comic.total).toBe(1);
    expect((await call('PUT', '/api/settings', { tagger: { comicInUnrecognized: false } })).json.tagger.comicInUnrecognized).toBe(false);
    expect((await call('GET', '/api/unrecognized/summary')).json.art).toMatchObject({ total: 6, kinds: { comic: { total: 0 } } });
    expect((await call('GET', '/api/unrecognized?artKind=comic')).json).toMatchObject({ items: [], total: 0 });
    expect((await call('GET', '/api/stats')).json.unrecognizedCount).toBe(6);
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

  // 设置用 PATCH（第 9 节）；PUT 留作兼容的别名，同一个命令 settings.update
  route('PATCH /api/settings', async () => {
    const res = await call('PATCH', '/api/settings', { ui: { theme: 'light' } });
    expect([res.status, res.json]).toMatchObject([200, { ui: { theme: 'light' } }]);
    // 改设置是不可撤销的命令：响应头说它是撤销屏障
    expect([res.res.headers['x-emaki-command'], res.res.headers['x-emaki-undo']]).toEqual(['settings.update', 'barrier']);
    expect((await call('PATCH', '/api/settings', { dedupe: { hammingThreshold: 100 } })).status).toBe(400);
    await call('PATCH', '/api/settings', { ui: { theme: 'system' } });
  });

  route('GET /api/commands', async () => {
    const { status, json } = await call('GET', '/api/commands');
    expect(status).toBe(200);
    expect(json).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'curation.link', kind: 'command', scope: 'curate', undoable: true, idempotent: true }),
      expect.objectContaining({ name: 'settings.update', kind: 'command', scope: 'settings', undoable: false }),
      expect.objectContaining({ name: 'images.list', kind: 'query', scope: 'read', http: [{ method: 'GET', path: '/api/images' }] }),
    ]));
  });

  route('GET /api/audit', async () => {
    await call('POST', '/api/images/bulk', { ids: ['i5'], action: { type: 'favorite', value: true } });
    const { status, json } = await call('GET', '/api/audit?limit=5');
    expect(status).toBe(200);
    expect(json.items[0]).toMatchObject({ command: 'curation.setFavorite', actor: 'user', status: 'done', undoToken: expect.any(String), changes: ['curation.favoriteChanged'] });
    expect((await call('GET', '/api/audit?actor=assistant')).json.items.every((r: { actor: string }) => r.actor === 'assistant')).toBe(true);
  });

  // 通用入口：新代码只用命令和查询（名字、输入就是注册表里的）
  route('POST /api/commands/:name', async () => {
    const res = await call('POST', '/api/commands/curation.setRating', { ids: ['i5'], value: 'sensitive' });
    expect([res.status, res.json]).toEqual([200, withUndo]);
    expect([res.res.headers['x-emaki-command'], res.res.headers['x-emaki-undo']]).toEqual(['curation.setRating', 'token']);
    expect(Number(res.res.headers['x-emaki-event'])).toBeGreaterThan(0);
    expect((await call('POST', '/api/commands/curation.setRating', { ids: ['i5'], value: 'nsfw' })).status).toBe(400);
    expect((await call('POST', '/api/commands/no.such', {})).status).toBe(404);
    // 查询不能当命令执行
    expect((await call('POST', '/api/commands/images.list', {})).status).toBe(404);
    await call('POST', `/api/undo/${res.json.undoToken}`);
  });

  route('GET /api/queries/:name', async () => {
    const { status, json } = await call('GET', '/api/queries/images.list?limit=2&favorite=true');
    expect([status, json]).toMatchObject([200, page]);
    expect((await call('GET', '/api/queries/curation.link')).status).toBe(404);
  });

  route('POST /api/library-roots', async () => {
    // 演示部件不碰用户的文件夹：参数校验通过后拒绝
    const { status, json } = await call('POST', '/api/library-roots', { path: 'F:/NewPics' });
    expect([status, json]).toEqual([400, apiError('bad_request')]);
    expect(json.error).toBe('演示数据不支持添加图库文件夹');
    expect((await call('POST', '/api/library-roots', { path: '' })).status).toBe(400);
    const comic = await call('POST', '/api/library-roots', { path: 'F:/Manga', mode: 'comic', comicRating: 'questionable' });
    expect(comic.json.error).toBe('演示数据不支持添加图库文件夹');
    expect((await call('GET', '/api/settings')).json.libraryRoots).toHaveLength(2);
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
    const sub = await call('PATCH', '/api/library-roots/root1', { comicFolder: { relDir: 'Manga', comicRating: 'sensitive' } });
    expect([sub.status, sub.json]).toEqual([200, withUndo]);
    expect((await call('PATCH', '/api/library-roots/root1', { removeComicFolder: 'Manga' })).status).toBe(200);
    expect((await call('PATCH', '/api/library-roots/root1', { removeComicFolder: 'Manga' })).status).toBe(404);
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
    const start=vi.spyOn(ds.registry,'execute');
    expect((await call('POST','/api/jobs',{kind:'pixiv-tags',refreshPixiv:true})).status).toBe(200);
    expect(start).toHaveBeenLastCalledWith('jobs.start',{kind:'pixiv-tags',refreshPixiv:true},expect.objectContaining({actor:'user'}));
    start.mockRestore();
    expect((await call('POST','/api/jobs',{kind:'scan',refreshPixiv:true})).status).toBe(400);
    expect((await call('POST','/api/jobs',{kind:'pixiv-tags',refreshPixiv:'yes'})).status).toBe(400);
  });

  route('DELETE /api/jobs/:id', async () => {
    const job = (await call('POST', '/api/jobs', { kind: 'scan' })).json as { id: string };
    const { status, json } = await call('DELETE', `/api/jobs/${job.id}`);
    expect([status, json]).toEqual([200, { ok: true }]);
  });

  route('POST /api/undo/:token', async () => {
    const token = (await call('POST', '/api/images/bulk', { ids: ['i3'], action: { type: 'favorite', value: true } })).json.undoToken as string;
    const { status, json } = await call('POST', `/api/undo/${token}`);
    expect([status, json]).toMatchObject([200, mutation]);
    expect((await call('GET', '/api/images/i3')).json.favorite).toBe(false);
    const again = await call('POST', `/api/undo/${token}`);
    expect([again.status, again.json]).toEqual([404, apiError('not_found')]);
  });

  route('POST /api/undo/status', async () => {
    const token = (await call('POST', '/api/images/bulk', { ids: ['i4'], action: { type: 'favorite', value: true } })).json.undoToken as string;
    const live = await call('POST', '/api/undo/status', { tokens: [token, 'nope'] });
    expect([live.status, live.json]).toEqual([200, { status: { [token]: 'live', nope: 'expired' } }]);
    await call('POST', `/api/undo/${token}`);
    expect((await call('POST', '/api/undo/status', { tokens: [token] })).json).toEqual({ status: { [token]: 'undone' } });
    // 和 GET 共用一个 schema：逗号分隔的字符串也认（GET 的查询串就是这样）；不是字符串、数组的照样 400
    expect((await call('POST', '/api/undo/status', { tokens: 5 })).status).toBe(400);
  });

  route('GET /api/undo/status', async () => {
    const token = (await call('POST', '/api/images/bulk', { ids: ['i4'], action: { type: 'favorite', value: false } })).json.undoToken as string;
    const live = await call('GET', `/api/undo/status?tokens=${token},nope`);
    expect([live.status, live.json]).toEqual([200, { status: { [token]: 'live', nope: 'expired' } }]);
    await call('POST', `/api/undo/${token}`);
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
      await ds.updateImage(id('i4'), { favorite: true });
      while (!text.includes('"type":"changed"')) text += decoder.decode((await reader.read()).value);
      expect(text).toMatch(/^retry: 3000\n\n/);
    } finally {
      ac.abort();
    }
  });

  it('未知接口 → 404', async () => {
    expect((await call('GET', '/api/no-such-route')).status).toBe(404);
  });
});

describe('按姿势找图（实验，注册表：pose.*）', () => {
  // 演示部件没有姿势模型：关着时只有状态能看，准备模型的命令只做校验，不联网
  route('GET /api/pose/status', async () => {
    const { status, json } = await call('GET', '/api/pose/status');
    expect(status).toBe(200);
    expect(json).toMatchObject({
      enabled: false,
      models: { ready: false, repo: 'deepghs/anime_person_detection、yzd-v/DWPose', download: { state: 'idle' } },
      job: null,
      rerun: false,
      tags: { requested: false, job: null },
    });
    expect(json.counts).toMatchObject({ eligible: expect.any(Number), processed: 0, outdated: 0 });
    expect(json.models.files.map((f: { name: string }) => f.name)).toEqual(['person_detect_v1.1_m/model.onnx', 'person_detect_v1.1_m/threshold.json', 'dw-ll_ucoco_384.onnx']);
  });
  // 换了找人模型后重提旧的、补充姿势标签、导入原型的低分（细节在 services/pose/rerun.test.ts、domain/evidence/poseTags.test.ts）
  route('POST /api/pose/reextract', async () => {
    expect((await call('POST', '/api/pose/reextract')).status).toBe(403);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const r = await call('POST', '/api/pose/reextract');
    expect([r.status, r.json.error]).toEqual([400, expect.stringContaining('姿势模型')]);
  });
  route('POST /api/pose/tags/backfill', async () => {
    expect((await call('POST', '/api/pose/tags/backfill')).status).toBe(403);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const r = await call('POST', '/api/pose/tags/backfill');
    expect([r.status, r.json.count]).toEqual([200, 0]);
  });
  route('POST /api/pose/tags/import', async () => {
    expect((await call('POST', '/api/pose/tags/import', { path: 'Z:/no/such.npz' })).status).toBe(403);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const r = await call('POST', '/api/pose/tags/import', { path: 'Z:/no/such.npz' });
    expect([r.status, r.json.error]).toEqual([400, expect.stringContaining('找不到文件')]);
  });
  route('POST /api/pose/models/download', async () => {
    // 没有同意不下载
    const r = await call('POST', '/api/pose/models/download', { consent: false });
    expect([r.status, r.json.code]).toEqual([400, 'bad_request']);
  });
  route('DELETE /api/pose/models/download', async () => {
    const r = await call('DELETE', '/api/pose/models/download');
    expect([r.status, r.json.message]).toEqual([200, '没有在下载']);
  });
  route('POST /api/pose/models/copy', async () => {
    const r = await call('POST', '/api/pose/models/copy', { path: 'Z:/no/such/dir' });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('找不到文件夹');
  });
  route('POST /api/pose/import', async () => {
    const r = await call('POST', '/api/pose/import', { keypointsPath: 'a.npz', assignmentsPath: 'b.json' });
    expect([r.status, r.json]).toEqual([403, apiError('forbidden')]);
  });
  route('POST /api/pose/extract', async () => {
    expect((await call('POST', '/api/pose/extract')).status).toBe(403);
    // 打开要先有模型
    const on = await call('PATCH', '/api/settings', { pose: { enabled: true } });
    expect([on.status, on.json.error]).toEqual([400, expect.stringContaining('姿势模型')]);
  });
  route('GET /api/pose/classes', async () => {
    expect((await call('GET', '/api/pose/classes')).status).toBe(403);
    expect((await call('GET', '/api/images?poseClass=full_01')).status).toBe(403);
    // 直接打开（跳过模型检查）：类别随仓库分发
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    ensurePoseClasses(ds.ctx);
    const { status, json } = await call('GET', '/api/pose/classes');
    expect(status).toBe(200);
    expect(json.groups.map((g: { id: string }) => g.id)).toEqual(['full', 'mid', 'waist', 'bust']);
    expect(json.groups[0].classes[0]).toMatchObject({ id: 'full_01', count: 0, figureUrl: '/api/pose/classes/full_01/figure.png?v=2' });
    const list = await call('GET', '/api/images?poseClass=full_01');
    expect([list.status, list.json.total]).toEqual([200, 0]);
    expect((await call('GET', '/api/images?poseClass=bogus')).status).toBe(400);
  });
  route('GET /api/pose/classes/:id/figure.png', async () => {
    expect((await call('GET', '/api/pose/classes/full_01/figure.png')).status).toBe(403);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    ensurePoseClasses(ds.ctx);
    const { status, res } = await call('GET', '/api/pose/classes/full_01/figure.png?v=2');
    expect([status, res.headers['content-type']]).toEqual([200, 'image/png']);
    expect(res.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect((await call('GET', '/api/pose/classes/full_99/figure.png')).status).toBe(404);
  });
  route('GET /api/pose/similar/:id', async () => {
    expect((await call('GET', '/api/pose/similar/i1')).status).toBe(403);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const { status, json } = await call('GET', '/api/pose/similar/i1');
    // 这张图还没有姿势数据
    expect([status, json.items, json.source.classId]).toEqual([200, [], null]);
  });
  // PoseWear 姿势库：导入、目录、线稿、每张图的匹配（细节在 domain/pose/posewear.test.ts）
  route('POST /api/pose/posewear/import', async () => {
    expect((await call('POST', '/api/pose/posewear/import', { path: 'Z:/no/such/dir' })).status).toBe(403);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const r = await call('POST', '/api/pose/posewear/import', { path: 'Z:/no/such/dir' });
    expect([r.status, r.json.error]).toEqual([400, expect.stringContaining('找不到文件夹')]);
  });
  route('POST /api/pose/posewear/matches', async () => {
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const r = await call('POST', '/api/pose/posewear/matches', { assignmentsPath: 'Z:/no/such.json' });
    expect([r.status, r.json.error]).toEqual([400, expect.stringContaining('找不到文件')]);
  });
  route('GET /api/pose/posewear', async () => {
    expect((await call('GET', '/api/pose/posewear')).status).toBe(403);
    expect((await call('GET', '/api/images?posewearPose=full_single_P001')).status).toBe(403);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const { status, json } = await call('GET', '/api/pose/posewear?all=1');
    expect([status, json]).toEqual([200, { sets: [], poses: 0 }]);
    const list = await call('GET', '/api/images?posewearPose=full_single_P001');
    expect([list.status, list.json.total]).toEqual([200, 0]);
    expect((await call('GET', '/api/images?posewearPose=pair60_P001')).status).toBe(400);
  });
  route('GET /api/pose/posewear/:size/:file', async () => {
    expect((await call('GET', '/api/pose/posewear/t/full_single_P001_front.webp')).status).toBe(403);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    // 没导入过
    expect((await call('GET', '/api/pose/posewear/t/full_single_P001_front.webp')).status).toBe(404);
    expect((await call('GET', '/api/pose/posewear/x/full_single_P001_front.webp')).status).toBe(400);
  });
  route('GET /api/pose/posewear-match/:id', async () => {
    expect((await call('GET', '/api/pose/posewear-match/i1')).status).toBe(403);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const { status, json } = await call('GET', '/api/pose/posewear-match/i1');
    expect([status, json.primary, json.related]).toEqual([200, null, []]);
  });
  route('GET /api/pose/posewear-low/:pose', async () => {
    expect((await call('GET', '/api/pose/posewear-low/full_single_P001')).status).toBe(403);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    expect(await call('GET', '/api/pose/posewear-low/pair_P054')).toMatchObject({ status: 200, json: { ids: [] } });
    expect((await call('GET', '/api/pose/posewear-low/pair60_P054')).status).toBe(400);
  });
  // Emaki 自己匹配 PoseWear 姿势（细节在 services/pose/posewearMatch.test.ts）
  route('GET /api/pose/posewear-skeleton/:id', async () => {
    expect((await call('GET', '/api/pose/posewear-skeleton/full_single_P001')).status).toBe(403);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const { status, json } = await call('GET', '/api/pose/posewear-skeleton/pair_P054?view=front');
    expect([status, json.poseId, json.persons.length, json.persons[0].points.length]).toEqual([200, 'pair_P054', 2, 23]);
    expect((await call('GET', '/api/pose/posewear-skeleton/full_single_P999')).status).toBe(404);
    expect((await call('GET', '/api/pose/posewear-skeleton/full_single_P001?view=top')).status).toBe(400);
  });
  route('POST /api/pose/rematch', async () => {
    expect((await call('POST', '/api/pose/rematch')).status).toBe(403);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const r = await call('POST', '/api/pose/rematch', { all: true });
    expect([r.status, r.json.kind]).toEqual([200, 'pose-match']);
    expect(r.res.headers['x-emaki-undo']).toBe('barrier');
    // 目录随包，「重新匹配」时同步进库
    expect((await call('GET', '/api/pose/posewear?all=1')).json.poses).toBeGreaterThan(200);
  });
});

describe('手机访问（注册表：access.*、devices.*，只在本机入口；局域网入口本身见 test/access/）', () => {
  /** 手机那一侧：直接调配对（提交、公开随机数），返回本机页面看到的请求 */
  const pairRequest = () => {
    const nonce = randomBytes(32);
    const commit = createHash('sha256').update(nonce).digest('hex');
    const { id: key } = ds.access.pairing.start({ name: 'Pixel 7', model: 'Pixel 7', commit }, '192.168.1.20') as { id: string };
    ds.access.pairing.reveal(key, nonce.toString('hex'));
    return { key, info: ds.access.status().requests.at(-1)! };
  };
  const status = { enabled: false, port: 5175, listening: false, error: null, requests: [], devices: [] };

  route('GET /api/access', async () => {
    const { status: code, json } = await call('GET', '/api/access');
    expect(code).toBe(200);
    expect(json).toMatchObject({
      ...status,
      name: null,
      defaultName: expect.any(String),
      serverId: expect.stringMatching(/^[0-9a-f]{32}$/),
      fingerprint: null,
    });
    expect(json.addresses).toEqual(expect.any(Array));
  });

  route('PATCH /api/access', async () => {
    const { status: code, json, res } = await call('PATCH', '/api/access', { enabled: true, port: 5299, name: '书房' });
    expect(code).toBe(200);
    // 测试里没有局域网入口的控制器：存下了，但没在监听
    expect(json).toMatchObject({ ok: true, status: { enabled: true, port: 5299, name: '书房', listening: false } });
    expect(res.headers['x-emaki-undo']).toBe('none');
    expect((await call('PATCH', '/api/access', { port: 80 })).status).toBe(400);
    expect((await call('PATCH', '/api/access', { name: null })).json.status.name).toBeNull();
  });

  route('POST /api/access/tickets', async () => {
    expect((await call('POST', '/api/access/tickets')).status).toBe(409);
    await call('PATCH', '/api/access', { enabled: true });
    const { status: code, json } = await call('POST', '/api/access/tickets');
    expect(code).toBe(200);
    const uri = /^emaki:\/\/pair\?id=[0-9a-f]{32}&fp=[0-9a-f]{64}&p=5175&h=[^&]*&t=/;
    expect(json).toEqual({ uri: expect.stringMatching(uri), expiresAt: expect.any(String) });
  });

  route('POST /api/access/requests/:id/approve', async () => {
    const { key, info } = pairRequest();
    expect(info).toMatchObject({ code: expect.stringMatching(/^\d{6}$/), name: 'Pixel 7', address: '192.168.1.20' });
    const approve = (id: string, body?: object) => call('POST', `/api/access/requests/${id}/approve`, body);
    const { status: code, json } = await approve(info.id, { scopes: ['read', 'settings'], name: '我的手机' });
    const device = expect.objectContaining({ name: '我的手机', scopes: ['read', 'settings'] });
    expect([code, json]).toEqual([200, { ok: true, message: '已批准「我的手机」', device }]);
    expect(await ds.access.pairing.status(key)).toMatchObject({ status: 'approved', token: expect.any(String) });
    expect((await approve(info.id)).status).toBe(404);
    // 设备永远拿不到的范围
    expect((await approve(pairRequest().info.id, { scopes: ['devices'] })).status).toBe(400);
  });

  route('POST /api/access/requests/:id/reject', async () => {
    const { key, info } = pairRequest();
    const rejected = await call('POST', `/api/access/requests/${info.id}/reject`);
    expect(rejected).toMatchObject({ status: 200, json: { ok: true, message: '已拒绝' } });
    expect((await call('GET', '/api/access')).json.requests).toEqual([]);
    expect(await ds.access.pairing.status(key)).toEqual({ status: 'rejected' });
  });

  route('PATCH /api/devices/:id', async () => {
    const { device } = ds.access.devices.create({ name: 'Pixel 7', model: null, scopes: ['read'] });
    const { status: code, json } = await call('PATCH', `/api/devices/${device.id}`, { name: '旧手机', scopes: ['read', 'curate'] });
    expect([code, json.device]).toEqual([200, expect.objectContaining({ id: device.id, name: '旧手机', scopes: ['read', 'curate'] })]);
    expect((await call('PATCH', `/api/devices/${device.id}`, { scopes: ['desktop'] })).status).toBe(400);
    expect((await call('PATCH', '/api/devices/nope', { name: 'x' })).status).toBe(404);
  });

  route('DELETE /api/devices/:id', async () => {
    const { device, token } = ds.access.devices.create({ name: 'Pixel 7', model: null, scopes: ['read'] });
    const removed = await call('DELETE', `/api/devices/${device.id}`);
    expect(removed).toMatchObject({ status: 200, json: { ok: true, message: '已移除「Pixel 7」' } });
    expect(ds.access.devices.authenticate(token)).toEqual({ error: 'device_revoked' });
    expect((await call('GET', '/api/access')).json.devices).toEqual([]);
    expect((await call('DELETE', `/api/devices/${device.id}`)).status).toBe(404);
  });
});

describe('插件（注册表：plugins.*，docs/plugins.md 第 9 节）', () => {
  route('GET /api/plugins', async () => {
    const { status, json } = await call('GET', '/api/plugins');
    expect(status).toBe(200);
    expect(json.safeMode).toBe(false);
    expect(json.plugins.find((p: { id: string }) => p.id === 'core.annex')).toMatchObject({ enabled: true, source: 'builtin' });
    expect((await call('GET', '/api/plugins?safe=1')).json.safeMode).toBe(true);
  });
  route('POST /api/plugins/:id/enabled', async () => {
    expect(await call('POST', '/api/plugins/core.annex/enabled', { enabled: false })).toMatchObject({ status: 200, json: { ok: true, message: '已停用「别册」' } });
    expect((await call('GET', '/api/plugins')).json.disabledPages).toEqual(['annex']);
    expect((await call('POST', '/api/plugins/core.settings/enabled', { enabled: false })).status).toBe(400);
    expect((await call('POST', '/api/plugins/nope/enabled', { enabled: true })).status).toBe(404);
  });
  route('POST /api/plugins/:id/name', async () => {
    expect(await call('POST', '/api/plugins/core.annex/name', { name: '杂项' })).toMatchObject({ status: 200, json: { message: '已改名为「杂项」' } });
    expect((await call('POST', '/api/plugins/core.annex/name', { name: '' })).status).toBe(400);
  });
  route('POST /api/plugins/overrides', async () => {
    const made = await call('POST', '/api/plugins/overrides', { name: '按修改时间', values: { 'images.defaultSort': 'modifiedAt' } });
    expect(made).toMatchObject({ status: 200, json: { ok: true, id: 'mine.override-1', message: '已新建并启用「按修改时间」' } });
    expect((await call('POST', '/api/plugins/overrides', { name: 'x', values: { 'images.defaultSort': 'page' } })).status).toBe(400);
  });
  route('POST /api/plugins/:id/overrides', async () => {
    const { json } = await call('POST', '/api/plugins/overrides', { name: 'A', values: { 'images.defaultSort': 'modifiedAt' } });
    expect((await call('POST', `/api/plugins/${json.id}/overrides`, { values: { 'images.defaultSort': 'bytes' } })).status).toBe(200);
    expect((await call('GET', '/api/plugins')).json.overrides['images.defaultSort'].value).toBe('bytes');
  });
  route('POST /api/plugins/overrides/choice', async () => {
    const a = (await call('POST', '/api/plugins/overrides', { name: 'A', values: { 'images.defaultSort': 'modifiedAt' } })).json.id;
    await call('POST', '/api/plugins/overrides', { name: 'B', values: { 'images.defaultSort': 'bytes' } });
    expect((await call('POST', '/api/plugins/overrides/choice', { key: 'images.defaultSort', plugin: a })).status).toBe(200);
    expect((await call('GET', '/api/plugins')).json.overrides['images.defaultSort'].value).toBe('modifiedAt');
    expect((await call('POST', '/api/plugins/overrides/choice', { key: 'nope', plugin: null })).status).toBe(400);
  });
  route('DELETE /api/plugins/:id', async () => {
    const { json } = await call('POST', '/api/plugins/overrides', { name: 'A', values: { 'images.defaultSort': 'modifiedAt' } });
    expect(await call('DELETE', `/api/plugins/${json.id}`)).toMatchObject({ status: 200, json: { message: '已删除「A」' } });
    expect((await call('DELETE', '/api/plugins/core.gallery')).status).toBe(400);
  });
  route('POST /api/plugins/nav', async () => {
    const r = await call('POST', '/api/plugins/nav', { visible: { plugins: true } });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    expect((await call('GET', '/api/plugins')).json.nav.footer.find((n: { id: string }) => n.id === 'plugins').visible).toBe(true);
    expect((await call('POST', '/api/plugins/nav', {})).status).toBe(400);
    expect((await call('POST', '/api/plugins/nav', { visible: { settings: false } })).status).toBe(400);
  });

  // 装插件（E2）：先准备（zip / 文件夹 / git），再按授权单装
  const sampleManifest = {
    id: 'example.smoke',
    name: '冒烟',
    version: '0.1.0',
    contributes: { 'override@1': { 'images.defaultSort': 'modifiedAt' } },
  };
  const putZip = (body: Buffer, name = 'smoke.zip') =>
    app.inject({ method: 'PUT', url: `/api/plugins/packages?name=${encodeURIComponent(name)}`, payload: body, headers: { 'content-type': 'application/zip' } });
  route('PUT /api/plugins/packages', async () => {
    const res = await putZip(makeZip({ 'emaki-plugin.json': JSON.stringify(sampleManifest) }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: { kind: 'file', location: 'smoke.zip' }, manifest: { id: 'example.smoke' }, problems: [], added: {} });
    expect((await putZip(Buffer.from('nope'))).statusCode).toBe(400);
  });
  route('POST /api/plugins/install', async () => {
    const { token } = (await putZip(makeZip({ 'emaki-plugin.json': JSON.stringify(sampleManifest) }))).json();
    expect(await call('POST', '/api/plugins/install', { token })).toMatchObject({ status: 200, json: { ok: true, id: 'example.smoke', message: '已安装并启用「冒烟」' } });
    expect((await call('GET', '/api/plugins')).json.overrides['images.defaultSort']).toMatchObject({ value: 'modifiedAt', plugin: 'example.smoke' });
    expect((await call('POST', '/api/plugins/install', { token })).status).toBe(400);
  });
  route('POST /api/plugins/packages/inspect', async () => {
    const dir = makeTmpDir('smoke-plugin');
    writeFileSync(path.join(dir, 'emaki-plugin.json'), JSON.stringify(sampleManifest));
    const { status, json } = await call('POST', '/api/plugins/packages/inspect', { source: { kind: 'folder', path: dir } });
    expect(status).toBe(200);
    expect(json).toMatchObject({ source: { kind: 'folder', location: dir }, manifest: { id: 'example.smoke' } });
    expect((await call('POST', '/api/plugins/packages/inspect', { source: { kind: 'git', url: 'ext::sh -c id' } })).status).toBe(400);
  });
  route('POST /api/plugins/:id/check-update', async () => {
    const dir = makeTmpDir('smoke-plugin');
    writeFileSync(path.join(dir, 'emaki-plugin.json'), JSON.stringify(sampleManifest));
    const { json } = await call('POST', '/api/plugins/packages/inspect', { source: { kind: 'folder', path: dir } });
    await call('POST', '/api/plugins/install', { token: json.token });
    writeFileSync(path.join(dir, 'emaki-plugin.json'), JSON.stringify({ ...sampleManifest, version: '0.2.0' }));
    const upd = await call('POST', '/api/plugins/example.smoke/check-update');
    expect(upd).toMatchObject({ status: 200, json: { manifest: { version: '0.2.0' }, current: { version: '0.1.0' } } });
    expect((await call('POST', '/api/plugins/core.annex/check-update')).status).toBe(400);
  });
  route('GET /api/plugins/packages/:token', async () => {
    const { token } = (await putZip(makeZip({ 'emaki-plugin.json': JSON.stringify(sampleManifest) }))).json();
    expect(await call('GET', `/api/plugins/packages/${token}`)).toMatchObject({ status: 200, json: { token, manifest: { id: 'example.smoke' } } });
    expect((await call('GET', '/api/plugins/packages/nope')).status).toBe(404);
  });

  // 视图（E4）：装一个带页面的插件，打开、调工具、记错、取图
  const viewManifest = {
    id: 'example.view',
    name: '视图',
    version: '0.1.0',
    permissions: { scopes: ['read'] },
    contributes: { 'page@1': [{ id: 'main', view: 'index.html' }], 'nav.item@1': [{ id: 'main', label: '视图', page: 'main' }] },
  };
  const installView = async () => {
    const { token } = (await putZip(makeZip({ 'emaki-plugin.json': JSON.stringify(viewManifest), 'index.html': '<p>hi</p>' }))).json();
    await call('POST', '/api/plugins/install', { token });
  };
  route('GET /api/plugins/:id/pages/:page', async () => {
    await installView();
    const { status, json } = await call('GET', '/api/plugins/example.view/pages/main');
    expect(status).toBe(200);
    expect(json).toMatchObject({ pluginId: 'example.view', pageId: 'main', title: '视图', html: '<p>hi</p>', mediaBase: expect.stringMatching(/^\/api\/plugin-media\//) });
    expect(json.tools.map((t: { name: string }) => t.name)).toEqual(['read_library', 'read_media']);
    expect((await call('GET', '/api/plugins/example.view/pages/nope')).status).toBe(404);
  });
  route('POST /api/plugins/:id/call', async () => {
    await installView();
    const r = await call('POST', '/api/plugins/example.view/call', { name: 'read_library', arguments: { path: '/api/summary' } });
    expect(r.status).toBe(200);
    expect(r.json.isError).toBeUndefined();
    const denied = await call('POST', '/api/plugins/example.view/call', { name: 'curation_set_favorite', arguments: { operationId: 'x', ids: ['1'], value: true } });
    expect(denied).toMatchObject({ status: 200, json: { isError: true } });
    expect((await call('POST', '/api/plugins/core.annex/call', { name: 'read_library', arguments: {} })).status).toBe(409);
  });
  route('POST /api/plugins/:id/storage', async () => {
    await installView();
    expect(await call('POST', '/api/plugins/example.view/storage', { op: 'set', key: 'tab', value: { a: 1 } })).toMatchObject({ status: 200 });
    expect((await call('POST', '/api/plugins/example.view/storage', { op: 'get', key: 'tab' })).json).toMatchObject({ value: { a: 1 } });
    expect((await call('POST', '/api/plugins/example.view/storage', { op: 'list' })).json).toMatchObject({ keys: ['tab'] });
    expect((await call('POST', '/api/plugins/example.view/storage', { op: 'nope' })).status).toBe(400);
  });
  route('POST /api/plugins/:id/errors', async () => {
    await installView();
    expect(await call('POST', '/api/plugins/example.view/errors', { message: '握手超时' })).toMatchObject({ status: 200, json: { autoDisabled: false } });
    expect((await call('POST', '/api/plugins/example.view/errors', {})).status).toBe(400);
  });
  route('GET /api/plugin-media/:token/:size/:imageId', async () => {
    await installView();
    const { json } = await call('GET', '/api/plugins/example.view/pages/main');
    const images = (await call('GET', '/api/images?limit=1')).json.items as { id: string }[];
    if (images[0]) expect((await app.inject({ method: 'GET', url: `${json.mediaBase}/thumb/${images[0].id}` })).statusCode).not.toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/plugin-media/nope/thumb/1' })).statusCode).toBe(404);
  });
  route('GET /api/plugin-media/:token/file/*', async () => {
    await installView();
    const { json } = await call('GET', '/api/plugins/example.view/pages/main');
    const dir = ds.plugins.dataDir('example.view');
    mkdirSync(path.join(dir, 'cache'), { recursive: true });
    writeFileSync(path.join(dir, 'cache', 'a.png'), 'png');
    writeFileSync(path.join(dir, 'notes.txt'), 'txt');
    const get = async (rel: string) => (await app.inject({ method: 'GET', url: `${json.mediaBase}/file/${rel}` })).statusCode;
    expect(await get('cache/a.png')).toBe(200);
    // 只给插件文件夹里的图片
    expect(await get('notes.txt')).toBe(404);
    expect(await get('..%2F..%2F..%2Femaki.sqlite')).toBe(404);
    expect(await get('cache/none.png')).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/plugin-media/nope/file/a.png' })).statusCode).toBe(404);
  });
  route('POST /api/plugins/:id/settings', async () => {
    await installView();
    // 这个插件没有设置
    expect(await call('POST', '/api/plugins/example.view/settings', { values: { a: 'b' } })).toMatchObject({ status: 400 });
    expect((await call('POST', '/api/plugins/nope/settings', { values: {} })).status).toBe(404);
  });
  route('POST /api/plugins/ai-views', async () => {
    const r = await call('POST', '/api/plugins/ai-views', { name: 'smoke', title: '冒烟页', html: '<p>ai</p>' });
    expect(r).toMatchObject({ status: 200, json: { status: 'needs_confirmation', id: 'ai.smoke', name: '冒烟页', version: '1.0.0' } });
    expect((await call('POST', '/api/plugins/ai-views', { name: 'smoke', title: '冒烟页', html: '<p>ai</p>', scopes: ['settings'] })).status).toBe(400);
  });
});

describe('手机上传（注册表：upload.*、devices.setUpload；http/uploads.ts）：本机入口上没有设备，传不了；整套流程见 test/upload/', () => {
  const sha = 'a'.repeat(64);
  route('POST /api/uploads/check', async () => {
    const { status, json } = await call('POST', '/api/uploads/check', { files: [{ sha256: sha, size: 10 }] });
    expect([status, json]).toEqual([200, { results: [{ sha256: sha, imageId: null, deleted: false, dir: null }] }]);
    expect((await call('POST', '/api/uploads/check', { files: [{ sha256: 'xyz', size: 10 }] })).status).toBe(400);
  });
  route('POST /api/uploads', async () => {
    const begin = { batchId: '7f1d6f0a-1c2b-4c5d-8e9f-0a1b2c3d4e5f', sha256: sha, size: 10, fileName: 'a.png' };
    const { status, json } = await call('POST', '/api/uploads', begin);
    expect([status, json]).toEqual([400, apiError('bad_request')]);
  });
  route('PUT /api/uploads/:id', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/uploads/u1?offset=0', payload: Buffer.from('abc'), headers: { 'content-type': 'application/octet-stream' } });
    expect([res.statusCode, res.json()]).toEqual([400, apiError('bad_request')]);
  });
  route('POST /api/uploads/:id/complete', async () => {
    expect((await call('POST', '/api/uploads/u1/complete')).status).toBe(400);
  });
  route('GET /api/uploads/batches', async () => {
    expect(await call('GET', '/api/uploads/batches')).toMatchObject({ status: 200, json: [] });
  });
  route('POST /api/uploads/batches/:id/undo', async () => {
    expect(await call('POST', '/api/uploads/batches/nope/undo')).toMatchObject({ status: 404, json: apiError('not_found') });
  });
  route('GET /api/uploads/targets', async () => {
    expect(await call('GET', '/api/uploads/targets')).toMatchObject({ status: 200, json: [] });
  });
  route('PATCH /api/devices/:id/upload', async () => {
    expect(await call('PATCH', '/api/devices/nope/upload', { rootId: null })).toMatchObject({ status: 404, json: apiError('not_found') });
  });
  // 同步相册（docs/mobile.md 5.5）：本机入口上要给 deviceId；报相册只有设备能调
  route('GET /api/uploads/albums', async () => {
    expect(await call('GET', '/api/uploads/albums')).toMatchObject({ status: 400, json: apiError('bad_request') });
    expect(await call('GET', '/api/uploads/albums?deviceId=nope')).toMatchObject({ status: 404, json: apiError('not_found') });
    const { device } = ds.access.devices.create({ name: 'Pixel 7', model: null, scopes: ['upload'] });
    const { status, json } = await call('GET', `/api/uploads/albums?deviceId=${device.id}`);
    expect([status, json]).toEqual([200, expect.objectContaining({ deviceId: device.id, albums: [], wifiOnly: true, chargingOnly: false })]);
  });
  route('POST /api/uploads/albums', async () => {
    expect(await call('POST', '/api/uploads/albums', { albums: [] })).toMatchObject({ status: 400, json: apiError('bad_request') });
  });
  route('PATCH /api/uploads/albums', async () => {
    const { device } = ds.access.devices.create({ name: 'Pixel 7', model: null, scopes: ['upload'] });
    const { status, json } = await call('PATCH', '/api/uploads/albums', { deviceId: device.id, wifiOnly: false });
    expect([status, json.info.wifiOnly]).toEqual([200, false]);
    expect(await call('PATCH', '/api/uploads/albums', { deviceId: device.id, albums: [{ path: 'Download', sync: true }] })).toMatchObject({
      status: 404,
      json: apiError('not_found'),
    });
  });
});

describe('本机安全（T23）', () => {
  it('非本机 Host → 403（防 DNS rebinding）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example' } });
    expect([res.statusCode, res.json()]).toEqual([403, apiError('forbidden')]);
    for (const host of ['127.0.0.1:5174', 'localhost:5173', '[::1]:5174']) {
      expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host } })).statusCode).toBe(200);
    }
  });

  it('POST 不是 JSON → 415（防跨站表单 / text/plain）', async () => {
    const bare = await app.inject({ method: 'POST', url: `/api/characters/${id('c1')}/seen` });
    expect([bare.statusCode, bare.json()]).toEqual([415, apiError('bad_request')]);
    const text = await app.inject({ method: 'POST', url: '/api/undo/x', headers: { 'content-type': 'text/plain' }, payload: 'x' });
    expect(text.statusCode).toBe(415);
    // 百分号编码的路径路由时会解码，照样命中 /api/...，也要拦
    for (const url of ['/%61pi/characters/c1/seen', '/a%70i/system/network-check', '/%61pi/duplicates/d1/ignore']) {
      const res = await app.inject({ method: 'POST', url, headers: { 'content-type': 'text/plain' }, payload: 'x' });
      expect([url, res.statusCode]).toEqual([url, 415]);
    }
    expect((await call('GET', '/api/duplicates')).json).toHaveLength(1);
  });

  // 开发时 vite 代理不改 Host（changeOrigin: false），生产和桌面窗口都是 127.0.0.1:5174 同源
  const own = [
    { host: 'localhost:5173', origin: 'http://localhost:5173' },
    { host: '127.0.0.1:5174', origin: 'http://127.0.0.1:5174' },
  ];

  it('自己的页面：Origin 和 Host 一致 → 放行', async () => {
    for (const { host, origin } of own) {
      const headers = { host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
      const res = await app.inject({ method: 'POST', url: `/api/characters/${id('c1')}/seen`, headers, payload: '{}' });
      expect([host, res.statusCode]).toEqual([host, 200]);
      const get = await app.inject({ method: 'GET', url: '/api/health', headers: { host, 'sec-fetch-site': 'same-origin' } });
      expect(get.statusCode).toBe(200);
    }
  });

  it('本机其他端口的页面 → 403，没有 CORS 头', async () => {
    const evil = { host: '127.0.0.1:5174', origin: 'http://127.0.0.1:8188' };
    const bulk = await app.inject({
      method: 'POST',
      url: '/api/images/bulk',
      headers: { ...evil, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' },
      payload: { ids: [id('i1')], action: { type: 'trash' } },
    });
    expect([bulk.statusCode, bulk.json()]).toEqual([403, apiError('forbidden')]);
    expect(bulk.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/images/bulk',
      headers: { ...evil, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.statusCode).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    const read = await app.inject({ method: 'GET', url: '/api/images?limit=2', headers: { host: '127.0.0.1:5174', origin: 'http://localhost:8888' } });
    expect(read.statusCode).toBe(403);
    expect(read.headers['access-control-allow-origin']).toBeUndefined();
    // 不带 Origin、只有 sec-fetch-site 的写请求也拦
    const noOrigin = await app.inject({
      method: 'POST',
      url: `/api/characters/${id('c1')}/seen`,
      headers: { host: '127.0.0.1:5174', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(noOrigin.statusCode).toBe(403);
  });

  it('跨站的图片 GET（<img>、CSS 背景，不带 Origin）照常放行', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/images/${id('i1')}/thumb?w=300`, headers: { host: '127.0.0.1:5174', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('路由清单', () => {
  it('源码里的每个路由都有冒烟用例', () => {
    // P6：HTTP 路由从命令 / 查询注册表生成，另外是 app.ts、http/*.ts 里手写的（SSE、健康检查、通用入口、旧地址的兼容层）
    const declared = new Set<string>(DEFINITIONS.flatMap((d) => (d.http ?? []).map((h) => `${h.method} ${h.path}`)));
    const files = [path.join(SRC, 'app.ts'), ...readdirSync(path.join(SRC, 'http')).filter((f) => f.endsWith('.ts')).map((f) => path.join(SRC, 'http', f))];
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
