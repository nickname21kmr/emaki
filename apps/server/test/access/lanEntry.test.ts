/**
 * 局域网入口的启停（access/lan.ts 的 LanEntry，docs/mobile.md 2.1、2.2）：按 lan_access 的配置开关 https 监听和 mDNS 广播，
 * access.configure 改了立即生效（关掉旧的、按新端口开），监听失败记进状态、不抛错。
 * 监听和广播换成记录调用的假实现（infra/ports.ts 的 lan）。
 *
 * 最后一条在随机端口上真的起 https：手机看到的证书指纹就是状态里的那个；设备被撤销时它开着的事件连接立即断开，事件里没有 access。
 */
import type { AccessStatus, ServerEvent } from '@emaki/shared';
import { createHash } from 'node:crypto';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LanNetwork } from '../../src/access/discovery.ts';
import { buildLanApp, LanEntry } from '../../src/access/lan.ts';
import { lanFixture, makeDevice, type LanFixture } from './harness.ts';

/** 记录调用的假网络：listen 可以让下一次失败 */
function fakeNetwork() {
  const calls: string[] = [];
  let fail: string | null = null;
  const errors: ((err: Error) => void)[] = [];
  const network: LanNetwork = {
    advertiser: (onError) => {
      errors.push(onError);
      return {
        start: (info) => void calls.push(`广播 ${info.name} ${info.port} ${info.serverId.length} v${info.protocol}`),
        stop: () => void calls.push('停止广播'),
      };
    },
    async listen(_app, port) {
      if (fail) {
        const err = Object.assign(new Error(`listen ${fail}`), { code: fail });
        fail = null;
        throw err;
      }
      calls.push(`监听 ${port}`);
    },
  };
  return {
    network,
    calls,
    failNext: (code: string) => void (fail = code),
    advertiseError: (msg: string) => errors.at(-1)!(new Error(msg)),
  };
}

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

const configure = (input: object) => f.ds.registry.execute<{ message: string; status: AccessStatus }>('access.configure', input);

describe('按配置启停', () => {
  it('默认关；打开后监听、广播；改端口关掉旧的按新端口开；改名称只重新广播；关掉停止', async () => {
    const net = fakeNetwork();
    const entry = new LanEntry(f.ds, f.bus, { network: net.network, webDist: f.webDist });
    await entry.start();
    expect(net.calls).toEqual([]);
    expect(f.ds.access.status()).toMatchObject({ enabled: false, port: 5175, listening: false, error: null });

    const on = await configure({ enabled: true });
    expect(on.message).toBe('手机访问已打开（端口 5175）');
    expect(on.status).toMatchObject({ enabled: true, listening: true, error: null, fingerprint: f.tls.fingerprintHex });
    const name = f.ds.access.displayName();
    expect(net.calls).toEqual(['监听 5175', `广播 ${name} 5175 32 v1`]);

    net.calls.length = 0;
    await configure({ port: 5180 });
    expect(net.calls).toEqual(['停止广播', '监听 5180', `广播 ${name} 5180 32 v1`]);

    net.calls.length = 0;
    const renamed = await configure({ name: '书房的电脑' });
    expect(net.calls).toEqual(['停止广播', '广播 书房的电脑 5180 32 v1']);
    expect(renamed.status).toMatchObject({ name: '书房的电脑', defaultName: expect.any(String), listening: true });
    expect(f.ds.access.hello().name).toBe('书房的电脑');
    // null 恢复成计算机名
    expect((await configure({ name: null })).status.name).toBeNull();

    net.calls.length = 0;
    const off = await configure({ enabled: false });
    expect(off.message).toBe('已关闭手机访问');
    expect(off.status).toMatchObject({ enabled: false, listening: false });
    expect(net.calls).toEqual(['停止广播']);
    // 本机页面每次都收到 changed
    expect(events.filter((e) => e.type === 'access').length).toBeGreaterThanOrEqual(5);
    await entry.close();
  });

  it('启动时按存下的配置打开（不用重启）；端口不在 1024–65535 时 400', async () => {
    await configure({ enabled: true, port: 5190 });
    const net = fakeNetwork();
    const entry = new LanEntry(f.ds, f.bus, { network: net.network, webDist: f.webDist });
    await entry.start();
    expect(net.calls[0]).toBe('监听 5190');
    await expect(configure({ port: 80 })).rejects.toMatchObject({ statusCode: 400 });
    await entry.close();
    expect(net.calls.at(-1)).toBe('停止广播');
    // 关掉以后再改配置不再启停
    net.calls.length = 0;
    await configure({ port: 5191 });
    expect(net.calls).toEqual([]);
  });

  it('监听失败（端口被占用）不抛错，原因记进状态；换个端口就好了', async () => {
    const net = fakeNetwork();
    const entry = new LanEntry(f.ds, f.bus, { network: net.network, webDist: f.webDist });
    net.failNext('EADDRINUSE');
    const r = await configure({ enabled: true, port: 5181 });
    expect(r.status).toMatchObject({ enabled: true, listening: false, error: '端口 5181 已被占用，换一个端口试试' });
    expect(r.message).toBe('手机访问没能打开：端口 5181 已被占用，换一个端口试试');
    expect(net.calls).toEqual([]);
    const ok = await configure({ port: 5182 });
    expect(ok.status).toMatchObject({ listening: true, error: null });
    // 广播出错：照样在监听，状态里写明原因
    net.advertiseError('bind EADDRINUSE 0.0.0.0:5353');
    expect(f.ds.access.status()).toMatchObject({ listening: true, error: expect.stringContaining('局域网广播出错') });
    await entry.close();
  });
});

describe('真的起 https（随机端口）', () => {
  it('证书指纹就是状态里的那个；撤销时这台设备开着的事件连接立即断开，局域网入口不推 access、command 事件', async () => {
    const app = await buildLanApp(f.ds, f.bus, f.ds.access, f.tls, { webDist: f.webDist });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as AddressInfo;

      // 手机：不走系统的证书校验，自己比对指纹
      const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
      await new Promise((resolve, reject) => socket.once('secureConnect', resolve).once('error', reject));
      const fp = createHash('sha256').update(socket.getPeerCertificate(true).raw).digest('hex');
      socket.destroy();
      expect(fp).toBe(f.ds.access.status().fingerprint);
      expect(fp).toBe(f.tls.fingerprintHex);
      // hello 里给的指纹（浏览器配对用）就是握手时的这张证书
      const hello = await new Promise<string>((resolve, reject) => {
        https
          .get({ host: '127.0.0.1', port, path: '/api/v1/hello', rejectUnauthorized: false }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => (text += c)).on('end', () => resolve(text));
          })
          .on('error', reject);
      });
      expect(JSON.parse(hello)).toMatchObject({ app: 'emaki', fingerprint: fp });

      const { device, auth } = makeDevice(f.ds);
      const other = makeDevice(f.ds, undefined, '另一台');
      const open = (headers: Record<string, string>) =>
        new Promise<{ text: () => string; ended: Promise<void> }>((resolve, reject) => {
          const req = https.get({ host: '127.0.0.1', port, path: '/api/events', headers, rejectUnauthorized: false }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            const ended = new Promise<void>((done) => res.on('end', done).on('close', done));
            res.on('data', (c: string) => {
              text += c;
              if (text.includes('"type":"hello"')) resolve({ text: () => text, ended });
            });
          });
          req.on('error', reject);
        });
      const mine = await open(auth);
      const theirs = await open(other.auth);
      // 本机页面的事件不推给手机；领域变化照推
      f.ds.access.notify('changed');
      f.bus.publish({ type: 'changed', changes: ['curation.favoriteChanged'], reason: 'mutation', actor: 'user' });
      // 电脑上的操作（带撤销令牌的 command 事件）也不推给手机
      const boot = f.bus.boot;
      const command = { name: 'curation.setFavorite', actor: 'user', message: '已收藏', boot } as const;
      f.bus.publish({ type: 'command', ...command, undoToken: 'secret-token', undo: 'token' });
      await new Promise((r) => setTimeout(r, 50));
      await f.ds.registry.execute('devices.revoke', { id: device.id });
      await mine.ended;
      expect(mine.text()).toContain('"type":"changed"');
      expect(mine.text()).not.toContain('"type":"access"');
      expect(mine.text()).not.toContain('"type":"command"');
      expect(mine.text()).not.toContain('secret-token');
      // 别的设备的连接不受影响
      f.bus.publish({ type: 'changed', changes: ['curation.ratingChanged'], reason: 'mutation', actor: 'user' });
      await expect.poll(() => theirs.text()).toContain('curation.ratingChanged');
      // 被撤销的设备再连：401 device_revoked
      const again = await new Promise<number>((resolve) =>
        https.get({ host: '127.0.0.1', port, path: '/api/events', headers: auth, rejectUnauthorized: false }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }),
      );
      expect(again).toBe(401);
    } finally {
      await app.close();
    }
  });
});
