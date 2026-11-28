/**
 * 生产模式托管前端（app.ts 的 fastifyStatic）：服务开着的时候重新构建了网页，新文件（带哈希的文件名）也要能读到；
 * 前端路由回落到 index.html，不存在的 /api/ 照旧是 JSON 的 404，本机入口上不存在的构建产物（/assets/）也是 404。
 * 缓存头按实际发出的文件定：构建产物长期缓存，index.html（包括回落出去的）每次核对。本机入口和局域网入口用的是同一套（serveWeb）。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildLanApp } from '../src/access/lan.ts';
import { buildApp } from '../src/app.ts';
import { EventBus } from '../src/core/events.ts';
import { SqliteDataSource } from './helpers/client.ts';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('../src/config.ts', async (importOriginal) => {
  const { mkdtempSync, mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { config } = await importOriginal<typeof import('../src/config.ts')>();
  state.dir = mkdtempSync(join(tmpdir(), 'emaki-static-'));
  const webDist = join(state.dir, 'dist');
  mk(join(webDist, 'assets'), { recursive: true });
  wf(join(webDist, 'index.html'), '<!doctype html><title>emaki</title>');
  wf(join(webDist, 'assets', 'index-old.js'), 'old');
  return { config: { ...config, dataDir: join(state.dir, 'data'), libraryDir: join(state.dir, 'data'), webDist } };
});

const prevLogLevel = process.env.EMAKI_LOG_LEVEL;
process.env.EMAKI_LOG_LEVEL = 'silent';
let app: FastifyInstance;
let ds: SqliteDataSource;
const bus = new EventBus();
beforeAll(async () => {
  ds = await SqliteDataSource.open(bus, path.join(state.dir, 'data'), { memory: true, autoJobs: false, importDict: false });
  app = await buildApp(ds, bus);
});
afterAll(async () => {
  await app.close();
  await ds.close();
  if (prevLogLevel === undefined) delete process.env.EMAKI_LOG_LEVEL;
  else process.env.EMAKI_LOG_LEVEL = prevLogLevel;
  rmSync(state.dir, { recursive: true, force: true, maxRetries: 4 });
});

it('启动以后才构建出来的文件也能读到，前端路由回落到 index.html，不存在的 /api/ 是 JSON 的 404', async () => {
  expect((await app.inject({ url: '/assets/index-old.js' })).body).toBe('old');
  // 服务开着的时候重新构建了网页：多了一个带新哈希的文件
  const dist = path.join(state.dir, 'dist');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  writeFileSync(path.join(dist, 'assets', 'index-new.js'), 'new');
  const fresh = await app.inject({ url: '/assets/index-new.js' });
  expect(fresh.statusCode).toBe(200);
  expect(fresh.body).toBe('new');
  const route = await app.inject({ url: '/gallery?kind=all', headers: { accept: 'text/html' } });
  expect(route.statusCode).toBe(200);
  expect(route.body).toContain('<title>emaki</title>');
  const api = await app.inject({ url: '/api/nope' });
  expect(api.statusCode).toBe(404);
  expect(api.json()).toMatchObject({ ok: false, code: 'not_found' });
});

const IMMUTABLE = 'public, max-age=31536000, immutable';

it('构建产物（文件名带哈希）长期缓存，启动以后才构建出来的也一样', async () => {
  writeFileSync(path.join(state.dir, 'dist', 'assets', 'index-later.js'), 'later');
  for (const url of ['/assets/index-old.js', '/assets/index-later.js', '/assets/index-old.js?v=1']) {
    const res = await app.inject({ url });
    expect([url, res.statusCode, res.headers['cache-control']]).toEqual([url, 200, IMMUTABLE]);
  }
  const head = await app.inject({ method: 'HEAD', url: '/assets/index-old.js' });
  expect([head.statusCode, head.headers['cache-control']]).toEqual([200, IMMUTABLE]);
  // 条件请求的 304 带同样的缓存头
  const etag = String((await app.inject({ url: '/assets/index-old.js' })).headers.etag);
  const again = await app.inject({ url: '/assets/index-old.js', headers: { 'if-none-match': etag } });
  expect([again.statusCode, again.headers['cache-control']]).toEqual([304, IMMUTABLE]);
});

it('index.html 每次核对：直接取、前端路由回落出去的都是 no-cache，重新构建之后马上拿到新的', async () => {
  writeFileSync(path.join(state.dir, 'dist', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  for (const url of ['/', '/index.html', '/gallery?kind=all', '/characters/1', '/favicon.svg']) {
    const res = await app.inject({ url, headers: { accept: 'text/html' } });
    expect([url, res.statusCode, res.headers['cache-control']]).toEqual([url, 200, 'no-cache']);
  }
  const first = await app.inject({ url: '/gallery' });
  expect(first.body).toContain('<title>emaki</title>');
  const same = await app.inject({ url: '/gallery', headers: { 'if-none-match': String(first.headers.etag) } });
  expect([same.statusCode, same.headers['cache-control']]).toEqual([304, 'no-cache']);
  // 重新构建：index.html 换了（大小变了，etag 跟着变），带着旧 etag 来核对拿到的是新的
  const index = path.join(state.dir, 'dist', 'index.html');
  writeFileSync(index, '<!doctype html><title>emaki</title><script type="module" src="/assets/index-later.js"></script>');
  try {
    const rebuilt = await app.inject({ url: '/gallery', headers: { 'if-none-match': String(first.headers.etag) } });
    expect([rebuilt.statusCode, rebuilt.headers['cache-control']]).toEqual([200, 'no-cache']);
    expect(rebuilt.body).toContain('index-later.js');
  } finally {
    writeFileSync(index, '<!doctype html><title>emaki</title>');
  }
});

it('本机入口：不存在的构建产物是 404，不回落成 index.html（重新构建后旧页面来取旧文件），也不带长缓存', async () => {
  for (const url of ['/assets/index-gone.js', '/assets/index-gone.js?v=1', '/%61ssets/index-gone.js', '/assets/sub/gone.css']) {
    const res = await app.inject({ url });
    expect([url, res.statusCode, res.headers['cache-control']]).toEqual([url, 404, 'no-cache']);
    expect(res.json()).toMatchObject({ ok: false, code: 'not_found' });
  }
  // 不在 /assets/ 下的照旧是前端路由
  const route = await app.inject({ url: '/assets' });
  expect([route.statusCode, route.headers['cache-control']]).toEqual([200, 'no-cache']);
  expect(route.body).toContain('<title>emaki</title>');
});

it('局域网入口用的是同一套托管（静态文件不要凭证），缓存头一样', async () => {
  const lan = await buildLanApp(ds, bus, ds.access, ds.access.tls(), { webDist: path.join(state.dir, 'dist') });
  try {
    const asset = await lan.inject({ url: '/assets/index-old.js' });
    expect([asset.statusCode, asset.headers['cache-control'], asset.body]).toEqual([200, IMMUTABLE, 'old']);
    const page = await lan.inject({ url: '/characters/1' });
    expect([page.statusCode, page.headers['cache-control']]).toEqual([200, 'no-cache']);
    expect(page.body).toContain('<title>emaki</title>');
    // 这个入口上不存在的构建产物还是回落到 index.html（test/access/lan.test.ts）。发出去的是 index.html，所以不带长缓存：
    // 旧哈希的地址不会把一份 index.html 缓存一年
    const gone = await lan.inject({ url: '/assets/index-gone.js' });
    expect([gone.statusCode, gone.headers['cache-control']]).toEqual([200, 'no-cache']);
    expect(gone.body).toContain('<title>emaki</title>');
    // 不存在的 /api/ 地址照旧先要凭证
    expect((await lan.inject({ url: '/api/nope' })).statusCode).toBe(401);
  } finally {
    await lan.close();
  }
});

it('长期缓存的前提：dist/assets/ 里只有构建出来的、文件名带哈希的文件', () => {
  // apps/web/public/assets/ 里的文件会原名拷进 dist/assets/，内容变了名字不变，会被浏览器缓存一年：不要在那里放东西
  expect(existsSync(path.resolve(import.meta.dirname, '../../web/public/assets'))).toBe(false);
});
