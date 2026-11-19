/**
 * 缓存回收（附录 #23）：只删数据目录下缩略图、动图缓存里没人引用的文件，和撤销令牌已经过期的替换备份；
 * 绝不碰用户图库里的文件、名字不对的文件、符号链接，也不删还在等撤销的备份。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { UndoStack } from '../../core/undo.ts';
import { openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { collectReplacementBackups } from '../library/replace.ts';
import { collectCaches } from './cacheGc.ts';

const sha = (c: string) => c.repeat(64);
const OLD = new Date('2026-01-01T00:00:00Z');

let dir: string;
let data: string;
let lib: string;
let db: Db;

const put = (file: string, body = 'x', at = OLD) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  utimesSync(file, at, at);
  return file;
};
const thumb = (s: string, w = 480) => path.join(data, 'thumbs', 'v1', s.slice(0, 2), `${s}_${w}.webp`);
const anim = (s: string) => path.join(data, 'animations', 'v1', s.slice(0, 2), `${s}.webp`);
const addImage = (id: number, s: string, extra = '') =>
  db
    .prepare(
      `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at${extra ? ', trashed_at, missing' : ''})
       VALUES (?, 1, ?, ?, 1, 1, 1, 'png', ?, 'x', 'x'${extra ? ", 'x', 1" : ''})`,
    )
    .run(id, `p/${id}.png`, `${id}.png`, s);

beforeEach(() => {
  dir = makeTmpDir('cache-gc');
  data = path.join(dir, 'data');
  lib = path.join(dir, 'library');
  mkdirSync(data, { recursive: true });
  mkdirSync(lib, { recursive: true });
  db = openDatabase(':memory:');
  migrate(db);
  db.prepare("INSERT INTO library_roots (id, path, last_scan_at) VALUES (1, ?, 'x')").run(lib);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('缩略图、动图缓存', () => {
  it('只删没有任何图片引用的；回收站里的、丢失的图也算引用；名字不对、分片不对、符号链接、刚写的都不碰', async () => {
    addImage(1, sha('a'));
    addImage(2, sha('b'), 'trashed');
    const keep = [thumb(sha('a')), thumb(sha('a'), 240), thumb(sha('b')), anim(sha('a'))].map((f) => put(f));
    const gone = [thumb(sha('c')), thumb(sha('c'), 960), anim(sha('d'))].map((f) => put(f));
    // 名字不对、放错了分片、别的扩展名：不认识的东西一概不碰
    const odd = [
      put(path.join(data, 'thumbs', 'v1', 'cc', `${sha('c')}_480.webp.tmp`)),
      put(path.join(data, 'thumbs', 'v1', 'dd', `${sha('c')}_480.webp`)),
      put(path.join(data, 'thumbs', 'v1', 'cc', `${sha('c')}_480.png`)),
      put(path.join(data, 'thumbs', 'v1', 'notes.txt')),
      put(path.join(data, 'thumbs', 'v2', sha('e').slice(0, 2), `${sha('e')}_480.webp`)),
    ];
    // 图库里的文件，名字恰好像缩略图：在缓存目录里放一个指向它的符号链接，回收不能顺着链接删掉它
    const userFile = put(path.join(lib, `${sha('f')}_480.webp`), 'user');
    const link = thumb(sha('f'));
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(userFile, link);
    // 回收开始之后才写的（正在生成的缩略图）
    const fresh = put(thumb(sha('9')), 'x', new Date(Date.now() + 60_000));

    const res = await collectCaches(db, data, { roots: [lib] });
    expect(res).toEqual({ thumbs: 2, animations: 1 });
    for (const f of [...keep, ...odd, fresh, userFile]) expect(existsSync(f), f).toBe(true);
    for (const f of gone) expect(existsSync(f), f).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('还在等撤销的替换备份的原版本留着', async () => {
    addImage(1, sha('a'));
    const old = put(thumb(sha('b')));
    expect(await collectCaches(db, data, { roots: [lib], keep: new Set([sha('b')]) })).toEqual({ thumbs: 0, animations: 0 });
    expect(existsSync(old)).toBe(true);
  });

  it('缓存目录和图库文件夹重叠、缓存目录是指到别处的链接时整个不做', async () => {
    addImage(1, sha('a'));
    const f = put(thumb(sha('c')));
    // 图库文件夹就是数据目录里面的缓存目录（不该发生，防一手）
    expect(await collectCaches(db, data, { roots: [path.join(data, 'thumbs')] })).toEqual({ thumbs: 0, animations: 0 });
    expect(existsSync(f)).toBe(true);
    // 缓存目录被换成指向图库的链接
    rmSync(path.join(data, 'thumbs'), { recursive: true, force: true });
    mkdirSync(path.join(data, 'thumbs'), { recursive: true });
    const inLib = put(path.join(lib, 'v1', 'cc', `${sha('c')}_480.webp`), 'user');
    symlinkSync(path.join(lib, 'v1'), path.join(data, 'thumbs', 'v1'));
    expect(await collectCaches(db, data, { roots: [lib] })).toEqual({ thumbs: 0, animations: 0 });
    expect(existsSync(inLib)).toBe(true);
  });

  it('图库里一张图都没有、或者有图库文件夹还从没扫完过时不做（库刚重建，扫完会接着用这些缓存）', async () => {
    const f = put(thumb(sha('c')));
    expect(await collectCaches(db, data, { roots: [lib] })).toBeNull();
    addImage(1, sha('a'));
    db.prepare("INSERT INTO library_roots (id, path) VALUES (2, '/somewhere/else')").run();
    expect(await collectCaches(db, data, { roots: [lib] })).toBeNull();
    expect(existsSync(f)).toBe(true);
  });
});

describe('替换备份', () => {
  const backup = (name: string, record: object | null, at = OLD) => {
    const d = path.join(data, 'image-replacements', name);
    put(path.join(d, 'original.bin'), 'old bytes', at);
    if (record) put(path.join(d, 'record.json'), JSON.stringify(record), at);
    utimesSync(d, at, at);
    return d;
  };
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('撤销令牌还能用的留着；用掉、过期（包括重启前发的）的删掉；还没来得及记令牌的新备份留着；别的东西不碰', () => {
    const undo = new UndoStack();
    const live = undo.push('替换', () => {});
    const used = undo.push('替换', () => {});
    void undo.run(used);
    const startedAt = Date.now() - 1000;
    const keepLive = backup(uuid(1), { media: { sha256: sha('a') }, undoToken: live });
    const dropUsed = backup(uuid(2), { media: { sha256: sha('b') }, undoToken: used });
    const dropRestart = backup(uuid(3), { media: { sha256: sha('c') }, undoToken: 'token-from-before-restart' });
    const dropLegacy = backup(uuid(4), { media: { sha256: sha('d') } });
    const keepFresh = backup(uuid(5), { media: { sha256: sha('e') } }, new Date());
    // 不是 uuid 的目录、多了别的文件的目录：不认识，不碰
    const notUuid = backup('my-files', { undoToken: 'x' });
    const extra = backup(uuid(6), { undoToken: 'x' });
    put(path.join(extra, 'photo.jpg'));

    const res = collectReplacementBackups(data, undo, startedAt);
    expect(res.removed).toBe(3);
    expect([...res.keptShas].sort()).toEqual([sha('a'), sha('e')]);
    for (const d of [keepLive, keepFresh, notUuid, extra]) expect(existsSync(d), d).toBe(true);
    for (const d of [dropUsed, dropRestart, dropLegacy]) expect(existsSync(d), d).toBe(false);
    expect(readdirSync(path.join(data, 'image-replacements')).sort()).toEqual([uuid(1), uuid(5), uuid(6), 'my-files'].sort());
  });
});
