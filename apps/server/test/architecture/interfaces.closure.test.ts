/**
 * 附录 #33–#36 已关闭（P6 命令 / 查询注册表与对外接口，docs/core-architecture.md 第 4.1、7、9 节）。
 * 跑在真实引擎（演示部件 + 契约夹具）上，经 HTTP（buildApp）、MCP（createLibraryMcp）和 SSE（真的监听一个本机端口）。
 * 注册表本身的完整性（每个写路由对应命令、每个 MCP 工具来自注册表、工具清单的快照）在 registry.test.ts；
 * 命令层的幂等、审计、事务和撤销在 src/commands/registry.test.ts；前端只刷新一遍、助手的修改进撤销栈在 apps/web/src/lib/events.p6.test.ts。
 */
import { JOB_KIND_LIST, JOB_KINDS, JOB_LABEL, STARTABLE_JOB_KINDS, type CommandEvent, type ServerEvent } from '@emaki/shared';
import { StartJobInput } from '@emaki/shared/schemas';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLibraryMcp, type ToolHost } from '../../src/assistant/tools.ts';
import { REPLAY_KEEP } from '../../src/core/events.ts';
import { EventBus } from '../../src/core/events.ts';
import { buildContractDb } from '../fixtures/contract-db.ts';
import { openDemoEngine, type SqliteDataSource } from '../helpers/client.ts';
import type { IdMap } from '../../src/demo/seed.ts';
import { stripComments } from './sqlWrites.ts';

// buildApp 会在 dataDir/assistant 下建目录，换成临时目录，不碰真实的 data/
const dataState = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../src/config.ts', async (importOriginal) => {
  const { mkdtempSync: mk } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join } = await import('node:path');
  const { config } = await importOriginal<typeof import('../../src/config.ts')>();
  dataState.dir = mk(join(tmp(), 'emaki-p6-'));
  return { config: { ...config, dataDir: dataState.dir, libraryDir: dataState.dir, webDist: '/nonexistent' } };
});
const { buildApp } = await import('../../src/app.ts');

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const SRC = path.resolve(import.meta.dirname, '../../src');
const WEB = path.resolve(import.meta.dirname, '../../../web/src');
const prevLogLevel = process.env.EMAKI_LOG_LEVEL;
process.env.EMAKI_LOG_LEVEL = 'silent';
afterAll(() => {
  if (prevLogLevel === undefined) delete process.env.EMAKI_LOG_LEVEL;
  else process.env.EMAKI_LOG_LEVEL = prevLogLevel;
  if (dataState.dir) rmSync(dataState.dir, { recursive: true, force: true, maxRetries: 4 });
});

let app: FastifyInstance;
let ds: SqliteDataSource;
let bus: EventBus;
let map: IdMap;
let events: ServerEvent[];
beforeEach(async () => {
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => void events.push(e));
  ({ ds, map } = await openDemoEngine(bus, { dir: mkdtempSync(path.join(tmpdir(), 'emaki-p6-lib-')), memory: true, data: buildContractDb(NOW), now: NOW, clock: () => NOW, jobStepMs: 1 }));
  app = await buildApp(ds, bus);
});
afterEach(async () => {
  for (const job of await ds.listJobs()) if (job.status === 'queued' || job.status === 'running') await ds.cancelJob(job.id);
  await app.close();
  await ds.close();
});

const img = (f: string) => String(map.images.get(f));
const chr = (f: string) => String(map.characters.get(f));
async function http(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: { host: 'localhost' }, ...(payload === undefined ? (method === 'POST' ? { payload: {} } : {}) : { payload: payload as object }) });
  return { status: res.statusCode, json: res.headers['content-type']?.toString().startsWith('application/json') ? res.json() : undefined, headers: res.headers };
}
/** 最近一条审计记录 */
const lastAudit = async () => (await ds.ask<{ items: { command: string; actor: string; undoToken: string | null }[] }>('audit.list', { limit: 1 })).items[0]!;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? sourceFiles(path.join(dir, d.name)) : /\.tsx?$/.test(d.name) && !/\.test\./.test(d.name) ? [path.join(dir, d.name)] : [],
  );
}

describe('附录 #33：一件事一个命令', () => {
  it('图 ↔ 角色的几条路（整组替换、批量归类、按标签归类、采纳建议、批量移出）都是 curation.link / unlink / replace', async () => {
    const cases: [string, () => Promise<{ status: number }>][] = [
      ['curation.replace', () => http('PATCH', `/api/images/${img('i3')}`, { characterIds: [chr('c1')] })],
      ['curation.link', () => http('POST', '/api/images/bulk', { ids: [img('i4')], action: { type: 'assign', characterId: chr('c2') } })],
      ['curation.unlink', () => http('POST', '/api/images/bulk', { ids: [img('i4')], action: { type: 'unassign', characterId: chr('c2') } })],
    ];
    for (const [command, run] of cases) {
      expect((await run()).status, command).toBe(200);
      expect((await lastAudit()).command, command).toBe(command);
    }
    // 采纳建议：未识别里有建议的一张
    const pending = (await http('GET', '/api/unrecognized?area=art&bucket=suggested&limit=1')).json.items[0];
    const tag = pending.suggestions[0].danbooruTag as string;
    expect((await http('POST', `/api/unrecognized/${pending.image.id}/accept`, { danbooruTag: tag })).status).toBe(200);
    expect((await lastAudit()).command).toBe('curation.link');
    // 按标签批量归类：和采纳是同一个命令（找不到角色时按建议建档）
    expect((await http('POST', '/api/images/bulk', { ids: [img('i5')], action: { type: 'assignTag', danbooruTag: tag } })).status).toBe(200);
    expect((await lastAudit()).command).toBe('curation.link');
  });

  it('收藏、分级、类型：单张（PATCH）和批量是同一个命令，审计里同一个名字', async () => {
    for (const [field, value, command] of [
      ['favorite', true, 'curation.setFavorite'],
      ['rating', 'sensitive', 'curation.setRating'],
      ['kind', 'photo', 'curation.setKind'],
    ] as const) {
      await http('PATCH', `/api/images/${img('i6')}`, { [field]: value });
      const single = (await lastAudit()).command;
      await http('POST', '/api/images/bulk', { ids: [img('i6'), img('i7')], action: { type: field, value } });
      expect([single, (await lastAudit()).command]).toEqual([command, command]);
    }
    // PATCH 一次改好几项：几个命令一个事务、一个令牌
    const both = await http('PATCH', `/api/images/${img('i8')}`, { favorite: true, rating: 'explicit' });
    expect((await lastAudit()).command).toBe('curation.setRating+curation.setFavorite');
    expect((await http('POST', `/api/undo/${both.json.undoToken}`)).status).toBe(200);
    expect((await http('GET', `/api/images/${img('i8')}`)).json).toMatchObject({ favorite: false });
  });

  it('旧的 HTTP 地址只是把参数转成命令：兼容层不碰领域模块和引擎内部', () => {
    for (const f of ['http/compat.ts', 'http/routes.ts']) {
      const text = stripComments(readFileSync(path.join(SRC, f), 'utf8'), f);
      expect(text, f).not.toMatch(/from '\.\.\/(domain|datasource)\//);
    }
  });

  it('撤销屏障来自注册表：不可撤销的命令（改设置、启动任务）响应头里说是 barrier；前端不再在 entryOf 里自己猜', async () => {
    expect((await http('PATCH', '/api/settings', { ui: { theme: 'dark' } })).headers['x-emaki-undo']).toBe('barrier');
    expect((await http('POST', '/api/jobs', { kind: 'dedupe' })).headers['x-emaki-undo']).toBe('barrier');
    expect((await http('POST', '/api/images/bulk', { ids: [img('i9')], action: { type: 'favorite', value: true } })).headers['x-emaki-undo']).toBe('token');
    const entryOf = readFileSync(path.join(WEB, 'lib/queries.ts'), 'utf8');
    expect(entryOf).toMatch(/meta\.undo === 'barrier'/);
  });
});

describe('附录 #34：任务种类登记在一处', () => {
  it('名称、通道、优先级、能否取消、能否手动启动都在 JOB_KINDS；服务端、网页没有别的按任务种类的表格', () => {
    expect(JOB_KIND_LIST.every((k) => JOB_KINDS[k].label === JOB_LABEL[k])).toBe(true);
    expect(StartJobInput.shape.kind.options).toEqual(STARTABLE_JOB_KINDS);
    // 以前散在约 8 处的 Record<JobKind, …>：现在只剩演示的假任务量（演示部件自己的）和网页的图标（组件不能放进 shared）
    const tables = [...sourceFiles(SRC).map((f) => ['server', f] as const), ...sourceFiles(WEB).map((f) => ['web', f] as const)].flatMap(([side, f]) =>
      // 手写的表格（Record<JobKind, …> = { … }）；从注册表推出来的（Object.fromEntries(JOB_KIND_LIST…)）不算
      /Record<\s*(JobKind|Job\['kind'\])\s*,[^>]*>\s*=\s*\{/.test(readFileSync(f, 'utf8')) ? [`${side}:${path.relative(side === 'server' ? SRC : WEB, f)}`] : [],
    );
    expect(tables.sort()).toEqual(['server:demo/ports.ts', 'web:features/settings/jobMeta.ts']);
  });

  it('后台任务写库也记 actor：审计记录里有 job:<任务>', async () => {
    await http('POST', '/api/jobs', { kind: 'dedupe' });
    await vi.waitFor(async () => expect((await ds.ask<{ items: { actor: string }[] }>('audit.list', { actor: 'job:dedupe' })).items.length).toBeGreaterThan(0), { timeout: 5000 });
  });
});

describe('附录 #35：MCP 从注册表来、记 actor、助手的修改进网页的撤销栈', () => {
  async function mcp() {
    const host: ToolHost = { assertEnabled() {}, context: () => null, present() {}, askUser: () => ({ questionId: 'q' }), recordMutation() {} };
    const server = createLibraryMcp(ds.registry, null, host, 'session-1', 'session-1');
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'p6', version: '1' });
    await client.connect(b);
    return client;
  }

  it('read_media、任务列表不再绕过：都是注册表里的查询（actor 是 assistant）', async () => {
    const client = await mcp();
    const query = vi.spyOn(ds.registry, 'query');
    try {
      const jobs: any = await client.callTool({ name: 'read_library', arguments: { path: '/api/jobs' } });
      expect(jobs.isError).not.toBe(true);
      const media: any = await client.callTool({ name: 'read_media', arguments: { imageId: img('i1') } });
      expect(media.content[0].type).toBe('image');
      expect(query.mock.calls.map((c) => [c[0], c[2]])).toEqual([
        ['jobs.list', { actor: 'assistant' }],
        ['images.original', { actor: 'assistant' }],
      ]);
    } finally {
      query.mockRestore();
      await client.close();
    }
  });

  it('每次写入都记 actor：网页是 user，助手是 assistant；审计记录里查得到', async () => {
    await http('POST', '/api/images/bulk', { ids: [img('i3')], action: { type: 'shelve', value: true } });
    expect(await lastAudit()).toMatchObject({ command: 'curation.setShelved', actor: 'user' });
    const client = await mcp();
    try {
      await client.callTool({ name: 'curation_set_shelved', arguments: { operationId: 'shelve-1', ids: [img('i3')], value: false } });
      expect(await lastAudit()).toMatchObject({ command: 'curation.setShelved', actor: 'assistant' });
      const byAssistant = (await http('GET', '/api/audit?actor=assistant')).json.items;
      expect(byAssistant.map((r: { command: string }) => r.command)).toEqual(['curation.setShelved']);
    } finally {
      await client.close();
    }
  });

  it('助手做的、可撤销的修改：推 command 事件（令牌、这次启动的 id），网页放进撤销栈后用普通的撤销接口撤得掉', async () => {
    const client = await mcp();
    try {
      events.length = 0;
      const res: any = await client.callTool({ name: 'curation_set_favorite', arguments: { operationId: 'fav-1', ids: [img('i10')], value: true } });
      const { undoToken } = JSON.parse(res.content[0].text);
      const command = events.find((e): e is CommandEvent => e.type === 'command');
      expect(command).toMatchObject({ name: 'curation.setFavorite', actor: 'assistant', undoToken, undo: 'token', boot: bus.boot, imageIds: [img('i10')] });
      // 健康检查里的 bootId 就是事件里的 boot：前端按它认领
      expect((await http('GET', '/api/health')).json.bootId).toBe(command!.boot);
      expect((await http('GET', `/api/images/${img('i10')}`)).json.favorite).toBe(true);
      expect((await http('POST', `/api/undo/${undoToken}`)).status).toBe(200);
      expect((await http('GET', `/api/images/${img('i10')}`)).json.favorite).toBe(false);
    } finally {
      await client.close();
    }
  });
});

describe('附录 #36：带类型、带 id 的事件，断线重连补发', () => {
  it('一次用户操作只推一条 changed（带变化类型、命令名），不再是「全部刷新」的 library-changed', async () => {
    events.length = 0;
    await http('POST', '/api/images/bulk', { ids: [img('i3')], action: { type: 'rating', value: 'general' } });
    const changed = events.filter((e) => e.type === 'changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ reason: 'mutation', actor: 'user', command: 'curation.setRating', changes: ['curation.ratingChanged'] });
    expect(events.some((e) => (e as { type: string }).type === 'library-changed')).toBe(false);
  });

  /** 连 SSE，读到 until 为止；返回读到的事件（带 SSE 的 id） */
  async function sse(base: string, until: (events: { id?: string; data: ServerEvent }[]) => boolean, headers: Record<string, string> = {}, query = '') {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events${query}`, { signal: ac.signal, headers });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const parse = () =>
      text
        .split('\n\n')
        .filter((b) => b.includes('data: '))
        .map((b) => ({ id: /^id: (.+)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(b)![1]!) as ServerEvent }));
    try {
      while (!until(parse())) text += decoder.decode((await reader.read()).value);
      return parse();
    } finally {
      ac.abort();
    }
  }

  it('SSE 的事件带 id；断开期间的事件按 Last-Event-ID 补发；后端重启过、漏得比保留的多时推 resync', async () => {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const hello = (es: { data: ServerEvent }[]) => es.some((e) => e.data.type === 'hello');
    // 连上：先推一条 hello（这次启动的 id、现在最后一条的 id），SSE 的 id 行跟着它
    const first = await sse(base, hello);
    const h = first.find((e) => e.data.type === 'hello')!;
    expect(h.id).toBe(`${bus.boot}.${bus.lastId}`);
    // 断开期间做两次修改
    await http('POST', '/api/images/bulk', { ids: [img('i3')], action: { type: 'favorite', value: true } });
    await http('POST', '/api/images/bulk', { ids: [img('i4')], action: { type: 'favorite', value: true } });
    // 带着断开前的 id 重连：补发漏掉的（changed、command 各两条），再推 hello
    const replayed = await sse(base, hello, { 'last-event-id': h.id! });
    const kinds = replayed.map((e) => e.data.type);
    expect(kinds.filter((k) => k === 'changed')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'command')).toHaveLength(2);
    expect(kinds.at(-1)).toBe('hello');
    expect(replayed.filter((e) => e.data.type !== 'hello').every((e) => e.id === `${bus.boot}.${(e.data as { id: number }).id}`)).toBe(true);
    // 手动重建连接时（代理回 502 之后前端自己重建 EventSource）id 放在查询串里，同样补发
    const viaQuery = await sse(base, hello, {}, `?lastEventId=${encodeURIComponent(h.id!)}`);
    expect(viaQuery.filter((e) => e.data.type === 'changed')).toHaveLength(2);
    // 没带 id 的新连接：不补发
    expect((await sse(base, hello)).some((e) => e.data.type === 'changed')).toBe(false);
    // 另一次启动的 id：补不上，resync
    const restarted = await sse(base, hello, { 'last-event-id': 'some-other-boot.3' });
    expect(restarted[0]!.data).toEqual({ type: 'resync', reason: 'restarted' });
    // 漏得比保留的还多：resync
    for (let i = 0; i <= REPLAY_KEEP; i++) bus.publish({ type: 'changed', changes: [], reason: 'scan', actor: 'job:scan' });
    const gap = await sse(base, hello, { 'last-event-id': h.id! });
    expect(gap[0]!.data).toEqual({ type: 'resync', reason: 'gap' });
  });
});
