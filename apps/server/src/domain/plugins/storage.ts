/**
 * 插件自己的键值存储（docs/plugins.md 第 5、6 节的 emaki.storage）：视图（E4）和服务端逻辑（E5）通过宿主读写，
 * 每个插件只看得到自己的。表 plugin_storage 只由插件模块写；卸载插件时由 Plugins.remove 一起删（能撤销）。
 *
 * 插件自己的运行状态，不是你做的修改：写入不进撤销栈（ctx.apply），也不推 plugins.changed。
 */
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { iso } from '../../datasource/sqlite/sql.ts';
import { BadRequestError } from '../../http/errors.ts';

export const STORAGE_LIMITS = {
  keyLength: 200,
  /** 一个值（JSON）最大 */
  valueBytes: 256 * 1024,
  /** 一个插件最多存多少 */
  totalBytes: 5 * 1024 * 1024,
  keys: 2000,
};

export class PluginStorage {
  constructor(private readonly ctx: SqliteContext) {}

  get(plugin: string, key: string): unknown {
    const row = this.ctx.db.prepare('SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?').get(plugin, key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  }

  /** 前缀相同的键（不给是全部），按键排序 */
  keys(plugin: string, prefix = ''): string[] {
    return (
      this.ctx.db
        .prepare("SELECT key FROM plugin_storage WHERE plugin_id = ? AND substr(key, 1, length(?)) = ? ORDER BY key")
        .pluck()
        .all(plugin, prefix, prefix) as string[]
    );
  }

  /** 存一个值（能转成 JSON 的）；undefined 等于删除 */
  set(plugin: string, key: string, value: unknown): void {
    if (!key || key.length > STORAGE_LIMITS.keyLength) throw new BadRequestError(`键要有 1 到 ${STORAGE_LIMITS.keyLength} 个字`);
    if (value === undefined) return this.delete(plugin, key);
    const text = JSON.stringify(value);
    if (text === undefined) throw new BadRequestError('这个值存不了（要能转成 JSON）');
    const bytes = Buffer.byteLength(text);
    if (bytes > STORAGE_LIMITS.valueBytes) throw new BadRequestError(`一个值最大 ${STORAGE_LIMITS.valueBytes / 1024} KB`);
    const used = this.ctx.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(value AS BLOB))), 0) AS bytes FROM plugin_storage WHERE plugin_id = ? AND key != ?')
      .get(plugin, key) as { n: number; bytes: number };
    if (used.n + 1 > STORAGE_LIMITS.keys) throw new BadRequestError(`一个插件最多存 ${STORAGE_LIMITS.keys} 个键`);
    if (used.bytes + bytes > STORAGE_LIMITS.totalBytes) throw new BadRequestError(`一个插件最多存 ${STORAGE_LIMITS.totalBytes / 1024 / 1024} MB`);
    this.ctx.apply(() =>
      this.ctx.db
        .prepare(
          `INSERT INTO plugin_storage (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(plugin, key, text, iso(this.ctx.clock())),
    );
  }

  delete(plugin: string, key: string): void {
    this.ctx.apply(() => this.ctx.db.prepare('DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?').run(plugin, key));
  }
}
