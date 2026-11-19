import path from 'node:path';
import { moveImageFiles, moveBack, normalizeSubdir, type MoveRow, type Moved } from './move.ts';
import { recordChange } from './changeLog.ts';
import type { SqliteContext } from './context.ts';
import type { MutationResult } from '@emaki/shared';
import { ConflictError } from '../../http/errors.ts';

export function assertOrganizeReady(ctx: SqliteContext, imageIds: number[]): void {
  const running = ctx.jobs
    .list()
    .filter((j) => j.status === 'running')
    .map((j) => j.kind);
  if (running.includes('scan')) throw new ConflictError('正在扫描图库，扫描完成后可整理文件夹');
  if (
    running.includes('tag') &&
    ctx.db
      .prepare(`SELECT 1 FROM images WHERE id IN (SELECT value FROM json_each(?)) AND (tagged_at IS NULL OR retag = 1) LIMIT 1`)
      .get(JSON.stringify(imageIds))
  ) {
    throw new ConflictError('这些图片正在识别，识别完成后可整理文件夹');
  }
}

/**
 * 整理到子文件夹：每个原文件夹里的成员各自收进一个以组名命名的子文件夹，不跨目录合并、不覆盖文件、不换图片 id。
 * 文件夹名不带内部编号：用户在资源管理器里看到的就是组名（前端确认弹窗用同一条规则预览）。
 */
export function organizeCollection(ctx: SqliteContext, collectionId: number, previous: MutationResult): MutationResult {
  const c = ctx.db.prepare('SELECT title FROM collections WHERE id = ?').get(collectionId) as { title: string | null };
  const folder = normalizeSubdir(
    (c.title ?? '组图')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/^[.$ ]+/, '')
      .slice(0, 70) || '组图',
  );
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
  const moved: Moved[] = [],
    failed: string[] = [];
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
    const out = moveImageFiles(ctx.db, xs, { rootId: first.root_id, rootPath: first.root_path, dir }, true);
    moved.push(...out.moved);
    failed.push(...out.failed);
  }
  const message =
    previous.message +
    (moved.length ? `，已整理 ${moved.length} 张到子文件夹` : '，文件位置无需调整') +
    (failed.length ? `；${failed.length} 张移动失败：${failed.slice(0, 3).join('、')}` : '');
  if (!moved.length) return { ...previous, message };
  const logId = recordChange(ctx, 'move', `组图整理：${moved.length} 张收进「${folder}」`, {
    where: `子文件夹「${folder}」`,
    items: moved,
    charSnap: [],
    retagSnap: [],
    excluded: [],
  });
  ctx.touch();
  return ctx.undo.result(message, async () => {
    const out = moveBack(ctx.db, moved);
    ctx.touch();
    if (out.failed.length)
      throw new ConflictError(`已移回 ${out.restored} 张；${out.failed.length} 张位置发生变化，可在设置的最近移动中继续处理`);
    ctx.db.prepare('UPDATE change_log SET reverted_at = ? WHERE id = ?').run(new Date(ctx.clock()).toISOString(), logId);
    if (previous.undoToken) await ctx.undo.run(previous.undoToken);
  });
}
