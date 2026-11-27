/**
 * 插件的服务端逻辑（docs/plugins.md 第 6 节，E5）：真的起子进程（test/fixtures/plugins/runtime-echo）。
 * 命令进注册表、转给子进程；读写自己目录以外的文件被拦下；经宿主调命令受授权限制、记成插件；联网只能连授权的域名；
 * 下载 → 导入（去重）；设置和凭证（视图读不到）；后台任务的进度和取消；崩了记错误、重启，多次就自动停用，Emaki 照常；事件。
 */
import type { PluginsState } from '@emaki/shared';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/events.ts';
import { PluginRuntime, type RuntimeOptions } from '../../src/services/plugins/runtime/host.ts';
import type { LoginWindow, LoginWindowOptions } from '../../src/services/plugins/runtime/loginWindow.ts';
import { SqliteDataSource } from '../helpers/client.ts';
import { makeTmpDir } from '../helpers/tmp.ts';

process.env.EMAKI_LOG_LEVEL = 'silent';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/plugins/runtime-echo');
const ID = 'test.echo';
/** 1×1 的 PNG */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let ds: SqliteDataSource;
let dir: string;
let lib: string;
let rootId: number;
let runtime: PluginRuntime | null;
const logs: string[] = [];
let fetched: { url: string; headers: Record<string, string> }[] = [];

beforeEach(async () => {
  dir = makeTmpDir('plugin-runtime');
  lib = path.join(dir, 'library');
  mkdirSync(lib);
  ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
  rootId = ds.ctx.db
    .prepare('INSERT INTO library_roots (path, enabled, content_mode) VALUES (?, 1, ?) RETURNING id')
    .pluck()
    .get(lib, 'auto') as number;
  runtime = null;
  logs.length = 0;
  fetched = [];
});
afterEach(async () => {
  await runtime?.close();
  await ds.close();
});

const fakeFetch: RuntimeOptions['fetch'] = async (url, init) => {
  fetched.push({ url, headers: init.headers ?? {} });
  if (url.includes('missing')) return new Response('no', { status: 404 });
  if (url.includes('redirect')) return new Response(null, { status: 302, headers: { location: 'https://evil.example.org/x' } });
  if (url.endsWith('.json')) return new Response(JSON.stringify({ hello: 'world' }), { headers: { 'content-type': 'application/json' } });
  return new Response(PNG, { headers: { 'content-type': 'image/png' } });
};

async function start(opts: RuntimeOptions = {}) {
  const pkg = await ds.plugins.inspect({ kind: 'folder', path: FIXTURE });
  expect(pkg.problems).toEqual([]);
  await ds.registry.execute('plugins.install', { token: pkg.token, folders: { downloads: { rootId: String(rootId), dir: '下载' } } });
  runtime = new PluginRuntime(ds, { log: (m) => logs.push(m), backoffMs: [20], startTimeoutMs: 10_000, fetch: fakeFetch, ...opts });
  runtime.start();
  await runtime.ready(ID);
}

const call = <T = Record<string, any>>(name: string, input: unknown = {}) => ds.registry.execute<T>(name, input);
const host = <T = Record<string, any>>(op: string, arg?: unknown) => call<T>('test.echo.host', { op, arg });
const state = () => ds.registry.query<PluginsState>('plugins.state', {});
const info = async () => (await state()).plugins.find((p) => p.id === ID)!;

async function until<T>(fn: () => T | Promise<T>, what: string, ms = 10_000): Promise<Exclude<T, false | null | undefined | 0 | ''>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as Exclude<T, false | null | undefined | 0 | ''>;
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('插件的服务端逻辑', () => {
  it('清单里的命令进注册表，调用转给子进程；停用就撤掉、子进程也停了', async () => {
    await start();
    expect(ds.registry.get('test.echo.echo')).toMatchObject({ kind: 'command', scope: 'read' });
    expect(await call('test.echo.echo', { text: '你好' })).toEqual({ text: '你好', caller: 'user' });
    // 输入按清单里的 JSON Schema 校验
    await expect(call('test.echo.echo', {})).rejects.toMatchObject({ statusCode: 400 });
    // 插件页上算「功能」
    expect((await info()).kinds).toContain('feature');

    const pid = runtime!.status(ID)!.pid!;
    expect(pid).toBeGreaterThan(0);
    await call('plugins.setEnabled', { id: ID, enabled: false });
    await until(() => !runtime!.status(ID), '停掉');
    expect(ds.registry.get('test.echo.echo')).toBeUndefined();
    await expect(call('test.echo.echo', { text: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    // 再启用又起来
    await call('plugins.setEnabled', { id: ID, enabled: true });
    await until(() => runtime!.status(ID), '再起来');
    await runtime!.ready(ID);
    expect(await call('test.echo.echo', { text: 'again' })).toMatchObject({ text: 'again' });
  });

  it('读写自己目录以外的文件被拦下，自己的数据目录能写；不能再起子进程', async () => {
    await start();
    const outside = path.join(dir, 'secret.txt');
    writeFileSync(outside, '别人的');
    const r = await call('test.echo.probe', { outside });
    expect(r).toEqual({
      readOutside: 'ERR_ACCESS_DENIED',
      writeOutside: 'ERR_ACCESS_DENIED',
      writeInside: 'ok',
      readInside: 'ok',
      spawn: 'ERR_ACCESS_DENIED',
      escape: '路径要在插件自己的文件夹里',
    });
    expect(readFileSync(path.join(ds.plugins.dataDir(ID), 'mine.txt'), 'utf8')).toBe('x');
    // 包所在的文件夹能读、不能写
    const r2 = await call('test.echo.probe', { outside: path.join(FIXTURE, 'emaki-plugin.json') });
    expect(r2).toMatchObject({ readOutside: 'ok', writeOutside: 'ERR_ACCESS_DENIED' });
  });

  it('经宿主调命令和查询：受授权限制，记成 plugin:<id>@<版本>；不能直接调 library.import', async () => {
    await start();
    const r = await host<{ value: PluginsState }>('call', { name: 'plugins.state' });
    expect(r.value.plugins.some((p) => p.id === ID)).toBe(true);
    // 授权里没有「改单张图的决定」
    await expect(host('call', { name: 'curation.setFavorite', input: { id: '1', favorite: true } })).rejects.toThrow(
      /这个插件没有「改单张图的决定/,
    );
    await expect(host('call', { name: 'library.import', input: {} })).rejects.toThrow(/emaki\.library\.import/);
  });

  it('联网只能连授权的域名（跳转也查）；下载进自己的文件夹，再导入授权给的文件夹，相同的不再导入', async () => {
    await start();
    const json = await host('fetch', { url: 'https://img.example.test/a.json' });
    expect(json).toMatchObject({ status: 200, ok: true, body: { hello: 'world' } });
    await expect(host('fetch', { url: 'https://www.example.org/' })).rejects.toThrow(/没有授权连接 www\.example\.org/);
    await expect(host('fetch', { url: 'https://img.example.test/redirect' })).rejects.toThrow(/没有授权连接 evil\.example\.org/);
    await expect(host('fetch', { url: 'file:///etc/passwd' })).rejects.toThrow();

    const first = await host<{ items: { status: string; imageId?: string }[]; message: string }>('download', {
      url: 'https://img.example.test/123_p0.png',
      name: '123_p0.png',
    });
    expect(first.items).toMatchObject([{ status: 'imported' }]);
    expect(fetched.at(-1)!.headers).toMatchObject({ referer: 'https://example.test/' });
    expect(readFileSync(path.join(lib, '下载', '123_p0.png'))).toEqual(PNG);
    const again = await host<{ items: { status: string; imageId?: string }[]; message: string }>('download', {
      url: 'https://img.example.test/123_p0.png',
      name: '123_p0.png',
    });
    expect(again.items).toMatchObject([{ status: 'existing', imageId: first.items[0]!.imageId }]);
    expect(again.message).toMatch(/图库里已经有了/);
    expect(await host('download', { url: 'https://img.example.test/missing.png', name: 'x.png' })).toEqual({ status: 404 });
    // 只能导入自己文件夹里的
    await expect(host('import', { files: [{ path: path.join(dir, 'secret.txt') }] })).rejects.toThrow(/插件自己的文件夹/);
    // 导入记成插件
    const actor = ds.ctx.db.prepare("SELECT actor FROM command_log WHERE command = 'library.import' ORDER BY id DESC").pluck().get();
    expect(actor).toBe('plugin:test.echo@0.1.0');
  });

  it('设置和凭证：插件的服务端读得到；网页只看得到凭证填没填；视图的存储里没有', async () => {
    await start();
    await call('plugins.setSettings', { id: ID, values: { token: 'TOKEN-123', name: '小明' } });
    const settings = (await info()).settings;
    expect(settings).toEqual([
      { id: 'token', value: null, filled: true },
      { id: 'name', value: '小明', filled: true },
    ]);
    expect(JSON.stringify(await state())).not.toContain('TOKEN-123');
    await host('setSecret', 'SESSION-9');
    expect(await host('settings')).toEqual({ token: 'TOKEN-123', name: '小明', session: 'SESSION-9' });
    // 视图的存储（plugin_storage）和凭证是分开的
    await host('storage', { a: 1 });
    const viewStorage = ds.plugins.storage.keys(ID).map((k) => JSON.stringify(ds.plugins.storage.get(ID, k)));
    expect(viewStorage).toContain(JSON.stringify({ a: 1 }));
    expect(viewStorage.join()).not.toMatch(/TOKEN-123|SESSION-9/);
    await expect(call('plugins.setSettings', { id: ID, values: { nope: 'x' } })).rejects.toThrow(/没有设置「nope」/);
    // 清掉
    await call('plugins.setSettings', { id: ID, values: { token: '' } });
    expect((await info()).settings![0]).toEqual({ id: 'token', value: null, filled: false });
  });

  it('后台任务：进任务列表（名字是插件给的），有进度；能取消', async () => {
    await start();
    const { id } = await host<{ id: string }>('job', { n: 5 });
    const done = await until(() => ds.ctx.jobs.get(id)?.status === 'done' && ds.ctx.jobs.get(id), '任务跑完');
    expect(done).toMatchObject({ kind: 'plugin', plugin: ID, title: '数到 5', progress: 5, total: 5, message: '数完了 5 个' });

    const long = await host<{ id: string }>('job', { n: 10_000, stepMs: 20 });
    await until(() => (ds.ctx.jobs.get(long.id)?.progress ?? 0) > 2, '开始数');
    ds.ctx.jobs.cancel(long.id);
    const cancelled = await until(
      () => ['cancelled', 'failed'].includes(ds.ctx.jobs.get(long.id)!.status) && ds.ctx.jobs.get(long.id),
      '取消',
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.message).toBe('数到 10000：已取消');
  });

  it('崩了：记一次错误、自动重启，Emaki 照常；等它的调用失败、超时的调用不卡住', async () => {
    await start({ callTimeoutMs: 300 });
    const pid = runtime!.status(ID)!.pid;
    await call('test.echo.crash');
    await until(() => runtime!.status(ID)!.crashes === 1, '记一次崩溃');
    await runtime!.ready(ID);
    expect(runtime!.status(ID)!.pid).not.toBe(pid);
    expect((await info()).errors![0]).toMatchObject({ source: '服务端', message: '故意崩的' });
    expect(await call('test.echo.echo', { text: '还活着' })).toMatchObject({ text: '还活着' });
    // 不回应的调用按超时失败
    await expect(call('test.echo.hang')).rejects.toThrow(/秒内没有回应/);
    // Emaki 照常
    expect((await ds.registry.query<{ imageCount: number }>('library.stats', {})).imageCount).toBe(0);
  });

  it('短时间内崩很多次：自动停用（写明原因），子进程不再起', async () => {
    await start();
    for (let i = 0; i < 5; i++) {
      await runtime!.ready(ID).catch(() => {});
      if (!runtime!.status(ID)) break;
      await call('test.echo.crash').catch(() => {});
      await until(() => !runtime!.status(ID) || runtime!.status(ID)!.crashes > i || runtime!.status(ID)!.state !== 'ready', '崩');
    }
    const p = await until(async () => {
      const x = await info();
      return !x.enabled && x;
    }, '自动停用');
    expect(p.disabledReason).toMatch(/自动停用/);
    await until(() => !runtime!.status(ID), '子进程停了');
    expect(ds.registry.get('test.echo.echo')).toBeUndefined();
  });

  it('订阅变化：图库变了以后插件收到（只是旁观）', async () => {
    await start();
    // 插件自己的变化也算：改个名
    await call('plugins.rename', { id: ID, name: '回声 2' });
    const r = await until(async () => (await host<{ changes: string[] | null }>('lastChange')).changes, '收到变化');
    expect(r).toContain('plugins.changed');
  });

  it('登录窗口：只能读授权连接的网站的登录；一次开一个；插件停了窗口跟着关', async () => {
    const opened: { o: LoginWindowOptions; finish(v: string): void; closed: boolean }[] = [];
    const loginWindow = async (o: LoginWindowOptions): Promise<LoginWindow> => {
      let finish!: (v: string) => void;
      let fail!: (e: Error) => void;
      const done = new Promise<string>((a, b) => ((finish = a), (fail = b)));
      done.catch(() => {});
      const w = { o, finish, closed: false };
      opened.push(w);
      return { done, close: () => ((w.closed = true), fail(new Error('登录取消了'))) };
    };
    await start({ loginWindow });
    const arg = { url: 'https://img.example.test/login', cookieUrl: 'https://img.example.test/', cookie: 'sid', pattern: '^u_' };
    await expect(host('login', { ...arg, cookieUrl: 'https://evil.example.org/' })).rejects.toThrow(/没有授权连接 evil\.example\.org/);
    await expect(host('login', { ...arg, url: 'file:///etc/passwd' })).rejects.toThrow(/http、https/);
    expect(await host('login', arg)).toEqual({ opened: true });
    expect(opened[0]!.o).toMatchObject({ url: arg.url, cookieUrl: arg.cookieUrl, cookie: 'sid' });
    expect(opened[0]!.o.pattern!.source).toBe('^u_');
    await expect(host('login', arg)).rejects.toThrow(/已经开着了/);
    opened[0]!.finish('u_123');
    expect(await until(() => ds.plugins.storage.get(ID, 'login'), '登录好')).toEqual({ value: 'u_123' });
    // 再开一个，插件停了：窗口跟着关
    await host('login', arg);
    await call('plugins.setEnabled', { id: ID, enabled: false });
    await until(() => opened[1]!.closed, '窗口关了');
  });

  it('附带的插件：没装的列在 bundled 里，装了就不列', async () => {
    const bundled = ds.plugins.bundled(path.dirname(FIXTURE));
    expect(bundled).toEqual([expect.objectContaining({ id: ID, name: '回声', version: '0.1.0', path: FIXTURE })]);
    await start();
    expect(ds.plugins.bundled(path.dirname(FIXTURE))).toEqual([]);
  });

  it('卸载：数据目录在下次启动时删掉', async () => {
    await start();
    await call('test.echo.probe', { outside: path.join(dir, 'nothing') });
    const data = ds.plugins.dataDir(ID);
    expect(readFileSync(path.join(data, 'mine.txt'), 'utf8')).toBe('x');
    await call('plugins.remove', { id: ID });
    await until(() => !runtime!.status(ID), '停掉');
    ds.plugins.cleanup();
    expect(() => readFileSync(path.join(data, 'mine.txt'))).toThrow();
  });
});
