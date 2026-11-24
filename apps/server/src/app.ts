import type { HealthResponse, Me } from '@emaki/shared';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { existsSync } from 'node:fs';
import { config } from './config.ts';
import type { EventBus } from './core/events.ts';
import type { SqliteDataSource } from './datasource/sqlite/SqliteDataSource.ts';
import { toApiError } from './http/errors.ts';
import { eventRoutes, type EventRouteOptions } from './http/events.ts';
import { registryRoutes } from './http/routes.ts';
import { pluginPackageRoutes } from './http/pluginPackages.ts';
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

/** 两个入口一样的 fastify 设置；extra 是局域网入口的 https 这类 */
export function createFastify(extra: Partial<FastifyServerOptions> & { https?: { key: string; cert: string } } = {}): FastifyInstance {
  // 局域网入口传了 https 时 fastify 的类型参数变成 https.Server；路由、钩子只用到和 http 一样的部分
  return Fastify({
    logger: { level: process.env.EMAKI_LOG_LEVEL ?? 'info', transport: undefined },
    // 批量操作可能带几千个 id
    bodyLimit: 5 * 1024 * 1024,
    ...extra,
  }) as unknown as FastifyInstance;
}

/** 两个入口共用的：错误处理、注册表生成的路由、SSE、健康检查 */
export function mountShared(app: FastifyInstance, engine: SqliteDataSource, bus: EventBus, events: EventRouteOptions = {}): void {
  app.setErrorHandler((err, req, reply) => {
    const { statusCode, body } = toApiError(err);
    if (statusCode >= 500 && statusCode !== 501) req.log.error(err);
    void reply.status(statusCode).send(body);
  });

  registryRoutes(app, engine.registry);
  uploadRoutes(app, engine);
  pluginPackageRoutes(app, engine);
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

/** 生产模式：托管前端构建产物（不要身份），前端路由全部回落到 index.html；不存在的 /api/ 地址 404 */
export async function serveWeb(app: FastifyInstance, webDist: string): Promise<void> {
  if (!existsSync(webDist)) return;
  // wildcard：按请求去磁盘找文件，不在启动时把文件列表定死。否则服务开着的时候重新构建了网页（带哈希的新文件名），
  // 新文件一律 404，要重启服务才好（2026-11-19 在真实部署里遇到）
  await app.register(fastifyStatic, { root: webDist, wildcard: true });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ ok: false, error: `没有这个接口：${req.method} ${req.url}`, code: 'not_found' });
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
  await serveWeb(app, config.webDist);

  return app;
}
