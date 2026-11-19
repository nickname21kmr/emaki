import type { HealthResponse } from '@emaki/shared';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { config } from './config.ts';
import type { EventBus } from './core/events.ts';
import type { SqliteDataSource } from './datasource/sqlite/SqliteDataSource.ts';
import { toApiError } from './http/errors.ts';
import { eventRoutes } from './http/events.ts';
import { registryRoutes } from './http/routes.ts';
import { keepAwakeStatus } from './services/system/keepAwake.ts';
import { assistantRoutes } from './assistant/routes.ts';
import { actorFromHeaders, runAs } from './propagation/actor.ts';

/**
 * HTTP 入口。路由从命令 / 查询注册表生成（http/routes.ts，docs/core-architecture.md 第 9 节）；
 * 另外只有 SSE（http/events.ts）、健康检查、AI 助手的会话管理（assistant/routes.ts）和生产模式托管前端。
 */
export async function buildApp(engine: SqliteDataSource, bus: EventBus) {
  const app = Fastify({
    logger: { level: process.env.EMAKI_LOG_LEVEL ?? 'info', transport: undefined },
    // 批量操作可能带几千个 id
    bodyLimit: 5 * 1024 * 1024,
  });

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

  app.setErrorHandler((err, req, reply) => {
    const { statusCode, body } = toApiError(err);
    if (statusCode >= 500 && statusCode !== 501) req.log.error(err);
    void reply.status(statusCode).send(body);
  });

  registryRoutes(app, engine.registry);
  eventRoutes(app, bus);
  assistantRoutes(app, engine);

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

  // 生产模式：托管前端构建产物，前端路由全部回落到 index.html
  if (existsSync(config.webDist)) {
    // wildcard：按请求去磁盘找文件，不在启动时把文件列表定死。否则服务开着的时候重新构建了网页（带哈希的新文件名），
    // 新文件一律 404，要重启服务才好（2026-11-19 在真实部署里遇到）
    await app.register(fastifyStatic, { root: config.webDist, wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).send({ ok: false, error: `没有这个接口：${req.method} ${req.url}`, code: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
