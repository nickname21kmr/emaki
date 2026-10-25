/**
 * 延后移到回收站。用户点「移到回收站」时只在库里标 trashed_at，并记一批到 pending_trash，这一步照常可撤销；
 * 最近 TRASH_UNDO_WINDOW 批（「全部处理」算一批）之外的才真的移进系统回收站，撤销 token 跟着作废。
 * 正常退出和启动时把剩下的都移走（启动时那些是上次被强杀留下的）。
 * 移不动的文件（被占用）只记日志：图在库里仍是移到回收站的状态，下次扫描发现文件还在会自己回来。
 */
import type { MutationResult } from '@emaki/shared';
import { TRASH_COMMITTED, TRASH_UNDO_WINDOW } from '../../core/undo.ts';
import { assertRecyclable } from '../../services/trash/driveType.ts';
import { moveToRecycleBin, type TrashImpl } from '../../services/trash/recycleBin.ts';
import type { SqliteContext } from './context.ts';
import { iso } from './sql.ts';
import type { UndoRecorder } from './undo.ts';

export interface PendingTrashOptions {
  /** 替换系统回收站（测试用） */
  trashImpl?: TrashImpl;
  /** 替换「这个盘有没有回收站」的检查（测试用） */
  checkRoot?: (rootPath: string) => Promise<void>;
  log?: (msg: string) => void;
}

export class PendingTrash {
  private queue: Promise<void> = Promise.resolve();
  /** 点的时候就检查有没有回收站，错误马上报出来 */
  readonly checkRoot: (rootPath: string) => Promise<void>;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly ctx: SqliteContext,
    private readonly opts: PendingTrashOptions = {},
  ) {
    this.checkRoot = opts.checkRoot ?? assertRecyclable;
    this.log = opts.log ?? ((m) => console.warn(`[回收站] ${m}`));
  }

  /** 在 mutate 的事务里调用：记一批，撤销时连批一起删掉。grp 相同的几批在窗口里只算一次 */
  record(u: UndoRecorder, items: { id: number; abs: string }[], grp?: string | null): number {
    const db = this.ctx.db;
    const id = Number(db.prepare('INSERT INTO pending_trash (created_at, grp) VALUES (?, ?)').run(iso(this.ctx.clock()), grp ?? null).lastInsertRowid);
    const ins = db.prepare('INSERT INTO pending_trash_items (batch_id, image_id, abs_path) VALUES (?, ?, ?)');
    for (const it of items) ins.run(id, it.id, it.abs);
    // 撤销逆序执行：先删明细再删批
    u.sql('DELETE FROM pending_trash WHERE id = ?', [id]);
    u.sql('DELETE FROM pending_trash_items WHERE batch_id = ?', [id]);
    return id;
  }

  /** mutate 之后：记下这批的撤销 token，挤出窗口的批作废 token、排队移文件。返回结果里带上作废的 token */
  added<T extends MutationResult>(batchId: number, res: T): T & { expiredUndoTokens?: string[] } {
    const expired = this.enforce(batchId, res.undoToken);
    return expired.length ? { ...res, expiredUndoTokens: expired } : res;
  }

  private enforce(batchId: number, token: string | null): string[] {
    const db = this.ctx.db;
    db.prepare('UPDATE pending_trash SET undo_token = ? WHERE id = ?').run(token, batchId);
    const groups = db
      .prepare("SELECT coalesce(grp, '#' || id) AS g FROM pending_trash WHERE flushing = 0 GROUP BY g ORDER BY max(id) DESC")
      .pluck()
      .all() as string[];
    const old = groups.slice(TRASH_UNDO_WINDOW);
    if (!old.length) return [];
    const ids = db
      .prepare("SELECT id FROM pending_trash WHERE flushing = 0 AND coalesce(grp, '#' || id) IN (SELECT value FROM json_each(?))")
      .pluck()
      .all(JSON.stringify(old)) as number[];
    return this.flush(ids);
  }

  /** 把剩下的全部移进系统回收站（退出、启动时） */
  flushAll(): Promise<void> {
    this.flush(this.ctx.db.prepare('SELECT id FROM pending_trash').pluck().all() as number[]);
    return this.queue;
  }

  /** 等排着的移动做完（测试、退出前用） */
  idle(): Promise<void> {
    return this.queue;
  }

  /** 先同步作废 token、标记 flushing，再排队移文件；返回作废的 token */
  private flush(ids: number[]): string[] {
    if (!ids.length) return [];
    const db = this.ctx.db;
    const json = JSON.stringify(ids);
    const tokens = db.prepare('SELECT undo_token FROM pending_trash WHERE id IN (SELECT value FROM json_each(?)) AND undo_token IS NOT NULL').pluck().all(json) as string[];
    db.prepare('UPDATE pending_trash SET flushing = 1 WHERE id IN (SELECT value FROM json_each(?))').run(json);
    for (const t of tokens) this.ctx.undo.expire(t, TRASH_COMMITTED);
    this.queue = this.queue.then(() => this.move(ids)).catch((err) => this.log(`移到系统回收站失败：${err instanceof Error ? err.message : String(err)}`));
    return tokens;
  }

  private async move(ids: number[]): Promise<void> {
    const db = this.ctx.db;
    const json = JSON.stringify(ids);
    // 图后来又回来了（还没 trashed_at）的不移；图的行已经没了（文件夹被移除）照样移，用户确实点了删除
    const paths = db
      .prepare(
        `SELECT p.abs_path FROM pending_trash_items p LEFT JOIN images i ON i.id = p.image_id
         WHERE p.batch_id IN (SELECT value FROM json_each(?)) AND (i.id IS NULL OR i.trashed_at IS NOT NULL)`,
      )
      .pluck()
      .all(json) as string[];
    if (paths.length) {
      const res = await moveToRecycleBin(paths, this.opts.trashImpl);
      if (res.failed.length) {
        const names = res.failed.slice(0, 3).map((f) => f.path).join('、');
        this.log(`${res.failed.length} 个文件没能移到系统回收站（文件可能被其他程序占用）：${names}${res.failed.length > 3 ? ' 等' : ''}`);
      }
    }
    db.prepare('DELETE FROM pending_trash_items WHERE batch_id IN (SELECT value FROM json_each(?))').run(json);
    db.prepare('DELETE FROM pending_trash WHERE id IN (SELECT value FROM json_each(?))').run(json);
  }
}
