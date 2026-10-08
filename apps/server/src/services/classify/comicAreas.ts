/**
 * 「按漫画导入」的范围：整个图库文件夹（library_roots.content_mode = 'comic'），
 * 或者图库文件夹里的某个子文件夹（comic_folders，用户 2026-10-09：漫画在已有的图库文件夹里面时不用单独再加一个）。
 * 范围里的页直接归漫画、不跑识别、不进未识别，每个子文件夹成一本；没识别过的页用范围选的分级。
 *
 * SQL 判断都从这里拿，别处不要自己写 content_mode = 'comic'。
 */
import type { Rating } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';

/** a 是 images 表（或视图）的别名：这张图在按漫画导入的范围里 */
export const IN_COMIC = (a = 'i') =>
  `(${a}.root_id IN (SELECT id FROM library_roots WHERE content_mode = 'comic')
    OR EXISTS (SELECT 1 FROM comic_folders cf WHERE cf.root_id = ${a}.root_id AND substr(${a}.rel_path, 1, length(cf.rel_dir) + 1) = cf.rel_dir || '/'))`;

/** 范围选的分级：最里层的漫画子文件夹优先，再是图库文件夹（只对在范围里的图有意义） */
export const COMIC_RATING = (a = 'i') =>
  `COALESCE((SELECT cf.comic_rating FROM comic_folders cf WHERE cf.root_id = ${a}.root_id AND substr(${a}.rel_path, 1, length(cf.rel_dir) + 1) = cf.rel_dir || '/'
      ORDER BY length(cf.rel_dir) DESC LIMIT 1),
    (SELECT comic_rating FROM library_roots WHERE id = ${a}.root_id))`;

export interface ComicArea {
  /** 范围的根：整个图库文件夹时是 ''，子文件夹时是它的相对路径 */
  relDir: string;
  /** 范围在磁盘上的完整路径（书名找不到时用它的名字） */
  path: string;
  rating: Rating;
}

/** 内存里查：扫描、合集重算这种逐行处理的地方用 */
export class ComicAreas {
  private constructor(private readonly byRoot: Map<number, ComicArea[]>) {}

  static load(db: Db): ComicAreas {
    const byRoot = new Map<number, ComicArea[]>();
    const add = (rootId: number, a: ComicArea) => byRoot.set(rootId, [...(byRoot.get(rootId) ?? []), a]);
    for (const r of db.prepare("SELECT id, path, comic_rating FROM library_roots WHERE content_mode = 'comic'").all() as {
      id: number;
      path: string;
      comic_rating: Rating;
    }[])
      add(r.id, { relDir: '', path: r.path, rating: r.comic_rating });
    for (const f of db
      .prepare('SELECT f.root_id, f.rel_dir, f.comic_rating, r.path FROM comic_folders f JOIN library_roots r ON r.id = f.root_id')
      .all() as { root_id: number; rel_dir: string; comic_rating: Rating; path: string }[])
      add(f.root_id, { relDir: f.rel_dir, path: `${f.path.replace(/\/+$/, '')}/${f.rel_dir}`, rating: f.comic_rating });
    // 最里层的在前：子文件夹的设置盖过图库文件夹的
    for (const list of byRoot.values()) list.sort((a, b) => b.relDir.length - a.relDir.length);
    return new ComicAreas(byRoot);
  }

  /** 这个文件夹（相对图库文件夹）或文件所在的范围；不在任何范围里为 null */
  of(rootId: number, relPath: string): ComicArea | null {
    for (const a of this.byRoot.get(rootId) ?? []) if (!a.relDir || relPath === a.relDir || relPath.startsWith(`${a.relDir}/`)) return a;
    return null;
  }

  /** 去掉范围前缀后的相对路径（合集起书名用） */
  static relIn(area: ComicArea, relPath: string): string {
    return area.relDir ? relPath.slice(area.relDir.length).replace(/^\/+/, '') : relPath;
  }
}
