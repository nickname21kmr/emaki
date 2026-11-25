/**
 * 装插件（docs/plugins.md E2）：zip、文件夹、git 三种来源；清单检查；授权单要列的东西（这次要新给的权限）；装上、更新、卸载、撤销；
 * 不兼容的不生效；出错多次自动停用；插件的存储；启动时清理。
 */
import type { PluginPackage, PluginsState } from '@emaki/shared';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/events.ts';
import { checkManifest } from '../../src/domain/plugins/manifest.ts';
import { checkGitUrl, PluginPackages } from '../../src/services/plugins/packages.ts';
import { unzip, ZipError } from '../../src/services/plugins/zip.ts';
import { SqliteDataSource } from '../helpers/client.ts';
import { makeTmpDir } from '../helpers/tmp.ts';
import { makeZip } from '../helpers/zip.ts';

process.env.EMAKI_LOG_LEVEL = 'silent';

const EXAMPLES_DIR = path.resolve(import.meta.dirname, '../../../../examples/plugins');
const example = (name: string) =>
  JSON.parse(readFileSync(path.join(EXAMPLES_DIR, name, 'emaki-plugin.json'), 'utf8')) as Record<string, any>;
/** 测试用的插件：侧栏一项加一个覆盖（样例插件各只演示一个贡献点，见 examples/plugins；这里两个都要） */
const sample = (): Record<string, any> => ({
  id: 'example.random-browse',
  name: '随便看看',
  version: '0.1.0',
  engines: { emaki: '>=0.1.17' },
  contributes: {
    'nav.item@1': [{ id: 'random', label: '随便看看', to: '/gallery?sort=random', icon: 'compass', section: 'main' }],
    'override@1': { 'images.defaultSort': 'modifiedAt' },
  },
});
const VERSION = '0.1.17';

let ds: SqliteDataSource;
let dataDir: string;
let now = Date.parse('2026-11-24T08:00:00Z');
const tick = () => (now += 1000);

beforeEach(async () => {
  dataDir = makeTmpDir('plugin-install');
  ds = await SqliteDataSource.open(new EventBus(), dataDir, { memory: true, autoJobs: false, importDict: false, clock: () => now });
});
afterEach(async () => {
  await ds.close();
});

const run = <T = { undoToken?: string; message: string }>(name: string, input: unknown = {}) => {
  tick();
  return ds.registry.execute<T>(name, input);
};
const state = () => ds.registry.query<PluginsState>('plugins.state', {});
const plugin = async (id: string) => (await state()).plugins.find((p) => p.id === id);
const undo = (token: string) => ds.registry.execute('history.undo', { token });
const zipOf = (manifest: object, extra: Record<string, string> = {}) =>
  makeZip({ 'emaki-plugin.json': JSON.stringify(manifest), ...extra });
const inspectZip = (manifest: object, name = 'plugin.zip') => ds.plugins.inspectZip(name, zipOf(manifest));
const install = (pkg: PluginPackage, folders?: Record<string, { rootId: string; dir: string }>) =>
  run<{ id: string; undoToken: string; message: string }>('plugins.install', { token: pkg.token, ...(folders && { folders }) });

const withPerms = (perms: object, extra: object = {}) => ({
  ...sample(),
  id: 'example.perms',
  name: '权限样例',
  permissions: perms,
  ...extra,
});

describe('zip 包', () => {
  it('解开：deflate 和不压缩的都行；文件夹项跳过', () => {
    const files = unzip(makeZip({ 'a.txt': 'hello', 'sub/b.json': '{"x":1}', 'dir/': '' }));
    expect(files.map((f) => [f.path, f.data.toString()])).toEqual([
      ['a.txt', 'hello'],
      ['sub/b.json', '{"x":1}'],
    ]);
    expect(unzip(makeZip({ 'a.txt': 'x' }, { store: true }))[0]!.data.toString()).toBe('x');
  });

  it('不安全的路径、符号链接、太大、不是 zip：整包拒绝', () => {
    expect(() => unzip(makeZip({ '../evil.txt': 'x' }))).toThrow(ZipError);
    expect(() => unzip(makeZip({ 'a/../../evil.txt': 'x' }))).toThrow(/不安全/);
    expect(() => unzip(makeZip({ '/etc/passwd': 'x' }))).toThrow(/不安全/);
    expect(() => unzip(makeZip({ 'C:/x.txt': 'x' }))).toThrow(/不安全/);
    expect(() => unzip(makeZip({ link: 'target' }, { symlink: ['link'] }))).toThrow(/符号链接/);
    expect(() => unzip(makeZip({ 'big.bin': Buffer.alloc(2000) }), { maxFiles: 10, maxEntry: 1000, maxTotal: 5000 })).toThrow(/太大/);
    expect(() => unzip(makeZip({ a: 'x', b: 'y' }), { maxFiles: 1, maxEntry: 1000, maxTotal: 5000 })).toThrow(/太多/);
    expect(() => unzip(Buffer.from('not a zip at all, just some text'))).toThrow(/不是 zip/);
  });
});

describe('清单检查', () => {
  it('样例插件（examples/plugins）都没有问题', () => {
    const names = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['random-browse', 'sort-by-modified']));
    for (const name of names) expect([name, checkManifest(example(name), VERSION).problems]).toEqual([name, []]);
    expect(checkManifest(example('random-browse'), VERSION).manifest!.contributes['nav.item@1']![0]).toMatchObject({
      id: 'random',
      to: '/gallery?sort=random',
      icon: 'compass',
      section: 'main',
    });
  });

  it('逐项写成能看懂的话', () => {
    const problems = (m: object) => checkManifest({ ...sample(), ...m }, VERSION).problems;
    expect(problems({ id: 'core.evil' })).toEqual([expect.stringMatching(/留给 Emaki 自己/)]);
    expect(problems({ version: '1.0' })).toEqual([expect.stringMatching(/1\.2\.3/)]);
    expect(problems({ engines: { emaki: '>=0.3' } })).toEqual(['需要 Emaki >=0.3，现在是 0.1.17']);
    expect(problems({ engines: { emaki: 'whatever' } })).toEqual([expect.stringMatching(/看懂的版本范围/)]);
    expect(problems({ contributes: { 'lightbox.toolbar@1': [] } })).toEqual(['用到了「lightbox.toolbar@1」，这个版本的 Emaki 还不支持']);
    expect(problems({ contributes: {} })).toEqual([expect.stringMatching(/什么都没有贡献/)]);
    expect(problems({ permissions: { scopes: ['read', 'devices', 'nope'] } })).toEqual([
      '要的权限「管理手机等设备」只给人和设备，插件拿不到',
      '要的权限「nope」Emaki 不认识',
    ]);
    // 服务端逻辑（E5）：入口要是包里的 .js；命令名带插件前缀、范围插件能用；有命令要有 server，有任务要能在后台跑
    expect(problems({ server: 'server/index.js' })).toEqual([]);
    expect(problems({ server: '../evil.js' })).toEqual([expect.stringMatching(/^server：/)]);
    expect(problems({ server: 'server/index.ts' })).toEqual([expect.stringMatching(/\.mjs/)]);
    const cmd = (c: object) => ({
      server: 'server/index.js',
      contributes: { 'command@1': [{ name: 'example.random-browse.go', summary: '走', scope: 'read', ...c }] },
    });
    expect(problems(cmd({}))).toEqual([]);
    expect(problems(cmd({ name: 'other.go' }))).toEqual([expect.stringMatching(/要以插件 id 开头/)]);
    expect(problems(cmd({ scope: 'devices' }))).toEqual([expect.stringMatching(/插件用不了/)]);
    expect(problems(cmd({ input: { type: 'string' } }))).toEqual([expect.stringMatching(/对象的 JSON Schema/)]);
    expect(problems({ contributes: cmd({}).contributes })).toEqual([expect.stringMatching(/没有 server/)]);
    // site@1：脚本只能加在声明过的网站上；页面对应的网站要有
    const site = (x: object = {}, perms: object = { network: ['www.pixiv.net'] }) => ({
      permissions: perms,
      contributes: {
        'site@1': [
          { id: 'pixiv', title: 'Pixiv', url: 'https://www.pixiv.net/', matches: ['www.pixiv.net'], script: 'site/pixiv.js', ...x },
        ],
      },
    });
    expect(problems(site())).toEqual([]);
    expect(problems(site({}, { network: ['pixiv.net'] }))).toEqual([]);
    expect(problems(site({}, {}))).toEqual([expect.stringMatching(/www\.pixiv\.net 不在 permissions\.network 里/)]);
    expect(problems(site({ url: 'https://evil.example/' }))).toEqual([expect.stringMatching(/起始页不在它的 matches 里/)]);
    expect(problems(site({ url: 'http://www.pixiv.net/' }))).toEqual([expect.stringMatching(/https/)]);
    expect(problems(site({ script: '../x.js' }))).toEqual([expect.stringMatching(/^site@1 的 0\.script/)]);
    expect(problems({ contributes: { 'page@1': [{ id: 'main', view: 'index.html', site: 'nope' }] } })).toEqual([
      expect.stringMatching(/对应的网站「nope」在 site@1 里没有/),
    ]);
    expect(problems({ server: 'server/index.js', contributes: { 'job.kind@1': [{ kind: 'dl', label: '下载' }] } })).toEqual([
      expect.stringMatching(/"background": true/),
    ]);
    expect(problems({ permissions: { unsafe: true } })).toEqual([expect.stringMatching(/内部/)]);
    expect(problems({ contributes: { 'override@1': { 'images.defaultSort': 'sideways' } } })).toEqual([
      expect.stringMatching(/不能是「sideways」/),
    ]);
    expect(problems({ contributes: { 'override@1': { 'no.such': 'x' } } })).toEqual([expect.stringMatching(/不认识/)]);
    for (const to of ['https://evil.example', '//evil.example', 'gallery', '/works/:id', 'javascript:alert(1)'])
      expect([to, problems({ contributes: { 'nav.item@1': [{ id: 'x', label: 'x', to }] } })]).toEqual([
        to,
        [expect.stringMatching(/Emaki 里的地址/)],
      ]);
    expect(checkManifest({ id: 'x' }, VERSION)).toMatchObject({
      manifest: null,
      problems: [expect.stringMatching(/清单里的 name/), expect.stringMatching(/清单里的 version/)],
    });
  });
});

describe('从 zip 装：授权单、装上、撤销、卸载', () => {
  it('样例插件：没要权限；装上就启用，侧栏多一项（id 带插件前缀），默认排序跟着变', async () => {
    const pkg = inspectZip(sample(), 'random-browse.zip');
    expect(pkg).toMatchObject({ problems: [], current: null, added: {}, source: { kind: 'file', location: 'random-browse.zip' } });
    expect(ds.plugins.overrideValue('images.defaultSort')).toBe('addedAt');

    const r = await install(pkg);
    expect(r).toMatchObject({ id: 'example.random-browse', message: '已安装并启用「随便看看」' });
    const p = (await plugin('example.random-browse'))!;
    expect(p).toMatchObject({ source: 'installed', enabled: true, version: '0.1.0', kinds: ['page', 'override'], problems: [] });
    expect(p.installed).toMatchObject({ kind: 'file', location: 'random-browse.zip', ref: null });
    expect(p.grant).toEqual({ scopes: [], folders: [], network: [], background: false, unsafe: false });
    const s = await state();
    expect(s.nav.main.map((n) => n.id)).toContain('example.random-browse/random');
    expect(ds.plugins.overrideValue('images.defaultSort')).toBe('modifiedAt');

    // 包放在 plugins/packages 下（库里记相对路径），staging 清掉了
    const pkgs = readdirSync(path.join(dataDir, 'plugins', 'packages'));
    expect(pkgs).toEqual([expect.stringMatching(/^example\.random-browse@0\.1\.0-/)]);
    expect(ds.ctx.db.prepare('SELECT package_dir FROM installed_plugins').pluck().get()).toBe(`packages/${pkgs[0]}`);
    expect(readdirSync(path.join(dataDir, 'plugins', 'staging'))).toEqual([]);

    // 撤销安装：插件没了，默认排序回去
    await undo(r.undoToken);
    expect(await plugin('example.random-browse')).toBeUndefined();
    expect(ds.plugins.overrideValue('images.defaultSort')).toBe('addedAt');
  });

  it('两个样例一起装：一个加侧栏项、一个改默认排序，不争同一个值', async () => {
    for (const name of ['random-browse', 'sort-by-modified']) await install(inspectZip(example(name), `${name}.zip`));
    expect(await plugin('example.random-browse')).toMatchObject({ enabled: true, kinds: ['page'], conflicts: [] });
    expect(await plugin('example.sort-by-modified')).toMatchObject({ enabled: true, kinds: ['override'], conflicts: [] });
    expect((await state()).nav.main.map((n) => n.id)).toContain('example.random-browse/random');
    expect(ds.plugins.overrideValue('images.defaultSort')).toBe('modifiedAt');
  });

  it('停用、启用、卸载（存储、授权一起删），撤销卸载一切回来', async () => {
    const { id } = await install(inspectZip(withPerms({ scopes: ['read'] })));
    ds.plugins.storage.set(id, 'k', { a: 1 });
    await run('plugins.setEnabled', { id, enabled: false });
    expect((await plugin(id))!.enabled).toBe(false);
    expect(ds.plugins.overrideValue('images.defaultSort')).toBe('addedAt');
    await run('plugins.setEnabled', { id, enabled: true });

    const r = await run<{ undoToken: string; message: string }>('plugins.remove', { id });
    expect(r.message).toBe('已卸载「权限样例」');
    expect(await plugin(id)).toBeUndefined();
    expect(ds.plugins.storage.get(id, 'k')).toBeUndefined();
    await undo(r.undoToken);
    expect((await plugin(id))!.grant!.scopes).toEqual(['read']);
    expect(ds.plugins.storage.get(id, 'k')).toEqual({ a: 1 });
  });

  it('授权单：列出要的全部权限；文件夹默认放在第一个自动识别的图库文件夹下，可以改', async () => {
    const root = ds.ctx.db
      .prepare("INSERT INTO library_roots (path, enabled, content_mode) VALUES ('/lib', 1, 'auto') RETURNING id")
      .pluck()
      .get() as number;
    const perms = {
      scopes: ['read', 'import'],
      folders: [{ id: 'downloads', purpose: '下载的图放在这里', suggest: '下载图片/Pixiv' }],
      network: ['www.pixiv.net', 'I.PXIMG.NET'],
      background: true,
    };
    const pkg = inspectZip(withPerms(perms));
    expect(pkg.problems).toEqual([]);
    expect(pkg.added).toEqual({ ...perms, network: ['www.pixiv.net', 'i.pximg.net'] });
    expect(pkg.folderDefaults).toEqual({ downloads: { rootId: root, dir: '下载图片/Pixiv' } });

    await expect(install(pkg, { downloads: { rootId: String(root), dir: '../外面' } })).rejects.toThrow();
    const again = inspectZip(withPerms(perms));
    await install(again, { downloads: { rootId: String(root), dir: '插件\\下载' } });
    expect((await plugin('example.perms'))!.grant).toEqual({
      scopes: ['read', 'import'],
      folders: [{ id: 'downloads', rootId: root, dir: '插件/下载' }],
      network: ['www.pixiv.net', 'i.pximg.net'],
      background: true,
      unsafe: false,
    });
  });

  it('装不上的：授权单上写明原因，install 拒绝', async () => {
    const pkg = inspectZip({ ...sample(), contributes: { 'lightbox.toolbar@1': [] } });
    expect(pkg.problems).toEqual(['用到了「lightbox.toolbar@1」，这个版本的 Emaki 还不支持']);
    await expect(install(pkg)).rejects.toThrow(/lightbox\.toolbar/);
    expect(() => ds.plugins.inspectZip('x.zip', makeZip({ 'readme.txt': 'hi' }))).toThrow(/没有 emaki-plugin\.json/);
    expect(() => ds.plugins.inspectZip('x.zip', makeZip({ 'emaki-plugin.json': '{oops' }))).toThrow(/不是合法的 JSON/);
    // 清单在唯一的一个文件夹里（直接压缩文件夹）也认
    expect(ds.plugins.inspectZip('x.zip', makeZip({ 'random-browse/emaki-plugin.json': JSON.stringify(sample()) })).problems).toEqual([]);
    await expect(run('plugins.install', { token: 'no-such-token' })).rejects.toThrow(/过期/);
  });
});

describe('更新', () => {
  it('只列新要的权限；保持原来的启用状态和选好的文件夹', async () => {
    const root = ds.ctx.db
      .prepare("INSERT INTO library_roots (path, enabled, content_mode) VALUES ('/lib', 1, 'auto') RETURNING id")
      .pluck()
      .get() as number;
    const v1 = { scopes: ['read'], folders: [{ id: 'dl', purpose: '放下载的图' }] };
    const { id } = await install(inspectZip(withPerms(v1)), { dl: { rootId: String(root), dir: '我选的' } });
    await run('plugins.setEnabled', { id, enabled: false });

    const pkg = inspectZip(withPerms({ ...v1, network: ['example.com'] }, { version: '0.2.0' }));
    expect(pkg.current).toMatchObject({ version: '0.1.0', grant: { scopes: ['read'] } });
    expect(pkg.added).toEqual({ network: ['example.com'] });
    expect(pkg.folderDefaults).toEqual({ dl: { rootId: root, dir: '我选的' } });
    const r = await install(pkg);
    expect(r.message).toBe('已把「权限样例」更新到 0.2.0');
    expect(await plugin(id)).toMatchObject({
      version: '0.2.0',
      enabled: false,
      grant: { network: ['example.com'], folders: [{ dir: '我选的' }] },
    });

    // 权限没多：added 是空的（网页直接更新，不再出授权单）
    expect(inspectZip(withPerms(v1, { version: '0.3.0' })).added).toEqual({});
  });
});

describe('从文件夹装（开发用）、从 git 装', () => {
  it('文件夹：不复制；改了清单「重新读取」；文件夹没了写明原因', async () => {
    const dir = makeTmpDir('plugin-folder');
    writeFileSync(path.join(dir, 'emaki-plugin.json'), JSON.stringify(sample()));
    const pkg = await run<PluginPackage>('plugins.inspect', { source: { kind: 'folder', path: dir } });
    expect(pkg.source).toEqual({ kind: 'folder', location: dir, ref: null });
    const { id } = await install(pkg);
    expect(existsSync(path.join(dataDir, 'plugins', 'packages'))).toBe(false);

    writeFileSync(path.join(dir, 'emaki-plugin.json'), JSON.stringify({ ...sample(), version: '0.1.1' }));
    const upd = await run<PluginPackage>('plugins.checkUpdate', { id });
    expect(upd).toMatchObject({ manifest: { version: '0.1.1' }, current: { version: '0.1.0' }, added: {} });
    await install(upd);
    expect((await plugin(id))!.version).toBe('0.1.1');

    rmSync(dir, { recursive: true, force: true });
    const p = (await plugin(id))!;
    expect(p).toMatchObject({ enabled: false, problems: [`文件夹不见了（${dir}）`] });
    expect(ds.plugins.overrideValue('images.defaultSort')).toBe('addedAt');
    await expect(run('plugins.setEnabled', { id, enabled: true })).rejects.toThrow(/不能启用/);
    await expect(run('plugins.inspect', { source: { kind: 'folder', path: 'relative/path' } })).rejects.toThrow(/完整的路径/);
  });

  it('git：只认 https、ssh、git@；浅克隆，不让 ext::、file:// 执行命令或读本机文件；去掉 .git', async () => {
    for (const bad of ['ext::sh -c touch% /tmp/pwned', '-uhttps://x', 'file:///etc', '/local/repo', 'C:\\repo', 'https://a b'])
      expect(() => checkGitUrl(bad), bad).toThrow();
    for (const good of ['https://github.com/a/b.git', 'ssh://git@host/a/b', 'git@github.com:a/b.git'])
      expect(() => checkGitUrl(good)).not.toThrow();

    const calls: string[][] = [];
    const tmp = makeTmpDir('plugin-git');
    const packages = new PluginPackages(
      tmp,
      () => now,
      async (args) => {
        calls.push(args);
        const dest = args.at(-1)!;
        mkdirSync(path.join(dest, '.git'), { recursive: true });
        cpSync(path.join(EXAMPLES_DIR, 'random-browse'), dest, { recursive: true });
      },
    );
    const s = await packages.stageGit('https://example.com/p.git', 'v0.1.0');
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        '-c',
        'protocol.ext.allow=never',
        'protocol.file.allow=never',
        'clone',
        '--depth',
        '1',
        '--branch',
        'v0.1.0',
        '--',
      ]),
    );
    expect(calls[0]!.slice(-3)).toEqual(['--', 'https://example.com/p.git', s.root]);
    expect(existsSync(path.join(s.root, '.git'))).toBe(false);
    expect(existsSync(path.join(s.root, 'emaki-plugin.json'))).toBe(true);
    await expect(packages.stageGit('https://example.com/p.git', '--upload-pack=evil')).rejects.toThrow(/写法不对/);

    const failing = new PluginPackages(
      tmp,
      () => now,
      async () => {
        throw Object.assign(new Error('x'), { stderr: 'Cloning into...\nfatal: repository not found\n' });
      },
    );
    await expect(failing.stageGit('https://example.com/none.git', null)).rejects.toThrow('git 下载失败：fatal: repository not found');
  });
});

describe('不兼容、出错、存储、清理', () => {
  it('Emaki 版本对不上的：不生效、写明原因、不能启用', async () => {
    const { id } = await install(inspectZip(sample()));
    const m = { ...sample(), engines: { emaki: '>=99' } };
    ds.ctx.db.prepare('UPDATE installed_plugins SET manifest = ? WHERE id = ?').run(JSON.stringify(m), id);
    expect(await plugin(id)).toMatchObject({ enabled: false, problems: ['需要 Emaki >=99，现在是 0.1.17'] });
    expect((await state()).nav.main.map((n) => n.id)).not.toContain(`${id}/random`);
    expect(ds.plugins.overrideValue('images.defaultSort')).toBe('addedAt');
  });

  it('十分钟内出错 5 次自动停用，写明原因；重新启用清掉原因；超过十分钟的不算', async () => {
    const { id } = await install(inspectZip(sample()));
    for (let i = 0; i < 4; i++) expect(ds.plugins.recordError(id, 'view', `坏了 ${i}`)).toEqual({ autoDisabled: false });
    now += 11 * 60_000;
    for (let i = 0; i < 4; i++) expect(ds.plugins.recordError(id, 'view', `又坏了 ${i}`).autoDisabled).toBe(false);
    expect(ds.plugins.recordError(id, 'view', '第五次').autoDisabled).toBe(true);
    const p = (await plugin(id))!;
    expect(p.enabled).toBe(false);
    expect(p.disabledReason).toMatch(/10 分钟内出错 5 次，自动停用了。最近一次：第五次/);
    expect(p.errors!.map((e) => e.message)).toEqual(['第五次', '又坏了 3', '又坏了 2', '又坏了 1', '又坏了 0']);
    await run('plugins.setEnabled', { id, enabled: true });
    expect((await plugin(id))!.disabledReason).toBeNull();
    // 内置插件不会被自动停用
    for (let i = 0; i < 6; i++) ds.plugins.recordError('core.annex', 'view', 'x');
    expect((await plugin('core.annex'))!.enabled).toBe(true);
  });

  it('存储：读写删、按前缀列键、有上限', () => {
    const s = ds.plugins.storage;
    s.set('p', 'a/1', 1);
    s.set('p', 'a/2', { x: [1, 2] });
    s.set('p', 'b', 'hi');
    s.set('q', 'a/1', 'other');
    expect(s.keys('p', 'a/')).toEqual(['a/1', 'a/2']);
    expect(s.get('p', 'a/2')).toEqual({ x: [1, 2] });
    s.set('p', 'a/2', undefined);
    expect(s.keys('p')).toEqual(['a/1', 'b']);
    expect(s.get('q', 'a/1')).toBe('other');
    expect(() => s.set('p', '', 1)).toThrow();
    expect(() => s.set('p', 'big', 'x'.repeat(300 * 1024))).toThrow(/最大/);
  });

  it('启动时清理：staging 清空，没有插件指向的包删掉', async () => {
    const keep = await install(inspectZip(sample()));
    const gone = await install(inspectZip(withPerms({})));
    await run('plugins.remove', { id: gone.id });
    inspectZip(withPerms({}, { id: 'example.pending' }));
    expect(readdirSync(path.join(dataDir, 'plugins', 'packages'))).toHaveLength(2);
    expect(readdirSync(path.join(dataDir, 'plugins', 'staging'))).toHaveLength(1);
    ds.plugins.cleanup();
    expect(readdirSync(path.join(dataDir, 'plugins', 'packages'))).toEqual([expect.stringMatching(/^example\.random-browse@/)]);
    expect(existsSync(path.join(dataDir, 'plugins', 'staging'))).toBe(false);
    expect((await plugin(keep.id))!.problems).toEqual([]);
  });
});
