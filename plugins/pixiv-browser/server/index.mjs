// Pixiv 浏览（随 Emaki 附带的插件，docs/plugins.md 第 6 节）：在 Emaki 给的子进程里跑，只能读写自己的文件夹。
// 联网都经 emaki.fetch（走 Emaki 的代理设置，只能连授权的 www.pixiv.net、i.pximg.net）；下载的原图先放在自己的文件夹，
// 再经 emaki.library.import 放进授权单上选的文件夹——去重、入库、识别都走 Emaki 现有的路。
//
// 请求要节流：Pixiv 的接口两次之间至少隔 PACE_MS，图片同时最多取几张；只拿你的账号本来就能看到的内容。
//
// 动图（ugoira）在 Pixiv 上是一个 zip（每一帧一张 JPEG / PNG）加一份每帧停多久的列表：拆开以后存成 HTML 动图
// （帧原样放进去，不重新压缩；用浏览器直接打开就能播放），Emaki 认得这种文件（services/image/htmlAnimation.ts）。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const WWW = 'https://www.pixiv.net';
const REFERER = 'https://www.pixiv.net/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
/** 接口两次请求之间至少隔多久 */
const PACE_MS = 600;
/** 缩略图缓存最多留多少张（启动时清掉旧的） */
const MAX_THUMBS = 3000;
/** Emaki 收的 HTML 动图最大 128 MiB、最多 1000 帧、每帧停 1–60000 毫秒（services/image/htmlAnimation.ts） */
const MAX_HTML = 128 * 1024 * 1024;
const MAX_FRAMES = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function activate(emaki) {
  const files = emaki.files;
  const thumbsDir = files.path('thumbs');
  const dlDir = files.path('dl');
  mkdirSync(thumbsDir, { recursive: true });
  // 上次没下完的临时文件
  rmSync(dlDir, { recursive: true, force: true });
  pruneThumbs(thumbsDir);

  // 作品一共几页（插件自己下过的，下次标「已下载」「下了 2/5 张」用；浏览时见过的在 seen 里）
  const pagesFile = files.path('pages.json');
  const knownPages = new Map(Object.entries(readJson(pagesFile, {})));
  const savePages = () => {
    if (knownPages.size > 20000) for (const k of [...knownPages.keys()].slice(0, knownPages.size - 15000)) knownPages.delete(k);
    writeFileSync(pagesFile, JSON.stringify(Object.fromEntries(knownPages)));
  };
  // 以前只记了下载过哪些（0.3.0）：现在按图库算，不用了
  rmSync(files.path('downloaded.json'), { force: true });

  // 浏览时见过的作品：下载时就不用再查一次标题、类型
  const seen = new Map();

  /**
   * 这些作品在图库里有几张、一共几页（不管是这个插件下的还是别的工具下的：Emaki 按图片的来源认作品号）。
   * have 够了 pages（或者不知道几页）算下载过；只列图库里有的
   */
  async function inLibrary(ids) {
    const out = {};
    for (let i = 0; i < ids.length; i += 500) {
      const { posts } = await emaki.call('images.pixivPosts', { ids: ids.slice(i, i + 500) });
      for (const [id, p] of Object.entries(posts)) {
        const pages = seen.get(id)?.pages ?? knownPages.get(id) ?? p.pages ?? null;
        out[id] = { have: p.images, pages, animated: p.animated > 0 };
      }
    }
    return out;
  }
  const isFull = (w) => !!w && (w.pages == null || w.have >= w.pages);

  /** 列表里的作品：记下来，标上图库里有几张 */
  const remember = async (items) => {
    for (const it of items) seen.set(it.id, it);
    if (seen.size > 5000) for (const k of [...seen.keys()].slice(0, seen.size - 4000)) seen.delete(k);
    const lib = await inLibrary(items.map((it) => it.id));
    return items.map((it) => ({ ...it, have: lib[it.id]?.have ?? 0, downloaded: isFull(lib[it.id]) }));
  };

  // ---------------------------------------------------------------- 请求 Pixiv

  let last = 0;
  let queue = Promise.resolve();
  /** 接口请求排队、按 PACE_MS 节流 */
  const paced = (fn) => {
    const run = queue.then(async () => {
      const wait = last + PACE_MS - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    queue = run.catch(() => {});
    return run;
  };

  /** 登录以后的 Cookie（经登录窗口拿到，存在插件的凭证里，页面读不到） */
  async function session() {
    const raw = ((await emaki.secrets.get('session')) ?? '').trim();
    return raw ? `PHPSESSID=${raw}` : null;
  }

  /** www.pixiv.net 的接口：返回 body（JSON 的 error 为 true 时抛出） */
  async function api(pathAndQuery, { login = false } = {}) {
    const cookie = await session();
    if (login && !cookie) throw new Error('要先登录 Pixiv');
    const r = await paced(() =>
      emaki.fetch(`${WWW}${pathAndQuery}`, {
        headers: {
          referer: REFERER,
          'user-agent': UA,
          accept: 'application/json',
          'accept-language': 'zh-CN,zh;q=0.9',
          ...(cookie && { cookie }),
        },
        as: 'json',
      }),
    );
    if (r.status === 401 || r.status === 403)
      throw new Error(cookie ? 'Pixiv 拒绝了请求：登录可能过期了，重新登录 Pixiv' : 'Pixiv 拒绝了请求：这个要先登录 Pixiv');
    if (r.status === 429) throw new Error('Pixiv 说请求太频繁了，过一会儿再试');
    if (!r.ok) throw new Error(`Pixiv 返回 HTTP ${r.status}`);
    const json = r.body;
    if (json && json.error) throw new Error(json.message || 'Pixiv 返回了错误');
    return json && 'body' in json ? json.body : json;
  }

  // ---------------------------------------------------------------- 浏览

  emaki.commands.handle('ranking', async ({ mode = 'daily', page = 1, date }) => {
    if (mode.endsWith('_r18') && !(await session())) throw new Error('R-18 的排行要先登录 Pixiv');
    const q = new URLSearchParams({ mode, p: String(page), format: 'json' });
    if (date) q.set('date', date);
    const r = await api(`/ranking.php?${q}`, { login: mode.endsWith('_r18') });
    const items = (r.contents ?? []).map((c) => ({
      id: String(c.illust_id),
      title: c.title,
      user: c.user_name,
      userId: String(c.user_id),
      pages: Number(c.illust_page_count) || 1,
      type: typeOf(Number(c.illust_type)),
      // 全年龄的榜里 illust_content_type.sexual 是轻度的（不是 R-18）
      r18: mode.endsWith('_r18'),
      ai: c.illust_ai_type === 2,
      thumb: smaller(c.url),
      width: c.width,
      height: c.height,
      rank: c.rank,
    }));
    return { items: await remember(items), next: r.next ? Number(r.next) : null, date: r.date ?? null };
  });

  emaki.commands.handle('search', async ({ word, page = 1, order = 'date_d', mode = 'safe', match = 'tag' }) => {
    if (mode !== 'safe' && !(await session())) throw new Error('看 R-18 的要先登录 Pixiv');
    const sMode = { tag: 's_tag_full', partial: 's_tag', text: 's_tc' }[match] ?? 's_tag_full';
    const q = new URLSearchParams({ word, order, mode, p: String(page), s_mode: sMode, type: 'illust_and_ugoira', lang: 'zh' });
    const r = await api(`/ajax/search/illustrations/${encodeURIComponent(word)}?${q}`);
    const block = r.illust ?? { data: [], total: 0, lastPage: 1 };
    const items = (block.data ?? []).filter((d) => d && d.id && !d.isAdContainer).map(fromThumbnail);
    return { items: await remember(items), next: page < (block.lastPage ?? 1) ? page + 1 : null, total: block.total ?? items.length };
  });

  emaki.commands.handle('following', async ({ page = 1, r18 = false }) => {
    const q = new URLSearchParams({ p: String(page), mode: r18 ? 'r18' : 'all', lang: 'zh' });
    const r = await api(`/ajax/follow_latest/illust?${q}`, { login: true });
    const items = (r.thumbnails?.illust ?? []).map(fromThumbnail);
    return { items: await remember(items), next: r.page?.isLastPage ? null : page + 1 };
  });

  // 一个作品（电脑上从图片的来源点进来：Emaki 的「Pixiv」页显示这个作品的每一页、图库里有几张、补齐）
  emaki.commands.handle('work', async ({ id }) => {
    const w = await api(`/ajax/illust/${id}?lang=zh`);
    const type = typeOf(Number(w.illustType));
    const count = type === 'ugoira' ? 1 : Number(w.pageCount) || 1;
    let pages = [{ thumb: w.urls?.small ?? w.urls?.thumb ?? null, width: w.width, height: w.height }];
    if (count > 1) {
      const ps = await api(`/ajax/illust/${id}/pages?lang=zh`);
      if (Array.isArray(ps) && ps.length) pages = ps.map((p) => ({ thumb: p.urls?.small ?? p.urls?.thumb_mini ?? null, width: p.width, height: p.height }));
    }
    const [item] = await remember([
      {
        id: String(id),
        title: w.title,
        user: w.userName,
        userId: String(w.userId),
        pages: count,
        type,
        r18: Number(w.xRestrict) > 0,
        ai: w.aiType === 2,
        thumb: pages[0]?.thumb ?? null,
        width: w.width,
        height: w.height,
      },
    ]);
    return { ...item, date: w.createDate ?? null, tags: (w.tags?.tags ?? []).map((t) => t.tag).slice(0, 20), pageThumbs: pages };
  });

  // ---------------------------------------------------------------- 登录

  // 正在登录（开着登录窗口）、上次登录失败的原因
  let login = null;

  // works：图库里有的作品各有几张、一共几页（不知道是 null）；downloaded：其中下全了的（或者不知道几页的）
  emaki.commands.handle('status', async ({ ids = [] }) => {
    const lib = await inLibrary(ids.map(String));
    return {
      session: !!(await session()),
      account: (await emaki.storage.get('account')) ?? null,
      login,
      downloaded: Object.keys(lib).filter((id) => isFull(lib[id])),
      works: Object.fromEntries(Object.entries(lib).map(([id, w]) => [id, { have: w.have, pages: w.pages }])),
    };
  });

  // 不让你去浏览器里翻 Cookie：在电脑上开一个 Pixiv 的登录页，你登录好以后 Emaki 读到登录的 Cookie，窗口自己关掉
  emaki.commands.handle('login', async () => {
    if (login?.state === 'waiting') return { message: '登录窗口已经开着了，在电脑上登录 Pixiv' };
    const win = await emaki.login.browser({
      url: 'https://accounts.pixiv.net/login?return_to=https%3A%2F%2Fwww.pixiv.net%2F&lang=zh&source=pc&view_type=page',
      cookieUrl: 'https://www.pixiv.net/',
      cookie: 'PHPSESSID',
      // 登录以后是「<用户 id>_…」，没登录的访客不是
      pattern: '^\\d+_',
    });
    login = { state: 'waiting' };
    win.done.then(
      async (value) => {
        await emaki.secrets.set('session', value);
        const id = value.split('_')[0];
        let name = null;
        try {
          name = (await api(`/ajax/user/${id}?lang=zh`, { login: true })).name ?? null;
        } catch (e) {
          emaki.log(`取账号名字失败：${e.message}`);
        }
        await emaki.storage.set('account', { id, name });
        login = null;
      },
      (e) => {
        login = { state: 'failed', error: e.message };
      },
    );
    return { message: '在电脑上弹出了 Pixiv 的登录页：在那里登录，登录好窗口会自己关掉' };
  });

  emaki.commands.handle('logout', async () => {
    await emaki.secrets.delete('session');
    await emaki.storage.delete('account');
    login = null;
    return { message: '已退出 Pixiv' };
  });

  // 缩略图：i.pximg.net 要带 Referer，页面里的 <img> 带不了，也连不了外站。取到自己的文件夹，页面经 Emaki 的地址显示
  emaki.commands.handle('thumbs', async ({ urls }) => {
    const out = {};
    const todo = [];
    for (const url of urls) {
      let u;
      try {
        u = new URL(url);
      } catch {
        continue;
      }
      if (u.hostname !== 'i.pximg.net') continue;
      const name = `${createHash('sha1').update(url).digest('hex')}${path.extname(u.pathname) || '.jpg'}`;
      const rel = `thumbs/${name}`;
      out[url] = rel;
      if (!existsSync(files.path(rel))) todo.push({ url, rel });
    }
    // 同时取 4 张
    await pool(todo, 4, async ({ url, rel }) => {
      const r = await emaki.fetch(url, { saveAs: rel, headers: { referer: REFERER, 'user-agent': UA } }).catch(() => null);
      if (!r?.ok) delete out[url];
    });
    return { files: out };
  });

  // ---------------------------------------------------------------- 下载

  // ids：只给作品 id（插件自己去查每一页的原图）；works：Pixiv 页面上加的按钮（App 里的站内浏览）给的，
  // 带标题和原图地址（页面用你在 App 里的登录查好的，R-18 也查得到），插件不用登录；动图给 ugoira（zip 的地址和每帧停多久）
  emaki.commands.handle('download', async ({ ids = [], works = [] }) => {
    const list = [];
    for (const w of works) {
      const ugoira = w.ugoira ? ugoiraOf(w.ugoira) : null;
      list.push({
        id: String(w.id),
        ...(w.title && { title: String(w.title) }),
        ...(w.urls?.length && { urls: w.urls.filter(isOriginal) }),
        ...(ugoira && { ugoira }),
      });
    }
    for (const id of ids) if (!list.some((w) => w.id === String(id))) list.push({ id: String(id) });
    const unique = list.filter((w, i) => list.findIndex((x) => x.id === w.id) === i);
    if (!unique.length) throw new Error('要给 ids 或 works');
    for (const w of unique) if (w.title) seen.set(w.id, { ...seen.get(w.id), id: w.id, title: w.title });
    const first = seen.get(unique[0].id);
    const title = unique.length === 1 && first ? `下载「${first.title}」` : `下载 ${unique.length} 个 Pixiv 作品`;
    const job = await emaki.jobs.start('download', { works: unique }, { title });
    return { jobId: job.id, message: `已开始${title}，进度在任务列表里` };
  });

  /** 动图的帧：zip 的地址（原尺寸的）、每帧停多久。R-18 的要登录 */
  async function ugoiraMeta(id) {
    const m = await api(`/ajax/illust/${id}/ugoira_meta?lang=zh`);
    const u = ugoiraOf({ zip: m?.originalSrc || m?.src, frames: m?.frames });
    if (!u) throw new Error('Pixiv 没给这个动图的帧');
    return u;
  }

  /** 下载动图的 zip，拆开，存成 HTML 动图（帧原样放进去）：返回给 library.import 的文件 */
  async function saveUgoira(id, title, ugoira, progress) {
    progress(`动图，${ugoira.frames.length} 帧`);
    const r = await emaki.fetch(ugoira.zip, { saveAs: `dl/${id}_ugoira.zip`, headers: { referer: REFERER, 'user-agent': UA } });
    if (!r.ok) throw new Error(`动图的帧取不到（HTTP ${r.status}）`);
    const entries = readZip(readFileSync(r.path));
    const frames = ugoira.frames.map((f) => {
      const data = entries.get(f.file);
      if (!data) throw new Error(`动图的 zip 里少了 ${f.file}`);
      return { data, delay: f.delay };
    });
    const html = ugoiraHtml(title, frames);
    if (html.length > MAX_HTML) throw new Error(`动图太大（${Math.round(html.length / 1048576)} MB），Emaki 最多收 128 MB`);
    const fileName = `${id}_ugoira.html`;
    const file = files.path(`dl/${fileName}`);
    writeFileSync(file, html);
    rmSync(r.path, { force: true });
    return { path: file, fileName };
  }

  emaki.jobs.register('download', async (input, job) => {
    // 老的任务只有 ids
    const list = input.works ?? (input.ids ?? []).map((id) => ({ id: String(id) }));
    const ids = list.map((w) => w.id);
    job.setTotal(ids.length);
    let works = 0;
    let added = 0;
    let existing = 0;
    const failed = [];
    for (const work of list) {
      const id = work.id;
      if (job.signal.aborted) throw new Error('取消了');
      const meta = seen.get(id);
      const label = meta?.title ? `「${meta.title}」` : id;
      try {
        let ugoira = work.ugoira ?? (meta?.type === 'ugoira' ? await ugoiraMeta(id) : null);
        let pages = ugoira
          ? []
          : work.urls?.length
            ? work.urls.map((original) => ({ urls: { original } }))
            : await api(`/ajax/illust/${id}/pages?lang=zh`, { login: false });
        // 不知道是不是动图（只给了 id）：动图的「页」是第一帧（<id>_ugoira0.jpg），不当静态图下
        if (!ugoira && /_ugoira0\./.test(pages[0]?.urls?.original ?? '')) {
          ugoira = await ugoiraMeta(id);
          pages = [];
        }
        if (!ugoira && (!Array.isArray(pages) || !pages.length)) throw new Error('没有找到这个作品的图');
        // 图库里已经有这个动图了（比如别的工具下的 HTML）：内容不一样，再存一份就重复了
        if (ugoira && (await inLibrary([id]))[id]?.animated) {
          existing += 1;
          works += 1;
          knownPages.set(id, 1);
          savePages();
          job.advance(1);
          continue;
        }
        const saved = ugoira ? [await saveUgoira(id, meta?.title ?? work.title ?? id, ugoira, (m) => job.setMessage(`下载 ${works + 1}/${ids.length}：${label}（${m}）`))] : [];
        for (let i = 0; i < pages.length; i++) {
          if (job.signal.aborted) throw new Error('取消了');
          job.setMessage(`下载 ${works + 1}/${ids.length}：${label}${pages.length > 1 ? `（第 ${i + 1}/${pages.length} 张）` : ''}`);
          const url = pages[i].urls?.original;
          if (!url) continue;
          const ext = path.extname(new URL(url).pathname) || '.jpg';
          const name = `${id}_p${i}${ext}`;
          const r = await emaki.fetch(url, { saveAs: `dl/${name}`, headers: { referer: REFERER, 'user-agent': UA } });
          if (!r.ok) throw new Error(`第 ${i + 1} 张取不到（HTTP ${r.status}）`);
          saved.push({ path: r.path, fileName: name });
          await sleep(200);
        }
        const result = await emaki.library.import({ folder: 'downloads', files: saved });
        for (const it of result.items) {
          if (it.status === 'imported') added += 1;
          else if (it.status === 'existing') existing += 1;
        }
        const bad = result.items.filter((it) => it.status === 'failed');
        if (bad.length) throw new Error(bad[0].error ?? '放进图库失败');
        knownPages.set(id, ugoira ? 1 : pages.length);
        savePages();
        works += 1;
      } catch (e) {
        if (job.signal.aborted) throw e;
        failed.push(`${label}：${e.message}`);
        emaki.log(`下载 ${id} 失败：${e.message}`);
      } finally {
        rmSync(files.path('dl'), { recursive: true, force: true });
      }
      job.advance(1);
    }
    if (!works && failed.length) throw new Error(failed[0]);
    const parts = [`下载完了 ${works} 个作品`, `新加 ${added} 张`];
    if (existing) parts.push(`${existing} 张图库里已经有了`);
    if (failed.length) parts.push(`${failed.length} 个失败（${failed[0]}）`);
    return parts.join('，');
  });
}

// ---------------------------------------------------------------- 小工具

/** 页面、Pixiv 给的动图信息 → 检查过的 { zip, frames }；不对的返回 null */
function ugoiraOf(u) {
  let zip;
  try {
    zip = new URL(String(u?.zip ?? ''));
  } catch {
    return null;
  }
  if (zip.protocol !== 'https:' || zip.hostname !== 'i.pximg.net' || !/\/img-zip-ugoira\/.+\.zip$/.test(zip.pathname)) return null;
  if (!Array.isArray(u.frames) || !u.frames.length || u.frames.length > MAX_FRAMES) return null;
  const frames = [];
  for (const f of u.frames) {
    const file = String(f?.file ?? '');
    if (!/^[\w.-]{1,64}$/.test(file)) return null;
    // Emaki 收 1–60000 毫秒
    frames.push({ file, delay: Math.min(60000, Math.max(1, Math.round(Number(f.delay) || 0))) });
  }
  return { zip: zip.href, frames };
}

/** zip 里的文件（名字 → 内容）：Pixiv 的动图 zip 不压缩（stored），也认 deflate */
function readZip(buf) {
  let end = buf.length - 22;
  const stop = Math.max(0, buf.length - 22 - 65535);
  while (end >= stop && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < stop) throw new Error('动图的 zip 坏了');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('动图的 zip 坏了');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`动图的 zip 用了不认识的压缩方式（${method}）`);
    p += 46 + skip;
  }
  return out;
}

/** 帧的类型（只收 JPEG、PNG：Emaki 的 HTML 动图只认图片帧） */
function frameType(data) {
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  throw new Error('动图的帧不是 JPEG、PNG');
}

/**
 * HTML 动图：帧列表 frames_info（每帧 data: 地址 + 停多久，放在最前面——Emaki 只看开头 64 KB 认这种文件）和一个小播放器。
 * Emaki 不跑里面的脚本，只读帧列表；用浏览器打开时脚本在画布上循环播放，点一下暂停
 */
function ugoiraHtml(title, frames) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const head = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>html,body{margin:0;height:100%;background:#111}body{display:flex;align-items:center;justify-content:center}canvas{max-width:100%;max-height:100%}</style>
</head>
<body>
<canvas id="c"></canvas>
<script>var frames_info=[`;
  const parts = [Buffer.from(head)];
  frames.forEach((f, i) => {
    parts.push(Buffer.from(`${i ? ',' : ''}{"file":"data:${frameType(f.data)};base64,`), Buffer.from(f.data.toString('base64')), Buffer.from(`","delay":${f.delay}}`));
  });
  parts.push(
    Buffer.from(`];</script>
<script>(function(){var c=document.getElementById('c'),x=c.getContext('2d'),im=[],left=frames_info.length,i=0,t=null;
function draw(){x.clearRect(0,0,c.width,c.height);x.drawImage(im[i],0,0);t=setTimeout(function(){i=(i+1)%im.length;draw();},frames_info[i].delay);}
frames_info.forEach(function(f,n){var m=new Image();m.onload=function(){if(--left===0){c.width=im[0].naturalWidth;c.height=im[0].naturalHeight;draw();}};m.src=f.file;im[n]=m;});
c.addEventListener('click',function(){if(t){clearTimeout(t);t=null;}else if(!left)draw();});})();</script>
</body>
</html>
`),
  );
  return Buffer.concat(parts);
}

/** Pixiv 的原图地址（i.pximg.net 的 https）：页面给的地址只认这种 */
function isOriginal(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'i.pximg.net';
  } catch {
    return false;
  }
}

function typeOf(n) {
  return n === 1 ? 'manga' : n === 2 ? 'ugoira' : 'illust';
}

/** 搜索、关注的作品 → 统一的样子 */
function fromThumbnail(d) {
  return {
    id: String(d.id),
    title: d.title,
    user: d.userName,
    userId: String(d.userId),
    pages: Number(d.pageCount) || 1,
    type: typeOf(Number(d.illustType)),
    r18: Number(d.xRestrict) > 0,
    ai: d.aiType === 2,
    thumb: d.url,
    width: d.width,
    height: d.height,
  };
}

/** 排行给的缩略图是 480×960，换成小一号的 */
function smaller(url) {
  return typeof url === 'string' ? url.replace('/c/480x960/', '/c/240x480/') : url;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 缩略图缓存太多时，删掉旧的一半 */
function pruneThumbs(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  if (names.length <= MAX_THUMBS) return;
  const byAge = names
    .map((n) => {
      try {
        return { n, t: statSync(path.join(dir, n)).mtimeMs };
      } catch {
        return { n, t: 0 };
      }
    })
    .sort((a, b) => a.t - b.t);
  for (const { n } of byAge.slice(0, byAge.length - MAX_THUMBS / 2)) rmSync(path.join(dir, n), { force: true });
}

/** 同时最多跑 n 个 */
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let it = queue.shift(); it; it = queue.shift()) await fn(it);
    }),
  );
}
