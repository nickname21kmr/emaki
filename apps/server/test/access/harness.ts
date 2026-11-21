/**
 * 局域网入口测试的公共部分：真实引擎（演示部件 + 契约夹具，内存库）+ buildLanApp(...).inject()，不开端口。
 *
 * - 证书：RSA 密钥生成要半秒多，一个测试文件只生成一张，写进每个引擎的 <dataDir>/lan（access 读到就不再生成）；
 * - 时钟可以拨：配对的过期、限速、最后访问时间都按引擎的时钟算；
 * - 网页的静态文件放在临时目录（index.html、assets/app.js），不依赖仓库里有没有构建过前端。
 */
import type { Scope } from '@emaki/shared';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createCert, type LanTls } from '../../src/access/cert.ts';
import { buildLanApp } from '../../src/access/lan.ts';
import { EventBus } from '../../src/core/events.ts';
import type { IdMap } from '../../src/demo/seed.ts';
import { NOW } from '../contract/harness.ts';
import { buildContractDb } from '../fixtures/contract-db.ts';
import { openDemoEngine, type SqliteDataSource } from '../helpers/client.ts';
import { makeTmpDir } from '../helpers/tmp.ts';

process.env.EMAKI_LOG_LEVEL = 'silent';

export { NOW };

let sharedCert: { key: string; cert: string } | null = null;

/** 一个测试文件共用的证书（写进 dir/lan，access.tls() 读到就不再生成） */
export function seedCert(dataDir: string): void {
  sharedCert ??= createCert('test-server');
  mkdirSync(path.join(dataDir, 'lan'), { recursive: true });
  writeFileSync(path.join(dataDir, 'lan', 'key.pem'), sharedCert.key);
  writeFileSync(path.join(dataDir, 'lan', 'cert.pem'), sharedCert.cert);
}

export interface LanFixture {
  ds: SqliteDataSource;
  bus: EventBus;
  map: IdMap;
  app: FastifyInstance;
  tls: LanTls;
  dir: string;
  webDist: string;
  /** 把引擎的时钟拨到某个时间（毫秒） */
  setNow(ms: number): void;
  /** 夹具 id（i1、c1 …）→ 库里的 id */
  id(fixtureId: string): string;
  close(): Promise<void>;
}

export async function lanFixture(): Promise<LanFixture> {
  const dir = makeTmpDir('lan');
  let now = NOW;
  const bus = new EventBus();
  const { ds, map } = await openDemoEngine(bus, { dir, memory: true, data: buildContractDb(NOW), now: NOW, clock: () => now });
  seedCert(dir);
  const tls = ds.access.tls();
  const webDist = path.join(dir, 'web');
  mkdirSync(path.join(webDist, 'assets'), { recursive: true });
  writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>Emaki</title>');
  writeFileSync(path.join(webDist, 'assets', 'app.js'), 'console.log(1)');
  const app = await buildLanApp(ds, bus, ds.access, tls, { webDist });
  const kinds: Record<string, keyof IdMap> = { i: 'images', c: 'characters', w: 'works', x: 'exclusions', d: 'duplicates', root: 'roots' };
  return {
    ds,
    bus,
    map,
    app,
    tls,
    dir,
    webDist,
    setNow: (ms) => void (now = ms),
    id: (f) => String(map[kinds[/^[a-z]+/.exec(f)![0]]!]!.get(f)),
    async close() {
      await app.close();
      await ds.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** 直接建一台设备（跳过配对），返回凭证和请求头 */
export function makeDevice(ds: SqliteDataSource, scopes?: readonly Scope[], name = 'Pixel 7') {
  const { device, token } = ds.access.devices.create({
    name,
    model: 'Pixel 7',
    scopes: scopes ?? ['read', 'curate', 'catalog', 'collections', 'history', 'ui', 'upload'],
  });
  return { device, token, auth: { authorization: `Bearer ${token}` } };
}

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** 第 1 步：手机生成 nonceA，提交它的哈希 */
export async function startPair(app: FastifyInstance, opts: { name?: string; address?: string } = {}) {
  const nonceA = randomBytes(32);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/pair',
    payload: { name: opts.name ?? 'Pixel 7', model: 'Pixel 7', commit: sha256Hex(nonceA) },
    ...(opts.address ? { remoteAddress: opts.address } : {}),
  });
  return { nonceA, res, body: res.json() as { id: string; nonce: string; expiresAt: string } };
}

/** 第 1、2 步：提交、公开 nonceA。返回手机这边算出的东西 */
export async function revealPair(app: FastifyInstance, opts: { name?: string; address?: string } = {}) {
  const started = await startPair(app, opts);
  if (started.res.statusCode !== 200) throw new Error(`pair ${started.res.statusCode} ${started.res.body}`);
  const reveal = await app.inject({
    method: 'POST',
    url: `/api/v1/pair/${started.body.id}/reveal`,
    payload: { nonce: started.nonceA.toString('hex') },
  });
  if (reveal.statusCode !== 200) throw new Error(`reveal ${reveal.statusCode} ${reveal.body}`);
  return { key: started.body.id, nonceA: started.nonceA, nonceB: Buffer.from(started.body.nonce, 'hex'), reveal };
}

/** 第 4 步：问一次状态 */
export async function pollPair(app: FastifyInstance, key: string, query = '') {
  const res = await app.inject({ method: 'GET', url: `/api/v1/pair/${key}${query}` });
  return { res, body: res.json() as { status: string; deviceId?: string; token?: string } };
}

/** 走完整个配对：请求 → 本机批准 → 取凭证 */
export async function pairDevice(f: LanFixture, approve: { scopes?: Scope[]; name?: string } = {}) {
  const p = await revealPair(f.app);
  const request = f.ds.access.status().requests.at(-1)!;
  await f.ds.registry.execute('devices.approve', { id: request.id, ...approve });
  const { body } = await pollPair(f.app, p.key);
  return { ...p, request, deviceId: body.deviceId!, token: body.token!, auth: { authorization: `Bearer ${body.token}` } };
}
