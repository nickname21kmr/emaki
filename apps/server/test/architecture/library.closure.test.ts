/**
 * 附录 #10、#11、#23 已关闭（P4a：入库与分析收口，docs/core-architecture.md 第 2.4、12、13 节 D1）。
 * #10 的主要用例（替换和外部修改走同一条路、结果一致）在 crossEntry.test.ts；这里是其余的关闭测试：
 * 写入只在图库与文件 / 分析模块（静态检查）、四条移动路径的后续处理相同、只有一处「不能动文件」的检查、
 * 合集判定的版本真正生效、派生数据的版本统一、回收站行的匹配规则、缓存回收不误删、暂停状态持久化。
 * 用真实的 SqliteDataSource；要动文件的在临时目录里放真的小图。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/events.ts';
import type { JobContext } from '../../src/core/jobs.ts';
import { SqliteDataSource, type SqliteOpenOptions } from '../../src/datasource/sqlite/SqliteDataSource.ts';
import { analyze } from '../../src/domain/analysis/analyze.ts';
import { DETECTOR_VERSION } from '../../src/domain/collections/detect.ts';
import { runAs } from '../../src/propagation/actor.ts';
import { recordedVersion } from '../../src/propagation/versions.ts';
import { isPaused } from '../../src/propagation/work.ts';
import { thumbPath } from '../../src/services/image/pixels.ts';
import { sharp } from '../../src/services/image/sharpConfig.ts';
import { makeTmpDir } from '../helpers/tmp.ts';
import { stripComments } from './sqlWrites.ts';
import { ALLOWED_WRITES } from './writers.allowlist.ts';

const SRC = path.resolve(import.meta.dirname, '../../src');
const OLD = new Date('2025-01-01T00:00:00.000Z');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** src 下非测试源码（相对 src，正斜杠）和去掉注释的内容 */
function sources(): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (/\.(ts|mts)$/.test(name.name) && !/\.test\.ts$/.test(name.name)) {
        const file = path.relative(SRC, p).split(path.sep).join('/');
        out.push({ file, code: stripComments(readFileSync(p, 'utf8'), file) });
      }
    }
  };
  walk(SRC);
  return out;
}
const filesMatching = (re: RegExp) =>
  sources()
    .filter((s) => re.test(s.code))
    .map((s) => s.file)
    .sort();

interface Env {
  ds: SqliteDataSource;
  lib: string;
  data: string;
  /** 送进「系统回收站」的文件 */
  recycled: string[];
  /** 系统回收站移不动（文件被占用） */
  trashFails: boolean;
}

/** 引擎 + 一个真实的图库文件夹（id 1）；系统回收站换成「挪到 recycle 目录」 */
async function engine(opts: SqliteOpenOptions & { file?: boolean } = {}): Promise<Env> {
  const dir = makeTmpDir('p4a-closure');
  const lib = path.join(dir, 'lib');
  const recycle = path.join(dir, 'recycle');
  mkdirSync(lib);
  mkdirSync(recycle);
  const env = { lib, data: path.join(dir, 'data'), recycled: [], trashFails: false } as unknown as Env;
  env.ds = await SqliteDataSource.open(new EventBus(), env.data, {
    memory: !opts.file,
    autoJobs: false,
    importDict: false,
    checkRecyclable: async () => {},
    trashImpl: async (paths) => {
      if (env.trashFails) throw new Error('文件被占用');
      for (const p of paths) {
        env.recycled.push(p);
        renameSync(p, path.join(recycle, `${env.recycled.length}-${path.basename(p)}`));
      }
    },
    ...opts,
  });
  cleanups.push(async () => {
    await env.ds.close();
    rmSync(dir, { recursive: true, force: true });
  });
  env.ds.ctx.db.prepare('INSERT INTO library_roots (id, path) VALUES (1, ?)').run(lib.replace(/\\/g, '/'));
  return env;
}

const png = (seed: number, w = 40) =>
  sharp({ create: { width: w, height: 60, channels: 3, background: { r: (seed * 37) % 256, g: (seed * 91) % 256, b: 150 } } }).png().toBuffer();

async function put(env: Env, rel: string, seed: number, at = OLD): Promise<string> {
  const file = path.join(env.lib, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, await png(seed));
  utimesSync(file, at, at);
  return file;
}

const job = (): JobContext => ({ signal: new AbortController().signal, setTotal() {}, advance() {}, setMessage() {}, shouldYield: () => false, requeue() {}, yielded: false });

/** 和扫描任务一样：job:scan 名下扫一遍，任务结束（做掉延后的全量重算） */
async function scan(env: Env): Promise<void> {
  env.ds.requests.requestFull();
  await runAs('job:scan', () => env.ds.scanner.scan(job()));
  env.ds.ctx.propagation.jobFinished('scan');
}

const idOf = (env: Env, file: string) => env.ds.ctx.db.prepare('SELECT id FROM images WHERE file_name = ? AND trashed_at IS NULL').pluck().get(file) as number | undefined;

describe('附录 #10、#23：写入只在图库与文件、分析模块；分类只有一个入口', () => {
  it('允许清单里没有图库与文件、分析的表和列（单一写入者测试保证没有别处在写）', () => {
    const libraryOrAnalysis = new Set(['library_roots', 'comic_folders', 'scan_errors', 'pending_trash', 'pending_trash_items', 'images#library', 'images#analysis', 'images#?']);
    expect(ALLOWED_WRITES.filter((a) => libraryOrAnalysis.has(a.table))).toEqual([]);
  });

  it('文件内容变化、入库、移动只由图库与文件模块声明；分类只在分析模块里算', () => {
    expect(filesMatching(/type:\s*'image\.fileChanged'/)).toEqual(['domain/library/images.ts']);
    expect(filesMatching(/type:\s*'image\.added'/)).toEqual(['domain/library/images.ts']);
    expect(filesMatching(/type:\s*'image\.moved'/)).toEqual(['domain/library/move.ts']);
    // 分类器只有分析模块调用（以前扫描、导入、缩略图、识别任务、识别写入、手动改类型各自调）
    expect(filesMatching(/\b(classifyContent|backfillClassification|computeClassification)\s*\(/)).toEqual([
      'domain/analysis/analyze.ts',
      'domain/analysis/classify.ts',
      'domain/analysis/reactions.ts',
      'domain/analysis/rootMode.ts',
      'services/classify/rules.ts',
    ]);
  });
});

describe('附录 #11：移动只有一条路径', () => {
  it('只有图库与文件模块动文件位置；「扫描或识别进行中不能动文件」只有一处', () => {
    expect(filesMatching(/\b(moveImageFiles|moveBack)\s*\(/)).toEqual(['domain/library/move.ts']);
    expect(filesMatching(/正在扫描图库/)).toEqual(['domain/library/guard.ts']);
  });

  /**
   * 两张推特图（gallery-dl 的命名）从 twitter/ 移进 twitter/alice/：来源（作者 alice）、漫画子文件夹（类型、自动关联）都按新位置重算。
   * 应用内「移动…」、整理到子文件夹、扫描发现的移动，后续处理一样；撤回移动回到原样
   */
  const files = ['twitter/1789012345678901234_1.png', 'twitter/1789012345678901235_1.png'];
  async function setup(): Promise<{ env: Env; ids: number[] }> {
    const env = await engine();
    for (const [i, f] of files.entries()) await put(env, f, i + 1);
    await scan(env);
    const db = env.ds.ctx.db;
    const ids = files.map((f) => idOf(env, path.posix.basename(f))!);
    // 识别过、自动关联了一个角色；twitter/alice 是按漫画导入的子文件夹
    db.prepare("INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (1, '爱丽丝', 'alice_(game_a)', 'danbooru', '2000-01-01')").run();
    for (const id of ids) {
      db.prepare("UPDATE images SET tagged_at = '2026-01-01' WHERE id = ?").run(id);
      db.prepare(
        `INSERT INTO image_characters (image_id, character_id, decision, actor, rule, evidence_provider, evidence_tag, evidence_score, added_at)
         VALUES (?, 1, 'auto', 'job:tag', 'auto-accept@2', 'tagger', 'alice_(game_a)', 0.9, '2026-01-01')`,
      ).run(id);
    }
    // 识别过了：分析模块按「识别过」重判一次（和识别写入之后一样）
    env.ds.ctx.apply(() => analyze(env.ds.ctx, ids));
    await env.ds.updateLibraryRoot('1', { comicFolder: { relDir: 'twitter/alice', comicRating: 'sensitive' } });
    return { env, ids };
  }
  const facts = (env: Env, ids: number[]) =>
    ids.map((id) =>
      env.ds.ctx.db
        .prepare(
          `SELECT rel_path, source_site, source_artist, content_kind, content_kind_source, retag,
             (SELECT COUNT(*) FROM image_characters ic WHERE ic.image_id = images.id) AS links FROM images WHERE id = ?`,
        )
        .get(id),
    );

  it('应用内移动、整理到子文件夹、扫描发现的移动：后续处理完全一样；撤回移动回到原样', async () => {
    const results: unknown[] = [];
    // 1. 应用内「移动…」
    {
      const { env, ids } = await setup();
      const before = facts(env, ids);
      await env.ds.moveImages({ ids: ids.map(String), rootId: '1', dir: 'twitter/alice' });
      results.push(facts(env, ids));
      expect(await env.ds.listChanges('move')).toHaveLength(1);
      // 4. 撤回移动（「最近的移动」里移回）：路径、来源、类型、自动关联都回到原样
      const [entry] = await env.ds.listChanges('move');
      await env.ds.revertChange(entry!.id);
      expect(facts(env, ids)).toEqual(before);
    }
    // 2. 整理到子文件夹（组名 alice）
    {
      const { env, ids } = await setup();
      await env.ds.createCollection({ imageIds: ids.map(String), kind: 'group', title: 'alice', organizeFiles: true });
      results.push(facts(env, ids));
      expect(await env.ds.listChanges('move')).toHaveLength(1);
    }
    // 3. 扫描发现的移动（外部程序挪的）：不记 change_log（不是 Emaki 动的文件），后续处理一样
    {
      const { env, ids } = await setup();
      mkdirSync(path.join(env.lib, 'twitter/alice'));
      for (const f of files) renameSync(path.join(env.lib, f), path.join(env.lib, 'twitter/alice', path.posix.basename(f)));
      await scan(env);
      results.push(facts(env, ids));
      expect(await env.ds.listChanges('move')).toHaveLength(0);
    }
    expect(results[0]).toEqual([
      {
        rel_path: 'twitter/alice/1789012345678901234_1.png',
        source_site: 'twitter',
        source_artist: 'alice',
        content_kind: 'comic',
        content_kind_source: 'folder',
        retag: 1,
        links: 0,
      },
      expect.objectContaining({ source_artist: 'alice', content_kind: 'comic', links: 0 }),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('扫描正在跑：移动、整理、移回、替换、撤销替换、撤销导入都被同一处检查挡住，什么都不动', async () => {
    const { env, ids } = await setup();
    await env.ds.moveImages({ ids: [String(ids[0])], rootId: '1', dir: 'elsewhere' });
    const [entry] = await env.ds.listChanges('move');
    const replacement = path.join(env.data, '..', 'hd.png');
    writeFileSync(replacement, await png(9, 80));
    const replaced = await env.ds.replaceImage(String(ids[1]), { path: replacement });
    const download = path.join(env.data, '..', 'new.png');
    writeFileSync(download, await png(10));
    const imported = await env.ds.importImages({ rootId: '1', dir: 'inbox', files: [{ path: download }] });
    const running = [{ id: 'j', kind: 'scan', status: 'running' }] as unknown as ReturnType<typeof env.ds.ctx.jobs.list>;
    vi.spyOn(env.ds.ctx.jobs, 'list').mockReturnValue(running);
    const snapshot = () => env.ds.ctx.db.prepare('SELECT id, root_id, rel_path, sha256, trashed_at FROM images ORDER BY id').all();
    const before = snapshot();
    const busy = /正在扫描图库，等扫描结束再/;
    await expect(env.ds.moveImages({ ids: [String(ids[1])], rootId: '1', dir: 'x' })).rejects.toThrow(busy);
    await expect(env.ds.createCollection({ imageIds: ids.map(String), kind: 'group', title: 'g', organizeFiles: true })).rejects.toThrow(busy);
    await expect(env.ds.revertChange(entry!.id)).rejects.toThrow(busy);
    await expect(env.ds.replaceImage(String(ids[0]), { path: replacement })).rejects.toThrow(busy);
    await expect(env.ds.undo(replaced.undoToken!)).rejects.toThrow(busy);
    await expect(env.ds.undo(imported.undoToken!)).rejects.toThrow(busy);
    expect(snapshot()).toEqual(before);
  });
});

describe('附录 #23：合集判定的版本真正生效', () => {
  /** 三个 20 页的书文件夹（页码文件名、书页比例） */
  const seed = (db: SqliteDataSource['ctx']['db'], lib: string) => {
    db.prepare('INSERT INTO library_roots (id, path) VALUES (1, ?)').run(lib);
    const ins = db.prepare(`INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, tagged_at)
      VALUES (1, ?, ?, 1200, 1700, 1000, 'jpeg', ?, '2026-01-01', '2026-01-01', '2026-01-01')`);
    for (const book of ['Book1', 'Book2', 'Book3'])
      for (let i = 1; i <= 20; i++) {
        const name = `${String(i).padStart(3, '0')}.jpg`;
        ins.run(`${book}/${name}`, name, `${book}-${i}`);
      }
  };

  it('版本没变时启动不全量重判；版本变了全量重判自动合集，手动的、说了不成册的不动', async () => {
    const dir = makeTmpDir('p4a-detector');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const data = path.join(dir, 'data');
    const lib = path.join(dir, 'lib').replace(/\\/g, '/');
    const open = (opts: SqliteOpenOptions = {}) => SqliteDataSource.open(new EventBus(), data, { autoJobs: false, importDict: false, ...opts });
    // 第一次打开：还没记过判定的版本，全量判定，记下现在的版本
    let ds = await open({ seed: (db) => seed(db, lib) });
    const db = () => ds.ctx.db;
    const list = () =>
      db().prepare("SELECT rel_dir, origin, state, title, detector_version FROM collections WHERE membership = 'folder' ORDER BY rel_dir").all() as {
        rel_dir: string;
        origin: string;
        state: string;
        title: string | null;
        detector_version: number;
      }[];
    expect(list().map((c) => [c.rel_dir, c.origin, c.state])).toEqual([
      ['Book1', 'auto', 'active'],
      ['Book2', 'auto', 'active'],
      ['Book3', 'auto', 'active'],
    ]);
    expect(recordedVersion(db(), 'collections')).toBe(String(DETECTOR_VERSION));
    // 用户把 Book2 改成手动的（改了名），Book3 说了「不成册」；再造出一份旧判定留下的结果：自动合集 Book1 的名字是旧规则起的，
    // 还有一本旧规则判出来、现在的规则不会判的自动合集（目录里没有页）
    db().exec(`
      UPDATE collections SET origin = 'manual', title = '我的书', title_manual = 1 WHERE rel_dir = 'Book2';
      UPDATE collections SET state = 'dismissed' WHERE rel_dir = 'Book3';
      UPDATE collections SET title = '旧规则起的名字', detector_version = ${DETECTOR_VERSION - 1} WHERE rel_dir = 'Book1';
      INSERT INTO collections (root_id, rel_dir, kind, kind_source, title, page_order, origin, state, detector_version, created_at, updated_at)
        VALUES (1, 'OldRule', 'doujin', 'pages', '旧规则判的', 'name', 'auto', 'active', ${DETECTOR_VERSION - 1}, '2026-01-01', '2026-01-01');
    `);
    const tampered = list();
    await ds.close();

    // 版本没变、也没有没做完的延后重算：启动不全量重判（以前每次启动都无条件全量重算，版本号存了从不检查）
    ds = await open();
    expect(list()).toEqual(tampered);
    // 判定规则升级了（库里记的是旧版本）：启动时全量重判
    db().prepare("UPDATE derived_versions SET version = ? WHERE name = 'collections'").run(String(DETECTOR_VERSION - 1));
    await ds.close();
    ds = await open();
    cleanups.push(() => ds.close());
    const after = list();
    // 自动合集按现在的规则重判：旧规则判出来的那本删掉，Book1 的名字按现在的规则起，版本记成现在的
    expect(after.map((c) => c.rel_dir)).toEqual(['Book1', 'Book2', 'Book3']);
    expect(after[0]).toMatchObject({ origin: 'auto', state: 'active', detector_version: DETECTOR_VERSION });
    expect(after[0]!.title).not.toBe('旧规则起的名字');
    // 手动的保留手动改的名字；说了不成册的还是不成册
    expect(after[1]).toMatchObject({ origin: 'manual', title: '我的书' });
    expect(after[2]).toMatchObject({ state: 'dismissed' });
    expect(recordedVersion(db(), 'collections')).toBe(String(DETECTOR_VERSION));
  });

  it('派生数据的版本统一记在 derived_versions；没人读写的 image_fingerprints 删了', async () => {
    const { ds } = await engine();
    const db = ds.ctx.db;
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'image_fingerprints'").get()).toBeUndefined();
    expect(db.prepare("SELECT key FROM settings WHERE key IN ('sourceParserVersion', 'sourceParserMode')").all()).toEqual([]);
    expect((db.prepare('SELECT name FROM derived_versions ORDER BY name').pluck().all() as string[]).sort()).toEqual(['classification', 'collections', 'source']);
  });
});

describe('附录 #23：回收站里的行不再永远是移动匹配的候选', () => {
  /** 移到回收站，并把延后的批次真的送进系统回收站 */
  async function trash(env: Env, id: number): Promise<void> {
    await env.ds.bulkImages({ ids: [String(id)], action: { type: 'trash' } });
    await env.ds.pendingTrash.flushAll();
  }

  it('送进系统回收站之后重新下载同样的文件（别的位置、同一个位置）：都是新 id，旧关联不复活', async () => {
    const env = await engine();
    await put(env, 'a/x.png', 1);
    await put(env, 'a/y.png', 2);
    await scan(env);
    const [x, y] = [idOf(env, 'x.png')!, idOf(env, 'y.png')!];
    env.ds.ctx.db.prepare("UPDATE images SET favorite = 1 WHERE id IN (?, ?)").run(x, y);
    await trash(env, x);
    await trash(env, y);
    expect(env.recycled.map((p) => path.basename(p))).toEqual(['x.png', 'y.png']);
    // 已经送进系统回收站：标成丢失（丢弃的行）
    expect(env.ds.ctx.db.prepare('SELECT trashed_at IS NOT NULL AS t, missing FROM images WHERE id IN (?, ?)').all(x, y)).toEqual([
      { t: 1, missing: 1 },
      { t: 1, missing: 1 },
    ]);
    // 重新下载：x 的内容放到别的位置（以前按 sha 匹配会把旧行「移」过来），y 放回原位（以前按路径复活旧行），时间也一样
    await put(env, 'b/x-again.png', 1);
    await put(env, 'a/y.png', 2);
    await scan(env);
    const x2 = idOf(env, 'x-again.png')!;
    const y2 = idOf(env, 'y.png')!;
    expect([x2, y2].every((id) => id > y)).toBe(true);
    expect(env.ds.ctx.db.prepare('SELECT favorite FROM images WHERE id IN (?, ?)').pluck().all(x2, y2)).toEqual([0, 0]);
    // 旧行还在（已处理的重复组要显示被删的图），还在回收站里；y 的旧行让出了路径
    const old = env.ds.ctx.db.prepare('SELECT id, rel_path, trashed_at IS NOT NULL AS t FROM images WHERE id IN (?, ?) ORDER BY id').all(x, y) as { id: number; rel_path: string; t: number }[];
    expect(old.map((r) => r.t)).toEqual([1, 1]);
    expect(old[0]!.rel_path).toBe('a/x.png');
    expect(old[1]!.rel_path).toBe(`.emaki-discarded/${y}/a/y.png`);
    // 再扫一遍不变
    await scan(env);
    expect(idOf(env, 'y.png')).toBe(y2);
    // 显式导入同名文件到丢弃的行的位置：不算重名，新 id
    const download = path.join(env.data, '..', 'x.png');
    writeFileSync(download, await png(7));
    const imported = await env.ds.importImages({ rootId: '1', dir: 'a', files: [{ path: download }] });
    expect(imported.items[0]).toMatchObject({ status: 'imported' });
    expect(Number((imported.items[0] as { imageId: string }).imageId)).toBeGreaterThan(y2);
    expect(env.ds.ctx.db.prepare('SELECT rel_path FROM images WHERE id = ?').pluck().get(x)).toBe(`.emaki-discarded/${x}/a/x.png`);
  });

  it('还在撤销窗口里的不动；没能送进系统回收站的（文件被占用）下次扫描照常回来', async () => {
    const env = await engine();
    await put(env, 'a/x.png', 1);
    await put(env, 'a/y.png', 2);
    await scan(env);
    const [x, y] = [idOf(env, 'x.png')!, idOf(env, 'y.png')!];
    // x：还在撤销窗口里（文件还在原处），扫描不当它回来了，也不当别的文件的移动来源
    await env.ds.bulkImages({ ids: [String(x)], action: { type: 'trash' } });
    await put(env, 'b/x-copy.png', 1);
    await scan(env);
    expect(env.ds.ctx.db.prepare('SELECT trashed_at IS NOT NULL FROM images WHERE id = ?').pluck().get(x)).toBe(1);
    expect(idOf(env, 'x-copy.png')).not.toBe(x);
    // y：系统回收站移不动（被占用）：行还是回收站状态但没丢失，文件还在原处 → 下次扫描回来（同一个 id）
    env.trashFails = true;
    await env.ds.bulkImages({ ids: [String(y)], action: { type: 'trash' } });
    await env.ds.pendingTrash.flushAll();
    expect(env.ds.ctx.db.prepare('SELECT missing FROM images WHERE id = ?').pluck().get(y)).toBe(0);
    await scan(env);
    expect(env.ds.ctx.db.prepare('SELECT trashed_at FROM images WHERE id = ?').pluck().get(y)).toBeNull();
  });
});

describe('附录 #23：缓存回收', () => {
  it('替换之后旧版本的缩略图等撤销令牌过期才删，替换备份同样；图库里的文件一个不碰', async () => {
    const env = await engine();
    const file = await put(env, 'a/x.png', 1);
    await put(env, 'a/y.png', 2);
    await scan(env);
    env.ds.ctx.db.prepare("UPDATE library_roots SET last_scan_at = '2026-01-01'").run();
    const x = idOf(env, 'x.png')!;
    const oldSha = env.ds.ctx.db.prepare('SELECT sha256 FROM images WHERE id = ?').pluck().get(x) as string;
    const thumbs = path.join(env.data, 'thumbs', 'v1');
    const oldThumb = thumbPath(thumbs, oldSha, 480);
    mkdirSync(path.dirname(oldThumb), { recursive: true });
    writeFileSync(oldThumb, 'old thumb');
    utimesSync(oldThumb, OLD, OLD);
    const hd = path.join(env.data, '..', 'hd.png');
    writeFileSync(hd, await png(5, 80));
    vi.spyOn(env.ds.pipeline, 'afterImport').mockImplementation(() => {});
    const replaced = await env.ds.replaceImage(String(x), { path: hd });
    const libraryFiles = () => readdirSync(env.lib, { recursive: true }).map(String).sort();
    const before = libraryFiles();

    // 撤销令牌还能用：旧版本的缩略图和备份都留着（撤销后马上能用）
    await env.ds.collectCacheGarbage();
    expect(existsSync(oldThumb)).toBe(true);
    expect(readdirSync(path.join(env.data, 'image-replacements'))).toHaveLength(1);
    // 令牌过期（被挤出撤销栈、重启）之后：旧 sha 没人引用了，缩略图和备份都删掉
    env.ds.ctx.undo.expire(replaced.undoToken!);
    const res = await env.ds.collectCacheGarbage();
    expect(res).toEqual({ thumbs: 1, animations: 0, backups: 1 });
    expect(existsSync(oldThumb)).toBe(false);
    expect(readdirSync(path.join(env.data, 'image-replacements'))).toHaveLength(0);
    expect(libraryFiles()).toEqual(before);
    expect(existsSync(file)).toBe(true);
    unlinkSync(hd);
  });
});

describe('第 7 节：暂停状态持久化', () => {
  it('用户取消了识别、画师补跑、Pixiv 补充：重启之后还是暂停的，手动开始才恢复', async () => {
    const env = await engine({ file: true });
    env.ds.pipeline.notePaused('tag');
    env.ds.pipeline.notePaused('pixiv-tags');
    await env.ds.close();
    env.ds = await SqliteDataSource.open(new EventBus(), env.data, { autoJobs: false, importDict: false });
    expect([isPaused(env.ds.ctx.db, 'tag'), isPaused(env.ds.ctx.db, 'artists'), isPaused(env.ds.ctx.db, 'pixiv-tags')]).toEqual([true, false, true]);
    env.ds.pipeline.noteManualStart('tag');
    expect(isPaused(env.ds.ctx.db, 'tag')).toBe(false);
  });
});
