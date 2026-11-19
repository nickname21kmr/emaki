/**
 * SQLite 版撤销：修改前记录快照 / 反向操作，撤销时在一个事务里逆序恢复。
 *
 * 规则：先记录子表，再记录父行；撤销逆序执行，父行先恢复，子行的外键不会失败。
 * 表名、列名都是代码里写死的白名单，不接收外部输入。
 *
 * 这里只还原事实。还原之后的连带处理（合集、排除结果、缓存、通知……）不在这里接线：
 * ctx.mutate 会把原操作声明的变化在同一个事务里重放一遍，由反应重算（docs/core-architecture.md 第 5.3 节）。
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
  | 'artist_links'
  | 'comic_folders'
  | 'image_evidence'
  | 'character_evidence'
  | 'work_evidence'
  | 'pixiv_character_checks'
  | 'character_vetoes'
  | 'exclusions'
  | 'library_roots'
  | 'duplicate_groups'
  | 'duplicate_members'
  | 'danbooru_tag_redirects'
  | 'character_verified_forms'
  | 'character_verified_names'
  | 'custom_character_matches'
  | 'collections'
  | 'collection_characters'
  | 'collection_works'
  | 'change_log'
  | 'derived_versions';

type Row = Record<string, unknown>;
type Op =
  | { t: 'columns'; table: UndoTable; rows: Row[] }
  | { t: 'set'; table: UndoTable; where: string; params: unknown[]; rows: Row[] }
  | { t: 'inserted'; table: UndoTable; ids: number[] }
  | { t: 'sql'; sql: string; params: unknown[] }
  | { t: 'guard'; sql: string; params: unknown[]; message: string }
  | { t: 'custom'; fn: () => void };

export class UndoRecorder {
  private readonly ops: Op[] = [];

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

  /** 撤销到这一步时 sql 查得到行就拒绝撤销（整个撤销回滚）。要最先检查的放在最后记录 */
  guard(sql: string, params: unknown[], message: string): void {
    this.ops.push({ t: 'guard', sql, params, message });
  }

  /**
   * 快照表达不了的还原步骤（例如按「期间有没有重新识别过」决定写不写回）：和其他记录一样在撤销事务里逆序执行，
   * 只能还原事实、同步执行；不要在这里做缓存、通知这类连带处理，那是反应的事
   */
  custom(fn: () => void): void {
    this.ops.push({ t: 'custom', fn });
  }

  get isEmpty(): boolean {
    return this.ops.length === 0;
  }

  /**
   * 生成还原函数：逆序执行所有记录。必须在调用方的事务里执行（ctx.mutate 的撤销会在同一个事务里重放变化）；
   * 外键 / 唯一约束失败时抛 ConflictError（409），整个撤销回滚
   */
  build(): () => void {
    const ops = [...this.ops].reverse();
    const db = this.db;

    const apply = (op: Op) => {
      switch (op.t) {
        case 'columns': {
          // 一批行的列都一样：语句只准备一次（逐行准备在 1,000 行时要多花十来毫秒）
          if (!op.rows.length) break;
          const cols = Object.keys(op.rows[0]!).filter((c) => c !== 'id');
          const upd = db.prepare(`UPDATE ${op.table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`);
          for (const row of op.rows) upd.run(row);
          break;
        }
        case 'set': {
          db.prepare(`DELETE FROM ${op.table} WHERE ${op.where}`).run(...op.params);
          if (!op.rows.length) break;
          const cols = Object.keys(op.rows[0]!);
          const ins = db.prepare(`INSERT INTO ${op.table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
          for (const row of op.rows) ins.run(row);
          break;
        }
        case 'inserted':
          db.prepare(`DELETE FROM ${op.table} WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(op.ids));
          break;
        case 'sql':
          db.prepare(op.sql).run(...op.params);
          break;
        case 'guard':
          if (db.prepare(op.sql).get(...op.params)) throw new ConflictError(op.message);
          break;
        case 'custom':
          op.fn();
          break;
      }
    };

    return () => {
      try {
        for (const op of ops) apply(op);
      } catch (err) {
        if (String((err as { code?: string }).code ?? '').startsWith('SQLITE_CONSTRAINT')) {
          throw new ConflictError('无法撤销：相关的数据已经变了（例如图片已被删除）');
        }
        throw err;
      }
    };
  }
}
