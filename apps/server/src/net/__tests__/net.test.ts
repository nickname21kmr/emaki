import { describe, expect, it } from 'vitest';
import { diagnose, errorCode } from '../diagnose.ts';
import { NetworkError } from '../http.ts';
import { parseRegQuery, pickFromProxyServer } from '../proxy.ts';

const coded = (code: string) => Object.assign(new Error(code), { code });
const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause });
const direct = { url: null, source: null, note: null };
const viaSystem = { url: 'http://127.0.0.1:7890', source: 'system' as const, note: null };

describe('系统代理', () => {
  it('读 reg query 的输出', () => {
    const out = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    127.0.0.1:10809',
      '    ProxyOverride    REG_SZ    localhost;127.*;<local>',
      '',
    ].join('\r\n');
    expect(parseRegQuery(out)).toEqual({ enabled: true, server: '127.0.0.1:10809', pac: null });
    expect(parseRegQuery('    ProxyEnable    REG_DWORD    0x0\r\n').enabled).toBe(false);
    expect(parseRegQuery('    AutoConfigURL    REG_SZ    http://127.0.0.1:10810/pac/?t=1\r\n').pac).toBe('http://127.0.0.1:10810/pac/?t=1');
  });

  it('ProxyServer 的几种写法', () => {
    expect(pickFromProxyServer('127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
    expect(pickFromProxyServer('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
    expect(pickFromProxyServer('http=127.0.0.1:1081;https=127.0.0.1:1082;socks=127.0.0.1:1080')).toBe('http://127.0.0.1:1082');
    expect(pickFromProxyServer('http=127.0.0.1:1081;socks=127.0.0.1:1080')).toBe('http://127.0.0.1:1081');
    expect(pickFromProxyServer('socks=127.0.0.1:1080')).toBeNull();
  });
});

describe('连接失败的原因', () => {
  it('从 undici 的 cause 里找 code', () => {
    expect(errorCode(fetchFailed(coded('ECONNRESET')))).toBe('ECONNRESET');
    expect(errorCode(fetchFailed(Object.assign(new AggregateError([coded('ETIMEDOUT')]), {})))).toBe('ETIMEDOUT');
    expect(errorCode(new DOMException('timed out', 'TimeoutError'))).toBe('TIMEOUT');
    const tunnel = Object.assign(new Error('Proxy response (502) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' });
    expect(errorCode(fetchFailed(tunnel))).toBe('PROXY_STATUS');
    expect(errorCode(new Error('x'))).toBeNull();
  });

  it('直连超时：提示要代理', () => {
    const err = new NetworkError('https://danbooru.donmai.us/tags.json', direct, fetchFailed(coded('UND_ERR_CONNECT_TIMEOUT')));
    const d = diagnose(err, 'Danbooru');
    expect(d.reason).toBe('连接 Danbooru 超时');
    expect(d.hint).toContain('现在是直连');
    expect(d.proxyAdvice).toBe(true);
  });

  it('系统代理开着但没在监听：直连时把原因带上', () => {
    const note = '系统代理设的是 127.0.0.1:7890，但这个端口没有程序在监听（代理软件没开？）';
    const err = new NetworkError('https://danbooru.donmai.us/', { ...direct, note }, fetchFailed(coded('ECONNRESET')));
    expect(diagnose(err, 'Danbooru').hint).toContain(note);
  });

  it('代理拒绝连接 / 走了代理还是不通', () => {
    const refused = new NetworkError('https://danbooru.donmai.us/', viaSystem, fetchFailed(coded('ECONNREFUSED')));
    expect(diagnose(refused, 'Danbooru')).toMatchObject({ reason: '代理 127.0.0.1:7890 拒绝连接', proxyAdvice: false });
    const reset = new NetworkError('https://danbooru.donmai.us/', viaSystem, fetchFailed(coded('ECONNRESET')));
    expect(diagnose(reset, 'Danbooru').hint).toContain('已经走了代理 127.0.0.1:7890（系统代理）');
  });

  it('证书问题不归到缺代理', () => {
    const err = new NetworkError('https://danbooru.donmai.us/', direct, fetchFailed(coded('SELF_SIGNED_CERT_IN_CHAIN')));
    expect(diagnose(err, 'Danbooru')).toMatchObject({ reason: 'Danbooru 的 HTTPS 证书校验失败', proxyAdvice: false });
  });

  it('不是 NetworkError（测试里注入的 fetch）也能给出原因', () => {
    expect(diagnose(new Error('boom'), 'Danbooru').reason).toBe('连不上 Danbooru');
  });
});
