/**
 * 附带的 Pixiv 浏览插件（plugins/pixiv-browser，docs/plugins.md 第 6 节）：和第三方插件走一样的路——按文件夹装、授权单、
 * 子进程。Pixiv 换成假的（不联网）：浏览排行、取缩略图、批量下载（后台任务：进度、取消），放进授权给的文件夹，
 * 图库里已经有的不再放一份；动图（帧的 zip + 每帧停多久）存成 HTML 动图。
 */
import type { PluginSite, PluginsState } from '@emaki/shared';
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config.ts';
import type { JobContext } from '../../src/core/jobs.ts';
import { EventBus } from '../../src/core/events.ts';
import { parseHtmlAnimation } from '../../src/services/image/htmlAnimation.ts';
import { sharp } from '../../src/services/image/sharpConfig.ts';
import { runAs } from '../../src/propagation/actor.ts';
import { PluginRuntime, type RuntimeOptions } from '../../src/services/plugins/runtime/host.ts';
import type { LoginWindow, LoginWindowOptions } from '../../src/services/plugins/runtime/loginWindow.ts';
import { SqliteDataSource } from '../helpers/client.ts';
import { animationHtml } from '../helpers/htmlAnimation.ts';
import { makeTmpDir } from '../helpers/tmp.ts';

process.env.EMAKI_LOG_LEVEL = 'silent';

const ID = 'pixiv-browser';
let ds: SqliteDataSource;
let lib: string;
let rootId: number;
let runtime: PluginRuntime;
let requests: { url: string; headers: Record<string, string> }[];
/** 这些地址前几次出问题（'drop' 连接中途断了，数字是回这个状态码），用一次少一次 */
let flaky: Map<string, ('drop' | number)[]>;
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

/** 动图的两帧（同样大小、颜色不同）和每帧停多久 */
const UGOIRA_DELAYS = [50, 80];
const ugoiraFrame = (id: string, i: number) => imageFor(`ugoira:${id}:${i}`);

/** 和 Pixiv 一样不压缩（stored）的 zip */
function storedZip(files: [string, Buffer][]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(10, 4);
    h.writeUInt32LE(crc32(data), 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    local.push(h, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(10, 4);
    c.writeUInt16LE(10, 6);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
const zipUrl = (id: string) => `https://i.pximg.net/img-zip-ugoira/img/2026/11/24/${id}_ugoira1920x1080.zip`;
const ugoiraInfo = (id: string) => ({
  zip: zipUrl(id),
  frames: UGOIRA_DELAYS.map((delay, i) => ({ file: `00000${i}.png`, delay })),
});

const fakePixiv: RuntimeOptions['fetch'] = async (url, init) => {
  requests.push({ url, headers: init.headers ?? {} });
  const trouble = flaky.get(url)?.shift();
  if (trouble === 'drop') throw new TypeError('terminated');
  if (trouble) return new Response('', { status: trouble });
  const u = new URL(url);
  if (u.hostname === 'www.pixiv.net' && u.pathname === '/ranking.php')
    return json({
      contents: [
        {
          illust_id: 11100001,
          title: '两张的',
          user_name: '画师甲',
          user_id: 9,
          illust_page_count: '2',
          illust_type: '0',
          url: 'https://i.pximg.net/c/480x960/img-master/img/11100001_p0_master1200.jpg',
          rank: 1,
          illust_content_type: { sexual: 0 },
        },
        {
          illust_id: 22200002,
          title: '一张的',
          user_name: '画师乙',
          user_id: 8,
          illust_page_count: '1',
          illust_type: '0',
          url: 'https://i.pximg.net/c/480x960/img-master/img/22200002_p0_master1200.jpg',
          rank: 2,
          illust_content_type: { sexual: 0 },
        },
        {
          illust_id: 33300003,
          title: '动图',
          user_name: '画师丙',
          user_id: 7,
          illust_page_count: '1',
          illust_type: '2',
          url: 'https://i.pximg.net/c/480x960/img-master/img/33300003_p0_master1200.jpg',
          rank: 3,
          illust_content_type: { sexual: 0 },
        },
      ],
      next: 2,
      date: '20261124',
    });
  const pages = /^\/ajax\/illust\/(\d+)\/pages$/.exec(u.pathname);
  // 33300003、152442850 是动图：「页」是第一帧
  const isUgoira = (id: string) => id === '33300003' || id === '152442850';
  // 一个作品（电脑上从图片的来源点进来，pixiv-browser.work）
  const illust = /^\/ajax\/illust\/(\d+)$/.exec(u.pathname);
  if (u.hostname === 'www.pixiv.net' && illust && illust[1] === '11100001')
    return json({
      error: false,
      body: {
        title: '两张的',
        userName: '画师甲',
        userId: '9',
        illustType: 0,
        pageCount: 2,
        xRestrict: 0,
        aiType: 1,
        width: 1200,
        height: 1600,
        createDate: '2026-11-24T00:00:00+09:00',
        urls: { small: 'https://i.pximg.net/c/540x540_70/img-master/img/11100001_p0_master1200.jpg' },
        tags: { tags: [{ tag: 'オリジナル' }] },
      },
    });
  if (u.hostname === 'www.pixiv.net' && pages) {
    const id = pages[1]!;
    if (isUgoira(id)) return json({ error: false, body: [{ urls: { original: `https://i.pximg.net/img-original/img/${id}_ugoira0.jpg` } }] });
    const n = id === '11100001' ? 2 : 1;
    return json({
      error: false,
      body: Array.from({ length: n }, (_, i) => ({
        urls: {
          original: `https://i.pximg.net/img-original/img/${id}_p${i}.png`,
          small: `https://i.pximg.net/c/540x540_70/img-master/img/${id}_p${i}_master1200.jpg`,
        },
        width: 1200,
        height: 1600,
      })),
    });
  }
  const meta = /^\/ajax\/illust\/(\d+)\/ugoira_meta$/.exec(u.pathname);
  if (u.hostname === 'www.pixiv.net' && meta && isUgoira(meta[1]!)) {
    const { zip, frames } = ugoiraInfo(meta[1]!);
    return json({ error: false, body: { src: zip.replace('1920x1080', '600x600'), originalSrc: zip, mime_type: 'image/png', frames } });
  }
  const zip = /\/(\d+)_ugoira1920x1080\.zip$/.exec(u.pathname);
  if (u.hostname === 'i.pximg.net' && zip) {
    if (init.headers?.referer !== 'https://www.pixiv.net/') return new Response('', { status: 403 });
    const id = zip[1]!;
    return new Response(storedZip(await Promise.all(UGOIRA_DELAYS.map(async (_, i) => [`00000${i}.png`, await ugoiraFrame(id, i)] as [string, Buffer]))));
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
  flaky = new Map();
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

/** 下载好的动图：HTML 里是原样的两帧和每帧停多久，图库认成 Pixiv 的动图 */
async function expectUgoira(id: string) {
  const file = path.join(lib, '下载图片', 'Pixiv', `${id}_ugoira.html`);
  const frames = parseHtmlAnimation(readFileSync(file));
  expect(frames.map((f) => f.delay)).toEqual(UGOIRA_DELAYS);
  for (const [i, f] of frames.entries())
    expect(Buffer.from(f.file.slice(f.file.indexOf(',') + 1), 'base64').equals(await ugoiraFrame(id, i))).toBe(true);
  expect(
    ds.ctx.db.prepare('SELECT format, frame_count, animated, source_site, source_post_id FROM images WHERE file_name = ?').get(`${id}_ugoira.html`),
  ).toEqual({ format: 'html', frame_count: 2, animated: 1, source_site: 'pixiv', source_post_id: id });
}

/** 和扫描任务一样扫一遍图库（别的工具放进来的文件） */
async function scan() {
  const job: JobContext = { signal: new AbortController().signal, setTotal() {}, advance() {}, setMessage() {}, shouldYield: () => false, requeue() {}, yielded: false };
  ds.requests.requestFull();
  await runAs('job:scan', () => ds.scanner.scan(job));
  ds.ctx.propagation.jobFinished('scan');
}

describe('附带的 Pixiv 浏览', () => {
  it('默认没装；装好以后能看排行、取缩略图', async () => {
    const before = await ds.registry.query<PluginsState>('plugins.state', {});
    expect(before.plugins.some((p) => p.id === ID)).toBe(false);
    await enable();
    // 接管 Pixiv 作品页的链接、看图器上「在 Pixiv 打开」（docs/plugins.md 12.7；按钮的 id 带上插件的 id）
    const info = (await ds.registry.query<PluginsState>('plugins.state', {})).plugins.find((p) => p.id === ID)!;
    expect(info.problems).toEqual([]);
    expect(info.contributes['link@1']).toEqual([
      expect.objectContaining({ urls: ['https://www.pixiv.net/artworks/*', 'https://www.pixiv.net/*/artworks/*'], page: 'browse', site: 'pixiv' }),
    ]);
    expect(info.contributes['lightbox.toolbar@1']).toEqual([{ id: `${ID}/open`, label: '在 Pixiv 打开', icon: 'external-link', sources: ['pixiv'], open: 'source' }]);
    const r = await call<{
      items: { id: string; title: string; pages: number; type: string; thumb: string; downloaded: boolean }[];
      next: number;
    }>('pixiv-browser.ranking', { mode: 'daily' });
    expect(r.items.map((i) => [i.id, i.title, i.pages, i.type, i.downloaded])).toEqual([
      ['11100001', '两张的', 2, 'illust', false],
      ['22200002', '一张的', 1, 'illust', false],
      ['33300003', '动图', 1, 'ugoira', false],
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

  it('批量下载：后台任务有进度，全部页放进授权的文件夹；动图存成 HTML 动图；再下载一次不再放一份', async () => {
    await enable();
    await call('pixiv-browser.ranking', { mode: 'daily' });
    const r = await call<{ jobId: string; message: string }>('pixiv-browser.download', { ids: ['11100001', '22200002', '33300003'] });
    expect(r.message).toMatch(/已开始下载 3 个 Pixiv 作品/);
    const job = await until(() => ['done', 'failed'].includes(ds.ctx.jobs.get(r.jobId)!.status) && ds.ctx.jobs.get(r.jobId)!, '下载完');
    expect(job).toMatchObject({ status: 'done', kind: 'plugin', plugin: ID, title: '下载 3 个 Pixiv 作品', progress: 3, total: 3 });
    expect(job.message).toBe('下载完了 3 个作品，新加 4 张');
    expect(readdirSync(path.join(lib, '下载图片', 'Pixiv')).sort()).toEqual(['11100001_p0.png', '11100001_p1.png', '22200002_p0.png', '33300003_ugoira.html']);
    await expectUgoira('33300003');
    // 导入记成插件；临时文件删掉了
    expect(ds.ctx.db.prepare("SELECT DISTINCT actor FROM command_log WHERE command = 'library.import'").pluck().all()).toEqual([
      'plugin:pixiv-browser@0.6.1',
    ]);
    expect(readdirSync(ds.plugins.dataDir(ID))).not.toContain('dl');
    // 页面上标「已下载」
    expect(await call('pixiv-browser.status', { ids: ['11100001', '22200002', '33300003'] })).toMatchObject({
      session: false,
      downloaded: ['11100001', '22200002', '33300003'],
      works: { '11100001': { have: 2, pages: 2 }, '22200002': { have: 1, pages: 1 }, '33300003': { have: 1, pages: 1 } },
    });
    expect((await call<{ items: { downloaded: boolean }[] }>('pixiv-browser.ranking', {})).items.map((i) => i.downloaded)).toEqual([
      true,
      true,
      true,
    ]);

    // 再下载一次：图库里已经有了，不再放一份
    const again = await call<{ jobId: string }>('pixiv-browser.download', { ids: ['22200002'] });
    const job2 = await until(() => ds.ctx.jobs.get(again.jobId)!.status === 'done' && ds.ctx.jobs.get(again.jobId)!, '再下载完');
    expect(job2.title).toBe('下载「一张的」');
    expect(job2.message).toBe('下载完了 1 个作品，新加 0 张，1 张图库里已经有了');
    expect(readdirSync(path.join(lib, '下载图片', 'Pixiv'))).toHaveLength(4);
  });

  it('「已下载」按图库算（别的工具下的也算）：只下了一部分是 1/2，再下载补齐；图库里已经有的动图不再存一份', async () => {
    await enable();
    await call('pixiv-browser.ranking', { mode: 'daily' });
    // 别的工具下的：两页的作品只有第一页（内容和 Pixiv 的原图一样），一个动图（别的工具存的 HTML，内容不一样）
    const other = path.join(lib, '别的工具');
    mkdirSync(other);
    writeFileSync(path.join(other, '11100001_p0.png'), await imageFor('https://i.pximg.net/img-original/img/11100001_p0.png'));
    writeFileSync(path.join(other, '33300003_ugoira0.html'), await animationHtml());
    // 扫描不收刚写完（可能还在写）的文件
    const before = new Date(Date.now() - 60_000);
    for (const f of readdirSync(other)) utimesSync(path.join(other, f), before, before);
    await scan();
    const s = await call<{ downloaded: string[]; works: Record<string, unknown> }>('pixiv-browser.status', { ids: ['11100001', '22200002', '33300003'] });
    // 电脑上从图片的来源点进来：这个作品的每一页、图库里有几张
    const work = await call('pixiv-browser.work', { id: '11100001' });
    expect(work).toMatchObject({ id: '11100001', title: '两张的', user: '画师甲', pages: 2, type: 'illust', have: 1, downloaded: false, tags: ['オリジナル'] });
    expect(work.pageThumbs.map((p: { thumb: string }) => p.thumb)).toEqual([
      'https://i.pximg.net/c/540x540_70/img-master/img/11100001_p0_master1200.jpg',
      'https://i.pximg.net/c/540x540_70/img-master/img/11100001_p1_master1200.jpg',
    ]);
    expect(s.downloaded).toEqual(['33300003']);
    expect(s.works).toEqual({ '11100001': { have: 1, pages: 2 }, '33300003': { have: 1, pages: 1 } });
    expect(
      (await call<{ items: { id: string; have: number; downloaded: boolean }[] }>('pixiv-browser.ranking', {})).items.map((i) => [i.id, i.have, i.downloaded]),
    ).toEqual([
      ['11100001', 1, false],
      ['22200002', 0, false],
      ['33300003', 1, true],
    ]);

    // 补齐：整个作品再下一次，图库里已经有的那页不再放一份；动图图库里已经有了，不下
    const r = await call<{ jobId: string }>('pixiv-browser.download', { ids: ['11100001', '33300003'] });
    const job = await until(() => ['done', 'failed'].includes(ds.ctx.jobs.get(r.jobId)!.status) && ds.ctx.jobs.get(r.jobId)!, '下载完');
    expect(job).toMatchObject({ status: 'done', progress: 2, message: '下载完了 2 个作品，新加 1 张，2 张图库里已经有了' });
    expect(readdirSync(path.join(lib, '下载图片', 'Pixiv'))).toEqual(['11100001_p1.png']);
    expect(requests.some((x) => x.url.includes('33300003_ugoira1920x1080.zip'))).toBe(false);
    expect(await call('pixiv-browser.status', { ids: ['11100001'] })).toMatchObject({
      downloaded: ['11100001'],
      works: { '11100001': { have: 2, pages: 2 } },
    });
    expect(await call('pixiv-browser.work', { id: '11100001' })).toMatchObject({ have: 2, downloaded: true });
  });

  it('只给作品 id、不知道是不是动图：从第一页认出来，存成 HTML 动图，不把第一帧当静态图下', async () => {
    await enable();
    const r = await call<{ jobId: string }>('pixiv-browser.download', { ids: ['152442850'] });
    const job = await until(() => ['done', 'failed'].includes(ds.ctx.jobs.get(r.jobId)!.status) && ds.ctx.jobs.get(r.jobId)!, '下载完');
    expect(job.message).toBe('下载完了 1 个作品，新加 1 张');
    expect(readdirSync(path.join(lib, '下载图片', 'Pixiv'))).toEqual(['152442850_ugoira.html']);
    expect(requests.some((x) => x.url.includes('_ugoira0.jpg'))).toBe(false);
    await expectUgoira('152442850');
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
          id: '55500005',
          title: '站内选的',
          urls: ['https://i.pximg.net/img-original/img/55500005_p0.png', 'https://i.pximg.net/img-original/img/55500005_p1.png'],
        },
        { id: '66600006', title: '地址不对的', urls: ['https://evil.example/x.png'] },
        // 动图：页面查好的帧的 zip 地址、每帧停多久
        { id: '33300003', title: '站内选的动图', ugoira: ugoiraInfo('33300003') },
        { id: '77700007', title: 'zip 地址不对的', ugoira: { ...ugoiraInfo('77700007'), zip: 'https://evil.example/77700007_ugoira1920x1080.zip' } },
      ],
    });
    expect(r.message).toMatch(/已开始下载 4 个 Pixiv 作品/);
    const job = await until(() => ds.ctx.jobs.get(r.jobId)!.status === 'done' && ds.ctx.jobs.get(r.jobId)!, '下载完');
    expect(job.message).toMatch(/下载完了 4 个作品/);
    // 55500005 用给的地址，没去查作品页；66600006 的地址不认，退回去查；33300003 的帧用给的（没去查动图信息），77700007 的 zip 地址不认，退回去查（不是动图）
    const asked = requests.slice(before).map((x) => new URL(x.url).pathname);
    expect(asked).not.toContain('/ajax/illust/55500005/pages');
    expect(asked).toContain('/ajax/illust/66600006/pages');
    expect(asked).not.toContain('/x.png');
    expect(asked.filter((a) => a.startsWith('/ajax/illust/33300003'))).toEqual([]);
    expect(requests.slice(before).some((x) => x.url.startsWith('https://evil.example'))).toBe(false);
    expect(readdirSync(path.join(lib, '下载图片', 'Pixiv')).sort()).toEqual(['33300003_ugoira.html', '55500005_p0.png', '55500005_p1.png', '66600006_p0.png', '77700007_p0.png']);
    await expectUgoira('33300003');
    // 停用了就不发
    await call('plugins.setEnabled', { id: ID, enabled: false });
    expect(await ds.registry.query('plugins.sites', {})).toEqual([]);
  });

  it('一张断了只重试这一张（最多 3 次）：连接中途断了、5xx 再试，作品照样下全；403 不再试', async () => {
    await enable();
    await call('pixiv-browser.ranking', { mode: 'daily' });
    const p1 = 'https://i.pximg.net/img-original/img/11100001_p1.png';
    const solo = 'https://i.pximg.net/img-original/img/22200002_p0.png';
    flaky.set(p1, ['drop', 503]);
    const r = await call<{ jobId: string }>('pixiv-browser.download', { ids: ['11100001'] });
    const job = await until(() => ['done', 'failed'].includes(ds.ctx.jobs.get(r.jobId)!.status) && ds.ctx.jobs.get(r.jobId)!, '下载完');
    expect(job).toMatchObject({ status: 'done', message: '下载完了 1 个作品，新加 2 张' });
    expect(requests.filter((x) => x.url === p1)).toHaveLength(3);
    // 第一张没有重下
    expect(requests.filter((x) => x.url.endsWith('11100001_p0.png'))).toHaveLength(1);
    // 403：不再试，算失败
    flaky.set(solo, [403]);
    const bad = await call<{ jobId: string }>('pixiv-browser.download', { ids: ['22200002'] });
    const job2 = await until(() => ['done', 'failed'].includes(ds.ctx.jobs.get(bad.jobId)!.status) && ds.ctx.jobs.get(bad.jobId)!, '失败');
    expect(job2.status).toBe('failed');
    expect(job2.message).toMatch(/HTTP 403/);
    expect(requests.filter((x) => x.url === solo)).toHaveLength(1);
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
