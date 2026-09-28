import cors from '@fastify/cors';
import type { HealthResponse } from '@emaki/shared';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
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

export async function buildApp(ds: DataSource, bus: EventBus) {
  const app = Fastify({
    logger: { level: process.env.EMAKI_LOG_LEVEL ?? 'info', transport: undefined },
    // 批量操作可能带几千个 id
    bodyLimit: 5 * 1024 * 1024,
  });

  // 只监听 127.0.0.1，CORS 只是为了 vite dev server 之外的调试方便
  await app.register(cors, { origin: [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] });

  // 本机安全（T23），在所有路由之前：
  // - 防 DNS rebinding：只接受本机 Host（EMAKI_HOST 改成别的地址时也认它）
  // - 防跨站 POST：写操作必须是 JSON。跨站页面发 JSON 会触发 CORS 预检而被拒绝；
  //   fastify 默认也解析 text/plain，不拦的话没有 body 的 POST（撤销、标记已看过）可以被任意网页触发
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', config.host]);
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!allowedHosts.has(host)) {
      return reply.code(403).send({ ok: false, error: '只允许本机访问', code: 'bad_request' });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/') && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
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
