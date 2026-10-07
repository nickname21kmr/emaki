/**
 * SQLite 版撤销：修改前记录快照 / 反向操作，撤销时在一个事务里逆序恢复。
 *
 * 规则：先记录子表，再记录父行；撤销逆序执行，父行先恢复，子行的外键不会失败。
 * 表名、列名都是代码里写死的白名单，不接收外部输入。
 */
import type { Db } from '../../db/connection.ts';
import { ConflictError } from '../../http/errors.ts';

export type UndoTable =
  | 'images'
  | 'characters'
  | 'works'
  | 'character_works'
  | 'aliases'
  | 'image_characters'
  | 'image_copyrights'
  | 'image_artists'
  | 'character_suggestions'
  | 'exclusions'
  | 'library_roots'
  | 'duplicate_groups'
  | 'duplicate_members'
  | 'danbooru_tag_redirects'
  | 'custom_character_matches'
  | 'collections'
  | 'collection_characters'
  | 'collection_works';

type Row = Record<string, unknown>;
type Op =
  | { t: 'columns'; table: UndoTable; rows: Row[] }
  | { t: 'set'; table: UndoTable; where: string; params: unknown[]; rows: Row[] }
  | { t: 'inserted'; table: UndoTable; ids: number[] }
  | { t: 'sql'; sql: string; params: unknown[] };

export class UndoRecorder {
  private readonly ops: Op[] = [];
  private readonly after: (() => void | Promise<void>)[] = [];

  constructor(private readonly db: Db) {}

  /** 修改前记下这些行的这些列（只用于有 id 主键的表） */
  columns(table: UndoTable, cols: string[], ids: number[]): void {
    if (!ids.length || !cols.length) return;
    const rows = this.db
      .prepare(`SELECT id, ${cols.join(', ')} FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as Row[];
    this.ops.push({ t: 'columns', table, rows });
  }

  /** 修改前记下满足条件的整行集合；where 只能依赖这次修改不会改到的列 */
  set(table: UndoTable, where: string, params: unknown[] = []): void {
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...params) as Row[];
    this.ops.push({ t: 'set', table, where, params, rows });
  }

  /** 插入新行之后记录 */
  inserted(table: UndoTable, id: number): void {
    this.ops.push({ t: 'inserted', table, ids: [id] });
  }

  /** 自定义反向 SQL（大范围「整体归零」时比快照便宜） */
  sql(sql: string, params: unknown[] = []): void {
    this.ops.push({ t: 'sql', sql, params });
  }

  /** 非数据库的补偿，在撤销事务提交后执行 */
  onUndo(fn: () => void | Promise<void>): void {
    this.after.push(fn);
  }

  get isEmpty(): boolean {
    return this.ops.length === 0 && this.after.length === 0;
  }

  /** 生成撤销函数：一个事务内逆序执行所有 op，然后逆序执行 onUndo 回调 */
  build(): () => Promise<void> {
    const ops = [...this.ops].reverse();
    const after = [...this.after].reverse();
    const db = this.db;

    const apply = (op: Op) => {
      switch (op.t) {
        case 'columns':
          for (const row of op.rows) {
            const cols = Object.keys(row).filter((c) => c !== 'id');
            db.prepare(`UPDATE ${op.table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run(row);
          }
          break;
        case 'set':
          db.prepare(`DELETE FROM ${op.table} WHERE ${op.where}`).run(...op.params);
          for (const row of op.rows) {
            const cols = Object.keys(row);
            db.prepare(`INSERT INTO ${op.table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(row);
          }
          break;
        case 'inserted':
          db.prepare(`DELETE FROM ${op.table} WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(op.ids));
          break;
        case 'sql':
          db.prepare(op.sql).run(...op.params);
          break;
      }
    };

    return async () => {
      try {
        db.transaction(() => {
          for (const op of ops) apply(op);
        })();
      } catch (err) {
        if (String((err as { code?: string }).code ?? '').startsWith('SQLITE_CONSTRAINT')) {
          throw new ConflictError('无法撤销：相关的数据已经变了（例如图片已被删除）');
        }
        throw err;
      }
      for (const fn of after) await fn();
    };
  }
}
