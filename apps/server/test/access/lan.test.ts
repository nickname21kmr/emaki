/**
 * 局域网入口（docs/mobile.md 2.1、2.4、2.6、2.9）：buildLanApp(...).inject()，不开端口。
 *
 * - 注册表里每个带 HTTP 地址的查询和命令、通用入口、兼容层、SSE、健康检查、AI 助手的路由，没有凭证时都被拒绝（401）；
 *   静态文件、前端路由回落、hello 照常；
 * - 凭证放在 Bearer 或 Cookie 都行；不认识的 401 unauthorized，撤销后立即 401 device_revoked；
 * - 写请求核对 Origin（https://<Host>）和 sec-fetch-site，POST 必须是 JSON；
 * - 不挂 AI 助手的路由（有凭证也是 404）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLanApp } from '../../src/access/lan.ts';
import { COMPAT_ROUTES } from '../../src/http/compat.ts';
import { stripComments } from '../architecture/sqlWrites.ts';
import { lanFixture, makeDevice, type LanFixture } from './harness.ts';

const SRC = path.resolve(import.meta.dirname, '../../src');

/** 源码里手写的路由（某个目录下，app.get / app.post …，字面路径） */
function literalRoutes(dir: string): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    const text = stripComments(readFileSync(path.join(dir, f), 'utf8'), f);
    for (const m of text.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g))
      out.push({ method: m[1]!.toUpperCase(), path: m[2]! });
  }
  return out;
}

/** 路径模板里的参数换成一个值 */
const fill = (p: string) => p.replace(/:(\w+)/g, '1');
const hasBody = (method: string) => method !== 'GET' && method !== 'DELETE';

let f: LanFixture;
beforeAll(async () => {
  f = await lanFixture();
});
afterAll(async () => {
  await f?.close();
});

describe('没有凭证：所有 /api/ 都拒绝（hello、配对除外）', () => {
  it('注册表里每个带 HTTP 地址的查询和命令 → 401 unauthorized', async () => {
    const defs = f.ds.registry.list();
    let count = 0;
    for (const d of defs)
      for (const h of d.http ?? []) {
        const res = await f.app.inject({ method: h.method, url: fill(h.path), ...(hasBody(h.method) ? { payload: {} } : {}) });
        expect([`${h.method} ${h.path}`, res.statusCode, res.json().code]).toEqual([`${h.method} ${h.path}`, 401, 'unauthorized']);
        count++;
      }
    expect(count).toBeGreaterThan(70);
  });

  it('通用入口、兼容层、SSE、健康检查、me → 401', async () => {
    const routes = [
      ...f.ds.registry.commands().map((c) => ({ method: 'POST', path: `/api/commands/${c.name}` })),
      ...f.ds.registry.queries().map((q) => ({ method: 'GET', path: `/api/queries/${q.name}` })),
      ...COMPAT_ROUTES.map((r) => ({ method: r.method, path: r.path })),
      { method: 'GET', path: '/api/events' },
      { method: 'GET', path: '/api/health' },
      { method: 'GET', path: '/api/v1/me' },
      // 不存在的接口也先要凭证（不让没批准的设备探测有哪些接口）
      { method: 'GET', path: '/api/no-such-route' },
    ];
    for (const r of routes) {
      const res = await f.app.inject({ method: r.method as 'GET', url: fill(r.path), ...(hasBody(r.method) ? { payload: {} } : {}) });
      expect([`${r.method} ${r.path}`, res.statusCode]).toEqual([`${r.method} ${r.path}`, 401]);
    }
  });

  it('AI 助手的路由：没有凭证 401；有凭证也是 404（局域网入口不挂，里面有外部 MCP 的令牌）', async () => {
    const routes = literalRoutes(path.join(SRC, 'assistant'));
    expect(routes.length).toBeGreaterThan(10);
    const { auth } = makeDevice(f.ds, ['read', 'curate', 'catalog', 'collections', 'import', 'jobs', 'settings']);
    for (const r of routes) {
      const opts = { method: r.method as 'GET', url: fill(r.path), ...(hasBody(r.method) ? { payload: {} } : {}) };
      expect([r.path, (await f.app.inject(opts)).statusCode]).toEqual([r.path, 401]);
      expect([r.path, (await f.app.inject({ ...opts, headers: auth })).statusCode]).toEqual([r.path, 404]);
    }
  });

  it('没有构建前端（开发时）也一样：不存在的 /api/ 地址先要凭证，有凭证才是 404', async () => {
    const bare = await buildLanApp(f.ds, f.bus, f.ds.access, f.tls, { webDist: path.join(f.dir, 'no-web') });
    try {
      const { auth } = makeDevice(f.ds);
      for (const url of ['/api/assistant/settings', '/api/no-such-route', '/%61pi/assistant/sessions'])
        expect([url, (await bare.inject({ method: 'GET', url })).statusCode]).toEqual([url, 401]);
      expect((await bare.inject({ method: 'GET', url: '/api/assistant/settings', headers: auth })).statusCode).toBe(404);
      expect((await bare.inject({ method: 'GET', url: '/api/v1/hello' })).statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });

  it('百分号编码的路径路由时会解码，照样要凭证', async () => {
    for (const url of ['/%61pi/images', '/a%70i/health', '/%61pi/settings', '/%61pi/assistant/settings', '/api/v1/pair/x/../../images'])
      expect([url, (await f.app.inject({ method: 'GET', url })).statusCode]).toEqual([url, 401]);
  });

  it('静态文件、前端路由回落、hello 不要凭证', async () => {
    const index = await f.app.inject({ method: 'GET', url: '/' });
    expect([index.statusCode, index.body]).toEqual([200, '<!doctype html><title>Emaki</title>']);
    expect((await f.app.inject({ method: 'GET', url: '/assets/app.js' })).body).toBe('console.log(1)');
    // 前端路由（页面刷新）回落到 index.html
    expect((await f.app.inject({ method: 'GET', url: '/characters/1' })).body).toContain('<title>Emaki</title>');
    const hello = await f.app.inject({ method: 'GET', url: '/api/v1/hello' });
    expect(hello.statusCode).toBe(200);
    const cfg = f.ds.access.config();
    expect(hello.json()).toEqual({
      app: 'emaki',
      protocol: 1,
      serverId: cfg.serverId,
      name: expect.any(String),
      version: expect.any(String),
      minAppVersion: '0.1.0',
      port: 5175,
      addresses: expect.any(Array),
      pairing: true,
      // 浏览器配对算校验码用（网页拿不到 TLS 证书）
      fingerprint: f.tls.fingerprintHex,
    });
    for (const a of hello.json().addresses as string[]) expect(a).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe('凭证：Bearer 或 Cookie', () => {
  it('Bearer 和 Cookie 都认；/api/v1/me 返回这台设备', async () => {
    const { device, token, auth } = makeDevice(f.ds, ['read', 'curate']);
    const viaBearer = await f.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth });
    expect([viaBearer.statusCode, viaBearer.json()]).toEqual([200, { deviceId: device.id, name: 'Pixel 7', scopes: ['read', 'curate'] }]);
    const cookie = `theme=dark; emaki_device=${token}`;
    const viaCookie = await f.app.inject({ method: 'GET', url: '/api/images?limit=2', headers: { cookie } });
    expect(viaCookie.statusCode).toBe(200);
    expect(viaCookie.json().items).toHaveLength(2);
    expect((await f.app.inject({ method: 'GET', url: '/api/health', headers: auth })).json()).toMatchObject({ ok: true });
  });

  it('不认识的凭证 401 unauthorized；撤销后立即 401 device_revoked（Bearer 和 Cookie 一样）', async () => {
    const bad = await f.app.inject({ method: 'GET', url: '/api/images', headers: { authorization: 'Bearer nope' } });
    expect([bad.statusCode, bad.json().code]).toEqual([401, 'unauthorized']);
    const { device, token, auth } = makeDevice(f.ds);
    expect((await f.app.inject({ method: 'GET', url: '/api/summary', headers: auth })).statusCode).toBe(200);
    await f.ds.registry.execute('devices.revoke', { id: device.id });
    for (const headers of [auth, { cookie: `emaki_device=${token}` }]) {
      const res = await f.app.inject({ method: 'GET', url: '/api/summary', headers });
      expect([res.statusCode, res.json().code]).toEqual([401, 'device_revoked']);
    }
    // 撤销不删行：名字还在（审计记录里要显示），设置里的列表不再有它
    expect(f.ds.access.devices.get(device.id)).toMatchObject({ name: 'Pixel 7', revokedAt: expect.any(String) });
    expect(f.ds.access.status().devices.map((d) => d.id)).not.toContain(device.id);
    const again = await f.ds.registry.execute('devices.revoke', { id: device.id }).catch((e: Error) => e);
    expect(again).toMatchObject({ statusCode: 404 });
  });
});

describe('写请求的来源检查（同本机入口，只是 https、Host 不限）', () => {
  it('Origin 必须是 https://<Host>；跨站的 sec-fetch-site 拒绝；POST 必须是 JSON', async () => {
    const { auth } = makeDevice(f.ds);
    const url = `/api/characters/${f.id('c1')}/seen`;
    const host = '192.168.1.5:5175';
    const ok = await f.app.inject({
      method: 'POST',
      url,
      headers: { ...auth, host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin' },
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    for (const headers of [
      { origin: `http://${host}` },
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      const res = await f.app.inject({ method: 'POST', url, headers: { ...auth, host, ...headers }, payload: {} });
      expect([headers, res.statusCode, res.json().code]).toEqual([headers, 403, 'forbidden']);
    }
    const text = await f.app.inject({ method: 'POST', url, headers: { ...auth, host, 'content-type': 'text/plain' }, payload: 'x' });
    expect(text.statusCode).toBe(415);
    // 配对的接口也一样
    const pair = await f.app.inject({ method: 'POST', url: '/api/v1/pair', headers: { 'content-type': 'text/plain' }, payload: 'x' });
    expect(pair.statusCode).toBe(415);
  });
});

describe('最后访问时间和地址', () => {
  it('内存里每次更新，库里同一台设备至少隔 60 秒写一次', async () => {
    const { device, auth } = makeDevice(f.ds);
    const row = () => f.ds.ctx.db.prepare('SELECT last_seen_at, last_address FROM devices WHERE id = ?').get(device.id);
    const req = (address: string) => f.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth, remoteAddress: address });
    f.setNow(Date.parse('2026-11-18T10:00:00Z'));
    await req('192.168.1.20');
    expect(row()).toEqual({ last_seen_at: '2026-11-18T10:00:00.000Z', last_address: '192.168.1.20' });
    f.setNow(Date.parse('2026-11-18T10:00:30Z'));
    await req('192.168.1.21');
    expect(row()).toEqual({ last_seen_at: '2026-11-18T10:00:00.000Z', last_address: '192.168.1.20' });
    expect(f.ds.access.status().devices.find((d) => d.id === device.id)).toMatchObject({
      lastSeenAt: '2026-11-18T10:00:30.000Z',
      lastAddress: '192.168.1.21',
    });
    f.setNow(Date.parse('2026-11-18T10:01:01Z'));
    await req('::ffff:192.168.1.22');
    expect(row()).toEqual({ last_seen_at: '2026-11-18T10:01:01.000Z', last_address: '192.168.1.22' });
  });
});
