/**
 * 启动器（scripts/start.mjs）用到的几样东西：
 * - 启动页服务（scripts/splash-server.mjs）回什么、probe 怎么认端口上是谁；
 * - 和后端的交接（src/system/launcher.ts）：启动页让出端口，后端接着在同一个端口上监听；
 * - 启动页（scripts/splash.html）：不引用外部资源；主题的判断和 apps/web/index.html 是同一套；
 *   各底色的颜色和 apps/web/src/styles/index.css 一致（那边改了颜色、加了底色，这里会失败，提醒把启动页一起改）。
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectLauncher, listenWhenFree, type LauncherProcess } from '../src/system/launcher.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

interface SplashModule {
  STAGES: string[];
  createSplashServer(options: { page: string; state: () => { stage: string; error?: string | null }; onReported?: (stage: string) => void }): http.Server;
  probe(url: string, timeoutMs?: number): Promise<{ kind: 'running' | 'free' | 'occupied' } | { kind: 'starting'; stage: string }>;
}
// 纯 JS 的脚本（start.mjs 不经 tsx 直接跑）：按路径动态引入
const splashModule = (await import(pathToFileURL(path.join(ROOT, 'scripts/splash-server.mjs')).href)) as SplashModule;
const { STAGES, createSplashServer, probe } = splashModule;

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((done) => s.close(done));
  }
});
function listen(server: http.Server, port = 0): Promise<string> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

describe('启动页服务', () => {
  const PAGE = '<!doctype html><title>Emaki 絵巻</title>';

  it('/api/health 回 503 和现在的阶段；页面地址回启动页；都不让缓存', async () => {
    const state = { stage: 'checking', error: null as string | null };
    const reported: string[] = [];
    const url = await listen(createSplashServer({ page: PAGE, state: () => state, onReported: (stage) => reported.push(stage) }));

    const health = await fetch(`${url}/api/health`);
    expect(health.status).toBe(503);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(await health.json()).toEqual({ ok: false, starting: true, stage: 'checking' });

    state.stage = 'failed';
    state.error = '界面构建失败';
    expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ ok: false, starting: true, stage: 'failed', error: '界面构建失败' });
    await vi.waitFor(() => expect(reported).toEqual(['checking', 'failed']));

    // 哪个页面地址进来都是启动页：后端接手后原地刷新，回到的还是这个地址
    for (const p of ['/', '/characters/12?tab=all', '/settings']) {
      const page = await fetch(url + p);
      expect(page.status, p).toBe(200);
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(await page.text()).toBe(PAGE);
    }
  });

  it('别的接口、脚本和图片、写请求一律 503，不拿启动页充数', async () => {
    const url = await listen(createSplashServer({ page: PAGE, state: () => ({ stage: 'opening' }) }));
    for (const p of ['/api/images?limit=1', '/api/events', '/assets/index-abc123.js', '/favicon.svg']) {
      const res = await fetch(url + p);
      expect(res.status, p).toBe(503);
      expect(await res.json(), p).toMatchObject({ starting: true, stage: 'opening' });
    }
    const post = await fetch(`${url}/`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(post.status).toBe(503);
    const head = await fetch(`${url}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});

describe('probe：端口上现在是谁', () => {
  it('Emaki 已经在运行 / 另一个 Emaki 正在启动 / 没人监听 / 被别的程序占着', async () => {
    const running = await listen(http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')));
    expect(await probe(running)).toEqual({ kind: 'running' });

    const starting = await listen(createSplashServer({ page: '', state: () => ({ stage: 'building' }) }));
    expect(await probe(starting)).toEqual({ kind: 'starting', stage: 'building' });

    const other = await listen(http.createServer((_req, res) => res.writeHead(503).end('Service Unavailable')));
    expect(await probe(other)).toEqual({ kind: 'occupied' });
    const notFound = await listen(http.createServer((_req, res) => res.writeHead(404).end('{}')));
    expect(await probe(notFound)).toEqual({ kind: 'occupied' });
    // 连上了但一直不回应
    const silent = await listen(http.createServer(() => {}));
    expect(await probe(silent, 150)).toEqual({ kind: 'occupied' });

    // 刚关掉的端口：没人监听
    const closed = http.createServer();
    const free = await listen(closed);
    servers.splice(servers.indexOf(closed), 1);
    await new Promise((done) => closed.close(done));
    expect(await probe(free)).toEqual({ kind: 'free' });
  });
});

describe('交接：启动页让出端口，后端在同一个端口上接着监听', () => {
  it('后端发 before-listen → 启动器关掉启动页、回 port-free → 后端监听上', async () => {
    const splash = createSplashServer({ page: 'splash', state: () => ({ stage: 'opening' }) });
    const url = await listen(splash);
    const port = Number(new URL(url).port);
    // 窗口里的启动页一直连着（keep-alive）：让出端口时这些连接要一起断开
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((done) => http.get(`${url}/api/health`, { agent }, (res) => res.resume().on('end', done)));

    // 启动器这一头（scripts/start.mjs 里 server.on('message') 做的事）
    let deliver: (message: unknown) => void = () => {};
    const sent: string[] = [];
    const proc: LauncherProcess = {
      env: { EMAKI_LAUNCHER: '1' },
      send: (message) => {
        const type = (message as { type: string }).type;
        sent.push(type);
        if (type === 'emaki:before-listen') {
          splash.close(() => deliver({ type: 'emaki:port-free' }));
          splash.closeAllConnections();
        }
        return true;
      },
      on: (_event, listener) => void (deliver = listener),
      off: () => {},
    };
    // 后端这一头（src/index.ts）
    const launcher = connectLauncher(proc)!;
    const backend = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
    servers.push(backend);
    const tryListen = () =>
      new Promise<void>((resolve, reject) => {
        backend.once('error', reject);
        backend.listen(port, '127.0.0.1', () => {
          backend.off('error', reject);
          resolve();
        });
      });

    expect(await probe(url)).toEqual({ kind: 'starting', stage: 'opening' });
    await launcher.releasePort();
    await listenWhenFree(tryListen, { everyMs: 20, forMs: 3000 });
    expect(sent).toEqual(['emaki:hello', 'emaki:before-listen']);
    expect(await probe(url)).toEqual({ kind: 'running' });
    agent.destroy();
  });
});

describe('启动页（scripts/splash.html）', () => {
  const splash = read('scripts/splash.html');
  const withoutComments = splash.replace(/<!--[\s\S]*?-->/g, '');

  it('不引用任何外部资源：这时候只有这一页能访问', () => {
    expect(withoutComments).not.toMatch(/<link\b/i);
    expect(withoutComments).not.toMatch(/\ssrc\s*=/i);
    // url(#cut) 是徽记自己的蒙版，不算
    expect(withoutComments).not.toMatch(/@import|url\((?!#)/i);
    // 只剩内联 SVG 图标里的命名空间
    const urls = withoutComments.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    expect(new Set(urls)).toEqual(new Set(['http://www.w3.org/2000/svg']));
    expect(withoutComments.match(/fetch\(([^,)]+)/g)).toEqual(["fetch('/api/health'"]);
    expect(withoutComments).toContain('<title>Emaki 絵巻</title>');
  });

  it('明暗和底色的判断和 apps/web/index.html 是同一段（换成应用时不闪）', () => {
    const themeScript = (html: string) => {
      const m = /<script>([\s\S]*?)<\/script>/.exec(html);
      if (!m) throw new Error('没有找到内联脚本');
      // 去掉注释和空白再比
      return m[1]!.replace(/\/\/.*$/gm, '').replace(/\s+/g, '');
    };
    expect(themeScript(withoutComments)).toBe(themeScript(read('apps/web/index.html')));
  });

  it('各底色的颜色和 apps/web/src/styles/index.css 一致', () => {
    /** 选择器 → 这一块里声明的自定义属性 */
    const blocks = (css: string) => {
      const out = new Map<string, Map<string, string>>();
      for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const vars = new Map<string, string>();
        for (const d of m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(d[1]!, d[2]!.trim().toLowerCase());
        if (!vars.size) continue;
        for (const selector of m[1]!.split(',')) out.set(selector.trim().replace(/"/g, "'"), vars);
      }
      return out;
    };
    const app = blocks(read('apps/web/src/styles/index.css'));
    const page = blocks(/<style>([\s\S]*?)<\/style>/.exec(splash)![1]!);
    const NAMES: [string, string][] = [
      ['--canvas', '--c-canvas'],
      ['--fg', '--c-fg'],
      ['--muted', '--c-fg-muted'],
      ['--brand', '--c-brand'],
      ['--line', '--c-line'],
    ];
    // 应用里的每一种底色 × 明暗，启动页都要有一块
    const themed = [...app.keys()].filter((s) => s === "[data-theme='dark']" || s.startsWith('[data-palette='));
    expect(themed.length).toBeGreaterThanOrEqual(9);
    for (const selector of [':root', ...themed]) {
      const mine = page.get(selector);
      expect(mine, `启动页缺 ${selector} 这一块`).toBeDefined();
      for (const [short, full] of NAMES) {
        const expected = app.get(selector)!.get(full);
        // 应用里这块没覆盖的（沿用米纸的值），启动页也不该写
        expect(mine!.get(short), `${selector} 的 ${short} 应当等于 index.css 的 ${full}`).toBe(expected);
      }
    }
  });

  it('启动器报的每个阶段都有一句话', () => {
    const texts = /var TEXT = \{([\s\S]*?)\};/.exec(splash)![1]!;
    const keys = [...texts.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual(STAGES.filter((s) => s !== 'failed').sort());
    expect(splash).toContain("next === 'failed'");
  });
});
