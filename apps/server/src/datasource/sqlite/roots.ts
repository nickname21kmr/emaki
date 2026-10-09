/**
 * 添加父文件夹时合并它里面已有的图库文件夹（包括以前移除过的）。
 * 子文件夹里每张图在父文件夹下的位置是确定的：相对路径前面补上子目录名。所以只改 root_id 和 rel_path，
 * 图片 id 不变，挂在 id 上的角色、原创、收藏、分级、标签、重复组全部保留；合集和读取失败记录同样补前缀。
 * 必须在事务内调用。
 */
import { readdir } from 'node:fs/promises';
import type { Db } from '../../db/connection.ts';
import { toAbs } from '../../services/fs/paths.ts';

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

/** 有冲突（同一个相对路径两边都有记录）时谁留下：还在用的子文件夹 > 父文件夹的旧记录 > 移除过的子文件夹 */
export function mergeChildRoots(db: Db, parentId: number, parentPath: string, children: ChildRoot[]): { images: number } {
  const ordered = [...children].sort((a, b) => Number(a.removed_at !== null) - Number(b.removed_at !== null));
  let images = 0;
  for (const c of ordered) {
    const p = { parent: parentId, child: c.id, prefix: relUnder(parentPath, c.path) };
    const childWins = c.removed_at === null;
    for (const [table, col, expr] of [
      ['images', 'rel_path', `@prefix || '/' || rel_path`],
      ['scan_errors', 'rel_path', `@prefix || '/' || rel_path`],
      ['collections', 'rel_dir', `CASE WHEN rel_dir = '' THEN @prefix ELSE @prefix || '/' || rel_dir END`],
    ] as const) {
      db.prepare(
        childWins
          ? `DELETE FROM ${table} WHERE root_id = @parent AND ${col} IN (SELECT ${expr} FROM ${table} WHERE root_id = @child)`
          : `DELETE FROM ${table} WHERE root_id = @child AND ${expr} IN (SELECT ${col} FROM ${table} WHERE root_id = @parent)`,
      ).run(p);
      const n = db.prepare(`UPDATE ${table} SET root_id = @parent, ${col} = ${expr} WHERE root_id = @child`).run(p).changes;
      if (table === 'images') images += n;
    }
    // 按漫画导入的设置跟着过来：整个按漫画导入的子文件夹变成父文件夹里的漫画子文件夹，里面的漫画子文件夹补上前缀
    // （删掉子文件夹记录时 comic_folders 会级联删除，所以先搬）
    if (childWins) {
      const child = db.prepare('SELECT content_mode, comic_rating FROM library_roots WHERE id = ?').get(c.id) as { content_mode: string; comic_rating: string } | undefined;
      const now = new Date().toISOString();
      if (child?.content_mode === 'comic')
        db.prepare('INSERT OR REPLACE INTO comic_folders (root_id, rel_dir, comic_rating, created_at) VALUES (?, ?, ?, ?)').run(parentId, p.prefix, child.comic_rating, now);
      db.prepare("UPDATE OR REPLACE comic_folders SET root_id = @parent, rel_dir = @prefix || '/' || rel_dir WHERE root_id = @child").run(p);
    }
    db.prepare('DELETE FROM library_roots WHERE id = ?').run(c.id);
  }
  // 首页「刚导入」按 imported_at 判断：合并进来的图不算新导入
  const first = children
    .map((c) => c.imported_at)
    .filter((x): x is string => x !== null)
    .sort()[0];
  if (first) db.prepare('UPDATE library_roots SET imported_at = MIN(COALESCE(imported_at, @first), @first) WHERE id = @id').run({ id: parentId, first });
  return { images };
}

/**
 * 反过来：在移除过的父文件夹里面添加子文件夹时，把父文件夹在这个子文件夹下的旧记录接管过来（去掉前缀）。
 * 图片 id 不变，角色、收藏、合集、重复组都找回来；以后再加回父文件夹，合并回去也不会和新记录冲突。
 * parents 由内往外排，prefix 用磁盘上的大小写；同一个相对路径只接管第一份。必须在事务内调用。
 */
export function adoptFromRemovedParents(db: Db, rootId: number, parents: (Pick<ChildRoot, 'id' | 'imported_at'> & { prefix: string })[]): { images: number } {
  let images = 0;
  let first: string | null = null;
  for (const a of parents) {
    const p = { root: rootId, from: a.id, prefix: a.prefix };
    for (const [table, col] of [
      ['images', 'rel_path'],
      ['scan_errors', 'rel_path'],
      ['collections', 'rel_dir'],
      ['comic_folders', 'rel_dir'],
    ] as const) {
      // 合集还要接管正好在这个子文件夹上的那本（单独加回一本书的文件夹）：新文件夹里它在 ''，同 mergeChildRoots 反过来。
      // comic_folders 不用：加回时选的导入方式本来就管整个文件夹
      const withDir = table === 'collections';
      const rest = withDir
        ? `CASE WHEN rel_dir = @prefix THEN '' ELSE substr(rel_dir, length(@prefix) + 2) END`
        : `substr(${col}, length(@prefix) + 2)`;
      const match = `substr(${col}, 1, length(@prefix) + 1) = @prefix || '/'`;
      const n = db
        .prepare(
          `UPDATE ${table} SET root_id = @root, ${col} = ${rest}
           WHERE root_id = @from AND ${withDir ? `(rel_dir = @prefix OR ${match})` : match}
             AND ${rest} NOT IN (SELECT ${col} FROM ${table} WHERE root_id = @root)`,
        )
        .run(p).changes;
      if (table !== 'images' || !n) continue;
      images += n;
      if (a.imported_at && (!first || a.imported_at < first)) first = a.imported_at;
    }
  }
  // 同 mergeChildRoots：接管回来的图不算新导入
  if (first) db.prepare('UPDATE library_roots SET imported_at = MIN(COALESCE(imported_at, @first), @first) WHERE id = @id').run({ id: rootId, first });
  return { images };
}
