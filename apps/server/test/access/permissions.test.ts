/**
 * 设备的权限（docs/mobile.md 2.5、2.9）：由注册表按 scope 统一拦截，不在各个接口里分别判断。
 *
 * - 默认权限的设备：读得了，能收藏，能撤销；审计记录里执行者是 device:<id>，返回撤销令牌；
 * - 调 settings、organize-files 的命令 403；devices、desktop 的命令和查询无论怎么授权都 403（批准时传这些 scope 400）；
 * - 拦截在校验输入之前；改了权限下一个请求就生效；本机入口、助手、后台任务没有 grant，不受影响。
 */
import {
  ASSISTANT_SCOPES,
  DEVICE_DEFAULT_SCOPES,
  DEVICE_GRANTABLE_SCOPES,
  SCOPES,
  type CommandEvent,
  type Scope,
  type ServerEvent,
} from '@emaki/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFINITIONS } from '../../src/commands/index.ts';
import { runAsDevice } from '../../src/propagation/actor.ts';
import { lanFixture, makeDevice, type LanFixture } from './harness.ts';

let f: LanFixture;
beforeAll(async () => {
  f = await lanFixture();
});
afterAll(async () => {
  await f?.close();
});

const byName = new Map(DEFINITIONS.map((d) => [d.name, d]));
const DEVICE_COMMANDS = [
  'access.configure',
  'access.createTicket',
  'devices.approve',
  'devices.reject',
  'devices.revoke',
  'devices.update',
];

describe('范围的定义', () => {
  it('devices、desktop 永远不在可授予的范围里；默认的是可授予的子集；助手的范围没变', () => {
    expect(DEVICE_GRANTABLE_SCOPES).not.toContain('devices');
    expect(DEVICE_GRANTABLE_SCOPES).not.toContain('desktop');
    for (const s of DEVICE_DEFAULT_SCOPES) expect(DEVICE_GRANTABLE_SCOPES).toContain(s);
    expect([...DEVICE_DEFAULT_SCOPES]).toEqual(['read', 'curate', 'catalog', 'collections', 'history', 'ui', 'upload']);
    const optional = ['organize-files', 'settings', 'rules', 'duplicates', 'jobs', 'import'];
    expect([...DEVICE_GRANTABLE_SCOPES].sort()).toEqual([...DEVICE_DEFAULT_SCOPES, ...optional].sort());
    // 除了 devices、desktop，每个范围都能授予
    expect(Object.keys(SCOPES).filter((s) => !DEVICE_GRANTABLE_SCOPES.includes(s as Scope))).toEqual(['devices', 'desktop']);
    expect([...ASSISTANT_SCOPES]).toEqual(['read', 'curate', 'catalog', 'collections', 'import', 'jobs']);
  });

  it('在电脑屏幕上弹东西的命令在 desktop 里，ui 只剩「标记看过」；设备管理全在 devices 里', () => {
    expect(byName.get('library.reveal')?.scope).toBe('desktop');
    expect(byName.get('system.pickFolder')?.scope).toBe('desktop');
    expect(DEFINITIONS.filter((d) => d.scope === 'ui').map((d) => d.name)).toEqual(['catalog.markSeen']);
    expect(DEFINITIONS.filter((d) => d.scope === 'devices').map((d) => d.name)).toEqual([...DEVICE_COMMANDS, 'access.status']);
    expect(DEFINITIONS.filter((d) => d.scope === 'upload')).toEqual([]);
  });
});

describe('默认权限的设备', () => {
  it('读得了；能收藏，返回撤销令牌，审计记录里是 device:<id>，命令事件也是；能撤销', async () => {
    const { device, auth } = makeDevice(f.ds);
    expect((await f.app.inject({ method: 'GET', url: '/api/images?limit=3', headers: auth })).json().items).toHaveLength(3);
    expect((await f.app.inject({ method: 'GET', url: `/api/characters/${f.id('c1')}`, headers: auth })).statusCode).toBe(200);

    const events: ServerEvent[] = [];
    const unsubscribe = f.bus.subscribe((e) => void events.push(e));
    const i4 = f.id('i4');
    const fav = await f.app.inject({
      method: 'POST',
      url: '/api/commands/curation.setFavorite',
      headers: auth,
      payload: { ids: [i4], value: true },
    });
    unsubscribe();
    expect(fav.statusCode).toBe(200);
    expect(fav.headers['x-emaki-undo']).toBe('token');
    const { undoToken } = fav.json() as { undoToken: string };
    expect(undoToken).toEqual(expect.any(String));
    expect(f.ds.ctx.db.prepare('SELECT favorite FROM images WHERE id = ?').pluck().get(Number(i4))).toBe(1);

    const audit: any = await f.ds.registry.query('audit.list', { command: 'curation.setFavorite' });
    expect(audit.items[0]).toMatchObject({ actor: `device:${device.id}`, actorName: 'Pixel 7', status: 'done', undoToken });
    // 强刷新（和用户、助手一样），命令事件带着执行者
    const changed = events.find((e) => e.type === 'changed');
    expect(changed).toMatchObject({ reason: 'mutation', actor: `device:${device.id}`, command: 'curation.setFavorite' });
    expect(events.find((e): e is CommandEvent => e.type === 'command')).toMatchObject({ actor: `device:${device.id}`, undoToken });

    const undo = await f.app.inject({ method: 'POST', url: `/api/undo/${undoToken}`, headers: auth, payload: {} });
    expect(undo.statusCode).toBe(200);
    expect(f.ds.ctx.db.prepare('SELECT favorite FROM images WHERE id = ?').pluck().get(Number(i4))).toBe(0);
  });

  it('只能撤销这台设备自己的操作：电脑上、别的手机上的撤销令牌 403（审计记录里看得到所有令牌）', async () => {
    const a = makeDevice(f.ds, undefined, '手机 A');
    const b = makeDevice(f.ds, undefined, '手机 B');
    const i3 = f.id('i3');
    const favorite = () => f.ds.ctx.db.prepare('SELECT favorite FROM images WHERE id = ?').pluck().get(Number(i3));
    // 电脑上（本机入口，user）的操作
    const local: any = await f.ds.registry.execute('curation.setFavorite', { ids: [i3], value: true });
    const asA = await f.app.inject({ method: 'POST', url: `/api/undo/${local.undoToken}`, headers: a.auth, payload: {} });
    expect([asA.statusCode, asA.json().code]).toEqual([403, 'forbidden']);
    expect(favorite()).toBe(1);
    // 手机 A 的操作：手机 B 撤销不了，手机 A 自己可以
    const fav = await f.app.inject({
      method: 'POST',
      url: '/api/commands/curation.setFavorite',
      headers: a.auth,
      payload: { ids: [i3], value: false },
    });
    const token = (fav.json() as { undoToken: string }).undoToken;
    expect((await f.app.inject({ method: 'POST', url: `/api/undo/${token}`, headers: b.auth, payload: {} })).statusCode).toBe(403);
    expect(favorite()).toBe(0);
    expect((await f.app.inject({ method: 'POST', url: `/api/undo/${token}`, headers: a.auth, payload: {} })).statusCode).toBe(200);
    expect(favorite()).toBe(1);
    // 本机入口照旧能撤销任何操作
    await f.ds.registry.execute('history.undo', { token: local.undoToken });
    expect(favorite()).toBe(0);
  });

  it('设置、移动文件、回收站（单独的地址、通用入口、兼容层）都 403', async () => {
    const { auth } = makeDevice(f.ds);
    const i1 = f.id('i1');
    const calls = [
      { method: 'GET', url: '/api/settings' },
      { method: 'PATCH', url: '/api/settings', payload: { ui: {} } },
      { method: 'POST', url: '/api/images/move', payload: { ids: [i1], rootId: f.id('root1'), folder: 'x' } },
      { method: 'POST', url: '/api/commands/library.trash', payload: { ids: [i1] } },
      { method: 'POST', url: '/api/images/bulk', payload: { ids: [i1], action: { type: 'trash' } } },
      { method: 'POST', url: '/api/jobs', payload: { kind: 'scan' } },
      { method: 'GET', url: '/api/queries/settings.get' },
    ] as const;
    for (const c of calls) {
      const res = await f.app.inject({ ...c, headers: auth });
      expect([c.url, res.statusCode, res.json().code]).toEqual([c.url, 403, 'forbidden']);
    }
    const settings = await f.app.inject({ method: 'GET', url: '/api/settings', headers: auth });
    expect(settings.json().error).toBe('这台设备没有「图库设置、图库文件夹、识别方式」的权限');
  });

  it('拦截在校验输入之前：没权限时参数不对也是 403，不是 400', async () => {
    const { auth } = makeDevice(f.ds, ['read']);
    const res = await f.app.inject({ method: 'PATCH', url: '/api/settings', headers: auth, payload: { nonsense: [1, 2, 3], ui: 'x' } });
    expect(res.statusCode).toBe(403);
    const fav = await f.app.inject({ method: 'POST', url: '/api/commands/curation.setFavorite', headers: auth, payload: {} });
    expect(fav.statusCode).toBe(403);
    // 注册表本身：带 grant 的上下文
    const asReader = <T,>(fn: () => Promise<T>) => runAsDevice('x', ['read'], fn);
    const forbidden = { statusCode: 403 };
    await expect(asReader(() => f.ds.registry.execute('settings.update', { nonsense: true }))).rejects.toMatchObject(forbidden);
    await expect(asReader(() => f.ds.registry.query('settings.get'))).rejects.toMatchObject(forbidden);
    const calls = [
      { name: 'curation.setFavorite', input: {} },
      { name: 'curation.setRating', input: {} },
    ];
    await expect(asReader(() => f.ds.registry.batch(calls))).rejects.toMatchObject(forbidden);
  });

  it('改了权限下一个请求就按新的；勾上 organize-files、settings 之后就能用', async () => {
    const { device, auth } = makeDevice(f.ds);
    const i2 = f.id('i2');
    const payload = { ids: [i2], value: true };
    const fav = () => f.app.inject({ method: 'POST', url: '/api/commands/curation.setFavorite', headers: auth, payload });
    expect((await fav()).statusCode).toBe(200);
    await f.ds.registry.execute('devices.update', { id: device.id, scopes: ['read', 'settings'] });
    expect((await fav()).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'GET', url: '/api/settings', headers: auth })).statusCode).toBe(200);
  });
});

describe('devices、desktop 怎么也调不了', () => {
  it('勾满所有可授予的范围：设备管理的查询和命令、在电脑上弹窗的命令仍然 403', async () => {
    const { auth } = makeDevice(f.ds, DEVICE_GRANTABLE_SCOPES);
    const calls = [
      { method: 'GET', url: '/api/access' },
      { method: 'PATCH', url: '/api/access', payload: { enabled: true } },
      { method: 'POST', url: '/api/access/tickets', payload: {} },
      { method: 'POST', url: '/api/access/requests/x/approve', payload: {} },
      { method: 'POST', url: '/api/access/requests/x/reject', payload: {} },
      { method: 'PATCH', url: '/api/devices/x', payload: { scopes: ['read'] } },
      { method: 'DELETE', url: '/api/devices/x' },
      { method: 'POST', url: '/api/commands/devices.approve', payload: { id: 'x' } },
      { method: 'GET', url: '/api/queries/access.status' },
      { method: 'POST', url: `/api/images/${f.id('i1')}/reveal`, payload: {} },
      { method: 'POST', url: '/api/system/pick-folder', payload: {} },
    ] as const;
    for (const c of calls) {
      const res = await f.app.inject({ ...c, headers: auth });
      expect([c.url, res.statusCode]).toEqual([c.url, 403]);
    }
  });

  it('库里的权限就算被改出了 devices、desktop，局域网入口也不认', async () => {
    const { device, auth } = makeDevice(f.ds, ['read']);
    f.ds.ctx.db.prepare('UPDATE devices SET scopes = ? WHERE id = ?').run(JSON.stringify(['read', 'devices', 'desktop']), device.id);
    // 内存里的也改掉（模拟读进来就是这样）
    f.ds.access.devices.get(device.id)!.scopes.push('devices', 'desktop');
    expect((await f.app.inject({ method: 'GET', url: '/api/access', headers: auth })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/api/system/pick-folder', headers: auth, payload: {} })).statusCode).toBe(403);
  });

  it('批准、改权限时传 devices、desktop：400', async () => {
    const { device } = makeDevice(f.ds);
    for (const scopes of [['read', 'devices'], ['desktop'], ['nope']])
      await expect(f.ds.registry.execute('devices.update', { id: device.id, scopes })).rejects.toMatchObject({ statusCode: 400 });
    await expect(f.ds.registry.execute('devices.approve', { id: 'x', scopes: ['devices'] })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('没有 grant 的调用方不受影响', () => {
  it('本机入口（注册表直接调，actor 是 user）、后台任务能调 devices 和 settings', async () => {
    await expect(f.ds.registry.query('access.status')).resolves.toMatchObject({ enabled: false });
    await expect(f.ds.registry.query('settings.get')).resolves.toBeTruthy();
  });

  it('设备管理的命令不可撤销、也不占撤销栈，不进 MCP', async () => {
    for (const name of DEVICE_COMMANDS) {
      const d = byName.get(name)!;
      expect(d).toMatchObject({ kind: 'command', scope: 'devices', undoable: false, barrier: false });
      expect(ASSISTANT_SCOPES).not.toContain(d.scope);
    }
  });
});
