/**
 * 图库文件夹（图库与文件模块，P4a 从 datasource/sqlite 搬来）：添加父文件夹时合并它里面已有的图库文件夹（包括以前移除过的）。
 * 子文件夹里每张图在父文件夹下的位置是确定的：相对路径前面补上子目录名。所以只改 root_id 和 rel_path，
 * 图片 id 不变，挂在 id 上的角色、原创、收藏、分级、标签、重复组全部保留；合集和读取失败记录同样补前缀。
 * 必须在事务内调用。
 */
import { readdir } from 'node:fs/promises';
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { toAbs } from '../../services/fs/paths.ts';
import { adoptCollections, mergeChildCollections } from '../collections/roots.ts';

export interface ChildRoot {
  id: number;
  path: string;
  removed_at: string | null;
  imported_at: string | null;
}

/** 父目录下的相对路径：('D:/', 'D:/a/b') → 'a/b'；('D:/x', 'D:/x/y') → 'y' */
export function relUnder(parent: string, child: string): string {
  return child.slice(parent.length).replace(/^\/+/, '');
}

/**
 * 手输的子文件夹路径换成磁盘上的大小写：Windows 找文件不分大小写，但图片的 rel_path 是按磁盘上的名字记的，
 * 漫画子文件夹按前缀比较时要一致（'x/manga' 对不上 'X/Manga/1.jpg'）。
 * 读不了目录、找不到的段原样保留。cache：一次要换很多路径时（扫描器），同一个目录只读一次
 */
export async function diskCaseRel(rootPath: string, rel: string, cache?: Map<string, Promise<string[]>>): Promise<string> {
  const out: string[] = [];
  for (const seg of rel.split('/').filter(Boolean)) {
    // 用 toAbs 拼：盘符根 'D:/' 去掉斜杠变成 'D:'，读到的是 D 盘的当前目录
    const dir = toAbs(rootPath, out.join('/'));
    let names = cache?.get(dir);
    if (!names) {
      names = readdir(dir).catch(() => [] as string[]);
      cache?.set(dir, names);
    }
    const list = await names;
    out.push(list.find((n) => n === seg) ?? list.find((n) => n.toLowerCase() === seg.toLowerCase()) ?? seg);
  }
  return out.join('/');
}

/** 子文件夹的记录并进父文件夹：相对路径补上前缀。childWins：同一个相对路径两边都有时留子文件夹的 */
function mergeRows(db: Db, p: { parent: number; child: number; prefix: string }, childWins: boolean): number {
  if (childWins) {
    db.prepare(
      `DELETE FROM images WHERE root_id = @parent AND rel_path IN (SELECT @prefix || '/' || rel_path FROM images WHERE root_id = @child)`,
    ).run(p);
    db.prepare(
      `DELETE FROM scan_errors WHERE root_id = @parent
         AND rel_path IN (SELECT @prefix || '/' || rel_path FROM scan_errors WHERE root_id = @child)`,
    ).run(p);
  } else {
    db.prepare(
      `DELETE FROM images WHERE root_id = @child AND @prefix || '/' || rel_path IN (SELECT rel_path FROM images WHERE root_id = @parent)`,
    ).run(p);
    db.prepare(
      `DELETE FROM scan_errors WHERE root_id = @child
         AND @prefix || '/' || rel_path IN (SELECT rel_path FROM scan_errors WHERE root_id = @parent)`,
    ).run(p);
  }
  const n = db.prepare(`UPDATE images SET root_id = @parent, rel_path = @prefix || '/' || rel_path WHERE root_id = @child`).run(p).changes;
  db.prepare(`UPDATE scan_errors SET root_id = @parent, rel_path = @prefix || '/' || rel_path WHERE root_id = @child`).run(p);
  return n;
}

/** 有冲突（同一个相对路径两边都有记录）时谁留下：还在用的子文件夹 > 父文件夹的旧记录 > 移除过的子文件夹 */
export function mergeChildRoots(db: Db, parentId: number, parentPath: string, children: ChildRoot[]): { images: number } {
  const ordered = [...children].sort((a, b) => Number(a.removed_at !== null) - Number(b.removed_at !== null));
  let images = 0;
  for (const c of ordered) {
    const p = { parent: parentId, child: c.id, prefix: relUnder(parentPath, c.path) };
    const childWins = c.removed_at === null;
    images += mergeRows(db, p, childWins);
    // 合集（合集模块的表）同样补前缀
    mergeChildCollections(db, p, childWins);
    // 按漫画导入的设置跟着过来：整个按漫画导入的子文件夹变成父文件夹里的漫画子文件夹，里面的漫画子文件夹补上前缀
    // （删掉子文件夹记录时 comic_folders 会级联删除，所以先搬）
    if (childWins) {
      const child = db.prepare('SELECT content_mode, comic_rating FROM library_roots WHERE id = ?').get(c.id) as
        | { content_mode: string; comic_rating: string }
        | undefined;
      const now = new Date().toISOString();
      if (child?.content_mode === 'comic')
        db.prepare('INSERT OR REPLACE INTO comic_folders (root_id, rel_dir, comic_rating, created_at) VALUES (?, ?, ?, ?)').run(
          parentId,
          p.prefix,
          child.comic_rating,
          now,
        );
      db.prepare("UPDATE OR REPLACE comic_folders SET root_id = @parent, rel_dir = @prefix || '/' || rel_dir WHERE root_id = @child").run(
        p,
      );
    }
    db.prepare('DELETE FROM library_roots WHERE id = ?').run(c.id);
  }
  // 首页「刚导入」按 imported_at 判断：合并进来的图不算新导入
  const first = children
    .map((c) => c.imported_at)
    .filter((x): x is string => x !== null)
    .sort()[0];
  if (first) keepImportedAt(db, parentId, first);
  return { images };
}

/**
 * 反过来：在移除过的父文件夹里面添加子文件夹时，把父文件夹在这个子文件夹下的旧记录接管过来（去掉前缀）。
 * 图片 id 不变，角色、收藏、合集、重复组都找回来；以后再加回父文件夹，合并回去也不会和新记录冲突。
 * parents 由内往外排，prefix 用磁盘上的大小写；同一个相对路径只接管第一份。必须在事务内调用。
 */
export function adoptFromRemovedParents(
  db: Db,
  rootId: number,
  parents: (Pick<ChildRoot, 'id' | 'imported_at'> & { prefix: string })[],
): { images: number } {
  let images = 0;
  let first: string | null = null;
  for (const a of parents) {
    const p = { root: rootId, from: a.id, prefix: a.prefix };
    const n = db
      .prepare(
        `UPDATE images SET root_id = @root, rel_path = substr(rel_path, length(@prefix) + 2)
         WHERE root_id = @from AND substr(rel_path, 1, length(@prefix) + 1) = @prefix || '/'
           AND substr(rel_path, length(@prefix) + 2) NOT IN (SELECT rel_path FROM images WHERE root_id = @root)`,
      )
      .run(p).changes;
    db.prepare(
      `UPDATE scan_errors SET root_id = @root, rel_path = substr(rel_path, length(@prefix) + 2)
       WHERE root_id = @from AND substr(rel_path, 1, length(@prefix) + 1) = @prefix || '/'
         AND substr(rel_path, length(@prefix) + 2) NOT IN (SELECT rel_path FROM scan_errors WHERE root_id = @root)`,
    ).run(p);
    // 合集（合集模块的表）还要接管正好在这个子文件夹上的那本
    adoptCollections(db, p);
    // comic_folders 只接管里面的：加回时选的导入方式本来就管整个文件夹
    db.prepare(
      `UPDATE comic_folders SET root_id = @root, rel_dir = substr(rel_dir, length(@prefix) + 2)
       WHERE root_id = @from AND substr(rel_dir, 1, length(@prefix) + 1) = @prefix || '/'
         AND substr(rel_dir, length(@prefix) + 2) NOT IN (SELECT rel_dir FROM comic_folders WHERE root_id = @root)`,
    ).run(p);
    if (!n) continue;
    images += n;
    if (a.imported_at && (!first || a.imported_at < first)) first = a.imported_at;
  }
  // 同 mergeChildRoots：接管回来的图不算新导入
  if (first) keepImportedAt(db, rootId, first);
  return { images };
}

/** 合并、接管进来的旧图不算新导入：首次导入时间取更早的那个 */
function keepImportedAt(db: Db, id: number, first: string): void {
  db.prepare('UPDATE library_roots SET imported_at = MIN(COALESCE(imported_at, @first), @first) WHERE id = @id').run({ id, first });
}

// ---------------------------------------------------------------- 图库文件夹和漫画子文件夹的行（P4a 从 SqliteDataSource 搬来）

export type RootMode = 'auto' | 'comic';

/** 新加一个图库文件夹，返回 id */
export function insertRoot(db: Db, r: { path: string; mode: RootMode; rating: string }): number {
  const ins = db.prepare('INSERT INTO library_roots (path, enabled, content_mode, comic_rating) VALUES (?, 1, ?, ?)');
  return Number(ins.run(r.path, r.mode, r.rating).lastInsertRowid);
}

/** 移除过的文件夹重新加回来：旧图和识别结果全部回来，导入方式按这次选的 */
export function reviveRoot(db: Db, id: number, r: { path: string; mode: RootMode; rating: string }): void {
  db.prepare('UPDATE library_roots SET removed_at = NULL, enabled = 1, path = ?, content_mode = ?, comic_rating = ? WHERE id = ?').run(
    r.path,
    r.mode,
    r.rating,
    id,
  );
}

/** 启用 / 停用、导入方式、漫画分级（cols 是真的变了的列，撤销用） */
export function updateRoot(
  db: Db,
  u: UndoRecorder,
  id: number,
  cols: string[],
  r: { enabled: number; mode: string; rating: string },
): void {
  u.columns('library_roots', cols, [id]);
  db.prepare('UPDATE library_roots SET enabled = ?, content_mode = ?, comic_rating = ? WHERE id = ?').run(r.enabled, r.mode, r.rating, id);
}

/** 移除（at）或撤销移除（null）。磁盘上的文件不动，30 天内加回来能找回整理结果 */
export function setRootRemoved(db: Db, id: number, at: string | null): void {
  db.prepare('UPDATE library_roots SET removed_at = ? WHERE id = ?').run(at, id);
}

/** 图库文件夹里的子文件夹按漫画导入（rating 为 null：不再按漫画导入）；可撤销 */
export function setComicFolderRow(db: Db, u: UndoRecorder, rootId: number, relDir: string, rating: string | null, at: string): void {
  u.set('comic_folders', 'root_id = ? AND rel_dir = ?', [rootId, relDir]);
  if (rating === null) db.prepare('DELETE FROM comic_folders WHERE root_id = ? AND rel_dir = ?').run(rootId, relDir);
  else
    db.prepare(
      `INSERT INTO comic_folders (root_id, rel_dir, comic_rating, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(root_id, rel_dir) DO UPDATE SET comic_rating = excluded.comic_rating`,
    ).run(rootId, relDir, rating, at);
}

/** 真正删掉移除超过保留期（cutoff 之前）的文件夹，级联删除它的图；返回删了几个 */
export function deleteRemovedRoots(db: Db, cutoff: string): number {
  return db.prepare('DELETE FROM library_roots WHERE removed_at IS NOT NULL AND removed_at < ?').run(cutoff).changes;
}
