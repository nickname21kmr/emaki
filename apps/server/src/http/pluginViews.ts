/**
 * 插件视图的桥接（docs/plugins.md 第 5 节）：网页把视图放进隔离的 iframe，视图经 postMessage（MCP Apps）调工具，
 * 网页这边的宿主（apps/web/src/features/plugins/view/）再调这里。视图自己碰不到 /api（安全策略不放行），只有图片例外。
 *
 * - GET  /api/plugins/:id/pages/:page：打开一页——HTML、页头标题、它能调的工具、图片地址的前缀（发一个短期令牌）；
 * - POST /api/plugins/:id/call：调一个工具。工具就是给 AI 助手的那一份（assistant/libraryTools.ts），按生效的范围过滤：
 *   插件的授权 ∩ 打开它的入口（本机是全部，局域网入口是这台设备的），docs/plugins.md 4.1 的「叠加取交集」。
 *   记成 plugin:<id>@<版本>，进审计，可撤销的修改进撤销栈；
 * - POST /api/plugins/:id/storage：插件自己的键值存储（emaki/storage/*，domain/plugins/storage.ts）；只看得到自己的；
 * - POST /api/plugins/:id/errors：宿主发现视图坏了（握手超时、自己跳走了……）记一次错，多次自动停用；
 * - GET  /api/plugin-media/:token/file/<路径>：插件自己文件夹里的图片（E5，插件的服务端下载的缩略图这类）；
 * - GET  /api/plugin-media/:token/thumb|original/:imageId：视图里的图片。匿名来源的请求不带 Cookie，凭地址里的令牌
 *   （services/plugins/media.ts）；局域网入口上它不要设备凭证（access/lan.ts 的 PUBLIC_ROUTES）。
 * - GET  /api/plugin-web/:id/:key/<路径>：改网页的插件的模块（E6，docs/plugins.md 第 7 节），网页 import 它。只给网页要加载的插件
 *   （启用着、授权了改内部、它改的点没变，PluginsState.webPatches）包里的 .js、.mjs；key 是版本和修改时间（只为了换地址、不缓存旧的）。
 *   局域网入口上也不要设备凭证：import 带不了 App 的请求头，内容只是这个插件的代码。
 *
 * 这几个不走注册表：调用是转发到注册表里的命令和查询，本身不是一个命令；图片是文件。权限检查在这里做，和注册表同一个口径。
 */
import { commandToolName, SCOPES, type PluginView, type Scope } from '@emaki/shared';
import { PluginViewInput } from '@emaki/shared/schemas';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { libraryTools, type LibraryTool } from '../assistant/libraryTools.ts';
import type { SqliteDataSource } from '../datasource/sqlite/SqliteDataSource.ts';
import type { FileResponse } from '../infra/ports.ts';
import { currentCall, pluginActor, runCall } from '../propagation/actor.ts';
import { ConflictError, HttpError, NotFoundError } from './errors.ts';
import { FILE_QUERIES, sendFile } from './routes.ts';
import { parse } from './validate.ts';

/** 每个插件的调用频率：一下子最多这么多次，之后每秒补这么多 */
export const CALL_LIMIT = { burst: 60, perSecond: 20 };
/** 一次调用返回的最大大小：超了让视图分页 */
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;

const CallInput = z.object({
  name: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
const StorageInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get'), key: z.string().min(1).max(200) }),
  z.object({ op: z.literal('set'), key: z.string().min(1).max(200), value: z.unknown() }),
  z.object({ op: z.literal('delete'), key: z.string().min(1).max(200) }),
  z.object({ op: z.literal('list'), prefix: z.string().max(200).default('') }),
]);
const ErrorInput = z.object({ source: z.string().trim().min(1).max(40).default('视图'), message: z.string().trim().min(1).max(500) });
const MediaParams = z.object({
  token: z.string().min(1).max(100),
  size: z.enum(['thumb', 'original']),
  imageId: z.string().min(1).max(40),
});

const failed = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

export function pluginViewRoutes(app: FastifyInstance, engine: SqliteDataSource): void {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const clock = () => engine.ctx.clock();

  /** 入口的范围（局域网入口上是这台设备的；本机入口没有 = 不限） */
  const outer = () => currentCall()?.grant;
  const requireOuter = (scope: Scope) => {
    const g = outer();
    if (g && !g.has(scope)) throw new HttpError(403, 'forbidden', '这台设备没有「读图库」的权限');
  };
  /** 生效的范围：插件的授权 ∩ 入口 */
  const effective = (scopes: readonly Scope[]): Set<Scope> => {
    const g = outer();
    return new Set(scopes.filter((s) => !g || g.has(s)));
  };
  const toolsFor = (id: string, version: string, scopes: ReadonlySet<Scope>): LibraryTool[] =>
    libraryTools(engine.registry, { actor: pluginActor(id, version), namespace: `plugin:${id}`, scopes });

  const take = (id: string): boolean => {
    const now = clock();
    const b = buckets.get(id) ?? { tokens: CALL_LIMIT.burst, at: now };
    b.tokens = Math.min(CALL_LIMIT.burst, b.tokens + ((now - b.at) / 1000) * CALL_LIMIT.perSecond);
    b.at = now;
    buckets.set(id, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };

  app.get('/api/plugins/:id/pages/:page', async (req): Promise<PluginView> => {
    const { id, page } = parse(PluginViewInput, req.params);
    requireOuter('read');
    const v = engine.plugins.view(id, page);
    const scopes = effective(v.scopes);
    return {
      pluginId: v.pluginId,
      pageId: v.pageId,
      version: v.version,
      title: v.title,
      html: v.html,
      mediaBase: scopes.has('read') ? engine.pluginMedia.mint(id, scopes) : null,
      tools: toolsFor(id, v.version, scopes).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: z.toJSONSchema(z.object(t.inputSchema), { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>,
      })),
    };
  });

  app.post('/api/plugins/:id/call', async (req): Promise<CallToolResult> => {
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const body = parse(CallInput, req.body);
    const g = engine.plugins.callGrant(id);
    if (!g) throw new ConflictError('这个插件停用了，或者已经删掉了');
    if (!take(id)) throw new HttpError(429, 'too_many_requests', `调用太频繁了（每秒最多 ${CALL_LIMIT.perSecond} 次）`);
    const scopes = effective(g.scopes);
    const tool = toolsFor(id, g.version, scopes).find((t) => t.name === body.name);
    if (!tool) {
      // 插件有这个权限、是这台设备没有（手机上用插件，生效的是两边的交集）：说清楚缺哪一个、去哪里给
      const def = engine.registry.commands().find((d) => commandToolName(d.name) === body.name);
      if (def && g.scopes.includes(def.scope) && !scopes.has(def.scope))
        return failed(`这台设备没有「${SCOPES[def.scope].split(/[，（]/)[0]}」的权限：在电脑上的「设置 → 手机访问」里给这台设备加上`);
      return failed(`这一页不能用「${body.name}」：没有这个工具，或者插件没有它要的权限`);
    }
    const args = z.object(tool.inputSchema).safeParse(body.arguments);
    if (!args.success) {
      const i = args.error.issues[0]!;
      return failed(`「${body.name}」的参数不对：${i.path.join('.') || '参数'} ${i.message}`);
    }
    try {
      const result = await runCall({ actor: pluginActor(id, g.version), grant: scopes }, () => tool.call(args.data));
      if (JSON.stringify(result).length > MAX_RESULT_BYTES)
        return failed(`返回的数据太大（超过 ${MAX_RESULT_BYTES / 1024 / 1024} MB），请分页或者用统计的查询`);
      return result;
    } catch (e) {
      return failed(e instanceof Error ? e.message : String(e));
    }
  });

  app.post('/api/plugins/:id/storage', async (req) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const body = parse(StorageInput, req.body);
    requireOuter('read');
    if (!engine.plugins.callGrant(id)) throw new ConflictError('这个插件停用了，或者已经删掉了');
    const st = engine.plugins.storage;
    if (body.op === 'get') return { value: st.get(id, body.key) ?? null };
    if (body.op === 'list') return { keys: st.keys(id, body.prefix) };
    if (body.op === 'set') st.set(id, body.key, body.value ?? null);
    else st.delete(id, body.key);
    return { ok: true };
  });

  app.post('/api/plugins/:id/errors', async (req) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const body = parse(ErrorInput, req.body);
    requireOuter('read');
    return engine.plugins.recordError(id, body.source, body.message);
  });

  app.get('/api/plugin-web/:id/:key/*', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(80), key: z.string().max(100) }), req.params);
    const rel = String((req.params as { '*': string })['*'] ?? '');
    const file = engine.plugins.webFile(id, rel);
    if (!file) throw new NotFoundError(`插件「${id}」改网页的代码`);
    return sendFile(req, reply, { kind: 'path', filePath: file, contentType: 'text/javascript; charset=utf-8' }, 'no-cache');
  });

  app.get('/api/plugin-media/:token/:size/:imageId', async (req, reply) => {
    const { token, size, imageId } = parse(MediaParams, req.params);
    const g = engine.pluginMedia.check(token);
    if (!g) throw new NotFoundError('图片地址过期了，重新打开这一页');
    const live = engine.plugins.callGrant(g.pluginId);
    if (!live) {
      engine.pluginMedia.revoke(g.pluginId);
      throw new NotFoundError('这个插件停用了');
    }
    // 取图按发令牌时的范围，且插件现在的授权里也还要有 read
    const scopes = new Set([...g.scopes].filter((s) => live.scopes.includes(s)));
    if (!scopes.has('read')) throw new HttpError(403, 'forbidden', '这个插件没有「读图库」的权限');
    const name = size === 'thumb' ? 'images.thumbnail' : 'images.original';
    const w = Number((req.query as { w?: string }).w);
    const input = size === 'thumb' ? { id: imageId, ...(Number.isFinite(w) && w > 0 && { w }) } : { id: imageId };
    const file = await runCall({ actor: pluginActor(g.pluginId, live.version), grant: scopes }, () =>
      engine.registry.query<FileResponse>(name, input),
    );
    return sendFile(req, reply, file, FILE_QUERIES[name]!);
  });

  /**
   * 插件自己文件夹里的图（E5）：插件的服务端下载的缩略图这类（视图的安全策略只放行宿主的地址，外站的图要经插件下到自己的文件夹）。
   * 只给插件的数据目录（<数据目录>/plugins/data/<id>/）里的图片文件，按真实路径查，不能经链接跳出去
   */
  app.get('/api/plugin-media/:token/file/*', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(100) }), req.params);
    const rel = String((req.params as { '*': string })['*'] ?? '');
    const g = engine.pluginMedia.check(token);
    if (!g) throw new NotFoundError('图片地址过期了，重新打开这一页');
    if (!engine.plugins.callGrant(g.pluginId)) {
      engine.pluginMedia.revoke(g.pluginId);
      throw new NotFoundError('这个插件停用了');
    }
    const type = IMAGE_TYPES[path.extname(rel).toLowerCase()];
    if (!type) throw new NotFoundError('插件文件夹里的这个文件');
    let file: string;
    try {
      const dir = realpathSync(engine.plugins.dataDir(g.pluginId));
      file = realpathSync(path.resolve(dir, ...rel.split('/')));
      if (!file.startsWith(dir + path.sep) || !statSync(file).isFile()) throw new Error('outside');
    } catch {
      throw new NotFoundError('插件文件夹里的这个文件');
    }
    return sendFile(req, reply, { kind: 'path', filePath: file, contentType: type }, 'private, max-age=86400');
  });
}

/** 插件文件夹里能给视图的文件：只有图片 */
const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};
