/**
 * 插件管理（docs/plugins.md 第 9 节）：内置插件（原来的每一页）默认全部启用、可以停用（必需的不行）、改名、不能删；
 * 覆盖插件启用就生效、停用就还原，冲突时按后启用的、可以选；侧栏的顺序和在不在侧栏；安全模式；都能撤销。
 */
import type { PluginsState } from '@emaki/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/events.ts';
import { SqliteDataSource } from '../helpers/client.ts';
import { makeTmpDir } from '../helpers/tmp.ts';

process.env.EMAKI_LOG_LEVEL = 'silent';

let ds: SqliteDataSource;
let now = Date.parse('2026-11-24T08:00:00Z');
const tick = () => (now += 1000);

const open = async (safeMode = false) =>
  SqliteDataSource.open(new EventBus(), makeTmpDir('plugins'), { memory: true, autoJobs: false, importDict: false, clock: () => now, safeMode });

beforeEach(async () => {
  ds = await open();
});
afterEach(async () => {
  await ds.close();
});

const run = <T = { undoToken?: string; message: string }>(name: string, input: unknown = {}) => {
  tick();
  return ds.registry.execute<T>(name, input);
};
const state = (safe = false) => ds.registry.query<PluginsState>('plugins.state', safe ? { safe: true } : {});
const undo = (token: string) => ds.registry.execute('history.undo', { token });
const navIds = (s: PluginsState) => ({
  main: s.nav.main.map((n) => n.id),
  triage: s.nav.triage.map((n) => n.id),
  footer: s.nav.footer.map((n) => n.id),
});
const defaultSort = () => ds.plugins.overrideValue('images.defaultSort');

describe('内置插件', () => {
  it('默认全部启用；侧栏和原来一样，「插件」页默认不在侧栏', async () => {
    const s = await state();
    expect(s.plugins.filter((p) => p.source === 'builtin').every((p) => p.enabled)).toBe(true);
    expect(navIds(s)).toEqual({
      main: ['home', 'gallery', 'characters', 'original', 'collections', 'annex'],
      triage: ['unrecognized', 'duplicates', 'excluded'],
      footer: ['plugins', 'settings'],
    });
    expect(s.nav.footer.find((n) => n.id === 'plugins')!.visible).toBe(false);
    expect(s.nav.footer.find((n) => n.id === 'settings')!.visible).toBe(true);
    expect(s.disabledPages).toEqual([]);
  });

  it('停用别册：它的页面、导航和首页的别册目次一起停掉；撤销回来', async () => {
    const r = await run('plugins.setEnabled', { id: 'core.annex', enabled: false });
    let s = await state();
    expect(s.plugins.find((p) => p.id === 'core.annex')!.enabled).toBe(false);
    expect(s.disabledPages).toEqual(['annex']);
    expect(s.disabledBlocks).toEqual(['home.annex']);
    expect(s.nav.main.map((n) => n.id)).not.toContain('annex');
    await undo(r.undoToken!);
    s = await state();
    expect(s.disabledPages).toEqual([]);
    expect(s.nav.main.map((n) => n.id)).toContain('annex');
  });

  it('必需的不能停用，内置的不能删', async () => {
    await expect(run('plugins.setEnabled', { id: 'core.settings', enabled: false })).rejects.toThrow(/必需/);
    await expect(run('plugins.setEnabled', { id: 'core.plugins', enabled: false })).rejects.toThrow(/必需/);
    await expect(run('plugins.remove', { id: 'core.gallery' })).rejects.toThrow(/内置/);
    await expect(run('plugins.setEnabled', { id: 'nope', enabled: false })).rejects.toThrow(/没有插件/);
  });

  it('改名：侧栏跟着变，恢复原名；能撤销', async () => {
    const r = await run('plugins.rename', { id: 'core.annex', name: '杂项' });
    expect((await state()).nav.main.find((n) => n.id === 'annex')!.label).toBe('杂项');
    await run('plugins.rename', { id: 'core.annex', name: null });
    expect((await state()).nav.main.find((n) => n.id === 'annex')!.label).toBe('别册');
    await run('plugins.rename', { id: 'core.annex', name: '杂项' });
    const again = await run('plugins.rename', { id: 'core.annex', name: '别册' });
    expect(again.message).toMatch(/恢复原名/);
    expect((await state()).plugins.find((p) => p.id === 'core.annex')!.displayName).toBeNull();
    void r;
  });
});

describe('覆盖插件', () => {
  it('启用就生效，停用就回到内置默认；删除也是；都能撤销', async () => {
    expect(defaultSort()).toBe('addedAt');
    const made = await run<{ id: string; undoToken: string }>('plugins.createOverride', {
      name: '默认按修改时间排序',
      values: { 'images.defaultSort': 'modifiedAt' },
    });
    expect(made.id).toBe('mine.override-1');
    expect(defaultSort()).toBe('modifiedAt');
    const s = await state();
    expect(s.overrides['images.defaultSort']).toEqual({ value: 'modifiedAt', plugin: 'mine.override-1', candidates: ['mine.override-1'] });
    expect(s.plugins.find((p) => p.id === made.id)).toMatchObject({ source: 'mine', kinds: ['override'], enabled: true });

    await run('plugins.setEnabled', { id: made.id, enabled: false });
    expect(defaultSort()).toBe('addedAt');
    await run('plugins.setEnabled', { id: made.id, enabled: true });
    expect(defaultSort()).toBe('modifiedAt');

    const del = await run('plugins.remove', { id: made.id });
    expect(defaultSort()).toBe('addedAt');
    expect((await state()).plugins.find((p) => p.id === made.id)).toBeUndefined();
    await undo(del.undoToken!);
    expect(defaultSort()).toBe('modifiedAt');
  });

  it('不认识的键、不在选项里的值拒绝', async () => {
    await expect(run('plugins.createOverride', { name: 'x', values: { 'images.nope': 'a' } })).rejects.toThrow(/没有能覆盖的值/);
    await expect(run('plugins.createOverride', { name: 'x', values: { 'images.defaultSort': 'page' } })).rejects.toThrow(/不能是/);
    await expect(run('plugins.createOverride', { name: 'x', values: {} })).rejects.toThrow(/至少/);
  });

  it('冲突：按后启用的那个，可以选用别的，删掉选中的就回到后启用的', async () => {
    const a = await run<{ id: string }>('plugins.createOverride', { name: 'A', values: { 'images.defaultSort': 'modifiedAt' } });
    const b = await run<{ id: string }>('plugins.createOverride', { name: 'B', values: { 'images.defaultSort': 'fileName' } });
    expect(defaultSort()).toBe('fileName');
    let s = await state();
    expect(s.overrides['images.defaultSort'].candidates).toEqual([a.id, b.id]);
    expect(s.plugins.find((p) => p.id === a.id)!.conflicts).toEqual(['images.defaultSort']);
    // 重新启用 A：A 成了后启用的
    await run('plugins.setEnabled', { id: a.id, enabled: false });
    await run('plugins.setEnabled', { id: a.id, enabled: true });
    expect(defaultSort()).toBe('modifiedAt');
    await run('plugins.chooseOverride', { key: 'images.defaultSort', plugin: b.id });
    expect(defaultSort()).toBe('fileName');
    await run('plugins.remove', { id: b.id });
    s = await state();
    expect(s.overrides['images.defaultSort'].plugin).toBe(a.id);
    expect(s.plugins.find((p) => p.id === a.id)!.conflicts).toEqual([]);
  });

  it('改值', async () => {
    const a = await run<{ id: string }>('plugins.createOverride', { name: 'A', values: { 'images.defaultSort': 'modifiedAt' } });
    await run('plugins.setOverrideValues', { id: a.id, values: { 'images.defaultSort': 'bytes' } });
    expect(defaultSort()).toBe('bytes');
    await expect(run('plugins.setOverrideValues', { id: 'core.gallery', values: { 'images.defaultSort': 'bytes' } })).rejects.toThrow(/不是你建的/);
  });

  it('图片列表没给排序时按生效的默认排序；给了照给的', async () => {
    const db = ds.ctx.db;
    db.prepare("INSERT INTO library_roots (id, path) VALUES (1, '/lib')").run();
    const ins = db.prepare(`INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, tagged_at, content_kind)
      VALUES (1, ?, ?, 800, 1200, ?, 'jpeg', ?, ?, ?, '2026-01-01', 'illustration')`);
    // a 最新入库、修改时间最早；b 反过来
    ins.run('a.jpg', 'a.jpg', 100, 'sha-a', '2026-03-01', '2025-01-01');
    ins.run('b.jpg', 'b.jpg', 300, 'sha-b', '2026-01-01', '2025-06-01');
    const names = async (q: Record<string, unknown> = {}) =>
      (await ds.registry.query<{ items: { fileName: string }[] }>('images.list', q)).items.map((i) => i.fileName);
    expect(await names()).toEqual(['a.jpg', 'b.jpg']);
    await run('plugins.createOverride', { name: 'A', values: { 'images.defaultSort': 'modifiedAt' } });
    expect(await names()).toEqual(['b.jpg', 'a.jpg']);
    expect(await names({ sort: 'addedAt' })).toEqual(['a.jpg', 'b.jpg']);
  });
});

describe('侧栏', () => {
  it('调顺序、换段、拿掉和放回；没排到的接在默认那一段最后；能撤销', async () => {
    const r = await run('plugins.setNav', {
      sections: { main: ['gallery', 'home', 'unrecognized'], triage: ['excluded'], footer: ['settings'] },
      visible: { plugins: true, annex: false },
    });
    let s = await state();
    expect(navIds(s)).toEqual({
      main: ['gallery', 'home', 'unrecognized', 'characters', 'original', 'collections', 'annex'],
      triage: ['excluded', 'duplicates'],
      footer: ['settings', 'plugins'],
    });
    expect(s.nav.main.find((n) => n.id === 'unrecognized')!.section).toBe('main');
    expect(s.nav.footer.find((n) => n.id === 'plugins')!.visible).toBe(true);
    expect(s.nav.main.find((n) => n.id === 'annex')!.visible).toBe(false);
    await undo(r.undoToken!);
    s = await state();
    expect(navIds(s).main).toEqual(['home', 'gallery', 'characters', 'original', 'collections', 'annex']);
  });

  it('「设置」不能从侧栏拿掉', async () => {
    await expect(run('plugins.setNav', { visible: { settings: false } })).rejects.toThrow(/设置/);
  });

  it('停用的插件的导航项不在侧栏，重新启用回到原来的位置', async () => {
    await run('plugins.setNav', { sections: { main: ['annex', 'home', 'gallery', 'characters', 'original', 'collections'], triage: [], footer: [] } });
    await run('plugins.setEnabled', { id: 'core.annex', enabled: false });
    expect(navIds(await state()).main[0]).toBe('home');
    await run('plugins.setEnabled', { id: 'core.annex', enabled: true });
    expect(navIds(await state()).main[0]).toBe('annex');
  });
});

describe('安全模式', () => {
  it('?safe：只用内置的、全部按原样；我的插件不加载，覆盖不生效，改的名字和顺序不管', async () => {
    await run('plugins.createOverride', { name: 'A', values: { 'images.defaultSort': 'modifiedAt' } });
    await run('plugins.setEnabled', { id: 'core.annex', enabled: false });
    await run('plugins.rename', { id: 'core.gallery', name: '全部' });
    await run('plugins.setNav', { sections: { main: ['gallery', 'home'], triage: [], footer: [] } });
    const s = await state(true);
    expect(s.safeMode).toBe(true);
    expect(s.plugins.every((p) => p.source === 'builtin' && p.enabled && p.displayName === null)).toBe(true);
    expect(s.overrides['images.defaultSort'].value).toBe('addedAt');
    expect(navIds(s).main).toEqual(['home', 'gallery', 'characters', 'original', 'collections', 'annex']);
    // 不带 ?safe 的照旧
    expect((await state()).disabledPages).toEqual(['annex']);
  });

  it('服务端 --safe：图片列表的默认排序也是内置的', async () => {
    await run('plugins.createOverride', { name: 'A', values: { 'images.defaultSort': 'modifiedAt' } });
    expect(defaultSort()).toBe('modifiedAt');
    const db = ds.ctx.db;
    const rows = db.prepare('SELECT * FROM user_plugins').all();
    await ds.close();
    ds = await open(true);
    const ins = ds.ctx.db.prepare('INSERT INTO user_plugins (id, manifest, created_at) VALUES (@id, @manifest, @created_at)');
    for (const r of rows) ins.run(r);
    expect(defaultSort()).toBe('addedAt');
    expect((await state()).safeMode).toBe(true);
  });
});
