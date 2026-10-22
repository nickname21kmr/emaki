import { rmSync } from 'node:fs';
import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { EventBus } from '../../core/events.ts';
import type { JobContext } from '../../core/jobs.ts';
import { openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { walkImages } from '../fs/walk.ts';
import { sharp } from '../image/sharpConfig.ts';
import { Scanner, type ScanSummary } from './Scanner.ts';
import { ScanRequests } from './ScanRequests.ts';

const ctx = (): JobContext => ({
  signal: new AbortController().signal,
  setTotal() {},
  advance() {},
  setMessage() {},
  shouldYield: () => false,
  requeue() {},
  yielded: false,
});

const png = (seed: number) =>
  sharp({ create: { width: 40 + seed, height: 60, channels: 3, background: { r: seed * 20, g: 100, b: 200 - seed * 10 } } })
    .png()
    .toBuffer();

describe('Scanner', () => {
  let root: string;
  let data: string;
  let db: Db;
  let requests: ScanRequests;
  const scanner = (settleMs = 0) => new Scanner({ db, bus: new EventBus(), dataDir: data, requests, settleMs });
  const scan = (settleMs = 0): Promise<ScanSummary> => scanner(settleMs).scan(ctx());
  const put = async (rel: string, seed: number) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), await png(seed));
  };
  const row = (fileName: string) =>
    db.prepare('SELECT id, rel_path, sha256, missing FROM images WHERE file_name = ?').get(fileName) as
      | { id: number; rel_path: string; sha256: string; missing: number }
      | undefined;

  beforeEach(async () => {
    root = makeTmpDir('scan-root');
    data = makeTmpDir('scan-data');
    db = openDatabase(':memory:');
    migrate(db);
    requests = new ScanRequests();
    db.prepare('INSERT INTO library_roots (path) VALUES (?)').run(root.replace(/\\/g, '/'));
    await put('a/one.png', 1);
    await put('a/two.png', 2);
    await put('b/three.png', 3);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  it('按漫画导入的文件夹：入库就归漫画，分级用导入时选的', async () => {
    db.prepare("UPDATE library_roots SET content_mode = 'comic', comic_rating = 'sensitive'").run();
    await scan();
    expect(db.prepare('SELECT DISTINCT content_kind, content_kind_source, content_kind_evidence, rating FROM images').all()).toEqual([
      { content_kind: 'comic', content_kind_source: 'folder', content_kind_evidence: '按漫画导入的文件夹', rating: 'sensitive' },
    ]);
  });

  it('新增', async () => {
    const s = await scan();
    expect(s).toMatchObject({ added: 3, missing: 0, errors: 0 });
    expect((await scan()).added).toBe(0);
  });

  it('新增和改名都遵循 Pixiv 文件名识别模式', async () => {
    const sourceOf = (name: string) => db.prepare('SELECT source_post_id FROM images WHERE file_name=?').pluck().get(name);
    await put('104714967_３人で奉仕.png', 6);
    await scan();
    expect(sourceOf('104714967_３人で奉仕.png')).toBeNull();
    db.prepare("INSERT INTO settings(key,value) VALUES('tagger',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({pixivFilenameMode:'broad'}));
    await put('108301050_ヘルモルト姉妹丼　その３.png', 7);
    await rename(path.join(root,'a/one.png'),path.join(root,'144506494_标题_3.png'));
    await scan();
    expect(sourceOf('104714967_３人で奉仕.png')).toBe('104714967');
    expect(sourceOf('108301050_ヘルモルト姉妹丼　その３.png')).toBe('108301050');
    expect(sourceOf('144506494_标题_3.png')).toBe('144506494');
    db.prepare("UPDATE settings SET value=? WHERE key='tagger'").run(JSON.stringify({pixivFilenameMode:'strict'}));
    await rename(path.join(root,'144506494_标题_3.png'),path.join(root,'144506494_另一标题.png'));
    await scan();
    expect(sourceOf('144506494_另一标题.png')).toBeNull();
  });

  it('改名和内容更新保留人工来源及主动清空，自动来源仍能解析', async () => {
    await scan();
    const first = row('one.png')!.id;
    const second = row('two.png')!.id;
    db.prepare("UPDATE images SET source_manual=1, source_site='other', source_url='https://example.com/original' WHERE id=?").run(first);
    db.prepare('UPDATE images SET source_manual=1 WHERE id=?').run(second);
    await rename(path.join(root, 'a/one.png'), path.join(root, 'a/98785437_p0.png'));
    await rename(path.join(root, 'a/two.png'), path.join(root, 'a/98785438_p0.png'));
    await rename(path.join(root, 'b/three.png'), path.join(root, 'b/98785439_p0.png'));
    expect((await scan()).moved).toBe(3);
    expect(row('98785437_p0.png')!.id).toBe(first);
    expect(row('98785438_p0.png')!.id).toBe(second);
    const sources = () => db.prepare('SELECT source_manual, source_site, source_url FROM images ORDER BY id').all();
    const preserved = sources();
    expect(db.prepare('SELECT source_site, source_url FROM images WHERE id=?').get(first)).toEqual({ source_site: 'other', source_url: 'https://example.com/original' });
    expect(db.prepare('SELECT source_site, source_url FROM images WHERE id=?').get(second)).toEqual({ source_site: null, source_url: null });
    expect(db.prepare("SELECT source_post_id FROM images WHERE file_name='98785439_p0.png'").pluck().get()).toBe('98785439');
    await put('a/98785437_p0.png', 9);
    const future = new Date(Date.now() + 10000);
    await utimes(path.join(root, 'a/98785437_p0.png'), future, future);
    expect((await scan()).updated).toBe(1);
    expect(sources()).toEqual(preserved);
  });

  it('整根扫描（新添加文件夹）更新上次扫描时间，子目录扫描不更新', async () => {
    const last = () => db.prepare('SELECT last_scan_at FROM library_roots').pluck().get();
    requests.addDirty({ rootId: 1, relDir: 'a', recursive: true });
    await scan();
    expect(last()).toBeNull();
    requests.addDirty({ rootId: 1, relDir: '', recursive: true });
    await scan();
    expect(last()).not.toBeNull();
  });

  it('移动后 id 不变', async () => {
    await scan();
    const before = row('one.png')!;
    await rename(path.join(root, 'a/one.png'), path.join(root, 'b/one.png'));
    expect((await scan()).moved).toBe(1);
    expect(row('one.png')).toMatchObject({ id: before.id, rel_path: 'b/one.png', missing: 0 });
  });

  it('改名 + 删除原文件：按 sha 认出是同一张', async () => {
    await scan();
    const before = row('two.png')!;
    await rename(path.join(root, 'a/two.png'), path.join(root, 'a/renamed.png'));
    expect((await scan()).moved).toBe(1);
    expect(row('renamed.png')?.id).toBe(before.id);
  });

  it('删除 → missing，放回 → 恢复', async () => {
    await scan();
    const buf = await png(3);
    await rm(path.join(root, 'b/three.png'));
    expect((await scan()).missing).toBe(1);
    expect(row('three.png')?.missing).toBe(1);
    await writeFile(path.join(root, 'b/three.png'), buf);
    await scan();
    expect(row('three.png')?.missing).toBe(0);
  });

  it('遍历时漏掉了、其实还在的文件（移动硬盘中途断开又接上）不标丢失；真删掉的照常标', async () => {
    await scan();
    await rm(path.join(root, 'b/three.png'));
    // 遍历时 one.png 读不到（没有报目录错误），实际文件还在
    const flaky: typeof walkImages = async function* (rootPath, o) {
      for await (const e of walkImages(rootPath, o)) if (!e.relPath.endsWith('one.png')) yield e;
    };
    const s = await new Scanner({ db, bus: new EventBus(), dataDir: data, requests, settleMs: 0, walk: flaky }).scan(ctx());
    expect(s.missing).toBe(1);
    expect(row('one.png')?.missing).toBe(0);
    expect(row('three.png')?.missing).toBe(1);
  });

  it('改内容后 id 不变但 sha 变了', async () => {
    await scan();
    const before = row('one.png')!;
    const file = path.join(root, 'a/one.png');
    await writeFile(file, await png(9));
    const t = new Date(Date.now() + 10_000); // 保证 mtime 一定变化
    await utimes(file, t, t);
    expect((await scan()).updated).toBe(1);
    const after = row('one.png')!;
    expect(after.id).toBe(before.id);
    expect(after.sha256).not.toBe(before.sha256);
  });

  it('刚写入的文件延后处理', async () => {
    // 刚写的文件修改时间偶尔会比 Date.now() 晚几毫秒（文件系统取整），会被当成「时钟不同步」不延后；固定成 1 秒前
    const t = new Date(Date.now() - 1000);
    for (const rel of ['a/one.png', 'a/two.png', 'b/three.png']) await utimes(path.join(root, rel), t, t);
    const s = await scan(60_000);
    expect(s.deferred).toBe(3);
    expect(s.added).toBe(0);
    expect(requests.pending).toBe(true);
  });

  it('读不了的文件记进 scan_errors，不重复报错', async () => {
    await writeFile(path.join(root, 'a/fake.png'), '不是图片');
    expect((await scan()).errors).toBe(1);
    expect((await scan()).errors).toBe(0);
    expect(db.prepare('SELECT count(*) FROM scan_errors').pluck().get()).toBe(1);
  });

  // 遍历时起点目录读不了（EPERM）
  const denied: typeof walkImages = async function* (_rootPath, o) {
    o?.onDirError?.(o.startRel ?? '', Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    yield* [];
  };
  const scanDenied = () => new Scanner({ db, bus: new EventBus(), dataDir: data, requests, settleMs: 0, walk: denied }).scan(ctx());
  const dirty = (...dirs: string[]) => {
    for (const relDir of dirs) requests.addDirty({ rootId: 1, relDir, recursive: true });
  };

  it('运行中整个文件夹改名（监听报上旧名和新名）：按移动处理，id 不变', async () => {
    await scan();
    const ids = [row('one.png')!.id, row('two.png')!.id];
    await rename(path.join(root, 'a'), path.join(root, 'c'));
    dirty('a', 'c');
    expect(await scan()).toMatchObject({ added: 0, moved: 2, missing: 0 });
    expect([row('one.png'), row('two.png')]).toMatchObject([
      { id: ids[0], rel_path: 'c/one.png', missing: 0 },
      { id: ids[1], rel_path: 'c/two.png', missing: 0 },
    ]);
  });

  it('运行中整个文件夹被删除：下面的行标丢失；读不了（不是不在了）的照样不标', async () => {
    await scan();
    dirty('a');
    expect((await scanDenied()).missing).toBe(0);
    await rm(path.join(root, 'a'), { recursive: true });
    dirty('a');
    expect((await scan()).missing).toBe(2);
    expect([row('one.png')?.missing, row('two.png')?.missing, row('three.png')?.missing]).toEqual([1, 1, 0]);
  });

  it('文件夹改成 . 开头藏起来（监听报上旧名和新名）：里面的图不入库，原来的行标丢失', async () => {
    await scan();
    await rename(path.join(root, 'a'), path.join(root, '.a'));
    dirty('a', '.a');
    expect(await scan()).toMatchObject({ added: 0, moved: 0, missing: 2 });
    expect(db.prepare("SELECT count(*) FROM images WHERE rel_path GLOB '.a/*'").pluck().get()).toBe(0);
  });

  const win = it.runIf(process.platform === 'win32');

  win('Windows：文件夹只改了大小写（a → A）：按移动处理，不产生重复行，之后全量扫描也没有变化', async () => {
    await scan();
    const ids = [row('one.png')!.id, row('two.png')!.id];
    await rename(path.join(root, 'a'), path.join(root, 'A'));
    dirty('a', 'A');
    expect(await scan()).toMatchObject({ added: 0, moved: 2, missing: 0 });
    expect([row('one.png'), row('two.png')]).toMatchObject([
      { id: ids[0], rel_path: 'A/one.png', missing: 0 },
      { id: ids[1], rel_path: 'A/two.png', missing: 0 },
    ]);
    expect(await scan()).toMatchObject({ added: 0, updated: 0, moved: 0, missing: 0 });
    expect(db.prepare('SELECT count(*) FROM images').pluck().get()).toBe(3);
  });

  // SQLite 的 NOCASE 只认 ASCII，Ä/ä 这种以前读库时读不到旧写法的行，会另外入库，全量扫描再把带收藏的原行标丢失
  win('Windows：非 ASCII 字母只改大小写（Äpfel → äpfel）：同样按移动处理，收藏还在', async () => {
    await rename(path.join(root, 'a'), path.join(root, 'Äpfel'));
    await scan();
    db.prepare("UPDATE images SET favorite = 1 WHERE rel_path GLOB 'Äpfel/*'").run();
    const ids = [row('one.png')!.id, row('two.png')!.id];
    await rename(path.join(root, 'Äpfel'), path.join(root, 'äpfel'));
    dirty('Äpfel', 'äpfel');
    expect(await scan()).toMatchObject({ added: 0, moved: 2, missing: 0 });
    expect(await scan()).toMatchObject({ added: 0, updated: 0, moved: 0, missing: 0 });
    expect(db.prepare('SELECT id, rel_path, missing, favorite FROM images WHERE file_name IN (?, ?) ORDER BY file_name').all('one.png', 'two.png')).toEqual([
      { id: ids[0], rel_path: 'äpfel/one.png', missing: 0, favorite: 1 },
      { id: ids[1], rel_path: 'äpfel/two.png', missing: 0, favorite: 1 },
    ]);
    expect(db.prepare('SELECT count(*) FROM images').pluck().get()).toBe(3);
  });

  win('Windows：以前留下的大小写重复行：全量扫描把旧写法的那行标丢失', async () => {
    await scan();
    await rename(path.join(root, 'a'), path.join(root, 'A'));
    // 修复前的增量扫描会按新写法另外入库一份
    db.prepare(
      `INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
       SELECT root_id, 'A/' || file_name, file_name, width, height, bytes, format, sha256, added_at, modified_at FROM images WHERE rel_path GLOB 'a/*'`,
    ).run();
    const old = db.prepare("SELECT id FROM images WHERE rel_path GLOB 'a/*' ORDER BY id").pluck().all();
    expect((await scan()).missing).toBe(2);
    expect(db.prepare('SELECT id FROM images WHERE missing = 1 ORDER BY id').pluck().all()).toEqual(old);
  });

  win('Windows：旧写法的行所在的目录读不了：不标丢失', async () => {
    await scan();
    await rename(path.join(root, 'a'), path.join(root, 'A'));
    dirty('A');
    expect((await scanDenied()).missing).toBe(0);
    expect([row('one.png')?.missing, row('two.png')?.missing]).toEqual([0, 0]);
  });
});
