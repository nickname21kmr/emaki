/**
 * 改内部的插件（docs/plugins.md 第 7 节，E6）：附带的「一个作品算一张」（plugins/count-by-work）真的装上、在这个进程里加载。
 * 补丁生效（角色、作品、画师的张数按投稿数）、停用撤掉；Emaki 改了它改的点（指纹变了）就不加载、自动停用、发通知，
 * 「仍然启用」以后照常；清单里没列的点改不了；这个版本没有的点装不上；activate 出错、补丁出错记在插件头上。
 */
import type { PluginInfo, PluginsState, ServerEvent } from '@emaki/shared';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/events.ts';
import { WEB_POINTS } from '@emaki/shared';
import { checkManifest } from '../../src/domain/plugins/manifest.ts';
import { COUNT_UNIT, COUNT_UNIT_POINT } from '../../src/readmodel/terms.ts';
import { pointContracts } from '../../src/core/pointContracts.ts';
import { defineWebPoints } from '../../src/services/plugins/webPoints.ts';
import { InternalPlugins } from '../../src/services/plugins/internal.ts';
import { SqliteDataSource } from '../helpers/client.ts';
import { makeTmpDir } from '../helpers/tmp.ts';

const EXAMPLE = path.resolve(import.meta.dirname, '../../../../plugins/count-by-work');
const ID = 'count-by-work';

let ds: SqliteDataSource;
let bus: EventBus;
let dir: string;
let loader: InternalPlugins | null;
const events: ServerEvent[] = [];
const logs: string[] = [];

beforeEach(async () => {
  dir = makeTmpDir('plugin-internal');
  const lib = path.join(dir, 'library');
  mkdirSync(lib);
  bus = new EventBus();
  ds = await SqliteDataSource.open(bus, path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
  bus.subscribe((e) => events.push(e));
  events.length = 0;
  logs.length = 0;
  loader = null;
  const db = ds.ctx.db;
  const root = db.prepare("INSERT INTO library_roots (path, enabled, content_mode) VALUES (?, 1, 'auto') RETURNING id").pluck().get(lib) as number;
  db.prepare("INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (1, '爱丽丝', 'alice', 'danbooru', '2000-01-01')").run();
  db.prepare("INSERT INTO works (id, name, danbooru_tag, created_at) VALUES (1, '游戏A', 'game_a', '2000-01-01')").run();
  db.prepare('INSERT INTO character_works (character_id, work_id, position) VALUES (1, 1, 0)').run();
  // 一个投稿的 3 张（组图）+ 2 张单独的：内置算 5 张，「一个作品算一张」算 3 张
  db.prepare(
    "INSERT INTO collections (id, root_id, rel_dir, kind, kind_source, origin, state, created_at, updated_at) VALUES (900, ?, 'post', 'group', 'source', 'auto', 'active', '2026-01-01', '2026-01-01')",
  ).run(root);
  const ins = db.prepare(
    `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, collection_id, page_no)
     VALUES (?, ?, ?, ?, 100, 100, 10, 'png', ?, '2026-01-01', '2026-01-01', ?, ?)`,
  );
  for (let i = 1; i <= 5; i++) {
    ins.run(i, root, `${i}.png`, `${i}.png`, `sha-${i}`, i <= 3 ? 900 : null, i <= 3 ? i : null);
    db.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (?, 1, 'manual', 'user', '2026-01-01')").run(i);
    db.prepare("INSERT INTO image_artists (image_id, artist, score) VALUES (?, 'kantoku', 1)").run(i);
  }
});
afterEach(async () => {
  loader?.close();
  await ds.close();
});

const q = <T = any>(name: string, input: unknown = {}) => ds.registry.query<T>(name, input);
const exec = <T = any>(name: string, input: unknown = {}) => ds.registry.execute<T>(name, input);
const info = async (id = ID): Promise<PluginInfo> => (await q<PluginsState>('plugins.state')).plugins.find((p) => p.id === id)!;

async function counts() {
  return {
    character: (await q('characters.list')).items[0].imageCount as number,
    top: (await q('characters.top')).at(0).imageCount as number,
    work: (await q('works.list'))[0].imageCount as number,
    artist: (await q('artists.list'))[0].imageCount as number,
  };
}
const BUILTIN = { character: 5, top: 5, work: 5, artist: 5 };
const BY_WORK = { character: 3, top: 3, work: 3, artist: 3 };

async function until<T>(fn: () => T | Promise<T>, what: string, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function install(folder: string) {
  const pkg = await ds.plugins.inspect({ kind: 'folder', path: folder });
  expect(pkg.problems).toEqual([]);
  await exec('plugins.install', { token: pkg.token });
  return pkg;
}

function startLoader() {
  loader = new InternalPlugins(ds, { log: (m) => logs.push(m) });
  return loader.start();
}

/** 在临时目录里写一个改内部的插件 */
function writePlugin(id: string, points: string[], code: string): string {
  const folder = path.join(dir, id);
  mkdirSync(path.join(folder, 'server'), { recursive: true });
  writeFileSync(
    path.join(folder, 'emaki-plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version: '1.0.0',
      permissions: { unsafe: true },
      contributes: { 'patch@1': points.map((point) => ({ point })) },
      internal: 'server/patch.mjs',
    }),
  );
  writeFileSync(path.join(folder, 'server', 'patch.mjs'), code);
  return folder;
}

describe('改内部的插件', () => {
  it('「一个作品算一张」：组图只算一张，停用就回到一张图算一张', async () => {
    await startLoader();
    expect(await counts()).toEqual(BUILTIN);
    // 附带的：在「插件」页「附带的」里，启用就是按文件夹装
    expect(ds.plugins.bundled(path.dirname(EXAMPLE)).map((b) => b.id)).toContain(ID);

    const pkg = await install(EXAMPLE);
    // 授权单：要改内部、改的是哪个点
    expect(pkg.manifest.permissions).toEqual({ unsafe: true });
    expect(pkg.patches).toEqual([
      { point: COUNT_UNIT_POINT, label: '排名的张数怎么数', why: expect.any(String), status: 'off' },
      { point: 'fn:count.unit', label: '排名的张数后面写的字', why: expect.any(String), status: 'off' },
    ]);
    await until(() => loader!.isLoaded(ID), '加载');
    await until(async () => (await counts()).character === 3, '张数按投稿数');
    expect(await counts()).toEqual(BY_WORK);

    const p = await info();
    expect(p.kinds).toEqual(['internal']);
    expect(p.grant?.unsafe).toBe(true);
    expect(p.patches).toEqual([
      expect.objectContaining({ point: COUNT_UNIT_POINT, status: 'active' }),
      expect.objectContaining({ point: 'fn:count.unit', status: 'active' }),
    ]);
    // 「谁改了哪里」：服务端的和网页的
    const st = await q<PluginsState>('plugins.state');
    expect(st.patched).toEqual([
      { point: COUNT_UNIT_POINT, label: '排名的张数怎么数', plugins: [ID] },
      { point: 'fn:count.unit', label: '排名的张数后面写的字', plugins: [ID] },
    ]);
    // 网页要加载的模块：地址带版本和修改时间，只能改清单里列的网页的点
    expect(st.webPatches).toEqual([
      { plugin: ID, version: '1.1.0', url: expect.stringMatching(/^\/api\/plugin-web\/count-by-work\/1\.1\.0-\d+\/web\/patch\.js$/), points: ['fn:count.unit'] },
    ]);
    expect(ds.plugins.webFile(ID, 'web/patch.js')).toBe(path.join(EXAMPLE, 'web', 'patch.js'));
    // 只给包里的 .js、.mjs，不能跳出去
    expect(ds.plugins.webFile(ID, 'emaki-plugin.json')).toBeNull();
    expect(ds.plugins.webFile(ID, '../pixiv-browser/site/pixiv.js')).toBeNull();
    // 补丁加上以后推了 plugins.changed（网页重新取张数）
    expect(events.some((e) => e.type === 'changed' && e.changes.includes('plugins.changed'))).toBe(true);

    const off = await exec<{ undoToken: string }>('plugins.setEnabled', { id: ID, enabled: false });
    await until(() => !loader!.isLoaded(ID), '撤掉');
    expect(await counts()).toEqual(BUILTIN);
    expect((await info()).patches).toEqual([expect.objectContaining({ status: 'off' }), expect.objectContaining({ status: 'off' })]);
    expect((await q<PluginsState>('plugins.state')).patched).toBeUndefined();
    expect((await q<PluginsState>('plugins.state')).webPatches).toBeUndefined();
    expect(ds.plugins.webFile(ID, 'web/patch.js')).toBeNull();

    // 撤销「停用」：又加上
    await exec('history.undo', { token: off.undoToken });
    await until(() => loader!.isLoaded(ID), '撤销以后又加载');
    await until(async () => (await counts()).character === 3, '又按投稿数');
  });

  it('Emaki 改了它改的点：不加载、自动停用、发通知；「仍然启用」以后照常', async () => {
    await startLoader();
    await install(EXAMPLE);
    await until(() => loader!.isLoaded(ID), '加载');
    loader!.close();

    // 模拟 Emaki 更新：这个点的约定变了（签名多了一个参数），重启以后再加载
    ds.ctx.points.define(COUNT_UNIT_POINT, { kind: 'term', label: '排名的张数怎么数', contract: ["signature: (a = 'i', b = 'r'): string", 'version: 1'] }, COUNT_UNIT);
    events.length = 0;
    await startLoader();
    await until(async () => !(await info()).enabled, '自动停用');
    expect(loader!.isLoaded(ID)).toBe(false);
    expect(await counts()).toEqual(BUILTIN);
    const p = await info();
    expect(p.disabledReason).toMatch(/它改的「排名的张数怎么数」变了.*仍然启用/);
    expect(p.patches).toEqual([expect.objectContaining({ status: 'changed' }), expect.objectContaining({ status: 'off' })]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'plugin-notice', plugin: ID, kind: 'points-changed', message: p.disabledReason }));
    expect(ds.plugins.pointsChanged(ID)).toEqual([COUNT_UNIT_POINT]);

    // 仍然启用：按现在的样子重新记，照常加载
    await exec('plugins.setEnabled', { id: ID, enabled: true });
    await until(() => loader!.isLoaded(ID), '仍然启用以后加载');
    await until(async () => (await counts()).character === 3, '张数按投稿数');
    expect(ds.plugins.pointsChanged(ID)).toEqual([]);
    expect((await info()).disabledReason).toBeNull();
    expect((await info()).patches).toEqual([expect.objectContaining({ status: 'active' }), expect.objectContaining({ status: 'active' })]);

    // 没变的点重启以后照常加载（不会每次部署都停）
    loader!.close();
    await startLoader();
    expect(loader!.isLoaded(ID)).toBe(true);
    expect((await info()).enabled).toBe(true);
  });

  it('指纹的算法换了不算点变了：旧算法记下的指纹不停用，加载时按现在的算法重记', async () => {
    await startLoader();
    await install(EXAMPLE);
    await until(() => loader!.isLoaded(ID), '加载');
    loader!.close();
    // 模拟旧算法记下的指纹（没有前缀、和现在的对不上）：12.11 换算法那次就把装好的插件误停了
    const legacy = JSON.stringify({ [COUNT_UNIT_POINT]: '0123456789abcdef', 'fn:count.unit': 'fedcba9876543210' });
    ds.ctx.db.prepare("UPDATE plugin_point_state SET value = ? WHERE point = 'patch' AND key = ?").run(legacy, ID);
    expect(ds.plugins.pointsChanged(ID)).toEqual([]);
    await startLoader();
    expect(loader!.isLoaded(ID)).toBe(true);
    expect((await info()).enabled).toBe(true);
    const saved = JSON.parse(ds.ctx.db.prepare("SELECT value FROM plugin_point_state WHERE point = 'patch' AND key = ?").pluck().get(ID) as string);
    expect(saved).toEqual({ [COUNT_UNIT_POINT]: ds.ctx.points.fingerprint(COUNT_UNIT_POINT), 'fn:count.unit': ds.ctx.points.fingerprint('fn:count.unit') });
    // 重记以后，约定真的变了照样停
    loader!.close();
    ds.ctx.points.define(COUNT_UNIT_POINT, { kind: 'term', label: '排名的张数怎么数', contract: ['signature: (a, b)', 'version: 1'] }, COUNT_UNIT);
    expect(ds.plugins.pointsChanged(ID)).toEqual([COUNT_UNIT_POINT]);
  });

  it('清单里没列的点改不了；activate 出错记在插件头上，补丁一个都不留', async () => {
    await startLoader();
    const folder = writePlugin(
      'test.sneaky',
      [COUNT_UNIT_POINT],
      `export function activate(internal) {
         internal.patch('term:count.unit', { around: (next, a) => next(a) });
         internal.patch('query:characters.top', { after: () => [] });
       }`,
    );
    await install(folder);
    await until(async () => (await info('test.sneaky')).errors?.length, '记了错');
    expect((await info('test.sneaky')).errors![0]).toMatchObject({ source: '改内部', message: expect.stringMatching(/query:characters\.top.*没有写在清单的 patch@1 里/) });
    expect(loader!.isLoaded('test.sneaky')).toBe(false);
    expect(ds.ctx.points.patched()).toEqual([]);
    expect(await counts()).toEqual(BUILTIN);
  });

  it('补丁能改命令和查询，叠起来后加的在外层；补丁抛的错照样抛、记在插件头上', async () => {
    await startLoader();
    await install(
      writePlugin(
        'test.top',
        ['query:characters.top'],
        `export function activate(internal) {
           internal.patch('query:characters.top', { after: (r) => r.map((c) => ({ ...c, name: c.name + '·内' })) });
           internal.patch('query:characters.top', {
             before: ([e, input]) => { if (input.limit === 13) throw new Error('不要 13'); return [e, input]; },
             after: (r) => r.map((c) => ({ ...c, name: '[' + c.name + ']' })),
           });
         }`,
      ),
    );
    await until(() => loader!.isLoaded('test.top'), '加载');
    expect((await q('characters.top')).map((c: { name: string }) => c.name)).toEqual(['[爱丽丝·内]']);
    expect((await q<PluginsState>('plugins.state')).patched).toEqual([{ point: 'query:characters.top', label: expect.stringMatching(/^查询「/), plugins: ['test.top', 'test.top'] }]);
    await expect(q('characters.top', { limit: 13 })).rejects.toThrow('不要 13');
    await until(async () => (await info('test.top')).errors?.length, '记了错');
    expect((await info('test.top')).errors![0]).toMatchObject({ source: '改内部', message: 'query:characters.top：不要 13' });
  });

  it('只改网页的插件：服务端只对指纹；网页的点的约定变了也自动停用，网页不再加载它', async () => {
    await startLoader();
    const folder = path.join(dir, 'test.web');
    mkdirSync(path.join(folder, 'web'), { recursive: true });
    writeFileSync(
      path.join(folder, 'emaki-plugin.json'),
      JSON.stringify({
        id: 'test.web',
        name: '改看图器',
        version: '1.0.0',
        permissions: { unsafe: true },
        contributes: { 'patch@1': [{ point: 'component:lightbox.Stage' }] },
        web: 'web/patch.js',
      }),
    );
    writeFileSync(path.join(folder, 'web', 'patch.js'), 'export function activate(internal) {}');
    await install(folder);
    await until(() => loader!.isLoaded('test.web'), '对过指纹');
    expect((await q<PluginsState>('plugins.state')).webPatches).toEqual([expect.objectContaining({ plugin: 'test.web', points: ['component:lightbox.Stage'] })]);
    expect(ds.ctx.points.patched()).toEqual([]);
    loader!.close();

    // 指纹只按约定算：重新登记（同样的约定）不算变；props 变了（约定的快照更新了）才算
    defineWebPoints(ds.ctx.points);
    expect(ds.plugins.pointsChanged('test.web')).toEqual([]);
    const stage = pointContracts()['component:lightbox.Stage']!;
    ds.ctx.points.define('component:lightbox.Stage', { kind: 'component', label: '看图器的大图', contract: [stage[0]!.replace('index: number;', 'index: number; zoom: number;'), ...stage.slice(1)] }, () => {});
    expect(ds.plugins.pointsChanged('test.web')).toEqual(['component:lightbox.Stage']);
    // 加载之前就不给网页了
    expect((await q<PluginsState>('plugins.state')).webPatches).toBeUndefined();
    await startLoader();
    await until(async () => !(await info('test.web')).enabled, '自动停用');
    expect((await info('test.web')).disabledReason).toMatch(/「看图器的大图」变了/);
    // 服务端不能给网页的点加补丁
    expect(() => ds.ctx.points.patch('component:lightbox.Stage', 'x', { after: (r) => r })).toThrow(/网页上/);
  });

  it('清单：改服务端的点要 internal，改网页的点要 web，入口要有点可改', async () => {
    const check = (m: object) =>
      checkManifest({ id: 'test.m', name: 'm', version: '1.0.0', permissions: { unsafe: true }, contributes: {}, ...m }, '0.1.17').problems;
    expect(check({ contributes: { 'patch@1': [{ point: 'fn:count.unit' }] } })).toEqual([expect.stringMatching(/fn:count\.unit.*没有 web/)]);
    expect(check({ contributes: { 'patch@1': [{ point: 'term:count.unit' }] } })).toEqual([expect.stringMatching(/term:count\.unit.*没有 internal/)]);
    expect(check({ contributes: { 'patch@1': [{ point: 'term:count.unit' }] }, internal: 'a.mjs', web: 'b.js' })).toEqual([
      expect.stringMatching(/有 web，但 patch@1 里没有列要改的网页的点/),
    ]);
    expect(check({ contributes: { 'patch@1': [{ point: 'fn:count.unit' }] }, web: 'b.cjs' })).toEqual([expect.stringMatching(/web：改网页的入口要是 ES 模块/)]);
    expect(check({ contributes: { 'patch@1': [{ point: 'nope:x' }] }, web: 'b.js' })[0]).toMatch(/内部点的名字/);
  });

  it('这个版本的 Emaki 没有的点：装不上；清单要 internal、unsafe、patch@1 三样一起', async () => {
    const folder = writePlugin('test.nope', ['term:nope'], 'export function activate() {}');
    const pkg = await ds.plugins.inspect({ kind: 'folder', path: folder });
    expect(pkg.problems).toEqual(['它要改的「term:nope」这个版本的 Emaki 里没有']);
    expect(pkg.patches).toEqual([{ point: 'term:nope', label: 'term:nope', status: 'missing' }]);
  });
});

describe('内部点的登记', () => {
  it('内置的命令、查询、反应、后台任务、口径、网页的点都登记了，插件的命令不算', () => {
    const list = ds.ctx.points.list();
    const kinds = new Set(list.map((p) => p.kind));
    expect([...kinds].sort()).toEqual(['command', 'component', 'fn', 'job', 'query', 'reaction', 'term']);
    const names = new Set(list.map((p) => p.name));
    for (const n of ['query:characters.top', 'command:plugins.setEnabled', 'reaction:invalidateCaches', 'job:scan', COUNT_UNIT_POINT, ...WEB_POINTS.map((p) => p.name)])
      expect(names).toContain(n);
    // 每个点都有记下的约定（指纹按它算）
    expect(list.filter((p) => !pointContracts()[p.name]).map((p) => p.name)).toEqual([]);
    expect(list.filter((p) => p.kind === 'query' || p.kind === 'command')).toHaveLength(ds.registry.list().length);
    // 每个点都算得出指纹（命令的输入格式要能转成 JSON Schema）
    for (const p of list) expect([p.name, ds.ctx.points.fingerprint(p.name)]).toEqual([p.name, expect.stringMatching(/^c1:[0-9a-f]{16}$/)]);
  });

  it('后台任务的补丁在跑的时候套上', async () => {
    const seen: string[] = [];
    const undo = ds.ctx.points.patch('job:dedupe', 'test', {
      around: async (next, ctx) => {
        seen.push('前');
        const r = await next(ctx);
        seen.push('后');
        return r;
      },
    });
    const job = ds.ctx.jobs.enqueue('dedupe');
    await until(() => ds.ctx.jobs.list().find((j) => j.id === job.id && (j.status === 'done' || j.status === 'failed')), '任务跑完');
    expect(seen).toEqual(['前', '后']);
    undo();
  });
});
