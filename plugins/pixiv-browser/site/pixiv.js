// Pixiv 浏览给 pixiv.net 加的按钮（site@1，docs/plugins.md 第 6 节）：安卓 App 里打开 Pixiv 网站本身时加载，网站原来的样子、功能都不动，只加：
// - 每个作品缩略图左上角一个选择圈，底部一条「已选 N 个 · 下载到 Emaki」；作品页上没选的时候是「下载这个作品」；
// - 图库里有的作品标「已下载」，只下了一部分的标「已下载 2/5」（不管是这个插件下的还是别的工具下的：电脑按图片的来源认作品号）；
//   作品页上是「补齐剩下的 3 张」。一共几页电脑不知道的，在这里查一次（只查图库里有的），记在这台设备上。
// 原图地址在这里查（用你在 App 里的 Pixiv 登录，R-18 也查得到），连同标题交给插件的 download 命令：后台下载、去重、放进授权的文件夹都在电脑上做。
// 动图查的是帧的 zip 地址和每帧停多久，电脑上拆开存成 HTML 动图。
// 经 App 注入的 window.__emakiSite.call(命令, 输入) 调这个插件自己的命令。只认作品链接（/artworks/<id>），不靠 Pixiv 的样式名。
(() => {
  if (window.__emakiPixiv || !window.__emakiSite) return;
  window.__emakiPixiv = true;
  const site = window.__emakiSite;
  const ARTWORK = /\/artworks\/(\d+)/;

  const selected = new Map(); // id → 标题
  const library = new Map(); // id → { have, pages }：图库里有几张、一共几页（不知道是 null）
  const asked = new Set();
  let toStatus = new Set();

  // 一共几页（电脑不知道的在这里查过的）：存在这台设备上，Pixiv 的作品很少再加页
  const PAGES_KEY = 'emaki-pixiv-pages';
  let pageCache = {};
  try {
    pageCache = JSON.parse(localStorage.getItem(PAGES_KEY) || '{}');
  } catch {}
  const savePageCache = () => {
    const keys = Object.keys(pageCache);
    if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 4000)) delete pageCache[k];
    try {
      localStorage.setItem(PAGES_KEY, JSON.stringify(pageCache));
    } catch {}
  };
  /** 图库里的情况：{ have, pages, full }；图库里没有是 null */
  const inLibrary = (id) => {
    const w = library.get(id);
    if (!w) return null;
    const pages = w.pages ?? pageCache[id] ?? null;
    return { have: w.have, pages, full: pages == null || w.have >= pages };
  };

  const style = document.createElement('style');
  style.textContent = `
    .emk-check { position: absolute; top: 6px; left: 6px; z-index: 5; width: 28px; height: 28px; padding: 0; border-radius: 999px;
      border: 2px solid #fff; background: rgba(0,0,0,.28); box-shadow: 0 1px 4px rgba(0,0,0,.35); color: #fff; font: 700 15px/24px system-ui, sans-serif;
      cursor: pointer; -webkit-tap-highlight-color: transparent; }
    .emk-check::after { content: ''; }
    .emk-check[aria-pressed="true"] { background: #c8402e; border-color: #c8402e; }
    .emk-check[aria-pressed="true"]::after { content: '✓'; }
    .emk-done { position: absolute; left: 6px; bottom: 6px; z-index: 5; padding: 0 7px; border-radius: 6px; background: rgba(20,120,60,.88);
      color: #fff; font: 600 11px/19px system-ui, sans-serif; pointer-events: none; }
    .emk-done.emk-part { background: rgba(176,110,0,.92); }
    .emk-bar { position: fixed; left: 50%; bottom: calc(14px + env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 2147483000;
      display: none; gap: 8px; align-items: center; padding: 7px 7px 7px 16px; border-radius: 999px; background: #1f1d1a; color: #f4f1ea;
      box-shadow: 0 6px 24px rgba(0,0,0,.28); font: 14px/1.4 system-ui, sans-serif; white-space: nowrap; max-width: calc(100vw - 16px); }
    .emk-bar.on { display: flex; }
    .emk-bar button { font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 999px; border: 1px solid rgba(255,255,255,.25);
      background: transparent; color: inherit; cursor: pointer; }
    .emk-bar button.emk-primary { background: #c8402e; border-color: #c8402e; color: #fff; }
    .emk-bar button:disabled { opacity: .5; }
    .emk-bar [hidden] { display: none; }
    .emk-toast { position: fixed; left: 50%; bottom: calc(72px + env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 2147483000;
      max-width: calc(100vw - 32px); padding: 8px 14px; border-radius: 10px; background: rgba(31,29,26,.94); color: #f4f1ea;
      font: 13px/1.5 system-ui, sans-serif; pointer-events: none; opacity: 0; transition: opacity .2s; }
    .emk-toast.on { opacity: 1; }
    .emk-toast.err { background: #b3261e; }
  `;
  document.head.append(style);

  const bar = document.createElement('div');
  bar.className = 'emk-bar';
  bar.innerHTML = `<span class="emk-count"></span><button type="button" data-act="clear">清除</button><button type="button" class="emk-primary" data-act="dl">下载到 Emaki</button>`;
  document.body.append(bar);
  const toast = document.createElement('div');
  toast.className = 'emk-toast';
  document.body.append(toast);
  let toastTimer = null;
  function say(text, error = false) {
    toast.textContent = text;
    toast.className = `emk-toast on${error ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.className = 'emk-toast'), error ? 6000 : 3500);
  }

  /** 这一页是作品页：作品 id */
  const currentWork = () => ARTWORK.exec(location.pathname)?.[1] ?? null;

  function render() {
    const n = selected.size;
    const work = currentWork();
    const w = work ? inLibrary(work) : null;
    bar.classList.toggle('on', n > 0 || !!work);
    bar.querySelector('.emk-count').textContent = n
      ? `已选 ${n} 个`
      : !w
        ? '这个作品'
        : w.full
          ? '这个作品已经下载过'
          : `已下载 ${w.have}/${w.pages} 张`;
    bar.querySelector('[data-act="clear"]').hidden = n === 0;
    bar.querySelector('[data-act="dl"]').textContent = n ? '下载到 Emaki' : w && !w.full ? `补齐剩下的 ${w.pages - w.have} 张` : '下载这个作品';
    for (const b of document.querySelectorAll('.emk-check')) b.setAttribute('aria-pressed', String(selected.has(b.dataset.emkId)));
    for (const a of document.querySelectorAll('a[data-emk]')) {
      const lib = inLibrary(a.dataset.emk);
      let badge = a.querySelector('.emk-done');
      if (!lib) {
        badge?.remove();
        continue;
      }
      if (!badge) {
        badge = document.createElement('span');
        a.append(badge);
      }
      badge.className = lib.full ? 'emk-done' : 'emk-done emk-part';
      const text = lib.full ? '已下载' : `已下载 ${lib.have}/${lib.pages}`;
      if (badge.textContent !== text) badge.textContent = text;
    }
  }

  /** 给新出现的作品缩略图加选择圈（无限滚动、换页时也会调） */
  function decorate() {
    for (const a of document.querySelectorAll('a[href*="/artworks/"]')) {
      if (a.dataset.emk) continue;
      const img = a.querySelector('img');
      const id = ARTWORK.exec(a.getAttribute('href') ?? '')?.[1];
      if (!img || !id) continue;
      a.dataset.emk = id;
      if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emk-check';
      b.dataset.emkId = id;
      b.dataset.emkTitle = (img.getAttribute('alt') || a.getAttribute('aria-label') || '').trim();
      b.setAttribute('aria-label', '选中，下载到 Emaki');
      a.append(b);
      if (!asked.has(id)) toStatus.add(id);
    }
    if (toStatus.size) scheduleStatus();
    render();
  }

  // 问电脑哪些下载过（攒一会儿一起问）
  let statusTimer = null;
  function scheduleStatus() {
    // Pixiv 的页面一直在变（广告、轮播）：已经排上的不再往后推，不然永远等不到
    if (statusTimer) return;
    statusTimer = setTimeout(async () => {
      statusTimer = null;
      const ids = [...toStatus].slice(0, 500);
      toStatus = new Set([...toStatus].slice(500));
      for (const id of ids) asked.add(id);
      try {
        const r = await site.call('pixiv-browser.status', { ids });
        const works = r.works ?? {};
        for (const id of ids) {
          const w = works[id];
          if (!w) library.delete(id);
          else {
            library.set(id, { have: w.have, pages: w.pages ?? null });
            if (w.pages == null && !(id in pageCache)) askPages(id);
          }
        }
        render();
      } catch {
        // 连不上电脑：不标
      }
      if (toStatus.size) scheduleStatus();
    }, 600);
  }

  // 图库里有、电脑不知道一共几页的作品：一个一个查（间隔一点，别给 Pixiv 添堵）
  const pageQueue = [];
  let pageBusy = false;
  function askPages(id) {
    if (!pageQueue.includes(id)) pageQueue.push(id);
    if (pageBusy) return;
    pageBusy = true;
    (async () => {
      while (pageQueue.length) {
        const next = pageQueue.shift();
        try {
          const r = await fetch(`/ajax/illust/${next}?lang=zh`, { credentials: 'include', headers: { accept: 'application/json' } });
          const j = await r.json();
          const n = Number(j?.body?.illustType) === 2 ? 1 : Number(j?.body?.pageCount);
          if (r.ok && !j.error && n > 0) {
            pageCache[next] = n;
            savePageCache();
            render();
          }
        } catch {
          // 查不到：照样标「已下载」
        }
        await new Promise((ok) => setTimeout(ok, 350));
      }
      pageBusy = false;
    })();
  }
  function recheck(ids) {
    for (const id of ids) {
      asked.delete(id);
      toStatus.add(id);
    }
    scheduleStatus();
  }

  // 选择圈在作品链接里面：在捕获阶段接住点击，不让它打开作品页
  document.addEventListener(
    'click',
    (e) => {
      const b = e.target instanceof Element ? e.target.closest('.emk-check') : null;
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      const id = b.dataset.emkId;
      if (selected.has(id)) selected.delete(id);
      else selected.set(id, b.dataset.emkTitle || '');
      render();
    },
    true,
  );

  bar.addEventListener('click', async (e) => {
    const act = e.target instanceof Element ? e.target.closest('[data-act]')?.dataset.act : null;
    if (act === 'clear') {
      selected.clear();
      render();
    } else if (act === 'dl') {
      const list = selected.size ? [...selected] : currentWork() ? [[currentWork(), document.title.replace(/ - pixiv$/, '')]] : [];
      if (list.length) await download(list);
    }
  });

  /** 一个作品：标题、每一页的原图地址；动图是帧的 zip 地址和每帧停多久（用这里的登录查） */
  async function lookup(id, title) {
    const get = async (path) => {
      const r = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' } });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.error) throw new Error(j?.message || `HTTP ${r.status}`);
      return j.body;
    };
    const info = await get(`/ajax/illust/${id}?lang=zh`);
    const name = info.illustTitle || info.title || title || id;
    const count = Number(info.illustType) === 2 ? 1 : Number(info.pageCount);
    if (count > 0) {
      pageCache[id] = count;
      savePageCache();
    }
    if (Number(info.illustType) === 2) {
      const meta = await get(`/ajax/illust/${id}/ugoira_meta?lang=zh`);
      const frames = (meta.frames ?? []).map((f) => ({ file: f.file, delay: f.delay }));
      return { id, title: name, ugoira: { zip: meta.originalSrc || meta.src, frames } };
    }
    if ((info.pageCount ?? 1) <= 1 && info.urls?.original) return { id, title: name, urls: [info.urls.original] };
    const pages = await get(`/ajax/illust/${id}/pages?lang=zh`);
    return { id, title: name, urls: pages.map((p) => p.urls?.original).filter(Boolean) };
  }

  async function download(list) {
    const btn = bar.querySelector('[data-act="dl"]');
    btn.disabled = true;
    try {
      const works = [];
      const skipped = [];
      for (let i = 0; i < list.length; i++) {
        const [id, title] = list[i];
        say(`查原图地址 ${i + 1}/${list.length}…`);
        try {
          works.push(await lookup(id, title));
        } catch (err) {
          skipped.push(`${title || id}：${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!works.length) throw new Error(skipped[0] ?? '没有能下载的作品');
      let message = '';
      for (let i = 0; i < works.length; i += 200)
        message = (await site.call('pixiv-browser.download', { works: works.slice(i, i + 200) })).message;
      say(skipped.length ? `${message}；${skipped.length} 个跳过（${skipped[0]}）` : message);
      selected.clear();
      render();
      const ids = works.map((w) => w.id);
      for (const t of [8000, 20000, 45000, 90000]) setTimeout(() => recheck(ids), t);
    } catch (err) {
      say(`没有下载：${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  // Pixiv 是单页应用：换页、无限滚动都只改页面里的元素
  let path = location.pathname;
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (location.pathname !== path) {
        path = location.pathname;
        const w = currentWork();
        if (w && !asked.has(w)) recheck([w]);
      }
      decorate();
    });
  }).observe(document.body, { childList: true, subtree: true });
  decorate();
  const w = currentWork();
  if (w) recheck([w]);
})();
