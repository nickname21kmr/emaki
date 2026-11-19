/**
 * 生产模式托管前端（app.ts 的 fastifyStatic）：服务开着的时候重新构建了网页，新文件（带哈希的文件名）也要能读到；
 * 前端路由回落到 index.html，不存在的 /api/ 照旧是 JSON 的 404。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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
beforeAll(async () => {
  const bus = new EventBus();
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
