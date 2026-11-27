/**
 * 插件的登录窗口（services/plugins/runtime/loginWindow.ts）：用这台电脑上真的浏览器（无界面）开一个假的登录页，
 * 访客的 Cookie 不算、登录以后的才算，读到就关掉窗口、删掉临时的资料目录；不等了就关掉。没有浏览器的机器上跳过。
 */
import { existsSync, readdirSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieApplies, findBrowser, openLoginWindow } from '../../src/services/plugins/runtime/loginWindow.ts';

/** 找浏览器：这台电脑上装的（Windows 上的 Chrome、Edge），或者 Playwright 下载的 Chromium（开发机） */
function browser(): string | null {
  const found = findBrowser();
  if (found) return found;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return null;
  for (const d of readdirSync(cache).filter((n) => n.startsWith('chromium-')))
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const exe = path.join(cache, d, sub, 'chrome');
      if (existsSync(exe)) return exe;
    }
  return null;
}

const exe = browser();
let server: http.Server;
let base: string;

beforeAll(async () => {
  // 假的登录页：先给访客的 Cookie，过一会儿「登录好」换成登录以后的
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/login')
      res.end(
        '<script>document.cookie="sid=guest; path=/"; setTimeout(() => { document.cookie = "sid=42_secret; path=/" }, 800)</script>登录',
      );
    else res.end('首页');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const profiles = () => readdirSync(os.tmpdir()).filter((n) => n.startsWith('emaki-login-')).length;

describe('登录窗口', () => {
  it('Cookie 会不会随地址发出去', () => {
    const url = new URL('https://www.pixiv.net/ajax/x');
    expect(cookieApplies({ domain: '.pixiv.net', path: '/' }, url)).toBe(true);
    expect(cookieApplies({ domain: 'www.pixiv.net', path: '/' }, url)).toBe(true);
    expect(cookieApplies({ domain: 'accounts.pixiv.net', path: '/' }, url)).toBe(false);
    expect(cookieApplies({ domain: '.evilpixiv.net', path: '/' }, url)).toBe(false);
    expect(cookieApplies({ domain: '.pixiv.net', path: '/other' }, url)).toBe(false);
  });

  it.skipIf(!exe)('读到登录以后的 Cookie 就关掉窗口，临时资料目录删掉', { timeout: 60_000 }, async () => {
    const before = profiles();
    const w = await openLoginWindow({
      url: `${base}/login`,
      cookieUrl: `${base}/`,
      cookie: 'sid',
      pattern: /^\d+_/,
      headless: true,
      executable: exe!,
    });
    expect(await w.done).toBe('42_secret');
    expect(profiles()).toBe(before);
  });

  it.skipIf(!exe)('不等了：关掉窗口，算没登录', { timeout: 60_000 }, async () => {
    const before = profiles();
    const w = await openLoginWindow({ url: `${base}/`, cookieUrl: `${base}/`, cookie: 'sid', headless: true, executable: exe! });
    setTimeout(() => w.close(), 500);
    await expect(w.done).rejects.toThrow('登录取消了');
    expect(profiles()).toBe(before);
  });

  it('没有浏览器：说清楚', async () => {
    await expect(
      openLoginWindow({ url: `${base}/`, cookieUrl: `${base}/`, cookie: 'sid', executable: path.join(os.tmpdir(), 'no-such-browser') }),
    ).rejects.toThrow(/开不起来/);
  });
});
