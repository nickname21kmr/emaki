import type { HealthResponse, Me } from '@emaki/shared';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { config } from './config.ts';
import type { EventBus } from './core/events.ts';
import type { SqliteDataSource } from './datasource/sqlite/SqliteDataSource.ts';
import { toApiError } from './http/errors.ts';
import { eventRoutes, type EventRouteOptions } from './http/events.ts';
import { registryRoutes } from './http/routes.ts';
import { uploadRoutes } from './http/uploads.ts';
import { keepAwakeStatus } from './services/system/keepAwake.ts';
import { assistantRoutes } from './assistant/routes.ts';
import { actorFromHeaders, runAs } from './propagation/actor.ts';

/**
 * HTTP 入口。路由从命令 / 查询注册表生成（http/routes.ts，docs/core-architecture.md 第 9 节）；
 * 另外只有 SSE（http/events.ts）、健康检查、AI 助手的会话管理（assistant/routes.ts）和生产模式托管前端。
 *
 * 两个入口（docs/mobile.md 2.1、2.6）共用 createFastify、mountShared、serveWeb：
 * - 本机入口 buildApp（这里，127.0.0.1:5174）：Host / Origin / 同源检查，免登录，挂 AI 助手的路由；
 * - 局域网入口 buildLanApp（access/lan.ts）：https，所有 /api/ 都要设备凭证，不挂助手的路由。
 */

type CompilersFactory = Required<NonNullable<NonNullable<FastifyServerOptions['schemaController']>['compilersFactory']>>;

// ajv、fast-json-stringify 的编译器是 fastify 的依赖，不是这个包的：从 fastify 所在的位置找
const requireFromFastify = createRequire(createRequire(import.meta.url).resolve('fastify'));

/** 第一次调用时才 load()，之后一直用那一个 */
function lazy<F>(load: () => F): F {
  let fn: ((...args: unknown[]) => unknown) | undefined;
  return ((...args: unknown[]) => (fn ??= load() as (...args: unknown[]) => unknown)(...args)) as F;
}

/**
 * JSON schema 的校验 / 序列化编译器，用到时才加载。fastify 默认在构造时就 require 它们（ajv、fast-json-stringify，一百多个模块，
 * 每次启动 0.3–0.4 秒），而这里的路由都不带 schema（校验走 zod，http/validate.ts）。以后哪条路由带了 schema，注册它的时候照常加载、照常校验；
 * 只有一处不同：从选项传进去的编译器 fastify 一律当成「自定义」的，headers 的 schema 不再替你把键转成小写
 */
function lazyCompilers(): CompilersFactory {
  return {
    buildValidator: lazy<CompilersFactory['buildValidator']>(() => requireFromFastify('@fastify/ajv-compiler')()),
    buildSerializer: lazy<CompilersFactory['buildSerializer']>(() => requireFromFastify('@fastify/fast-json-stringify-compiler')()),
  };
}

/** 比这个久的请求记一行日志 */
export const SLOW_REQUEST_MS = 300;

/** 5xx 算出错；501 是「还没实现」（NotImplementedError），不算 */
const isServerError = (statusCode: number) => statusCode >= 500 && statusCode !== 501;

/**
 * 一个结束了的请求记哪一级的日志：出错的（5xx）warn，慢的 info，其余 debug（默认的 info 级别下不出现；
 * 要看全部请求时把 EMAKI_LOG_LEVEL 设成 debug）。一行：方法、地址、状态码、毫秒。
 * byFastify：响应是 fastify 发出去的。被接管的连接（reply.hijack()：/api/events 这类 SSE、MCP）开多久不代表处理慢，结束时不算慢请求
 */
export function requestLogEntry(r: {
  method: string;
  url: string;
  statusCode: number;
  ms: number;
  byFastify: boolean;
}): { level: 'warn' | 'info' | 'debug'; msg: string } {
  const url = r.url.length > 300 ? `${r.url.slice(0, 300)}…` : r.url;
  const line = `${r.method} ${url} ${r.statusCode} ${Math.round(r.ms)} ms`;
  if (isServerError(r.statusCode)) return { level: 'warn', msg: `请求出错 ${line}` };
  if (r.byFastify && r.ms > SLOW_REQUEST_MS) return { level: 'info', msg: `慢请求 ${line}` };
  return { level: 'debug', msg: line };
}

/** fastify 自己发出去的响应（createFastify 的 onSend 钩子记的；被接管的响应不经过 onSend） */
const sentByFastify = new WeakSet<FastifyReply>();

/**
 * 请求日志。fastify 默认给每个请求记两行（收到、完成）：翻一页缩略图就是两百多行，同步写进那个黑色窗口，和同步的 SQLite 抢同一个线程。
 * 这里每个请求结束时最多一行，平时只有慢的和出错的看得到（requestLogEntry）；浏览器自己掐掉的下载（滚动、翻页时取消的图片）不记。
 * fastify 别的日志（响应发到一半出错这些）照旧。出错的详情在 mountShared 的 setErrorHandler 里记。
 * 不用顶层的 disableRequestLogging 选项：现在的 fastify（5.12）里它已弃用，每次启动打一条警告，而且会把「响应发到一半出错」的警告一起关掉
 */
class RequestLog extends LogController {
  override incomingRequest(): void {}

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    if (error) return super.requestCompleted(error, request, reply);
    const entry = requestLogEntry({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      ms: reply.elapsedTime,
      byFastify: sentByFastify.has(reply),
    });
    reply.log[entry.level](entry.msg);
  }

  override streamError(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') super.streamError(error, request, reply);
  }
}

/** 两个入口一样的 fastify 设置；extra 是局域网入口的 https 这类 */
export function createFastify(extra: Partial<FastifyServerOptions> & { https?: { key: string; cert: string } } = {}): FastifyInstance {
  // 局域网入口传了 https 时 fastify 的类型参数变成 https.Server；路由、钩子只用到和 http 一样的部分
  const app = Fastify({
    logger: { level: process.env.EMAKI_LOG_LEVEL ?? 'info', transport: undefined },
    logController: new RequestLog(),
    // 批量操作可能带几千个 id
    bodyLimit: 5 * 1024 * 1024,
    schemaController: { compilersFactory: lazyCompilers() },
    ...extra,
  }) as unknown as FastifyInstance;
  // 记下哪些响应是 fastify 发的：RequestLog 靠它认出被接管的长连接
  app.addHook('onSend', (_req, reply, _payload, done) => {
    sentByFastify.add(reply);
    done();
  });
  return app;
}

/** 两个入口共用的：错误处理、注册表生成的路由、SSE、健康检查 */
export function mountShared(app: FastifyInstance, engine: SqliteDataSource, bus: EventBus, events: EventRouteOptions = {}): void {
  app.setErrorHandler((err, req, reply) => {
    const { statusCode, body } = toApiError(err);
    if (isServerError(statusCode)) req.log.error(err);
    void reply.status(statusCode).send(body);
  });

  registryRoutes(app, engine.registry);
  uploadRoutes(app, engine);
  eventRoutes(app, bus, events);

  // 谁在调用（docs/mobile.md 2.5）：本机入口是 local、全部范围；局域网入口是这台设备和它真正生效的范围。网页按它隐藏用不了的入口
  app.get('/api/me', (): Me => engine.access.me());

  app.get(
    '/api/health',
    (): HealthResponse => ({
      ok: true,
      dataSource: config.dataSource,
      version: config.appVersion,
      dataDir: config.libraryDir,
      bootId: bus.boot,
      ...(config.dataSource === 'sqlite' ? { keepAwake: keepAwakeStatus() } : {}),
    }),
  );
}

/**
 * 前端构建产物的缓存头，按实际发出去的文件定：dist/assets/ 下的文件名带内容哈希，内容不会变，缓存一年、不用回来问；
 * 其余的（index.html、favicon）每次回来核对，重新构建之后立刻拿到新的。
 * 不能按请求地址定：前端路由和找不到的地址发出去的是 index.html，按地址给长缓存的话旧地址会把它缓存一年
 */
export function webCacheControl(webDist: string, filePath: string): string {
  const [dir, ...rest] = path.relative(webDist, filePath).split(path.sep);
  return dir === 'assets' && rest.length > 0 ? 'public, max-age=31536000, immutable' : 'no-cache';
}

/** 请求的是不是构建产物（/assets/ 下的文件）。和静态托管找文件时一样，看 decodeURI 之后的路径 */
export function isAssetRequest(url: string): boolean {
  try {
    return decodeURI(url.split('?')[0] ?? '').startsWith('/assets/');
  } catch {
    return false;
  }
}

/**
 * 生产模式：托管前端构建产物（不要身份），前端路由全部回落到 index.html；不存在的 /api/ 地址 404。
 * assets404：不存在的构建产物（/assets/…）也回 404，不回落。本机入口开着；局域网入口还没开：那边的测试写明了
 * 不存在的资源文件回落到 index.html（test/access/lan.test.ts），等手机端确认以后两边统一，这个参数就可以去掉
 */
export async function serveWeb(app: FastifyInstance, webDist: string, opts: { assets404?: boolean } = {}): Promise<void> {
  if (!existsSync(webDist)) return;
  // wildcard：按请求去磁盘找文件，不在启动时把文件列表定死。否则服务开着的时候重新构建了网页（带哈希的新文件名），
  // 新文件一律 404，要重启服务才好（2026-11-19 在真实部署里遇到）
  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: true,
    setHeaders: (reply, filePath) => void reply.header('cache-control', webCacheControl(webDist, filePath)),
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ ok: false, error: `没有这个接口：${req.method} ${req.url}`, code: 'not_found' });
    }
    // 重新构建之后，还开着的旧页面会来取旧哈希的文件：回 404，不回 index.html（脚本、样式拿到一份 HTML 只会报类型不对）
    if (opts.assets404 && isAssetRequest(req.url)) {
      return reply.status(404).header('cache-control', 'no-cache').send({ ok: false, error: `没有这个文件：${req.url}`, code: 'not_found' });
    }
    return reply.sendFile('index.html');
  });
}

/** 本机入口 */
export async function buildApp(engine: SqliteDataSource, bus: EventBus) {
  const app = createFastify();

  // 本机安全（T23），在所有路由之前。不开 CORS：开发时 vite 把 /api 代理成同源，生产由后端自己托管前端，
  // 本机其他端口的页面（ComfyUI、别的 vite 项目）不该能读图库或发写操作。
  // - 防 DNS rebinding：只接受本机 Host（EMAKI_HOST 改成别的地址时也认它）
  // - 只认自己的页面：带了 Origin 就必须和 Host 一致；写请求的 sec-fetch-site 也必须是同源。
  //   <img>、CSS 背景图这种跨站 GET 不带 Origin，照常放行（喜好报告从本地文件读封面）
  // - 防跨站 POST：写操作必须是 JSON。跨站页面发 JSON 会触发预检，没有 CORS 就过不去；
  //   fastify 默认也解析 text/plain，不拦的话没有 body 的 POST（撤销、标记已看过）可以被任意网页触发。
  //   不看路径：req.url 是没解码的原始路径，'/%61pi/...' 照样会路由到 /api/...
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', config.host, ...config.allowedHosts]);
  // actor（docs/core-architecture.md 第 5.2 节）：HTTP 请求默认是用户；AI 助手经 app.inject 调接口时带本进程的内部令牌，记成助手。
  // 放在最前面：后面的钩子和处理函数（包括其中的异步续体）都在这个 actor 下执行
  app.addHook('onRequest', (req, _reply, done) => runAs(actorFromHeaders(req.headers), done));
  app.addHook('onRequest', async (req, reply) => {
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(hostHeader.replace(/:\d+$/, ''))) {
      return reply.code(403).send({ ok: false, error: '只允许本机访问', code: 'forbidden' });
    }
    const origin = req.headers.origin?.toLowerCase();
    const site = req.headers['sec-fetch-site'];
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if ((origin && origin !== `http://${hostHeader}`) || (write && site && site !== 'same-origin' && site !== 'none')) {
      return reply.code(403).send({ ok: false, error: '只允许 Emaki 自己的页面调用', code: 'forbidden' });
    }
    if (req.method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return reply.code(415).send({ ok: false, error: '请求必须是 JSON', code: 'bad_request' });
    }
  });

  mountShared(app, engine, bus);
  assistantRoutes(app, engine);
  await serveWeb(app, config.webDist, { assets404: true });

  return app;
}
