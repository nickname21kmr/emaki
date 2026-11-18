/**
 * 命令 / 查询注册表的完整性（P6，docs/core-architecture.md 第 4.1、9 节，附录 #33、#35）：
 * - 每个 HTTP 写路由都对应注册表里的命令（或者是把参数转成命令的兼容层）；只读的查询可以另有 POST 地址（参数太长时用）；
 * - 每个 MCP 工具都来自注册表（会话工具除外，列在 SESSION_TOOLS）；助手能用的命令按 scope 决定，不能动用户的文件、设置、规则、撤销；
 * - MCP 工具清单和 schema 存一份快照（__snapshots__/mcp-tools.json）：助手的能力不能悄悄扩大，改了要看得见；
 * - 每个命令声明了 scope、是否可撤销、是否支持 operationId，执行函数只有一种（tx 或 run）。
 */
import { ASSISTANT_SCOPES, CONTENT_KINDS, SCOPES, STARTABLE_JOB_KINDS } from '@emaki/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assistantCommands, createLibraryMcp, READ_TOOLS, SESSION_TOOLS, toolName, type ToolHost } from '../../src/assistant/tools.ts';
import { DEFINITIONS } from '../../src/commands/index.ts';
import type { CommandDef } from '../../src/commands/registry.ts';
import { EventBus } from '../../src/core/events.ts';
import { COMPAT_ROUTES } from '../../src/http/compat.ts';
import { buildContractDb } from '../fixtures/contract-db.ts';
import { openDemoEngine, type DemoEngine } from '../helpers/client.ts';
import { makeTmpDir } from '../helpers/tmp.ts';
import { stripComments } from './sqlWrites.ts';

const SRC = path.resolve(import.meta.dirname, '../../src');
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const byName = new Map(DEFINITIONS.map((d) => [d.name, d]));
const commands = DEFINITIONS.filter((d): d is CommandDef => d.kind === 'command');

/** 源码里手写的路由（app.get / app.post …，字面路径） */
function literalRoutes(): { method: string; path: string; file: string }[] {
  const out: { method: string; path: string; file: string }[] = [];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory()
        ? walk(path.join(dir, d.name))
        : d.name.endsWith('.ts') && !d.name.endsWith('.test.ts')
          ? [path.join(dir, d.name)]
          : [],
    );
  for (const f of walk(SRC)) {
    const text = stripComments(readFileSync(f, 'utf8'), f);
    for (const m of text.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g))
      out.push({ method: m[1]!.toUpperCase(), path: m[2]!, file: path.relative(SRC, f) });
  }
  return out;
}

describe('注册表的定义', () => {
  it('名字唯一、按「模块.动作」命名；每个都声明了 scope；命令声明了是否可撤销、是否支持 operationId，执行函数只有一种', () => {
    expect(byName.size).toBe(DEFINITIONS.length);
    for (const d of DEFINITIONS) {
      expect(d.name, d.name).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
      expect(Object.keys(SCOPES), d.name).toContain(d.scope);
      expect(d.summary.length, d.name).toBeGreaterThan(3);
    }
    for (const c of commands) {
      expect(typeof c.undoable, c.name).toBe('boolean');
      expect(typeof c.idempotent, c.name).toBe('boolean');
      expect(!!c.tx !== !!c.run, c.name).toBe(true);
    }
  });

  it('查询都是只读的 scope、设置或设备管理（手机访问的状态）；HTTP 地址不重复', () => {
    const seen = new Set<string>();
    for (const d of DEFINITIONS)
      for (const h of d.http ?? []) {
        const key = `${h.method} ${h.path}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    for (const d of DEFINITIONS.filter((x) => x.kind === 'query')) expect(['read', 'settings', 'devices'], d.name).toContain(d.scope);
  });
});

describe('每个 HTTP 写路由都对应一个命令（附录 #33、#35）', () => {
  it('注册表里的写地址：命令的，或者是只读查询另给的 POST（参数太长时用）', () => {
    for (const d of DEFINITIONS)
      for (const h of d.http ?? []) {
        if (h.method === 'GET') continue;
        if (d.kind === 'command') continue;
        // 只读查询的 POST：一定也有 GET
        expect(
          (d.http ?? []).some((x) => x.method === 'GET'),
          `${h.method} ${h.path} → ${d.name}`,
        ).toBe(true);
      }
  });

  it('源码里手写的写路由：通用入口、兼容层（转成注册表里的命令），或者 AI 助手的会话管理、局域网入口的配对（不是图库操作）', () => {
    const compat = new Set(COMPAT_ROUTES.map((r) => `${r.method} ${r.path}`));
    const writes = literalRoutes().filter((r) => r.method !== 'GET');
    // 配对（access/lan.ts，docs/mobile.md 2.3）：手机还没有凭证时用的协议，只建设备凭证，不碰图库
    const pairing = (r: { path: string; file: string }) => r.file === 'access/lan.ts' && r.path.startsWith('/api/v1/pair');
    const allowed = (r: { method: string; path: string; file: string }) =>
      compat.has(`${r.method} ${r.path}`) || r.path === '/api/commands/:name' || r.path.startsWith('/api/assistant/') || pairing(r);
    const stray = writes.filter((r) => !allowed(r));
    expect(stray).toEqual([]);
    for (const r of COMPAT_ROUTES) for (const c of r.commands) expect(byName.get(c)?.kind, `${r.path} → ${c}`).toBe('command');
    // 兼容层确实都挂上了
    for (const key of compat)
      expect(
        writes.map((r) => `${r.method} ${r.path}`),
        key,
      ).toContain(key);
  });
});

describe('MCP 工具从注册表生成（附录 #35）', () => {
  let demo: DemoEngine;
  let client: Client;
  let tools: { name: string; description?: string; inputSchema: unknown; annotations?: unknown }[];
  const host: ToolHost = {
    assertEnabled() {},
    context: () => null,
    present() {},
    askUser: () => ({ questionId: 'q' }),
    recordMutation() {},
  };

  beforeAll(async () => {
    demo = await openDemoEngine(new EventBus(), {
      dir: makeTmpDir('mcp-registry'),
      memory: true,
      data: buildContractDb(NOW),
      now: NOW,
      clock: () => NOW,
    });
    // 有数据库文件（SQL 工具）、绑定了网页会话（ask_user）：工具最全的情况
    const server = createLibraryMcp(demo.ds.registry, '/tmp/emaki-registry-test.sqlite', host, 'session-1', 'session-1');
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: 'registry-test', version: '1' });
    await client.connect(b);
    tools = (await client.listTools()).tools;
  });
  afterAll(async () => {
    await client?.close();
    await demo?.ds.close();
  });

  it('每个工具都来自注册表：写工具是助手能用的命令，读工具是查询；其余只有会话工具', () => {
    const generated = assistantCommands(demo.ds.registry).map((c) => toolName(c.name));
    expect(tools.map((t) => t.name).sort()).toEqual([...SESSION_TOOLS, ...READ_TOOLS, ...generated].sort());
    for (const c of assistantCommands(demo.ds.registry)) expect(ASSISTANT_SCOPES, c.name).toContain(c.scope);
  });

  it('权限边界：助手不能动用户已有的文件、设置、规则，不能撤销；能读、能归类、编目、合集、导入替换、启动 / 取消任务', () => {
    const names = new Set(tools.map((t) => t.name));
    for (const c of [
      'library.trash',
      'library.move',
      'duplicates.resolve',
      'duplicates.ignore',
      'settings.update',
      'settings.setSourceMode',
      'library.addRoot',
      'library.removeRoot',
      'visibility.createRule',
      'curation.promote',
      'history.undo',
      'history.revertChange',
      'library.reveal',
      'system.pickFolder',
      'catalog.markSeen',
    ])
      expect(names.has(toolName(c)), c).toBe(false);
    for (const c of [
      'curation.link',
      'curation.unlink',
      'curation.setKind',
      'curation.setSource',
      'catalog.createCharacter',
      'catalog.mergeCharacter',
      'collections.create',
      'library.import',
      'library.replace',
      'jobs.start',
      'jobs.cancel',
    ])
      expect(names.has(toolName(c)), c).toBe(true);
    // 被授权的 scope 里没有一个命令落在外面，外面的也没有混进来
    const allowed = commands.filter((c) => ASSISTANT_SCOPES.includes(c.scope)).map((c) => toolName(c.name));
    expect(
      [...names].filter((n) => !(SESSION_TOOLS as readonly string[]).includes(n) && !(READ_TOOLS as readonly string[]).includes(n)).sort(),
    ).toEqual(allowed.sort());
  });

  it('枚举和 schema 自动一致：类型取自 CONTENT_KINDS、任务取自任务种类的注册表，批量动作不再手抄', () => {
    const schema = (name: string) =>
      tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, { enum?: string[] }>; required?: string[] };
    expect(schema('curation_set_kind').properties.value!.enum).toEqual([...CONTENT_KINDS, 'auto']);
    expect(schema('jobs_start').properties.kind!.enum).toEqual(STARTABLE_JOB_KINDS);
    // 以前 update_images 少了的：按标签归类（assignTag）、画师改回自动（artist-auto）现在是同一范围里的命令
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['curation_link', 'curation_reset_artists']));
    expect(schema('curation_link').properties).toHaveProperty('tags');
    // 写工具都要 operationId
    for (const c of assistantCommands(demo.ds.registry)) expect(schema(toolName(c.name)).required, c.name).toContain('operationId');
  });

  it('read_library 只读注册表里 scope 允许的查询（设置读不到），read_media 走查询 images.original', async () => {
    const description = tools.find((t) => t.name === 'read_library')!.description!;
    expect(description).toContain('/api/images/:id');
    expect(description).toContain('/api/jobs');
    expect(description).not.toContain('/api/settings');
    const denied: any = await client.callTool({ name: 'read_library', arguments: { path: '/api/settings' } });
    expect(denied.isError).toBe(true);
  });

  it('工具清单和 schema 的快照：助手的能力变了要看得见（改了就更新快照并在评审里说明）', async () => {
    const snapshot = tools
      .map((t) => {
        const command = assistantCommands(demo.ds.registry).find((c) => toolName(c.name) === t.name);
        return {
          name: t.name,
          ...(command ? { command: command.name, scope: command.scope, undoable: command.undoable } : {}),
          annotations: t.annotations,
          inputSchema: t.inputSchema,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    await expect(JSON.stringify(snapshot, null, 2) + '\n').toMatchFileSnapshot('./__snapshots__/mcp-tools.json');
  });
});
