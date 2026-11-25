/**
 * 附带的 Pixiv 浏览插件（plugins/pixiv-browser，docs/plugins.md 第 6 节）：和第三方插件走一样的路——按文件夹装、授权单、
 * 子进程。Pixiv 换成假的（不联网）：浏览排行、取缩略图、批量下载（后台任务：进度、取消），放进授权给的文件夹，
 * 图库里已经有的不再放一份。
 */
import type { PluginSite, PluginsState } from '@emaki/shared';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config.ts';
import { EventBus } from '../../src/core/events.ts';
import { sharp } from '../../src/services/image/sharpConfig.ts';
import { PluginRuntime, type RuntimeOptions } from '../../src/services/plugins/runtime/host.ts';
import type { LoginWindow, LoginWindowOptions } from '../../src/services/plugins/runtime/loginWindow.ts';
import { SqliteDataSource } from '../helpers/client.ts';
import { makeTmpDir } from '../helpers/tmp.ts';

process.env.EMAKI_LOG_LEVEL = 'silent';

const ID = 'pixiv-browser';
let ds: SqliteDataSource;
let lib: string;
let rootId: number;
let runtime: PluginRuntime;
let requests: { url: string; headers: Record<string, string> }[];
/** 假的登录窗口：测试里决定登录好还是关掉 */
let logins: { o: LoginWindowOptions; finish(v: string): void; fail(m: string): void }[];
const fakeLogin = async (o: LoginWindowOptions): Promise<LoginWindow> => {
  let finish!: (v: string) => void;
  let fail!: (m: string) => void;
  const done = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = (m) => reject(new Error(m));
  });
  done.catch(() => {});
  logins.push({ o, finish, fail });
  return { done, close: () => fail('登录取消了') };
};
const png = new Map<string, Buffer>();

/** 每个地址一张不同的图（颜色按地址算） */
async function imageFor(url: string): Promise<Buffer> {
  let b = png.get(url);
  if (!b) {
    const n = [...url].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    b = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: n & 255, g: (n >> 8) & 255, b: (n >> 16) & 255 } } })
      .png()
      .toBuffer();
    png.set(url, b);
  }
  return b;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const fakePixiv: RuntimeOptions['fetch'] = async (url, init) => {
  requests.push({ url, headers: init.headers ?? {} });
  const u = new URL(url);
  if (u.hostname === 'www.pixiv.net' && u.pathname === '/ranking.php')
    return json({
      contents: [
        {
          illust_id: 111,
          title: '两张的',
          user_name: '画师甲',
          user_id: 9,
          illust_page_count: '2',
          illust_type: '0',
          url: 'https://i.pximg.net/c/480x960/img-master/img/111_p0_master1200.jpg',
          rank: 1,
          illust_content_type: { sexual: 0 },
        },
        {
          illust_id: 222,
          title: '一张的',
          user_name: '画师乙',
          user_id: 8,
          illust_page_count: '1',
          illust_type: '0',
          url: 'https://i.pximg.net/c/480x960/img-master/img/222_p0_master1200.jpg',
          rank: 2,
          illust_content_type: { sexual: 0 },
        },
        {
          illust_id: 333,
          title: '动图',
          user_name: '画师丙',
          user_id: 7,
          illust_page_count: '1',
          illust_type: '2',
          url: 'https://i.pximg.net/c/480x960/img-master/img/333_p0_master1200.jpg',
          rank: 3,
          illust_content_type: { sexual: 0 },
        },
      ],
      next: 2,
      date: '20261124',
    });
  const pages = /^\/ajax\/illust\/(\d+)\/pages$/.exec(u.pathname);
  if (u.hostname === 'www.pixiv.net' && pages) {
    const id = pages[1]!;
    const n = id === '111' ? 2 : 1;
    return json({
      error: false,
      body: Array.from({ length: n }, (_, i) => ({ urls: { original: `https://i.pximg.net/img-original/img/${id}_p${i}.png` } })),
    });
  }
  if (u.hostname === 'www.pixiv.net' && u.pathname === '/ajax/user/12345')
    return init.headers?.cookie ? json({ error: false, body: { userId: '12345', name: '测试账号' } }) : new Response('', { status: 401 });
  if (u.hostname === 'www.pixiv.net' && u.pathname.startsWith('/ajax/follow_latest'))
    return init.headers?.cookie
      ? json({ error: false, body: { thumbnails: { illust: [] }, page: { isLastPage: true } } })
      : new Response('', { status: 401 });
  if (u.hostname === 'i.pximg.net') {
    if (init.headers?.referer !== 'https://www.pixiv.net/') return new Response('', { status: 403 });
    return new Response(await imageFor(url), { headers: { 'content-type': 'image/png' } });
  }
  return new Response('', { status: 404 });
};

beforeEach(async () => {
  const dir = makeTmpDir('pixiv-browser');
  lib = path.join(dir, 'library');
  mkdirSync(lib);
  ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
  rootId = ds.ctx.db
    .prepare('INSERT INTO library_roots (path, enabled, content_mode) VALUES (?, 1, ?) RETURNING id')
    .pluck()
    .get(lib, 'auto') as number;
  requests = [];
  logins = [];
  runtime = new PluginRuntime(ds, { fetch: fakePixiv, log: () => {}, loginWindow: fakeLogin });
  runtime.start();
});
afterEach(async () => {
  await runtime.close();
  await ds.close();
});

const call = <T = Record<string, any>>(name: string, input: unknown = {}) => ds.registry.execute<T>(name, input);

async function until<T>(fn: () => T | Promise<T>, what: string, ms = 20_000): Promise<Exclude<T, false | null | undefined | ''>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as Exclude<T, false | null | undefined | ''>;
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 和「插件」页一样：附带的列表 → 按文件夹准备 → 授权单 → 装 */
async function enable() {
  const state = await ds.registry.query<PluginsState>('plugins.state', {});
  const bundled = state.bundled!.find((b) => b.id === ID)!;
  expect(bundled).toMatchObject({ name: 'Pixiv 浏览', path: path.join(config.bundledPluginsDir, 'pixiv-browser') });
  const pkg = await ds.plugins.inspect({ kind: 'folder', path: bundled.path });
  expect(pkg.problems).toEqual([]);
  expect(pkg.added).toMatchObject({ scopes: ['read', 'import'], network: ['www.pixiv.net', 'i.pximg.net'], background: true });
  await call('plugins.install', { token: pkg.token, folders: { downloads: { rootId: String(rootId), dir: '下载图片/Pixiv' } } });
  await runtime.ready(ID);
}

describe('附带的 Pixiv 浏览', () => {
  it('默认没装；装好以后能看排行、取缩略图', async () => {
    const before = await ds.registry.query<PluginsState>('plugins.state', {});
    expect(before.plugins.some((p) => p.id === ID)).toBe(false);
    await enable();
    const r = await call<{
      items: { id: string; title: string; pages: number; type: string; thumb: string; downloaded: boolean }[];
      next: number;
    }>('pixiv-browser.ranking', { mode: 'daily' });
    expect(r.items.map((i) => [i.id, i.title, i.pages, i.type, i.downloaded])).toEqual([
      ['111', '两张的', 2, 'illust', false],
      ['222', '一张的', 1, 'illust', false],
      ['333', '动图', 1, 'ugoira', false],
    ]);
    expect(r.next).toBe(2);
    // 排行的缩略图换成小一号的
    expect(r.items[0]!.thumb).toContain('/c/240x480/');
    const t = await call<{ files: Record<string, string> }>('pixiv-browser.thumbs', {
      urls: [r.items[0]!.thumb, 'https://evil.example/x.jpg'],
    });
    expect(Object.keys(t.files)).toEqual([r.items[0]!.thumb]);
    expect(t.files[r.items[0]!.thumb]).toMatch(/^thumbs\/[0-9a-f]{40}\.jpg$/);
    // 带了 Referer
    expect(requests.find((x) => x.url.includes('i.pximg.net'))!.headers.referer).toBe('https://www.pixiv.net/');
    // 关注要登录
    await expect(call('pixiv-browser.following', {})).rejects.toThrow(/要先登录 Pixiv/);
  });

  it('登录：在电脑上开 Pixiv 的登录页，读到登录以后的 Cookie（不用你去翻 PHPSESSID），存进凭证；能退出', async () => {
    await enable();
    // 插件详情里没有要填的设置了
    expect((await ds.registry.query<PluginsState>('plugins.state', {})).plugins.find((p) => p.id === ID)!.settings).toBeUndefined();
    const r = await call<{ message: string }>('pixiv-browser.login');
    expect(r.message).toMatch(/在电脑上弹出了 Pixiv 的登录页/);
    expect(logins[0]!.o).toMatchObject({ cookieUrl: 'https://www.pixiv.net/', cookie: 'PHPSESSID' });
    expect(logins[0]!.o.url).toMatch(/^https:\/\/accounts\.pixiv\.net\/login/);
    // 访客的 Cookie 不算，登录以后的才算
    expect(logins[0]!.o.pattern!.test('abcdef')).toBe(false);
    expect(logins[0]!.o.pattern!.test('12345_abcdef')).toBe(true);
    expect(await call('pixiv-browser.status')).toMatchObject({ session: false, login: { state: 'waiting' } });
    // 开着的时候再点：不再开一个
    expect((await call<{ message: string }>('pixiv-browser.login')).message).toMatch(/已经开着了/);
    expect(logins).toHaveLength(1);

    logins[0]!.finish('12345_abcdef');
    const s = await until(async () => {
      const x = await call<{ session: boolean; account: unknown; login: unknown }>('pixiv-browser.status');
      return x.session && x.account && x;
    }, '登录好');
    expect(s).toMatchObject({ session: true, account: { id: '12345', name: '测试账号' }, login: null });
    expect(await call('pixiv-browser.following', {})).toMatchObject({ items: [], next: null });
    expect(requests.at(-1)!.headers.cookie).toBe('PHPSESSID=12345_abcdef');
    // 凭证视图读不到
    expect(JSON.stringify(ds.plugins.storage.keys(ID).map((k) => ds.plugins.storage.get(ID, k)))).not.toContain('abcdef');

    await call('pixiv-browser.logout');
    expect(await call('pixiv-browser.status')).toMatchObject({ session: false, account: null });

    // 窗口关了没登录：说清楚
    await call('pixiv-browser.login');
    logins[1]!.fail('登录窗口关掉了，还没有登录好');
    expect(
      await until(async () => (await call<{ login: { error?: string } | null }>('pixiv-browser.status')).login?.error, '失败的原因'),
    ).toBe('登录窗口关掉了，还没有登录好');
  });

  it('批量下载：后台任务有进度，全部页放进授权的文件夹；动图跳过；再下载一次不再放一份', async () => {
    await enable();
    await call('pixiv-browser.ranking', { mode: 'daily' });
    const r = await call<{ jobId: string; message: string }>('pixiv-browser.download', { ids: ['111', '222', '333'] });
    expect(r.message).toMatch(/已开始下载 3 个 Pixiv 作品/);
    const job = await until(() => ['done', 'failed'].includes(ds.ctx.jobs.get(r.jobId)!.status) && ds.ctx.jobs.get(r.jobId)!, '下载完');
    expect(job).toMatchObject({ status: 'done', kind: 'plugin', plugin: ID, title: '下载 3 个 Pixiv 作品', progress: 3, total: 3 });
    expect(job.message).toMatch(/下载完了 2 个作品，新加 3 张，1 个失败（「动图」：动图/);
    expect(readdirSync(path.join(lib, '下载图片', 'Pixiv')).sort()).toEqual(['111_p0.png', '111_p1.png', '222_p0.png']);
    // 导入记成插件；临时文件删掉了
    expect(ds.ctx.db.prepare("SELECT DISTINCT actor FROM command_log WHERE command = 'library.import'").pluck().all()).toEqual([
      'plugin:pixiv-browser@0.3.0',
    ]);
    expect(readdirSync(ds.plugins.dataDir(ID))).not.toContain('dl');
    // 页面上标「已下载」
    expect(await call('pixiv-browser.status', { ids: ['111', '222', '333'] })).toMatchObject({
      session: false,
      downloaded: ['111', '222'],
    });
    expect((await call<{ items: { downloaded: boolean }[] }>('pixiv-browser.ranking', {})).items.map((i) => i.downloaded)).toEqual([
      true,
      true,
      false,
    ]);

    // 再下载一次：图库里已经有了，不再放一份
    const again = await call<{ jobId: string }>('pixiv-browser.download', { ids: ['222'] });
    const job2 = await until(() => ds.ctx.jobs.get(again.jobId)!.status === 'done' && ds.ctx.jobs.get(again.jobId)!, '再下载完');
    expect(job2.title).toBe('下载「一张的」');
    expect(job2.message).toBe('下载完了 1 个作品，新加 0 张，1 张图库里已经有了');
    expect(readdirSync(path.join(lib, '下载图片', 'Pixiv'))).toHaveLength(3);
  });

  it('App 里的站内浏览：网站脚本发给 App；Pixiv 页面查好的原图地址直接下载（插件不用登录），只认 i.pximg.net', async () => {
    await enable();
    const sites = await ds.registry.query<PluginSite[]>('plugins.sites', {});
    expect(sites).toEqual([
      expect.objectContaining({
        pluginId: ID,
        id: 'pixiv',
        url: 'https://www.pixiv.net/',
        matches: ['www.pixiv.net'],
        code: expect.stringContaining('__emakiSite'),
      }),
    ]);
    const before = requests.length;
    const r = await call<{ jobId: string; message: string }>('pixiv-browser.download', {
      works: [
        {
          id: '555',
          title: '站内选的',
          urls: ['https://i.pximg.net/img-original/img/555_p0.png', 'https://i.pximg.net/img-original/img/555_p1.png'],
        },
        { id: '666', title: '地址不对的', urls: ['https://evil.example/x.png'] },
      ],
    });
    expect(r.message).toMatch(/已开始下载 2 个 Pixiv 作品/);
    const job = await until(() => ds.ctx.jobs.get(r.jobId)!.status === 'done' && ds.ctx.jobs.get(r.jobId)!, '下载完');
    expect(job.message).toMatch(/下载完了 2 个作品/);
    // 555 用给的地址，没去查作品页；666 的地址不认，退回去查
    const asked = requests.slice(before).map((x) => new URL(x.url).pathname);
    expect(asked).not.toContain('/ajax/illust/555/pages');
    expect(asked).toContain('/ajax/illust/666/pages');
    expect(asked).not.toContain('/x.png');
    expect(readdirSync(path.join(lib, '下载图片', 'Pixiv')).sort()).toEqual(['555_p0.png', '555_p1.png', '666_p0.png']);
    // 停用了就不发
    await call('plugins.setEnabled', { id: ID, enabled: false });
    expect(await ds.registry.query('plugins.sites', {})).toEqual([]);
  });

  it('取消下载：任务停下，算取消', async () => {
    await enable();
    const ids = Array.from({ length: 30 }, (_, i) => String(1000 + i));
    const r = await call<{ jobId: string }>('pixiv-browser.download', { ids });
    await until(() => (ds.ctx.jobs.get(r.jobId)?.progress ?? 0) >= 1, '开始下载');
    ds.ctx.jobs.cancel(r.jobId);
    const job = await until(
      () => ['cancelled', 'failed', 'done'].includes(ds.ctx.jobs.get(r.jobId)!.status) && ds.ctx.jobs.get(r.jobId)!,
      '停下',
    );
    expect(job.status).toBe('cancelled');
    expect(job.progress).toBeLessThan(30);
  });
});
