/**
 * HTTP 路由从命令 / 查询注册表生成（docs/core-architecture.md 第 9 节，附录 #35）：每个定义里写了 http 地址的，在这里统一挂上，
 * 参数校验用注册表里的 schema（packages/shared/src/schemas.ts），不再在路由文件里另写一份。
 *
 * - 输入 = 路径参数 + 查询串（GET / DELETE）或请求体；
 * - 写命令：actor 取请求的上下文（网页是 user，助手经 MCP 是 assistant），请求头 Idempotency-Key 就是 operationId；
 *   响应头带上命令层的说明：x-emaki-command（命令名）、x-emaki-undo（token / barrier / none，前端的撤销屏障由它生成）、
 *   x-emaki-event（这次推出去的最后一个 changed 事件 id，前端等到它就不用自己再刷新）、x-emaki-changes（变了哪些事实）；
 * - 通用入口：POST /api/commands/:name、GET /api/queries/:name（新代码只用命令和查询）；GET /api/commands 是清单；
 * - 旧的地址（PATCH /api/images/:id、POST /api/images/bulk 这类一个地址对多个命令的）在 compat.ts，只把参数转成命令。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import type { CommandMeta, Def, Registry } from '../commands/registry.ts';
import type { FileResponse } from '../infra/ports.ts';
import { currentActor } from '../propagation/actor.ts';
import { compatRoutes } from './compat.ts';

/** 请求头里的 operationId（网页、外部调用者都可以带；同一个键重试返回第一次的结果） */
export const OPERATION_HEADER = 'idempotency-key';

/** 文件查询：响应是图片本身，不是 JSON（缺省的缓存策略：缩略图按 id 永久缓存；原图一小时） */
const FILE_QUERIES: Record<string, string> = {
  'images.thumbnail': 'public, max-age=31536000, immutable',
  'images.original': 'private, max-age=3600',
};

/** 一条路由的输入：路径参数 + 查询串或请求体（路径参数优先） */
export function inputOf(req: FastifyRequest): Record<string, unknown> {
  const extra = req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE' ? req.query : req.body;
  return { ...(extra && typeof extra === 'object' ? (extra as Record<string, unknown>) : {}), ...(req.params as Record<string, unknown>) };
}

/** 写命令的调用选项：actor 取请求上下文，Idempotency-Key 是 operationId */
export function callOf(req: FastifyRequest): { operationId?: string } {
  const key = req.headers[OPERATION_HEADER];
  return typeof key === 'string' && key ? { operationId: key.slice(0, 200) } : {};
}

/** 把命令层的说明放进响应头 */
export function sendCommand(reply: FastifyReply, meta: CommandMeta | undefined, result: unknown) {
  if (meta) {
    reply.header('x-emaki-command', meta.command);
    reply.header('x-emaki-undo', meta.undo);
    if (meta.eventId !== null) reply.header('x-emaki-event', String(meta.eventId));
    if (meta.changes.length) reply.header('x-emaki-changes', meta.changes.join(','));
    if (meta.replayed) reply.header('x-emaki-replayed', '1');
  }
  return result;
}

// 大的查询结果（重复组一次 6 MB）：数据源缓存命中时返回同一个对象，序列化结果也跟着复用（T22）
const serialized = new WeakMap<object, string>();
function sendJson(reply: FastifyReply, result: unknown) {
  if (!result || typeof result !== 'object') return result;
  let body = serialized.get(result);
  if (body === undefined) {
    body = JSON.stringify(result);
    serialized.set(result, body);
  }
  return reply.type('application/json; charset=utf-8').send(body);
}

/** 数据源可以给 etag（内容 sha）和自己的缓存策略；不带 etag 的（演示模式的占位图）走默认的 */
function sendFile(req: FastifyRequest, reply: FastifyReply, file: FileResponse, defaultCache: string) {
  reply.header('Cache-Control', file.cacheControl ?? defaultCache);
  if (file.etag) {
    reply.header('ETag', file.etag);
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === file.etag)) return reply.code(304).send();
  }
  reply.type(file.contentType);
  return file.kind === 'buffer' ? reply.send(file.body) : reply.send(createReadStream(file.filePath));
}

async function handle(registry: Registry, def: Def, req: FastifyRequest, reply: FastifyReply) {
  const input = inputOf(req);
  if (def.kind === 'query') {
    const result = await registry.query(def.name, input);
    const cache = FILE_QUERIES[def.name];
    return cache ? sendFile(req, reply, result as FileResponse, cache) : sendJson(reply, result);
  }
  const result = await registry.execute(def.name, input, { ...callOf(req), actor: currentActor() });
  return sendCommand(reply, registry.meta(result), result);
}

/** 注册表里所有带 http 地址的命令和查询，加上通用入口和旧地址的兼容层 */
export function registryRoutes(app: FastifyInstance, registry: Registry): void {
  for (const def of registry.list()) {
    for (const h of def.http ?? []) app.route({ method: h.method, url: h.path, handler: (req, reply) => handle(registry, def, req, reply) });
  }
  // 通用入口：名字就是注册表里的名字，输入就是 schema 的形状
  app.post('/api/commands/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const result = await registry.execute(name, req.body ?? {}, { ...callOf(req), actor: currentActor() });
    return sendCommand(reply, registry.meta(result), result);
  });
  app.get('/api/queries/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const def = registry.get(name);
    if (def?.kind === 'query' && FILE_QUERIES[name]) return handle(registry, def, req, reply);
    return sendJson(reply, await registry.query(name, req.query ?? {}));
  });
  compatRoutes(app, registry);
}
