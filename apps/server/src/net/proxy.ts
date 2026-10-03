/**
 * 出网代理从哪来：.env / 环境变量（EMAKI_HTTP_PROXY 等）优先，其次 Windows 的系统代理。
 * Clash、v2rayN 的「系统代理」只写注册表，浏览器会用，Node 不会，所以这里自己读。
 * 结果缓存 30 秒：用户中途打开或关掉代理软件，不用重启 Emaki。
 */
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import type { NetworkCheckResponse } from '@emaki/shared';
import { config } from '../config.ts';

export type ProxyInfo = NetworkCheckResponse['proxy'];

const TTL = 30_000;
let cached: { at: number; info: Promise<ProxyInfo> } | null = null;

export function resolveProxy(): Promise<ProxyInfo> {
  if (cached && Date.now() - cached.at < TTL) return cached.info;
  const info = detect().catch((): ProxyInfo => ({ url: null, source: null, note: null }));
  cached = { at: Date.now(), info };
  return info;
}

/** 检测网络时重新读一遍 */
export function forgetProxy(): void {
  cached = null;
}

async function detect(): Promise<ProxyInfo> {
  if (config.httpProxy) return { url: withScheme(config.httpProxy), source: 'env', note: null };
  if (process.platform !== 'win32') return { url: null, source: null, note: null };

  const sys = await readSystemProxy();
  if (sys.enabled && sys.server) {
    const url = pickFromProxyServer(sys.server);
    if (!url) return { url: null, source: null, note: `系统代理只设了 SOCKS（${sys.server}），Emaki 用不了，需要 HTTP 代理` };
    if (await listening(url)) return { url, source: 'system', note: null };
    return { url: null, source: null, note: `系统代理设的是 ${hostPort(url)}，但这个端口没有程序在监听（代理软件没开？）` };
  }
  if (sys.pac) {
    const url = await proxyFromPac(sys.pac);
    if (url && (await listening(url))) return { url, source: 'pac', note: null };
    return { url: null, source: null, note: `系统用的是自动配置脚本（${sys.pac}），没能从里面读出代理地址` };
  }
  return { url: null, source: null, note: null };
}

interface SystemProxy {
  enabled: boolean;
  server: string | null;
  pac: string | null;
}

async function readSystemProxy(): Promise<SystemProxy> {
  const { stdout } = await promisify(execFile)('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
    windowsHide: true,
    timeout: 5000,
  });
  return parseRegQuery(stdout);
}

/** reg query 的输出：每行「    名字    类型    值」 */
export function parseRegQuery(stdout: string): SystemProxy {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
    if (m) values.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  return {
    enabled: Number(values.get('proxyenable') ?? 0) === 1,
    server: values.get('proxyserver') || null,
    pac: values.get('autoconfigurl') || null,
  };
}

/** ProxyServer 可能是「127.0.0.1:7890」，也可能分协议「http=…;https=…;socks=…」 */
export function pickFromProxyServer(server: string): string | null {
  if (!server.includes('=')) return withScheme(server);
  const parts = new Map(
    server
      .split(';')
      .map((p) => p.split('=').map((s) => s.trim()))
      .filter((kv): kv is [string, string] => kv.length === 2 && !!kv[1])
      .map(([k, v]) => [k.toLowerCase(), v]),
  );
  const hp = parts.get('https') ?? parts.get('http');
  return hp ? withScheme(hp) : null;
}

/** PAC 脚本没法真的执行，只找里面写的第一个 PROXY 地址（v2rayN、SSR 的 PAC 都是这样写的） */
async function proxyFromPac(pacUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pacUrl, { signal: AbortSignal.timeout(3000) });
    const m = /\bPROXY\s+([\w.-]+:\d+)/i.exec(await res.text());
    return m ? withScheme(m[1]!) : null;
  } catch {
    return null;
  }
}

function withScheme(s: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
}

export function hostPort(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 端口有没有程序在监听：代理软件关了但系统代理没还原时，直连反而能用 */
function listening(url: string): Promise<boolean> {
  let host: string;
  let port: number;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const sock = connect({ host, port, timeout: 1500 });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}
