/**
 * 附带的 Pixiv 浏览插件（plugins/pixiv-browser，docs/plugins.md 第 6 节）：和第三方插件走一样的路——按文件夹装、授权单、
 * 子进程。Pixiv 换成假的（不联网）：浏览排行、取缩略图、批量下载（后台任务：进度、取消），放进授权给的文件夹，
 * 图库里已经有的不再放一份。
 */
import type { PluginsState } from '@emaki/shared';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config.ts';
import { EventBus } from '../../src/core/events.ts';
import { sharp } from '../../src/services/image/sharpConfig.ts';
import { PluginRuntime, type RuntimeOptions } from '../../src/services/plugins/runtime/host.ts';
import { SqliteDataSource } from '../helpers/client.ts';
import { makeTmpDir } from '../helpers/tmp.ts';

process.env.EMAKI_LOG_LEVEL = 'silent';

const ID = 'pixiv-browser';
let ds: SqliteDataSource;
let lib: string;
let rootId: number;
let runtime: PluginRuntime;
let requests: { url: string; headers: Record<string, string> }[];
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
  runtime = new PluginRuntime(ds, { fetch: fakePixiv, log: () => {} });
  runtime.start();
});
afterEach(async () => {
  await runtime.close();
  await ds.close();
});

const call = <T = Record<string, any>>(name: string, input: unknown = {}) => ds.registry.execute<T>(name, input);

async function until<T>(fn: () => T, what: string, ms = 20_000): Promise<Exclude<T, false | null | undefined>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as Exclude<T, false | null | undefined>;
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
    await expect(call('pixiv-browser.following', {})).rejects.toThrow(/Pixiv 登录/);
    await call('plugins.setSettings', { id: ID, values: { session: 'abc123' } });
    expect(await call('pixiv-browser.following', {})).toMatchObject({ items: [], next: null });
    expect(requests.at(-1)!.headers.cookie).toBe('PHPSESSID=abc123');
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
      'plugin:pixiv-browser@0.1.0',
    ]);
    expect(readdirSync(ds.plugins.dataDir(ID))).not.toContain('dl');
    // 页面上标「已下载」
    expect(await call('pixiv-browser.status', { ids: ['111', '222', '333'] })).toEqual({ session: false, downloaded: ['111', '222'] });
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
