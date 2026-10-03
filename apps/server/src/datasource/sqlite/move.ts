/**
 * 把图移到图库里的某个文件夹（issue #1：识别完按角色分文件夹）。
 * 磁盘上真的移动，同时改 images 的 root_id / rel_path，图片 id 不变，识别和整理结果都保留。
 *
 * 文件操作全用同步 API：移动过程中事件循环不让出，扫描任务插不进来，
 * 不会出现「扫描读到了旧的记录、又发现文件不在了」把刚移走的图标成丢失。
 */
import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { BadRequestError } from '../../http/errors.ts';
import { isSkippedDirName, parentRel, toAbs } from '../../services/fs/paths.ts';
import type { Db } from '../../db/connection.ts';

const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** 图库文件夹下的子目录：'角色\\未花\\' → '角色/未花'，'' = 图库文件夹本身 */
export function normalizeSubdir(input: string): string {
  const parts = input
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (/^\.+$/.test(s)) throw new BadRequestError('文件夹名不能只有点');
      // Windows 会悄悄去掉结尾的点和空格，先去掉，免得记录和磁盘对不上
      return s.replace(/[. ]+$/, '');
    });
  for (const s of parts) {
    if (BAD_CHARS.test(s)) throw new BadRequestError(`文件夹名不能包含 < > : " | ? *：${s}`);
    if (RESERVED.test(s)) throw new BadRequestError(`「${s}」是 Windows 保留的名字，换一个`);
    // 扫描器不进这些目录，移进去的图下次扫描会被当成丢失
    if (isSkippedDirName(s)) throw new BadRequestError(`「${s}」开头是 . 或 $，或者是系统目录，Emaki 不会扫描这种文件夹，换一个名字`);
  }
  const dir = parts.join('/');
  if (dir.length > 200) throw new BadRequestError('文件夹路径太长');
  return dir;
}

/** 同盘直接改名；跨盘复制后删除原文件，并保留修改时间（识别模型的新旧分流、统计都用它） */
function moveFile(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    const st = statSync(src);
    copyFileSync(src, dst, constants.COPYFILE_EXCL);
    try {
      utimesSync(dst, st.atime, st.mtime);
      unlinkSync(src);
    } catch (e) {
      // 原文件删不掉（比如被占用）：删掉刚复制的那份，算这张移动失败，记录仍指向原文件
      rmSync(dst, { force: true });
      throw e;
    }
  }
}

export interface MoveRow {
  id: number;
  root_id: number;
  rel_path: string;
  file_name: string;
  root_path: string;
  collection_id: number | null;
}

export interface Moved {
  id: number;
  from: { rootId: number; rel: string; name: string; rootPath: string };
  to: { rootId: number; rel: string; name: string; rootPath: string };
}

export interface MoveOutcome {
  moved: Moved[];
  /** 合集（本子、画集）里的页：移走会拆散合集，不动 */
  inCollection: number;
  /** 已经在目标文件夹里 */
  alreadyThere: number;
  failed: string[];
}

export function moveImageFiles(db: Db, rows: MoveRow[], dest: { rootId: number; rootPath: string; dir: string }): MoveOutcome {
  const out: MoveOutcome = { moved: [], inCollection: 0, alreadyThere: 0, failed: [] };
  const destAbs = toAbs(dest.rootPath, dest.dir);
  const occupiedInDb = db.prepare('SELECT 1 FROM images WHERE root_id = ? AND rel_path = ?');
  const update = db.prepare('UPDATE images SET root_id = ?, rel_path = ?, file_name = ? WHERE id = ?');
  const taken = new Set<string>();
  const free = (rel: string) => !taken.has(rel.toLowerCase()) && !occupiedInDb.get(dest.rootId, rel) && !existsSync(toAbs(dest.rootPath, rel));

  let made = false;
  for (const r of rows) {
    if (r.collection_id !== null) {
      out.inCollection++;
      continue;
    }
    if (r.root_id === dest.rootId && parentRel(r.rel_path).toLowerCase() === dest.dir.toLowerCase()) {
      out.alreadyThere++;
      continue;
    }
    if (!made) {
      mkdirSync(destAbs, { recursive: true });
      made = true;
    }
    // 重名：a.jpg → a (1).jpg
    const ext = path.extname(r.file_name);
    const stem = r.file_name.slice(0, r.file_name.length - ext.length);
    let name = r.file_name;
    let rel = dest.dir ? `${dest.dir}/${name}` : name;
    for (let n = 1; !free(rel); n++) {
      name = `${stem} (${n})${ext}`;
      rel = dest.dir ? `${dest.dir}/${name}` : name;
    }
    try {
      moveFile(toAbs(r.root_path, r.rel_path), toAbs(dest.rootPath, rel));
    } catch (err) {
      out.failed.push(`${r.file_name}（${(err as NodeJS.ErrnoException).code ?? (err as Error).message}）`);
      continue;
    }
    // 每张移完立刻写库：中途出错时，已经移走的图记录也是对的
    update.run(dest.rootId, rel, name, r.id);
    taken.add(rel.toLowerCase());
    out.moved.push({
      id: r.id,
      from: { rootId: r.root_id, rel: r.rel_path, name: r.file_name, rootPath: r.root_path },
      to: { rootId: dest.rootId, rel, name, rootPath: dest.rootPath },
    });
  }
  return out;
}

/** 撤销：按原路移回。记录或文件已经变了、原位置被占了的跳过 */
export function moveBack(db: Db, moved: Moved[]): { restored: number; failed: string[] } {
  const current = db.prepare('SELECT root_id, rel_path FROM images WHERE id = ?');
  const update = db.prepare('UPDATE images SET root_id = ?, rel_path = ?, file_name = ? WHERE id = ?');
  let restored = 0;
  const failed: string[] = [];
  for (const m of [...moved].reverse()) {
    const row = current.get(m.id) as { root_id: number; rel_path: string } | undefined;
    const src = toAbs(m.to.rootPath, m.to.rel);
    const dst = toAbs(m.from.rootPath, m.from.rel);
    if (!row || row.root_id !== m.to.rootId || row.rel_path !== m.to.rel || !existsSync(src) || existsSync(dst)) {
      failed.push(m.to.name);
      continue;
    }
    try {
      mkdirSync(path.dirname(dst), { recursive: true });
      moveFile(src, dst);
    } catch {
      failed.push(m.to.name);
      continue;
    }
    update.run(m.from.rootId, m.from.rel, m.from.name, m.id);
    restored++;
  }
  return { restored, failed };
}
