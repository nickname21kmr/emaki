import type { HealthResponse } from '@emaki/shared';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { config } from './config.ts';
import type { EventBus } from './core/events.ts';
import type { DataSource } from './datasource/DataSource.ts';
import { toApiError } from './http/errors.ts';
import { keepAwakeStatus } from './services/system/keepAwake.ts';
import { collectionRoutes } from './routes/collections.ts';
import { imageRoutes } from './routes/images.ts';
import { libraryRoutes } from './routes/library.ts';
import { systemRoutes } from './routes/system.ts';

/** 这次启动的 id：撤销栈只在内存里，前端看到它变了就丢掉旧的撤销记录 */
const bootId = randomUUID();

export async function buildApp(ds: DataSource, bus: EventBus) {
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
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', config.host]);
  app.addHook('onRequest', async (req, reply) => {
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(hostHeader.replace(/:\d+$/, ''))) {
      return reply.code(403).send({ ok: false, error: '只允许本机访问', code: 'bad_request' });
    }
    const origin = req.headers.origin?.toLowerCase();
    const site = req.headers['sec-fetch-site'];
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if ((origin && origin !== `http://${hostHeader}`) || (write && site && site !== 'same-origin' && site !== 'none')) {
      return reply.code(403).send({ ok: false, error: '只允许 Emaki 自己的页面调用', code: 'bad_request' });
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

  libraryRoutes(app, ds);
  collectionRoutes(app, ds);
  imageRoutes(app, ds);
  systemRoutes(app, ds, bus);

  app.get(
    '/api/health',
    (): HealthResponse => ({
      ok: true,
      dataSource: config.dataSource,
      version: config.appVersion,
      dataDir: config.dataDir,
      bootId,
      ...(config.dataSource === 'sqlite' ? { keepAwake: keepAwakeStatus() } : {}),
    }),
  );

  // 生产模式：托管前端构建产物，前端路由全部回落到 index.html
  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).send({ ok: false, error: `没有这个接口：${req.method} ${req.url}`, code: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
