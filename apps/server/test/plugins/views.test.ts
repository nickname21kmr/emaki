/**
 * 视图（docs/plugins.md 第 5 节、E4）：带页面的插件、视图的桥接（打开、调工具、权限取交集、记成插件、限频、取图）、
 * AI 助手做的页面（保存就是授权、改了直接存新的一版、权限上限），以及同一页在 MCP 里（在 Claude 里打开）。
 */
import type { PluginsState, PluginView } from '@emaki/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLibraryMcp, viewToolName, type ToolHost } from '../../src/assistant/tools.ts';
import { forMcp, MCP_APP_MIME } from '../../src/assistant/views.ts';
import { EventBus } from '../../src/core/events.ts';
import { toApiError } from '../../src/http/errors.ts';
import { CALL_LIMIT, pluginViewRoutes } from '../../src/http/pluginViews.ts';
import { runAsDevice } from '../../src/propagation/actor.ts';
import { buildContractDb } from '../fixtures/contract-db.ts';
import { openDemoEngine, type DemoEngine } from '../helpers/client.ts';
import { makeTmpDir } from '../helpers/tmp.ts';
import { makeZip } from '../helpers/zip.ts';

process.env.EMAKI_LOG_LEVEL = 'silent';

const NOW = Date.parse('2026-11-25T08:00:00Z');
let now = NOW;
let demo: DemoEngine;
let app: FastifyInstance;
/** 局域网入口上这台设备的范围（null：本机入口，不限） */
let device: string[] | null = null;

beforeEach(async () => {
  now = NOW;
  device = null;
  demo = await openDemoEngine(new EventBus(), {
    dir: makeTmpDir('plugin-views'),
    memory: true,
    data: buildContractDb(NOW),
    now: NOW,
    clock: () => now,
  });
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const { statusCode, body } = toApiError(err);
    void reply.status(statusCode).send(body);
  });
  app.addHook('onRequest', (_req, _reply, done) => (device ? runAsDevice('d1', device as never, done) : done()));
  pluginViewRoutes(app, demo.ds);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await demo.ds.close();
});

const ds = () => demo.ds;
const run = <T = { message: string; undoToken?: string }>(name: string, input: unknown = {}) => {
  now += 1000;
  return ds().registry.execute<T>(name, input);
};
const state = () => ds().registry.query<PluginsState>('plugins.state', {});
const plugin = async (id: string) => (await state()).plugins.find((p) => p.id === id);

const VIEW = {
  id: 'example.stats',
  name: '统计',
  version: '0.1.0',
  permissions: { scopes: ['read', 'curate'] },
  contributes: {
    'page@1': [{ id: 'main', view: 'views/index.html', title: '收藏统计' }],
    'nav.item@1': [{ id: 'main', label: '统计', page: 'main', icon: 'chart' }],
  },
};
const HTML = '<!doctype html><script src="/plugin-sdk/app.js"></script><p>stats</p>';

async function installView(manifest: object = VIEW, files: Record<string, string> = { 'views/index.html': HTML }) {
  const pkg = ds().plugins.inspectZip('stats.zip', makeZip({ 'emaki-plugin.json': JSON.stringify(manifest), ...files }));
  return { pkg, r: await run<{ id: string; message: string; undoToken: string }>('plugins.install', { token: pkg.token }) };
}
const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, json: res.statusCode < 300 && res.headers['content-type']?.includes('json') ? res.json() : null };
};
const call = async (id: string, name: string, args: object = {}) => {
  now += 10;
  const res = await app.inject({ method: 'POST', url: `/api/plugins/${id}/call`, payload: { name, arguments: args } });
  return { status: res.statusCode, json: res.json() as { isError?: boolean; content: { type: string; text: string }[] } };
};

describe('带页面的插件', () => {
  it('page@1 是包里的 HTML；导航项写 page，宿主填成 /p/<插件>/<页面>', async () => {
    const { pkg } = await installView();
    expect(pkg).toMatchObject({ problems: [], added: { scopes: ['read', 'curate'] } });
    const p = (await plugin('example.stats'))!;
    expect(p).toMatchObject({
      enabled: true,
      kinds: ['page'],
      contributes: { 'page@1': [{ id: 'main', view: 'views/index.html', title: '收藏统计' }] },
    });
    const nav = (await state()).nav.main.find((n) => n.id === 'example.stats/main');
    expect(nav).toMatchObject({ label: '统计', to: '/p/example.stats/main', icon: 'chart', visible: true });
  });

  it('装不上的：视图文件不在包里、路径往上跳、导航指向没有的页面', () => {
    const problems = (manifest: object, files: Record<string, string> = {}) =>
      ds().plugins.inspectZip('x.zip', makeZip({ 'emaki-plugin.json': JSON.stringify(manifest), ...files })).problems;
    expect(problems(VIEW)).toEqual(['页面「收藏统计」的视图文件 views/index.html 不在包里']);
    expect(problems({ ...VIEW, contributes: { 'page@1': [{ id: 'main', view: '../x.html' }] } })).toEqual([
      expect.stringMatching(/包里的 HTML 文件/),
    ]);
    expect(
      problems(
        { ...VIEW, contributes: { 'page@1': [{ id: 'main', view: 'a.html' }], 'nav.item@1': [{ id: 'n', label: 'x', page: 'other' }] } },
        { 'a.html': 'x' },
      ),
    ).toEqual(['导航项「x」指向的页面「other」在 page@1 里没有']);
    expect(problems({ ...VIEW, contributes: { 'nav.item@1': [{ id: 'n', label: 'x', to: '/gallery', page: 'main' }] } })).toEqual([
      expect.stringMatching(/to 和 page 要写一个/),
    ]);
  });
});

describe('视图的桥接', () => {
  it('打开：HTML、标题（改了名跟着变）、能调的工具（按授权）、图片地址的前缀', async () => {
    await installView();
    const v = (await get('/api/plugins/example.stats/pages/main')).json as PluginView;
    expect(v).toMatchObject({ pluginId: 'example.stats', pageId: 'main', version: '0.1.0', title: '收藏统计', html: HTML });
    expect(v.mediaBase).toMatch(/^\/api\/plugin-media\/[\w-]+$/);
    const names = v.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['read_library', 'read_media', 'curation_set_favorite', 'curation_link']));
    expect(names).not.toContain('catalog_create_character');
    expect(names).not.toContain('plugins_set_enabled');
    expect(v.tools.find((t) => t.name === 'curation_set_favorite')!.inputSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['operationId', 'ids']),
    });
    await run('plugins.rename', { id: 'example.stats', name: '我的统计' });
    expect((await get('/api/plugins/example.stats/pages/main')).json.title).toBe('我的统计');
  });

  it('调工具：读图库、改收藏（记成 plugin:<id>@<版本>，能撤销）；没授权的工具、参数不对写成出错', async () => {
    await installView();
    const summary = await call('example.stats', 'read_library', { path: '/api/summary' });
    expect(summary.json.isError).toBeUndefined();
    expect(JSON.parse(summary.json.content[0]!.text)).toHaveProperty('images');

    const images = JSON.parse((await call('example.stats', 'read_library', { path: '/api/images?limit=1' })).json.content[0]!.text)
      .items as { id: string }[];
    const fav = await call('example.stats', 'curation_set_favorite', { operationId: 'op-1', ids: [images[0]!.id], value: true });
    expect(fav.json.isError).toBeUndefined();
    const result = JSON.parse(fav.json.content[0]!.text);
    expect(result.undoToken).toEqual(expect.any(String));
    const actor = ds()
      .ctx.db.prepare("SELECT actor FROM command_log WHERE command = 'curation.setFavorite' ORDER BY id DESC LIMIT 1")
      .pluck()
      .get();
    expect(actor).toBe('plugin:example.stats@0.1.0');

    expect((await call('example.stats', 'catalog_create_character', { operationId: 'x', name: 'x' })).json).toMatchObject({
      isError: true,
    });
    expect((await call('example.stats', 'curation_set_favorite', { ids: 'nope' })).json).toMatchObject({
      isError: true,
      content: [{ text: expect.stringMatching(/参数不对/) }],
    });
    expect((await call('example.stats', 'read_library', { path: '/api/nope' })).json).toMatchObject({ isError: true });
  });

  it('权限取交集：局域网上的设备没有 curate，视图也改不了；设备没有 read 打不开', async () => {
    await installView();
    device = ['read'];
    const v = (await get('/api/plugins/example.stats/pages/main')).json as PluginView;
    expect(v.tools.map((t) => t.name)).toEqual(['read_library', 'read_media']);
    expect((await call('example.stats', 'curation_set_favorite', { operationId: 'x', ids: ['1'], value: true })).json).toMatchObject({
      isError: true,
    });
    device = ['curate'];
    expect((await get('/api/plugins/example.stats/pages/main')).status).toBe(403);
  });

  it('停用了：打不开、调不了，图片地址也不认了', async () => {
    await installView();
    const { mediaBase } = (await get('/api/plugins/example.stats/pages/main')).json as PluginView;
    const images = JSON.parse((await call('example.stats', 'read_library', { path: '/api/images?limit=1' })).json.content[0]!.text)
      .items as { id: string }[];
    expect((await app.inject({ method: 'GET', url: `${mediaBase}/thumb/${images[0]!.id}` })).statusCode).toBe(200);
    await run('plugins.setEnabled', { id: 'example.stats', enabled: false });
    expect((await get('/api/plugins/example.stats/pages/main')).status).toBe(409);
    expect((await call('example.stats', 'read_library', { path: '/api/summary' })).status).toBe(409);
    expect((await app.inject({ method: 'GET', url: `${mediaBase}/thumb/${images[0]!.id}` })).statusCode).toBe(404);
  });

  it('图片的令牌：没有 read 的插件没有前缀；过期作废', async () => {
    await installView({ ...VIEW, id: 'example.noread', permissions: { scopes: ['curate'] } });
    expect((await get('/api/plugins/example.noread/pages/main')).json.mediaBase).toBeNull();
    await installView();
    const { mediaBase } = (await get('/api/plugins/example.stats/pages/main')).json as PluginView;
    now += 13 * 3600_000;
    expect((await app.inject({ method: 'GET', url: `${mediaBase}/thumb/1` })).statusCode).toBe(404);
  });

  it('限频：一下子太多次 429', async () => {
    await installView();
    const statuses: number[] = [];
    for (let i = 0; i < CALL_LIMIT.burst + 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins/example.stats/call',
        payload: { name: 'read_library', arguments: { path: '/api/summary' } },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('视图坏了记一次错，多次自动停用', async () => {
    await installView();
    for (let i = 0; i < 5; i++)
      await app.inject({ method: 'POST', url: '/api/plugins/example.stats/errors', payload: { message: '自己跳走了' } });
    expect(await plugin('example.stats')).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/自动停用/) });
  });
});

describe('AI 助手做的页面', () => {
  const save = (extra: object = {}) =>
    run<{ status: string; id: string; token?: string; version: string }>('plugins.saveView', {
      name: 'fav-stats',
      title: '收藏统计',
      html: '<p>v1</p>',
      ...extra,
    });

  it('第一次保存要你确认（授权单）；确认时可以不放进侧栏；算「我的」', async () => {
    const r = await save();
    expect(r).toMatchObject({ status: 'needs_confirmation', id: 'ai.fav-stats', version: '1.0.0', token: expect.any(String) });
    expect(await plugin('ai.fav-stats')).toBeUndefined();
    const pkg = ds().plugins.stagedPackage(r.token!);
    expect(pkg).toMatchObject({ source: { kind: 'ai', location: 'AI 助手' }, added: { scopes: ['read'] }, problems: [] });
    expect(pkg.manifest).toMatchObject({
      id: 'ai.fav-stats',
      author: 'AI 助手',
      contributes: { 'nav.item@1': [{ page: 'main', icon: 'chart' }] },
    });

    expect(await run('plugins.install', { token: r.token, showInNav: false })).toMatchObject({ message: '已保存「收藏统计」' });
    const p = (await plugin('ai.fav-stats'))!;
    expect(p).toMatchObject({ source: 'mine', enabled: true, installed: { kind: 'ai' }, grant: { scopes: ['read'] } });
    expect((await state()).nav.main.find((n) => n.id === 'ai.fav-stats/main')).toMatchObject({
      visible: false,
      to: '/p/ai.fav-stats/main',
    });
    expect((await get('/api/plugins/ai.fav-stats/pages/main')).json.html).toBe('<p>v1</p>');
  });

  it('修改：权限没变直接存成新的一版（能撤销）；多要了权限再出授权单，只列新的', async () => {
    await run('plugins.install', { token: (await save()).token });
    const v2 = await save({ html: '<p>v2</p>' });
    expect(v2).toMatchObject({ status: 'saved', version: '2.0.0' });
    expect((await get('/api/plugins/ai.fav-stats/pages/main')).json).toMatchObject({ version: '2.0.0', html: '<p>v2</p>' });
    await ds().registry.execute('history.undo', { token: (v2 as unknown as { undoToken: string }).undoToken });
    expect((await get('/api/plugins/ai.fav-stats/pages/main')).json).toMatchObject({ version: '1.0.0', html: '<p>v1</p>' });

    const more = await save({ scopes: ['read', 'curate'] });
    expect(more).toMatchObject({ status: 'needs_confirmation', version: '2.0.0' });
    expect(ds().plugins.stagedPackage(more.token!)).toMatchObject({ added: { scopes: ['curate'] }, current: { version: '1.0.0' } });
  });

  it('权限不超过助手自己的；不能冒用别的插件的 id', async () => {
    await expect(save({ scopes: ['settings'] })).rejects.toThrow(/不能要「图库设置/);
    await expect(save({ scopes: ['plugins'] })).rejects.toThrow(/不能要/);
    expect(
      ds().plugins.inspectZip(
        'x.zip',
        makeZip({ 'emaki-plugin.json': JSON.stringify({ ...VIEW, id: 'ai.fake' }), 'views/index.html': 'x' }),
      ).problems,
    ).toEqual([expect.stringMatching(/留给 Emaki 自己/)]);
  });
});

describe('在 Claude 里打开（MCP Apps）', () => {
  const host: ToolHost = {
    assertEnabled() {},
    context: () => null,
    present() {},
    askUser: () => ({ questionId: 'q' }),
    recordMutation() {},
  };
  async function mcp() {
    const server = createLibraryMcp(ds().registry, null, host, 'external', undefined, {
      plugins: ds().plugins,
      sdk: () => 'window.Emaki={}; // </script>',
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'views-test', version: '1' });
    await client.connect(b);
    return client;
  }

  it('启用着的页面挂成工具（带 _meta.ui.resourceUri）和 ui:// 资源；资源是 MCP Apps 的 HTML，内联了宿主的库', async () => {
    await installView();
    const client = await mcp();
    const tool = (await client.listTools()).tools.find((t) => t.name === viewToolName('example.stats', 'main'))!;
    expect(tool).toMatchObject({
      title: '收藏统计',
      inputSchema: { type: 'object' },
      _meta: { ui: { resourceUri: 'ui://example.stats/main' } },
    });
    const res = await client.readResource({ uri: 'ui://example.stats/main' });
    const c = res.contents[0] as { mimeType: string; text: string };
    expect(c.mimeType).toBe(MCP_APP_MIME);
    expect(c.text).toBe('<!doctype html><script>window.Emaki={}; // <\\/script></script><p>stats</p>');
    expect(await client.callTool({ name: tool.name, arguments: {} })).toMatchObject({ content: [{ type: 'text' }] });
    await client.close();
  });

  it('停用的插件的页面不挂', async () => {
    await installView();
    await run('plugins.setEnabled', { id: 'example.stats', enabled: false });
    const client = await mcp();
    expect((await client.listTools()).tools.some((t) => t.name.startsWith('open_view_'))).toBe(false);
    await client.close();
  });

  it('助手的会话里 plugins_save_view：出一张保存卡片（授权单）；外部客户端给确认链接；plugins_list 能读回 HTML', async () => {
    const cards: unknown[] = [];
    const session: ToolHost = { ...host, present: (card) => void cards.push(card) };
    const server = createLibraryMcp(ds().registry, null, session, 's1', 's1', { plugins: ds().plugins, sdk: () => null });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'session', version: '1' });
    await client.connect(b);
    const r = await client.callTool({
      name: 'plugins_save_view',
      arguments: { operationId: 'op-1', name: 'fav', title: '收藏', html: '<p>x</p>' },
    });
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toMatchObject({
      status: 'needs_confirmation',
      id: 'ai.fav',
      to: '/p/ai.fav/main',
    });
    expect(cards).toEqual([
      expect.objectContaining({
        title: '保存页面「收藏」',
        plugin: expect.objectContaining({ pluginId: 'ai.fav', version: '1.0.0', token: expect.any(String) }),
      }),
    ]);
    await run('plugins.install', { token: (cards[0] as { plugin: { token: string } }).plugin.token });
    const listed = await client.callTool({ name: 'plugins_list', arguments: { id: 'ai.fav' } });
    expect(JSON.parse((listed.content as { text: string }[])[0]!.text)).toMatchObject({
      id: 'ai.fav',
      source: 'ai',
      pages: [{ id: 'main', to: '/p/ai.fav/main', html: '<p>x</p>' }],
    });
    await client.close();

    const ext = createLibraryMcp(ds().registry, null, host, 'external', undefined, { plugins: ds().plugins });
    const [c, d] = InMemoryTransport.createLinkedPair();
    await ext.connect(c);
    const outside = new Client({ name: 'outside', version: '1' });
    await outside.connect(d);
    const r2 = await outside.callTool({
      name: 'plugins_save_view',
      arguments: { operationId: 'op-2', name: 'other', title: '别的', html: '<p>y</p>' },
    });
    expect(JSON.parse((r2.content as { text: string }[])[0]!.text).message).toMatch(/\/plugins\?confirm=/);
    await outside.close();
  });

  it('内联只换掉 /plugin-sdk/app.js 那一个标签；没构建过网页就原样', () => {
    expect(forMcp(`<script src='/plugin-sdk/app.js' defer></script><script src="/other.js"></script>`, 'X')).toBe(
      '<script>X</script><script src="/other.js"></script>',
    );
    expect(forMcp('<script src="/plugin-sdk/app.js"></script>', null)).toBe('<script src="/plugin-sdk/app.js"></script>');
  });
});
