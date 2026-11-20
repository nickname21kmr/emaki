/**
 * 配对（docs/mobile.md 2.3，协议见 src/access/pairing.ts 文件头）：手机一侧走局域网入口（inject），电脑一侧走注册表的命令（同本机入口）。
 *
 * 校验码两边一致、换了证书就不一致；commit 对不上作废；reveal 只能一次；过期；限速（同时 3 个、同一地址 10 分钟 10 次）；
 * 凭证只发一次；拒绝；扫码口令一次有效、过期失效；浏览器配对的 Cookie。
 */
import { DEVICE_DEFAULT_SCOPES, type ServerEvent } from '@emaki/shared';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pairingCode } from '../../src/access/pairing.ts';
import { lanFixture, NOW, pairDevice, pollPair, revealPair, startPair, type LanFixture } from './harness.ts';

let f: LanFixture;
let events: ServerEvent[];
beforeEach(async () => {
  f = await lanFixture();
  events = [];
  f.bus.subscribe((e) => void events.push(e));
});
afterEach(async () => {
  await f?.close();
});

const accessEvents = () => events.filter((e) => e.type === 'access');

describe('校验码', () => {
  it('手机按自己看到的证书指纹算出的数，和电脑上显示的一样；换一个指纹（中间人换了证书）就不一样', async () => {
    const p = await revealPair(f.app);
    // 电脑不把校验码告诉手机
    expect(p.reveal.json()).toEqual({ ok: true });
    const [request] = f.ds.access.status().requests;
    expect(request).toMatchObject({ code: expect.stringMatching(/^\d{6}$/), name: 'Pixel 7', model: 'Pixel 7', address: '127.0.0.1' });
    expect(pairingCode(f.tls.fingerprint, p.nonceA, p.nonceB)).toBe(request!.code);
    expect(pairingCode(randomBytes(32), p.nonceA, p.nonceB)).not.toBe(request!.code);
    // 本机页面收到 requested（带请求）
    expect(accessEvents()).toEqual([{ type: 'access', reason: 'requested', request }]);
    // 手机手里的凭据（key）和本机页面用的编号不是一个
    expect(request!.id).not.toBe(p.key);
  });

  // 固定输入的结果：App 的实现拿它对照
  it('算法：sha256("emaki-pair-v1" ‖ fp ‖ nonceA ‖ nonceB) 前 4 字节大端 mod 1e6，补零到 6 位', () => {
    const z = Buffer.alloc(32);
    // sha256 前 4 字节 f6705da6 = 4134559142
    expect(pairingCode(z, z, z)).toBe('559142');
    expect(pairingCode(Buffer.alloc(32, 1), Buffer.alloc(32, 2), z)).toBe('645456');
    // 三段的顺序有意义
    expect(pairingCode(z, Buffer.alloc(32, 1), z)).not.toBe(pairingCode(z, z, Buffer.alloc(32, 1)));
  });

  it('commit 对不上：这条请求直接作废；reveal 只能一次', async () => {
    const s = await startPair(f.app);
    const url = `/api/v1/pair/${s.body.id}/reveal`;
    const reveal = (nonce: Buffer) => f.app.inject({ method: 'POST', url, payload: { nonce: nonce.toString('hex') } });
    const wrong = await reveal(randomBytes(32));
    expect([wrong.statusCode, wrong.json().code]).toEqual([400, 'bad_request']);
    expect((await pollPair(f.app, s.body.id)).body).toEqual({ status: 'expired' });
    // 作废后用对的也不行
    const late = await reveal(s.nonceA);
    expect(late.statusCode).toBe(404);
    expect(f.ds.access.status().requests).toEqual([]);

    const p = await revealPair(f.app);
    const twice = await f.app.inject({ method: 'POST', url: `/api/v1/pair/${p.key}/reveal`, payload: { nonce: p.nonceA.toString('hex') } });
    expect(twice.statusCode).toBe(409);
  });

  it('还没公开随机数的请求不出现在本机页面上，也不能批准', async () => {
    await startPair(f.app);
    expect(f.ds.access.status().requests).toEqual([]);
    expect(accessEvents()).toEqual([]);
  });
});

describe('批准、拒绝、凭证只发一次', () => {
  it('批准后长轮询拿到凭证（只发一次，再问是 expired）；凭证能用，权限是默认的', async () => {
    const p = await revealPair(f.app);
    expect((await pollPair(f.app, p.key)).body).toEqual({ status: 'pending' });
    // 长轮询：批准时提前返回
    const waiting = pollPair(f.app, p.key, '?wait=20');
    const [request] = f.ds.access.status().requests;
    const approved: any = await f.ds.registry.execute('devices.approve', { id: request!.id });
    expect(approved).toMatchObject({ ok: true, device: { name: 'Pixel 7', scopes: [...DEVICE_DEFAULT_SCOPES] } });
    expect(f.ds.registry.meta(approved)).toMatchObject({ undo: 'none' });
    const { body } = await waiting;
    expect(body).toEqual({ status: 'approved', deviceId: approved.device.id, token: expect.any(String) });
    expect((await pollPair(f.app, p.key)).body).toEqual({ status: 'expired' });
    const me = await f.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${body.token}` } });
    expect(me.json()).toMatchObject({ deviceId: approved.device.id, name: 'Pixel 7' });
    // 库里只存哈希
    const row: any = f.ds.ctx.db.prepare('SELECT * FROM devices WHERE id = ?').get(approved.device.id);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(body.token);
    expect(accessEvents().map((e) => e.type === 'access' && e.reason)).toEqual(['requested', 'changed']);
    expect(f.ds.access.status()).toMatchObject({
      requests: [],
      devices: [{ id: approved.device.id, name: 'Pixel 7', lastSeenAt: expect.any(String) }],
    });
  });

  it('批准时可以改名字、勾权限', async () => {
    const d = await pairDevice(f, { name: '卧室的平板', scopes: ['read', 'organize-files'] });
    const me = await f.app.inject({ method: 'GET', url: '/api/v1/me', headers: d.auth });
    expect(me.json()).toEqual({ deviceId: d.deviceId, name: '卧室的平板', scopes: ['read', 'organize-files'] });
  });

  it('拒绝：手机下次问的时候是 rejected，之后是 expired', async () => {
    const p = await revealPair(f.app);
    const [request] = f.ds.access.status().requests;
    await f.ds.registry.execute('devices.reject', { id: request!.id });
    expect(f.ds.access.status().requests).toEqual([]);
    expect((await pollPair(f.app, p.key)).body).toEqual({ status: 'rejected' });
    expect((await pollPair(f.app, p.key)).body).toEqual({ status: 'expired' });
    expect(f.ds.access.status().devices).toEqual([]);
    const again = await f.ds.registry.execute('devices.approve', { id: request!.id }).catch((e: Error) => e);
    expect(again).toMatchObject({ statusCode: 404 });
  });

  it('浏览器配对：?cookie=1 时批准的响应顺带 Set-Cookie（HttpOnly、Secure、SameSite=Strict）', async () => {
    const p = await revealPair(f.app);
    await f.ds.registry.execute('devices.approve', { id: f.ds.access.status().requests[0]!.id });
    const { res, body } = await pollPair(f.app, p.key, '?cookie=1');
    expect(res.headers['set-cookie']).toBe(`emaki_device=${body.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=315360000`);
    const summary = await f.app.inject({ method: 'GET', url: '/api/summary', headers: { cookie: `emaki_device=${body.token}` } });
    expect(summary.statusCode).toBe(200);
  });
});

describe('过期', () => {
  it('5 分钟没处理就作废：从本机页面上消失，手机问到 expired', async () => {
    const p = await revealPair(f.app);
    expect(f.ds.access.status().requests).toHaveLength(1);
    f.setNow(NOW + 5 * 60_000);
    expect(f.ds.access.status().requests).toEqual([]);
    expect((await pollPair(f.app, p.key)).body).toEqual({ status: 'expired' });
    expect(accessEvents().at(-1)).toEqual({ type: 'access', reason: 'changed' });
  });

  it('批准后 5 分钟内没取走凭证也作废，设备行一并删掉', async () => {
    const p = await revealPair(f.app);
    f.setNow(NOW + 4 * 60_000);
    const approved: any = await f.ds.registry.execute('devices.approve', { id: f.ds.access.status().requests[0]!.id });
    // 批准后重新算 5 分钟
    f.setNow(NOW + 8 * 60_000);
    expect(f.ds.access.status().devices).toHaveLength(1);
    f.setNow(NOW + 9 * 60_000);
    expect(f.ds.access.status().devices).toEqual([]);
    expect(f.ds.ctx.db.prepare('SELECT COUNT(*) FROM devices').pluck().get()).toBe(0);
    expect(f.ds.access.devices.get(approved.device.id)).toBeNull();
    expect((await pollPair(f.app, p.key)).body).toEqual({ status: 'expired' });
  });
});

describe('限速', () => {
  it('同时等批准的最多 3 个，第 4 个 429；处理掉一个就又能发', async () => {
    for (let i = 0; i < 3; i++) await revealPair(f.app, { address: `192.168.1.${10 + i}` });
    const fourth = await startPair(f.app, { address: '192.168.1.99' });
    expect([fourth.res.statusCode, fourth.res.json().code]).toEqual([429, 'too_many_requests']);
    await f.ds.registry.execute('devices.reject', { id: f.ds.access.status().requests[0]!.id });
    expect((await startPair(f.app, { address: '192.168.1.99' })).res.statusCode).toBe(200);
  });

  it('同一个地址 10 分钟内最多 10 次，第 11 次 429；别的地址不受影响；过了 10 分钟又能发', async () => {
    const attempt = async (address: string) => {
      const s = await startPair(f.app, { address });
      if (s.res.statusCode === 200)
        // 公开一个错的随机数让它作废：不占「同时等批准」的名额
        await f.app.inject({ method: 'POST', url: `/api/v1/pair/${s.body.id}/reveal`, payload: { nonce: '00'.repeat(32) } });
      return s.res;
    };
    for (let i = 0; i < 10; i++) expect((await attempt('192.168.1.50')).statusCode).toBe(200);
    const eleventh = await attempt('192.168.1.50');
    expect([eleventh.statusCode, eleventh.json().code]).toEqual([429, 'too_many_requests']);
    expect((await attempt('192.168.1.51')).statusCode).toBe(200);
    f.setNow(NOW + 10 * 60_000);
    expect((await attempt('192.168.1.50')).statusCode).toBe(200);
  });
});

describe('扫码的一次性口令', () => {
  it('局域网入口没开时 409；开了以后二维码内容带电脑标识、指纹、端口、地址、口令', async () => {
    const closed = await f.ds.registry.execute('access.createTicket', {}).catch((e: Error) => e);
    expect(closed).toMatchObject({ statusCode: 409 });
    await f.ds.registry.execute('access.configure', { enabled: true, port: 5299 });
    const t: any = await f.ds.registry.execute('access.createTicket', {});
    const cfg = f.ds.access.config();
    const uri = new RegExp(`^emaki://pair\\?id=${cfg.serverId}&fp=${f.tls.fingerprintHex}&p=5299&h=[0-9.,]*&t=[A-Za-z0-9_-]{22}$`);
    expect(t.uri).toMatch(uri);
    expect(Date.parse(t.expiresAt) - NOW).toBe(2 * 60_000);
  });

  it('带口令直接批准（默认权限），用一次就失效；过期的也不行', async () => {
    await f.ds.registry.execute('access.configure', { enabled: true });
    const ticketOf = async () => {
      const { uri } = await f.ds.registry.execute<{ uri: string }>('access.createTicket', {});
      return new URL(uri).searchParams.get('t')!;
    };
    const t1 = await ticketOf();
    const pair = (ticket: string) => f.app.inject({ method: 'POST', url: '/api/v1/pair', payload: { name: '扫码的手机', ticket } });
    const ok = await pair(t1);
    expect(ok.json()).toEqual({ status: 'approved', deviceId: expect.any(String), token: expect.any(String) });
    const me = await f.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${ok.json().token}` } });
    expect(me.json()).toMatchObject({ name: '扫码的手机', scopes: [...DEVICE_DEFAULT_SCOPES] });
    const reused = await pair(t1);
    expect([reused.statusCode, reused.json().code]).toEqual([403, 'forbidden']);
    const t2 = await ticketOf();
    f.setNow(NOW + 2 * 60_000);
    expect((await pair(t2)).statusCode).toBe(403);
    expect((await pair('made-up')).statusCode).toBe(403);
  });
});
