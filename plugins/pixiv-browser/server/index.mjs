// Pixiv 浏览（随 Emaki 附带的插件，docs/plugins.md 第 6 节）：在 Emaki 给的子进程里跑，只能读写自己的文件夹。
// 联网都经 emaki.fetch（走 Emaki 的代理设置，只能连授权的 www.pixiv.net、i.pximg.net）；下载的原图先放在自己的文件夹，
// 再经 emaki.library.import 放进授权单上选的文件夹——去重、入库、识别都走 Emaki 现有的路。
//
// 请求要节流：Pixiv 的接口两次之间至少隔 PACE_MS，图片同时最多取几张；只拿你的账号本来就能看到的内容。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WWW = 'https://www.pixiv.net';
const REFERER = 'https://www.pixiv.net/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
/** 接口两次请求之间至少隔多久 */
const PACE_MS = 600;
/** 缩略图缓存最多留多少张（启动时清掉旧的） */
const MAX_THUMBS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function activate(emaki) {
  const files = emaki.files;
  const thumbsDir = files.path('thumbs');
  const dlDir = files.path('dl');
  mkdirSync(thumbsDir, { recursive: true });
  // 上次没下完的临时文件
  rmSync(dlDir, { recursive: true, force: true });
  pruneThumbs(thumbsDir);

  // 下载过的作品（只有插件自己用：页面上标「已下载」）
  const doneFile = files.path('downloaded.json');
  const downloaded = new Set(readJson(doneFile, []));
  const saveDownloaded = () => writeFileSync(doneFile, JSON.stringify([...downloaded]));

  // 浏览时见过的作品：下载时就不用再查一次标题、类型
  const seen = new Map();
  const remember = (items) => {
    for (const it of items) seen.set(it.id, it);
    if (seen.size > 5000) for (const k of [...seen.keys()].slice(0, seen.size - 4000)) seen.delete(k);
    return items.map((it) => ({ ...it, downloaded: downloaded.has(it.id) }));
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
    return { items: remember(items), next: r.next ? Number(r.next) : null, date: r.date ?? null };
  });

  emaki.commands.handle('search', async ({ word, page = 1, order = 'date_d', mode = 'safe', match = 'tag' }) => {
    if (mode !== 'safe' && !(await session())) throw new Error('看 R-18 的要先登录 Pixiv');
    const sMode = { tag: 's_tag_full', partial: 's_tag', text: 's_tc' }[match] ?? 's_tag_full';
    const q = new URLSearchParams({ word, order, mode, p: String(page), s_mode: sMode, type: 'illust_and_ugoira', lang: 'zh' });
    const r = await api(`/ajax/search/illustrations/${encodeURIComponent(word)}?${q}`);
    const block = r.illust ?? { data: [], total: 0, lastPage: 1 };
    const items = (block.data ?? []).filter((d) => d && d.id && !d.isAdContainer).map(fromThumbnail);
    return { items: remember(items), next: page < (block.lastPage ?? 1) ? page + 1 : null, total: block.total ?? items.length };
  });

  emaki.commands.handle('following', async ({ page = 1, r18 = false }) => {
    const q = new URLSearchParams({ p: String(page), mode: r18 ? 'r18' : 'all', lang: 'zh' });
    const r = await api(`/ajax/follow_latest/illust?${q}`, { login: true });
    const items = (r.thumbnails?.illust ?? []).map(fromThumbnail);
    return { items: remember(items), next: r.page?.isLastPage ? null : page + 1 };
  });

  // ---------------------------------------------------------------- 登录

  // 正在登录（开着登录窗口）、上次登录失败的原因
  let login = null;

  emaki.commands.handle('status', async ({ ids = [] }) => ({
    session: !!(await session()),
    account: (await emaki.storage.get('account')) ?? null,
    login,
    downloaded: ids.filter((id) => downloaded.has(String(id))),
  }));

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

  emaki.commands.handle('download', async ({ ids }) => {
    const unique = [...new Set(ids.map(String))];
    const first = seen.get(unique[0]);
    const title = unique.length === 1 && first ? `下载「${first.title}」` : `下载 ${unique.length} 个 Pixiv 作品`;
    const job = await emaki.jobs.start('download', { ids: unique }, { title });
    return { jobId: job.id, message: `已开始${title}，进度在任务列表里` };
  });

  emaki.jobs.register('download', async ({ ids }, job) => {
    job.setTotal(ids.length);
    let works = 0;
    let added = 0;
    let existing = 0;
    const failed = [];
    for (const id of ids) {
      if (job.signal.aborted) throw new Error('取消了');
      const meta = seen.get(id);
      const label = meta ? `「${meta.title}」` : id;
      try {
        if (meta?.type === 'ugoira') throw new Error('动图（ugoira）暂时下载不了');
        const pages = await api(`/ajax/illust/${id}/pages?lang=zh`, { login: false });
        if (!Array.isArray(pages) || !pages.length) throw new Error('没有找到这个作品的图');
        const saved = [];
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
        downloaded.add(id);
        saveDownloaded();
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
