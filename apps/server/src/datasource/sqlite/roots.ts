/**
 * 添加父文件夹时合并它里面已有的图库文件夹（包括以前移除过的）。
 * 子文件夹里每张图在父文件夹下的位置是确定的：相对路径前面补上子目录名。所以只改 root_id 和 rel_path，
 * 图片 id 不变，挂在 id 上的角色、原创、收藏、分级、标签、重复组全部保留；合集和读取失败记录同样补前缀。
 * 必须在事务内调用。
 */
import { readdir } from 'node:fs/promises';
import type { Db } from '../../db/connection.ts';

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
 * 漫画子文件夹按前缀比较时要一致（'x/manga' 对不上 'X/Manga/1.jpg'）
 */
export async function diskCaseRel(rootPath: string, rel: string): Promise<string> {
  let cur = rootPath.replace(/\/+$/, '');
  const out: string[] = [];
  for (const seg of rel.split('/').filter(Boolean)) {
    const names = await readdir(cur).catch(() => [] as string[]);
    const hit = names.find((n) => n === seg) ?? names.find((n) => n.toLowerCase() === seg.toLowerCase()) ?? seg;
    out.push(hit);
    cur = `${cur}/${hit}`;
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
