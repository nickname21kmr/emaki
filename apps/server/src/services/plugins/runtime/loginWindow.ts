/**
 * 插件的登录窗口（docs/plugins.md 第 6 节，emaki.login.browser）：要登录的网站（Pixiv 这类）不让插件自己收账号密码，
 * 也不让你去浏览器里翻 Cookie——在这台电脑上开一个普通的浏览器窗口（Chrome，没有就用 Edge、Chromium），你像平常一样登录，
 * 读到登录以后的那个 Cookie 就关掉窗口。
 *
 * - 用一个临时的资料目录（不碰你平常用的浏览器，登录完删掉），窗口带地址栏，看得到是在哪个网站上；
 * - 经浏览器的调试协议（只听 127.0.0.1，窗口开着的这一会儿）读 Cookie：只读插件要的那个地址会带上的、名字对的、值像登录以后的；
 * - 你把窗口关了、等太久没登录好，就算没登录。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LoginWindowOptions {
  /** 打开的地址（网站的登录页） */
  url: string;
  /** 读这个地址会带上的 Cookie（插件授权连接的网站） */
  cookieUrl: string;
  /** Cookie 的名字 */
  cookie: string;
  /** 值要满足的样子（分清登录了没有：Pixiv 登录以后是 <用户 id>_…） */
  pattern?: RegExp;
  /** 最多等多久（默认 10 分钟） */
  timeoutMs?: number;
  /** 不显示窗口（测试用） */
  headless?: boolean;
  /** 浏览器的程序（不给就找，见 findBrowser） */
  executable?: string;
}

export interface LoginWindow {
  /** 登录好了：Cookie 的值 */
  done: Promise<string>;
  /** 不等了，关掉窗口 */
  close(): void;
}

/** 这台电脑上的浏览器：EMAKI_BROWSER，然后 Chrome、Edge、Chromium */
export function findBrowser(): string | null {
  const env = process.env.EMAKI_BROWSER;
  if (env && existsSync(env)) return env;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const r of roots) candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const r of roots) candidates.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'])
        candidates.push(path.join(dir, name));
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** 这个 Cookie 会不会随 url 发出去（域名、路径） */
export function cookieApplies(c: { domain: string; path: string }, url: URL): boolean {
  const domain = c.domain.replace(/^\./, '').toLowerCase();
  const host = url.hostname.toLowerCase();
  return (host === domain || host.endsWith(`.${domain}`)) && url.pathname.startsWith(c.path || '/');
}

/** 开一个登录窗口。窗口开好了才返回（没有浏览器、开不起来直接报错）；done 等你登录好 */
export async function openLoginWindow(o: LoginWindowOptions): Promise<LoginWindow> {
  const exe = o.executable ?? findBrowser();
  if (!exe) throw new Error('这台电脑上没找到 Chrome 或 Edge，开不了登录窗口');
  const cookieUrl = new URL(o.cookieUrl);
  const profile = mkdtempSync(path.join(os.tmpdir(), 'emaki-login-'));
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--new-window',
    '--window-size=560,820',
    ...(o.headless ? ['--headless=new'] : []),
    // Linux 上以 root 跑（服务器、容器里）Chromium 不让开沙箱
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    o.url,
  ];
  let child: ChildProcess;
  try {
    child = spawn(exe, args, { stdio: 'ignore' });
  } catch (e) {
    rmSync(profile, { recursive: true, force: true });
    throw new Error(`登录窗口开不起来：${(e as Error).message}`);
  }
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    child.once('error', () => {
      exited = true;
      resolve();
    });
  });
  const cleanup = async () => {
    if (!exited) {
      const kill = setTimeout(() => child.kill(), 3_000);
      await exit;
      clearTimeout(kill);
    }
    // Windows 上浏览器刚退出时还占着文件：多试几次
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };

  // 浏览器开好以后把调试端口写进资料目录的 DevToolsActivePort
  let endpoint: string | null = null;
  for (let i = 0; i < 200 && !exited; i++) {
    try {
      const [port, wsPath] = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
      if (port && wsPath) {
        endpoint = `ws://127.0.0.1:${port}${wsPath}`;
        break;
      }
    } catch {
      // 还没写
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!endpoint) {
    child.kill();
    await cleanup();
    throw new Error('登录窗口开不起来（浏览器没有响应）');
  }

  const cdp = await connect(endpoint).catch(async (e: Error) => {
    child.kill();
    await cleanup();
    throw new Error(`登录窗口开不起来：${e.message}`);
  });

  let closed = false;
  let stop: () => void = () => {};
  const done = new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + (o.timeoutMs ?? 10 * 60_000);
    const finish = async (value: string | null, error?: Error) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await cdp.send('Browser.close').catch(() => {});
      cdp.close();
      await cleanup();
      if (value !== null) resolve(value);
      else reject(error ?? new Error('登录窗口关掉了'));
    };
    stop = () => void finish(null, new Error('登录取消了'));
    void exit.then(() => finish(null, new Error('登录窗口关掉了，还没有登录好')));
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || closed) return;
      busy = true;
      try {
        if (Date.now() > deadline)
          return void (await finish(null, new Error(`等了 ${Math.round((o.timeoutMs ?? 600_000) / 60_000)} 分钟还没有登录好，窗口关掉了`)));
        const r = (await cdp.send('Storage.getCookies')) as { cookies?: { name: string; value: string; domain: string; path: string }[] };
        const hit = r.cookies?.find((c) => c.name === o.cookie && cookieApplies(c, cookieUrl) && (!o.pattern || o.pattern.test(c.value)));
        if (hit) await finish(hit.value);
      } catch {
        // 浏览器正在关：等 exit
      } finally {
        busy = false;
      }
    }, 1_000);
  });
  done.catch(() => {});
  return { done, close: () => stop() };
}

/** 浏览器调试协议的一个连接（只用到 send） */
async function connect(endpoint: string): Promise<{ send(method: string, params?: object): Promise<unknown>; close(): void }> {
  const ws = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('连不上浏览器')), { once: true });
  });
  let seq = 0;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  ws.addEventListener('message', (e) => {
    let m: { id?: number; result?: unknown; error?: { message: string } };
    try {
      m = JSON.parse(String(e.data)) as typeof m;
    } catch {
      return;
    }
    const p = m.id !== undefined ? pending.get(m.id) : undefined;
    if (!p) return;
    pending.delete(m.id!);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Error('浏览器关掉了'));
    pending.clear();
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) return reject(new Error('浏览器关掉了'));
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}
