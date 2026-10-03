/**
 * 「检测网络」：同时连一下 Danbooru、Hugging Face 和国内镜像，看是哪一段不通。
 * 国内镜像通、Danbooru 不通 = 缺代理；全都不通 = 没联网或代理本身坏了。
 */
import type { NetworkCheckResponse } from '@emaki/shared';
import { config } from '../config.ts';
import { diagnose, sourceLabel } from './diagnose.ts';
import { httpFetch } from './http.ts';
import { forgetProxy, hostPort, resolveProxy } from './proxy.ts';

type Target = NetworkCheckResponse['targets'][number];

const UA = `Emaki/${config.appVersion} (+${config.appRepoUrl})`;

async function probe(name: string, url: string, needsProxy: boolean): Promise<Target> {
  const t0 = performance.now();
  try {
    const res = await httpFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    const ms = Math.round(performance.now() - t0);
    if (res.status === 403 && (res.headers.get('cf-mitigated') === 'challenge' || body.includes('Just a moment'))) {
      return { name, url, ok: false, ms, message: '连上了，但被 Cloudflare 拦了：换个代理节点，或者过一会儿再试' };
    }
    if (res.status >= 500) return { name, url, ok: false, ms, message: `连上了，但服务器出错（HTTP ${res.status}），过一会儿再试` };
    return { name, url, ok: true, ms, message: `正常，${ms} 毫秒` };
  } catch (err) {
    const { reason, hint, proxyAdvice } = diagnose(err, name, needsProxy);
    // 代理建议统一放在结论里，这里只说哪一步断的
    return { name, url, ok: false, ms: null, message: reason + (hint && !proxyAdvice ? `：${hint}` : '') };
  }
}

export async function checkNetwork(): Promise<NetworkCheckResponse> {
  forgetProxy();
  const proxy = await resolveProxy();
  const [danbooru, hf, mirror] = await Promise.all([
    probe('Danbooru', `${config.danbooruBaseUrl}/tags.json?limit=1&only=name`, true),
    probe('Hugging Face', 'https://huggingface.co/api/models/SmilingWolf/wd-eva02-large-tagger-v3', true),
    probe('hf-mirror（国内镜像）', 'https://hf-mirror.com/api/models/SmilingWolf/wd-eva02-large-tagger-v3', false),
  ]);
  const via = proxy.url ? `走的是${sourceLabel(proxy)} ${hostPort(proxy.url)}` : '现在是直连，没有用代理';

  let summary: string;
  if (danbooru.ok) summary = `Danbooru 能连上（${via}），同步应该没问题。`;
  else if (!mirror.ok && !hf.ok) {
    summary = proxy.url
      ? `三个都连不上，${via}：代理软件可能没开，或者节点断了。先确认浏览器能不能打开网页。`
      : '三个都连不上：电脑可能没联网。';
  } else if (proxy.url) summary = `国内网站能连上，Danbooru 连不上。${via}，可能是节点不通，或者代理软件的规则没放行 danbooru.donmai.us。`;
  else {
    summary =
      `国内网站能连上，Danbooru 连不上，${via}${proxy.note ? `（${proxy.note}）` : ''}。` +
      '国内直连 Danbooru 一般连不上：开着 Clash、v2rayN 这类软件的话，打开它的「系统代理」或 TUN 模式，再点一次检测；' +
      '也可以在 Emaki 目录的 .env 里写一行 EMAKI_HTTP_PROXY=http://127.0.0.1:7890（端口换成自己的），然后重启 Emaki。';
  }
  return { proxy, targets: [danbooru, hf, mirror], summary };
}
