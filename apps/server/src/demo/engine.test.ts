/**
 * 演示模式（附录 #31、docs/core-architecture.md 第 8 节）：真实引擎 + 演示数据 + 假部件。
 * - 用文件数据库（AI 助手的只读 SQL 能读），每次打开前清空重建；
 * - 图片是占位图；后台任务只走进度条、不改数据；
 * - 绝不碰用户的图库文件夹：移动、导入、替换、显示在资源管理器、添加文件夹、整理到子文件夹、移回原处都拒绝；
 * - 演示用的图库路径不可能真实存在。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../core/events.ts';
import { buildContractDb } from '../../test/fixtures/contract-db.ts';
import { makeTmpDir } from '../../test/helpers/tmp.ts';
import { openDemoEngine, type DemoEngine } from './engine.ts';
import { buildDemoDb, DEMO_ROOT_PREFIX } from './fixtures.ts';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

let base: string;
let dir: string;
let demo: DemoEngine;
beforeEach(async () => {
  base = makeTmpDir('demo-engine');
  dir = path.join(base, 'demo');
  // 上一次演示留下的东西：打开时要清掉
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'leftover.txt'), 'x');
  demo = await openDemoEngine(new EventBus(), { dir, data: buildContractDb(NOW), now: NOW, clock: () => NOW, jobStepMs: 1 });
});
afterEach(async () => {
  await demo.ds.close();
  rmSync(base, { recursive: true, force: true });
});
const img = (id: string) => String(demo.map.images.get(id));

it('数据目录每次重建，用文件数据库', () => {
  expect(existsSync(path.join(dir, 'leftover.txt'))).toBe(false);
  expect(demo.ds.databaseFile).toBe(path.join(dir, 'emaki.sqlite'));
  expect(existsSync(demo.ds.databaseFile!)).toBe(true);
});

it('图片是 SVG 占位图，不读磁盘', async () => {
  const thumb = await demo.ds.getThumbnail(img('i1'), 480);
  expect(thumb).toMatchObject({ kind: 'buffer', contentType: 'image/svg+xml' });
  expect(String((thumb as { body: string }).body)).toContain('width="480"');
  const original = await demo.ds.getOriginal(img('i1'));
  expect(String((original as { body: string }).body)).toContain('i1.png');
  expect(await demo.ds.getThumbnail('999999', 240)).toBeNull();
});

describe('不碰用户的图库文件夹', () => {
  const rejects = async (p: Promise<unknown>, what: string) => expect(p).rejects.toThrow(`演示数据不支持${what}`);

  it('移动、导入、替换、显示在资源管理器、添加图库文件夹、整理到子文件夹都拒绝', async () => {
    const root = String(demo.map.roots.get('root1'));
    await rejects(demo.ds.moveImages({ ids: [img('i1')], rootId: root, dir: '别处' }), '移动文件');
    await rejects(demo.ds.importImages({ rootId: root, dir: '', files: [{ path: path.join(base, 'a.png') }] }), '导入文件');
    await rejects(demo.ds.replaceImage(img('i1'), { path: path.join(base, 'a.png') }), '替换图库里的文件');
    await rejects(demo.ds.revealImage(img('i1')), '在资源管理器中显示文件');
    await rejects(demo.ds.addLibraryRoot({ path: base }), '添加图库文件夹');
    await rejects(demo.ds.createCollection({ imageIds: [img('i1'), img('i2')], title: '组图', kind: 'group', organizeFiles: true }), '整理到子文件夹');
    const { collection } = await demo.ds.createCollection({ imageIds: [img('i1'), img('i2')], title: '组图', kind: 'group' });
    await rejects(demo.ds.updateCollection(collection.id, { organizeFiles: true }), '整理到子文件夹');
    // 库里的路径没变
    expect((await demo.ds.getImage(img('i1')))!.relPath).toBe('角色/i1.png');
  });

  it('移到回收站只在库里标记，系统回收站什么也没收到', async () => {
    await demo.ds.bulkImages({ ids: [img('i1')], action: { type: 'trash' } });
    await demo.ds.pendingTrash.flushAll();
    expect(await demo.ds.getImage(img('i1'))).toBeNull();
    expect(demo.ports.trashed).toEqual([]);
  });

  it('演示数据的图库路径不可能是真实存在的文件夹', () => {
    const demoDb = buildDemoDb(NOW);
    for (const r of demoDb.settings.libraryRoots) expect(r.path.startsWith(`${DEMO_ROOT_PREFIX}/`)).toBe(true);
    for (const e of demoDb.exclusions) if (e.kind === 'folder') expect(e.target.startsWith(`${DEMO_ROOT_PREFIX}/`)).toBe(true);
    // Windows 上 < > 是非法字符
    expect(DEMO_ROOT_PREFIX).toMatch(/[<>]/);
  });
});

it('后台任务只走进度条：不扫描、不识别、不改数据', async () => {
  const before = await demo.ds.getStats();
  for (const kind of ['scan', 'tag', 'pixiv-tags', 'danbooru-sync', 'dedupe'] as const) await demo.ds.startJob(kind);
  for (let i = 0; i < 400 && (await demo.ds.listJobs()).some((j) => j.status === 'queued' || j.status === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const jobs = await demo.ds.listJobs();
  expect(jobs.map((j) => j.status).sort()).toEqual(['done', 'done', 'done', 'done', 'done']);
  expect(jobs.every((j) => j.message?.startsWith('演示数据'))).toBe(true);
  const after = await demo.ds.getStats();
  expect({ ...after, lastScanAt: before.lastScanAt }).toEqual(before);
});
