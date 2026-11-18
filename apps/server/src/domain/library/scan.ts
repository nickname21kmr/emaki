/**
 * 扫描写库的部分（图库与文件模块，P4a）：扫描器（services/scan/Scanner.ts）只遍历、读文件、算 sha、读文件头，
 * 看到的东西都经这里和 images.ts、move.ts 写进库：图库文件夹的导入 / 扫描时间、读不了的文件（scan_errors）、
 * 跟着磁盘改名的漫画子文件夹（comic_folders）。图片行的新增、内容变化、移动、丢失、找回见 images.ts、move.ts。
 */
import type { Db } from '../../db/connection.ts';
import { stmt } from '../tx.ts';
import { FILE_LIVE } from '../../readmodel/terms.ts';

/** 第一次扫描的文件夹记下首次导入时间（开始时就写，首页能在扫描过程中进入「刚导入」状态） */
export function markRootsImported(db: Db, rootIds: readonly number[], at: string): void {
  const upd = stmt(db, 'UPDATE library_roots SET imported_at = ? WHERE id = ? AND imported_at IS NULL');
  for (const id of rootIds) upd.run(at, id);
}

/** 整个文件夹扫完（没取消）：记下「上次扫描」 */
export function markRootsScanned(db: Db, rootIds: readonly number[], at: string): void {
  const upd = stmt(db, 'UPDATE library_roots SET last_scan_at = ? WHERE id = ?');
  for (const id of rootIds) upd.run(at, id);
}

export interface ScanErrorRow {
  rootId: number;
  relPath: string;
  bytes: number;
  modifiedAt: string;
  error: string;
  at: string;
}

/** 读不了的文件：记下来，文件没变之前不再重试 */
export function recordScanError(db: Db, e: ScanErrorRow): void {
  stmt(
    db,
    `INSERT INTO scan_errors (root_id, rel_path, bytes, modified_at, error, at) VALUES (@rootId, @relPath, @bytes, @modifiedAt, @error, @at)
     ON CONFLICT(root_id, rel_path) DO UPDATE SET
       bytes=excluded.bytes, modified_at=excluded.modified_at, error=excluded.error, at=excluded.at`,
  ).run(e);
}

/** 以前读失败、这次成功入库了，或者文件已经不在了：清掉失败记录 */
export function clearScanError(db: Db, rootId: number, relPath: string): void {
  stmt(db, 'DELETE FROM scan_errors WHERE root_id = ? AND rel_path = ?').run(rootId, relPath);
}

export interface FolderMove {
  /** 原来的行（快速移动匹配到的） */
  row: { root_id: number; rel_path: string };
  /** 磁盘上的新位置 */
  entry: { rootId: number; relPath: string };
}

/**
 * 按漫画导入的子文件夹（comic_folders）在磁盘上改名、挪位置时跟过去：按快速移动匹配到的页投票，
 * 一半以上的页去了同一个文件夹、原来的文件夹这次一张都没有了才跟。onDisk：这次遍历到的文件。返回改了几个
 */
export function followComicFolders(db: Db, moves: readonly FolderMove[], onDisk: Iterable<{ rootId: number; relPath: string }>): number {
  if (!moves.length) return 0;
  const folders = db.prepare('SELECT root_id, rel_dir FROM comic_folders').all() as { root_id: number; rel_dir: string }[];
  if (!folders.length) return 0;
  const live = db
    .prepare(
      `SELECT COUNT(*) FROM images WHERE root_id = ? AND ${FILE_LIVE('')}
         AND substr(rel_path, 1, length(?) + 1) = ? || '/'`,
    )
    .pluck();
  const upd = db.prepare('UPDATE OR IGNORE comic_folders SET root_id = ?, rel_dir = ? WHERE root_id = ? AND rel_dir = ?');
  const disk = [...onDisk];
  let n = 0;
  for (const f of folders) {
    const prefix = `${f.rel_dir}/`;
    const votes = new Map<string, { rootId: number; dir: string; n: number }>();
    for (const { row, entry } of moves) {
      if (row.root_id !== f.root_id || !row.rel_path.startsWith(prefix)) continue;
      // 文件夹里面的相对位置不变，前面换了：'旧名/v1/1.png' → '新名/v1/1.png'
      const rest = row.rel_path.slice(f.rel_dir.length);
      if (!entry.relPath.endsWith(rest)) continue;
      const dir = entry.relPath.slice(0, -rest.length);
      const k = `${entry.rootId}\n${dir}`;
      const v = votes.get(k) ?? { rootId: entry.rootId, dir, n: 0 };
      v.n++;
      votes.set(k, v);
    }
    const best = [...votes.values()].sort((a, b) => b.n - a.n)[0];
    if (!best || best.n * 2 < (live.get(f.root_id, f.rel_dir, f.rel_dir) as number)) continue;
    if (disk.some((e) => e.rootId === f.root_id && e.relPath.startsWith(prefix))) continue;
    n += upd.run(best.rootId, best.dir, f.root_id, f.rel_dir).changes;
  }
  return n;
}
