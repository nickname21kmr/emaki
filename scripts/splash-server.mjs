// 启动页服务（scripts/start.mjs 用）：后端还没监听的那几秒先占住它的端口，窗口一打开就有东西看；后端准备好了再把端口让给它。
// 和后端同一个地址，所以窗口的名字、位置记忆、存在浏览器里的主题都和应用本身是同一份。只用 Node 内置模块。
//
// 约定（scripts/splash.html 和 start.mjs 的「已在运行 / 正在启动」判断都按它来）：
//   /api/ 开头的地址 → 503，JSON { ok: false, starting: true, stage, error? }（真正的后端在 /api/health 回 200）
//   其它页面地址（GET）→ 200，启动页；后端接手后页面原地刷新，所以哪个地址进来都行
//   带扩展名的地址（上次没关的页面来要脚本、图片）和非 GET → 503
// 一律 no-store：刷新后拿到的必须是后端给的页面。
import http from 'node:http';

/** 启动走到哪一步了：checking 检查依赖 / installing 安装依赖 / building 构建界面 / opening 后端在打开图库 / failed 没能启动（带 error） */
export const STAGES = ['checking', 'installing', 'building', 'opening', 'failed'];

/**
 * @param {{ page: string | Buffer, state: () => { stage: string, error?: string | null }, onReported?: (stage: string) => void }} options
 *   page：启动页的内容；state：现在的阶段；onReported：一次阶段查询已经发给页面之后调用（start.mjs 用它等页面读到失败原因）
 */
export function createSplashServer({ page, state, onReported }) {
  return http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    const { stage, error } = state();
    const starting = JSON.stringify({ ok: false, starting: true, stage, ...(error ? { error } : {}) });
    const send = (status, type, body) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const get = req.method === 'GET' || req.method === 'HEAD';
    if (get && !pathname.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(pathname)) return send(200, 'text/html; charset=utf-8', page);
    if (get && pathname === '/api/health') res.once('finish', () => onReported?.(stage));
    send(503, 'application/json; charset=utf-8', starting);
  });
}

/**
 * 端口上现在是谁：running = Emaki 已经在运行；starting = 另一个 Emaki 的启动页（stage 是它走到哪一步）；
 * free = 没人监听；occupied = 被别的程序占着（包括连上了但不像 Emaki、超时没回应）
 * @returns {Promise<{ kind: 'running' | 'free' | 'occupied' } | { kind: 'starting', stage: string }>}
 */
export async function probe(url, timeoutMs = 800) {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { kind: 'running' };
    const body = await res.json().catch(() => null);
    return res.status === 503 && body?.starting === true ? { kind: 'starting', stage: String(body.stage) } : { kind: 'occupied' };
  } catch (e) {
    return { kind: e?.cause?.code === 'ECONNREFUSED' ? 'free' : 'occupied' };
  }
}
