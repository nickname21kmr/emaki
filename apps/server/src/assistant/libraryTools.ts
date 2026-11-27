/**
 * 图库的工具（docs/core-architecture.md 第 9 节，docs/plugins.md 第 5 节）：AI 助手的 MCP 服务器（tools.ts）和插件视图的桥接
 * （http/pluginViews.ts）用的是同一份，名字、参数、说明都一样，只是按范围过滤、记成不同的 actor。
 *
 * 都从命令 / 查询注册表生成，不手抄 schema 和枚举：
 * - 写：范围里的每个命令一个工具，名字是命令名换成下划线（curation.link → curation_link），参数就是命令的 schema 加 operationId；
 * - 读：read_library 按地址读注册表里的查询（和网页同一个口径），read_media 读查询 images.original 再缩放、裁剪。
 * 这个文件不加载 MCP SDK（只用类型），插件视图的桥接在启动时就能用。
 */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { ASSISTANT_SCOPES, commandToolName, type ImportImagesResult, type Scope } from '@emaki/shared';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { openSharp } from '../services/image/pixels.ts';
import type { CommandDef, QueryDef, Registry } from '../commands/registry.ts';
import type { FileResponse } from '../infra/ports.ts';
import type { Actor } from '../propagation/actor.ts';

/** 不来自注册表的工具：助手自己的会话工具（不是图库操作），以及按地址读查询、看图这两个读工具 */
export const SESSION_TOOLS = ['describe_database', 'query_database', 'get_page_context', 'ask_user', 'present_result'] as const;
export const READ_TOOLS = ['read_library', 'read_media'] as const;

export const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

/** 命令名 → 工具名：curation.setFavorite → curation_set_favorite（@emaki/shared，插件视图的库也用） */
export const toolName = commandToolName;

/** 手写成工具的命令（不按通用的方式生成）：AI 做页面要在对话里出卡片 */
const CUSTOM_TOOL_COMMANDS = new Set(['plugins.saveView']);

/** 助手能用的命令（按 scope），按名字排好 */
export function assistantCommands(registry: Registry, scopes: ReadonlySet<Scope> = new Set(ASSISTANT_SCOPES)): CommandDef[] {
  return registry
    .commands()
    .filter((d) => scopes.has(d.scope) && !CUSTOM_TOOL_COMMANDS.has(d.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** read_library 能读的查询：scope 在范围里、有 GET 地址、不是文件（看图用 read_media） */
export function readableQueries(
  registry: Registry,
  scopes: ReadonlySet<Scope> = new Set(ASSISTANT_SCOPES),
): { def: QueryDef; path: string; pattern: RegExp; params: string[] }[] {
  return registry
    .queries()
    .filter(
      (d) =>
        scopes.has(d.scope) &&
        d.name !== 'images.thumbnail' &&
        d.name !== 'images.original' &&
        d.name !== 'pose.figure' &&
        d.name !== 'pose.posewearFile',
    )
    .flatMap((def) =>
      (def.http ?? [])
        .filter((h) => h.method === 'GET')
        .map((h) => {
          const params: string[] = [];
          const pattern = new RegExp(`^${h.path.replace(/:(\w+)/g, (_m, p: string) => (params.push(p), '([^/]+)'))}$`);
          return { def, path: h.path, pattern, params };
        }),
    );
}

/** 命令的参数：对象 schema 直接展开加上 operationId；别的（判别联合）放在 input 里 */
export function toolInput(def: CommandDef): { shape: Record<string, z.ZodType>; wrapped: boolean } {
  const operationId = z.string().min(1).max(100).describe('本次操作的唯一标识，重试使用同一个值');
  const input = def.input as unknown as { shape?: Record<string, z.ZodType> };
  if (input.shape) return { shape: { operationId, ...input.shape }, wrapped: false };
  return { shape: { operationId, input: def.input as z.ZodType }, wrapped: true };
}

/** app.inject 按 WHATWG URL 解析：\ 当作 /，.. 和 %2e 会被消掉。所以按解析后的结果判断，且解析不能改写路径 */
export function parseReadPath(path: string): URL {
  const url = URL.canParse(path, 'http://localhost') ? new URL(path, 'http://localhost') : null;
  if (!url || url.origin !== 'http://localhost' || url.hash || url.pathname !== path.split(/[?#]/)[0]) throw new Error('不支持的读取路径');
  return url;
}

/** file 为 null 表示引擎用的是内存库（测试），没有文件可读，不提供 SQL 工具 */

// ---------------------------------------------------------------- 图库的工具（MCP 和插件视图共用）

/** 一个工具：名字、说明、参数（zod 的形状）和执行。MCP 服务器按它注册；插件视图的桥接按它列出、调用（http/pluginViews.ts） */
export interface LibraryTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  annotations: ToolAnnotations;
  call(args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface LibraryToolOptions {
  /** 记成谁做的：助手、plugin:<id>@<版本> */
  actor: Actor;
  /** operationId 的命名空间（同一个 operationId 在不同调用方之间不冲突） */
  namespace: string;
  /** 能用的范围：读的查询、写的命令都按它过滤（插件是授权 ∩ 入口） */
  scopes: ReadonlySet<Scope>;
  /** 每次调用前检查（助手关了就拒绝） */
  check?: () => void;
  /** 可撤销的修改做完了（助手记进会话的撤销记录） */
  onMutation?: (result: unknown) => void;
}

/** 图库的工具：read_library、read_media，加上范围里每个命令一个（名字是命令名换成下划线，curation.link → curation_link） */
export function libraryTools(registry: Registry, o: LibraryToolOptions): LibraryTool[] {
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  const { actor } = o;
  const check = () => o.check?.();
  const tools: LibraryTool[] = [];

  // ---------------------------------------------------------------- 读：注册表里的查询
  const readable = readableQueries(registry, o.scopes);
  if (readable.length)
    tools.push({
      name: 'read_library',
      description:
        '按应用现有口径读取图库（注册表里的查询，和网页同一个口径）。path 是下面的地址之一，可附查询参数：' +
        readable.map((r) => `${r.path}（${r.def.summary}）`).join('；') +
        '。角色归入搜索可用 /api/search?forAssignment=true&q=角色名。界面上显示的数（待处理数、已认出比例、别册张数等）读 /api/summary。' +
        '图片的状态是三个事实：tagged（这份文件识别过没有）、characterCount（角色数）、queue（art 未识别「插画 · 漫画」、shelved 放下的、annex「照片 · 文字等」、book 在整本处理的合集里、null 不在），另有 excluded。',
      inputSchema: { path: z.string().max(4000) },
      annotations: read,
      async call(args) {
        check();
        const url = parseReadPath(String(args.path ?? ''));
        for (const r of readable) {
          const m = r.pattern.exec(url.pathname);
          if (!m) continue;
          const input: Record<string, unknown> = Object.fromEntries(url.searchParams);
          r.params.forEach((p, i) => (input[p] = decodeURIComponent(m[i + 1]!)));
          return json(await registry.query(r.def.name, input, { actor }));
        }
        throw new Error('不支持的读取路径');
      },
    });
  if (o.scopes.has('read'))
    tools.push({
      name: 'read_media',
      description:
        '实际查看图库图片（查询 images.original）。按需使用，可指定原图的像素裁剪区域检查局部。输出缩放到最多 1600px（给了 size 就是 size）。',
      inputSchema: {
        imageId: z.string().min(1),
        crop: z
          .object({
            left: z.number().int().nonnegative(),
            top: z.number().int().nonnegative(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .optional(),
        size: z.number().int().min(64).max(1600).optional().describe('长边缩到多少像素（缩略图用 240～480）'),
      },
      annotations: read,
      async call(args) {
        check();
        const { imageId, crop, size } = args as {
          imageId: string;
          crop?: { left: number; top: number; width: number; height: number };
          size?: number;
        };
        const file = await registry.query<FileResponse>('images.original', { id: imageId }, { actor });
        // 和缩略图同一套解码：容忍 pixiv 常见的坏 JPEG，BMP 走自带解码器
        const bmp = file.contentType === 'image/bmp';
        const input = file.kind === 'buffer' ? Buffer.from(file.body) : bmp ? await readFile(file.filePath) : file.filePath;
        let pipeline = openSharp(input, bmp ? 'bmp' : 'jpeg');
        if (crop) pipeline = pipeline.extract(crop);
        const edge = size ?? 1600;
        const bytes = await pipeline
          .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
        return { content: [{ type: 'image' as const, mimeType: 'image/jpeg', data: bytes.toString('base64') }] };
      },
    });

  // ---------------------------------------------------------------- 写：注册表里范围内的命令
  for (const def of assistantCommands(registry, o.scopes)) {
    const { shape, wrapped } = toolInput(def);
    const notes = [
      def.mcp?.description,
      def.undoable ? '可撤销，返回撤销 token（也会出现在网页的撤销栈里）' : '不可撤销',
      'operationId 是本次操作的唯一标识，重试复用同一个值',
    ];
    tools.push({
      name: toolName(def.name),
      description: `${def.summary}。${notes.filter(Boolean).join('；')}。`,
      inputSchema: shape,
      annotations: { readOnlyHint: false, destructiveHint: !!def.mcp?.destructive, idempotentHint: true },
      async call(args) {
        check();
        const { operationId, ...rest } = args;
        const input = wrapped ? rest.input : rest;
        const result = await registry.execute<Record<string, unknown>>(def.name, input, {
          actor,
          operationId: String(operationId),
          namespace: o.namespace,
        });
        if (result && typeof result === 'object' && result.undoToken) o.onMutation?.(result);
        // 新增入库：全部失败（重名要确认的不算）时标成出错
        const items = (result as Partial<ImportImagesResult>).items;
        const failed = def.name === 'library.import' && items?.every((i) => i.status === 'failed' && i.code !== 'needs_confirm');
        return { ...json(result), ...(failed ? { isError: true } : {}) };
      },
    });
  }
  return tools;
}
