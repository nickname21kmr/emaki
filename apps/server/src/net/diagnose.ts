/**
 * 把连接失败翻译成人话：哪一步断的（域名、超时、被重置、代理没开、证书），以及该怎么办。
 * undici 的错误是「fetch failed」，真正的原因在 cause（有时还套一层 AggregateError）。
 */
import { NetworkError } from './http.ts';
import { hostPort, type ProxyInfo } from './proxy.ts';

type Kind = 'dns' | 'timeout' | 'reset' | 'refused' | 'unreachable' | 'cert' | 'proxy-status' | 'other';

/** 找到最里层带 code 的错误 */
export function errorCode(err: unknown): string | null {
  let e = err as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown[] } | undefined;
  for (let depth = 0; e && depth < 6; depth++) {
    if (typeof e.code === 'string' && e.code !== 'UND_ERR_ABORTED') return e.code;
    if (e.name === 'TimeoutError') return 'TIMEOUT';
    if (typeof e.message === 'string' && /Proxy response/i.test(e.message)) return 'PROXY_STATUS';
    e = (e.cause ?? e.errors?.[0]) as typeof e;
  }
  return null;
}

function kindOf(code: string | null): Kind {
  if (!code) return 'other';
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME)$/.test(code)) return 'dns';
  if (/^(ETIMEDOUT|TIMEOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(code)) return 'timeout';
  if (/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|ERR_SSL_WRONG_VERSION_NUMBER|EPROTO)$/.test(code)) return 'reset';
  if (code === 'ECONNREFUSED') return 'refused';
  if (/^(ENETUNREACH|EHOSTUNREACH|ENETDOWN)$/.test(code)) return 'unreachable';
  if (/CERT|^UNABLE_TO_|SELF_SIGNED|^ERR_TLS/.test(code)) return 'cert';
  if (code === 'PROXY_STATUS') return 'proxy-status';
  return 'other';
}

export interface NetDiagnosis {
  /** 哪一步断的，一句话 */
  reason: string;
  /** 该怎么办，可能为空 */
  hint: string;
  /** hint 是不是「缺代理」那段通用建议（检测网络时统一放在结论里） */
  proxyAdvice: boolean;
}

const NEED_PROXY =
  '国内直连 Danbooru 一般连不上。开着 Clash、v2rayN 这类软件的话，打开它的「系统代理」或 TUN 模式再试；也可以在 Emaki 目录的 .env 里写一行 EMAKI_HTTP_PROXY=http://127.0.0.1:7890（端口换成自己的），然后重启 Emaki';

/** site 用来拼句子（「Danbooru」「Hugging Face」）；needsProxy：国内直连是否通常连不上 */
export function diagnose(err: unknown, site: string, needsProxy = true): NetDiagnosis {
  const proxy: ProxyInfo | null = err instanceof NetworkError ? err.proxy : null;
  const code = errorCode(err);
  const kind = kindOf(code);
  const via = proxy?.url ? `代理 ${hostPort(proxy.url)}` : null;

  const reason = {
    dns: `找不到 ${site} 的地址（域名解析失败）`,
    timeout: `连接 ${site} 超时`,
    reset: `连接 ${site} 时被中断`,
    refused: via ? `${via} 拒绝连接` : `${site} 拒绝连接`,
    unreachable: '网络不通',
    cert: `${site} 的 HTTPS 证书校验失败`,
    'proxy-status': `${via ?? '代理'} 连不上 ${site}`,
    other: `连不上 ${site}${code ? `（${code}）` : ''}`,
  }[kind];

  let hint = '';
  let proxyAdvice = false;
  if (kind === 'cert') hint = '可能是杀毒软件或代理软件在拦截 HTTPS，也可能是电脑时间不对';
  else if (kind === 'unreachable') hint = '看看电脑有没有联网';
  else if (via && kind === 'refused') hint = '代理软件可能没开，或者端口填错了';
  else if (via) {
    hint = `已经走了${via}（${sourceLabel(proxy!)}），还是连不上：换个节点试试，或者看看代理软件的规则有没有放行 ${site}`;
    proxyAdvice = true;
  } else if (needsProxy && proxy) {
    hint = `现在是直连，没有用代理${proxy?.note ? `（${proxy.note}）` : ''}。${NEED_PROXY}`;
    proxyAdvice = true;
  } else if (proxy?.note) hint = proxy.note;
  return { reason, hint, proxyAdvice };
}

export function sourceLabel(p: ProxyInfo): string {
  return p.source === 'env' ? '你在 .env 里设的代理' : p.source === 'system' ? '系统代理' : p.source === 'pac' ? '系统自动代理脚本里的代理' : '直连';
}
