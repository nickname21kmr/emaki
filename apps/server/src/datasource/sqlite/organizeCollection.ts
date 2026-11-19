import path from 'node:path';
import { moveImages, normalizeSubdir, revertMoveLog, type MoveGroup, type MoveRow } from '../../domain/library/move.ts';
import { assertFilesIdle } from '../../domain/library/guard.ts';
import type { SqliteContext } from './context.ts';
import { ConflictError } from '../../http/errors.ts';
import { organizeFolderName, type MutationResult } from '@emaki/shared';

/** 建合集、改合集之前先看能不能动文件（和移动同一条检查，domain/library/guard.ts） */
export function assertOrganizeReady(ctx: SqliteContext, imageIds: number[]): void {
  assertFilesIdle(ctx, imageIds, '整理文件夹');
}

/**
 * 整理到子文件夹：每个原文件夹里的成员各自收进一个以组名命名的子文件夹，不跨目录合并、不覆盖文件、不换图片 id。
 * 文件夹名不带内部编号：用户在资源管理器里看到的就是组名（前端确认弹窗用同一条规则预览）。
 */
export function organizeCollection(ctx: SqliteContext, collectionId: number, previous: MutationResult): MutationResult {
  const c = ctx.db.prepare('SELECT title FROM collections WHERE id = ?').get(collectionId) as { title: string | null };
  const folder = normalizeSubdir(organizeFolderName(c.title));
  const rows = ctx.db
    .prepare(
      `SELECT i.id, i.root_id, i.rel_path, i.file_name, i.collection_id, r.path AS root_path
    FROM v_counted_images i JOIN library_roots r ON r.id = i.root_id WHERE i.collection_id = ?`,
    )
    .all(collectionId) as MoveRow[];
  const parents = new Map<string, MoveRow[]>();
  for (const r of rows) {
    const parent = path.posix.dirname(r.rel_path) === '.' ? '' : path.posix.dirname(r.rel_path);
    if (parent.split('/').at(-1) === folder) continue; // 已经在组名文件夹里
    const key = r.root_id + '\0' + parent;
    const xs = parents.get(key) ?? [];
    xs.push(r);
    parents.set(key, xs);
  }
  // 和应用内移动同一条路径（domain/library/move.ts）：改文件、改路径、声明 image.moved、记 change_log；
  // 来源、分类、排除、合集由反应按新位置重算（附录 #11、#17）
  const groups: MoveGroup[] = [];
  for (const xs of parents.values()) {
    const first = xs[0]!;
    const parent = path.posix.dirname(first.rel_path);
    const existing = rows.find(
      (r) =>
        r.root_id === first.root_id &&
        path.posix.basename(path.posix.dirname(r.rel_path)) === folder &&
        path.posix.dirname(path.posix.dirname(r.rel_path)) === parent,
    );
    if (xs.length < 2 && !existing) continue;
    const dir = existing ? path.posix.dirname(existing.rel_path) : normalizeSubdir(parent === '.' ? folder : parent + '/' + folder);
    groups.push({ rows: xs, dest: { rootId: first.root_id, rootPath: first.root_path, dir } });
  }
  const out = moveImages(ctx, groups, {
    reason: 'organize',
    where: `子文件夹「${folder}」`,
    summary: (n) => `组图整理：${n} 张收进「${folder}」`,
    allowCollection: true,
  });
  const { moved, failed, logId } = out;
  const message =
    previous.message +
    (moved.length ? `，已整理 ${moved.length} 张到子文件夹` : '，文件位置无需调整') +
    (failed.length ? `；${failed.length} 张移动失败：${failed.slice(0, 3).join('、')}` : '');
  if (logId === null) return { ...previous, message };
  return ctx.undo.result(message, async () => {
    const back = revertMoveLog(ctx, logId, true);
    if (back.conflict) throw new ConflictError(`已移回 ${back.restored} 张；${back.failed.length} 张位置发生变化，可在设置的最近移动中继续处理`);
    if (previous.undoToken) await ctx.undo.run(previous.undoToken);
  });
}
