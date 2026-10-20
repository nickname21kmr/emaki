import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { z } from 'zod';
import type { DataSource } from '../datasource/DataSource.ts';
import { config } from '../config.ts';
import { BadRequestError } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { AssistantService } from './service.ts';
import { apiModelsInput, fetchApiModels } from './apiModels.ts';

const origin = (url: string) => (URL.canParse(url) ? new URL(url).origin : '');

export function assistantRoutes(app: FastifyInstance, ds: DataSource) {
  const streams = new Set<import('node:http').ServerResponse>();
  const service = new AssistantService(path.join(config.dataDir, 'assistant'), config.repoRoot, () => {
    const address = app.server.address(); return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : config.port}/api/assistant/mcp`;
  });
  app.addHook('preClose', async () => { for (const stream of streams) stream.end(); await service.close(); });
  app.get('/api/assistant/settings', () => service.store.publicSettings());
  app.patch('/api/assistant/settings', async (req) => {
    const body = parse(z.object({ enabled: z.boolean().optional(), accessMode: z.enum(['ask', 'full']).optional(), backend: z.enum(['codex', 'pi', 'dsh']).nullable().optional(), codexPath: z.string().max(2000).optional(), dshPath: z.string().max(2000).optional(), apiKey: z.string().max(10000).optional(),
      pi: z.object({ provider: z.string().max(200), baseUrl: z.union([z.literal(''), z.url().refine(v => /^https?:\/\//.test(v))]), model: z.string().max(100000), api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']), vision: z.boolean().default(true), reasoning: z.boolean().default(false) }).optional() }), req.body);
    const s = service.store.settings;
    // 已保存的 key 只属于原来的 API 主机，换了地址不能默默带过去（和读取模型列表同一规则）。放在所有赋值之前，拒绝时设置不变
    if (body.pi?.baseUrl && body.apiKey === undefined && s.apiKey && origin(s.pi.baseUrl) !== origin(body.pi.baseUrl))
      throw new BadRequestError('API 地址已更换，请填写对应的 API Key');
    if (body.accessMode !== undefined) s.accessMode = body.accessMode;
    if (body.enabled !== undefined) s.enabled = body.enabled;
    if (body.backend !== undefined) s.backend = body.backend;
    if (body.codexPath !== undefined) s.codexPath = body.codexPath;
    if (body.dshPath !== undefined) s.dshPath = body.dshPath;
    if (body.pi) s.pi = { ...body.pi, apiKeyConfigured: Boolean(s.apiKey) };
    if (body.apiKey !== undefined) s.apiKey = body.apiKey;
    service.store.saveSettings(); await service.close(); return service.store.publicSettings();
  });
  app.post('/api/assistant/detect', () => service.detect());
  app.post('/api/assistant/api-models', (req) => {
    service.assertEnabled();
    return fetchApiModels(parse(apiModelsInput, req.body), service.store.settings);
  });
  app.get('/api/assistant/mcp-config', () => { service.assertEnabled(); return { url: service.endpoint(), token: service.store.settings.externalToken }; });
  app.get('/api/assistant/sessions', () => { service.assertEnabled(); return [...service.store.sessions.values()].map(s => ({ id: s.id, title: s.title, backend: s.backend, updatedAt: s.updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); });
  app.post('/api/assistant/sessions', () => { service.assertEnabled(); return service.store.publicSession(service.store.create()); });
  const id = (params: unknown) => parse(z.object({ id: z.uuid() }), params).id;
  app.get('/api/assistant/sessions/:id', (req) => { service.assertEnabled(); return service.store.publicSession(service.store.get(id(req.params))); });
  app.get('/api/assistant/sessions/:id/models', (req) => { service.assertEnabled(); return service.models(id(req.params)); });
  app.post('/api/assistant/sessions/:id/messages', (req) => service.send(id(req.params), parse(z.object({ requestId: z.uuid(), text: z.string().min(1).max(30000), model: z.string().min(1).max(500), effort: z.string().max(50).default(''),
    context: z.object({ page: z.string().max(5000), imageIds: z.array(z.string().max(100)).max(5000), selectionScope: z.string().max(300).optional() }) }), req.body)));
  app.post('/api/assistant/sessions/:id/stop', async (req) => { service.assertEnabled(); await service.stop(id(req.params)); return { ok: true }; });
  app.post('/api/assistant/sessions/:id/resume', (req) => service.resume(id(req.params), parse(z.object({ requestId: z.uuid(), messageId: z.string().min(1).max(200), model: z.string().min(1).max(500), effort: z.string().max(50).default('') }), req.body)));
  app.post('/api/assistant/sessions/:id/answer', async (req) => { const body = parse(z.object({ requestId: z.string().max(200), value: z.string().max(10000) }), req.body); await service.answer(id(req.params), body.requestId, body.value); return { ok: true }; });
  app.get('/api/assistant/sessions/:id/events', (req, reply) => {
    service.assertEnabled(); const sessionId = id(req.params); service.store.get(sessionId);
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    streams.add(reply.raw);
    const send = () => {
      if (!service.store.settings.enabled) { reply.raw.write('event: disabled\ndata: {}\n\n'); reply.raw.end(); return; }
      reply.raw.write(`data: ${JSON.stringify(service.store.publicSession(service.store.get(sessionId)))}\n\n`);
    };
    send(); const unsubscribe = service.subscribe(changed => { if (changed === sessionId) send(); });
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
    reply.raw.on('close', () => { streams.delete(reply.raw); unsubscribe(); clearInterval(heartbeat); });
  });
  app.post('/api/assistant/mcp', async (req, reply) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const auth = service.authorize(token);
    // MCP SDK 和 sharp 用到时才加载，助手没开时启动不付这份开销
    const [{ StreamableHTTPServerTransport }, { createLibraryMcp }] = await Promise.all([import('@modelcontextprotocol/sdk/server/streamableHttp.js'), import('./tools.ts')]);
    // SQL 工具直接读库文件，只有真实 SQLite 数据源才提供；--mock 下不能去读开发机上的真实图库
    const file = config.dataSource === 'sqlite' ? path.join(config.dataDir, 'emaki.sqlite') : null;
    const server = createLibraryMcp(app, ds, file, service, auth.scope, auth.sessionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport); reply.hijack();
    reply.raw.once('close', () => { void server.close(); });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  return service;
}
