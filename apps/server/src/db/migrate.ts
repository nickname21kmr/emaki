/**
 * 迁移执行器。
 *
 * - `schema.sql` 是 v1；之后的改动放在 `migrations/NNN_名字.sql`，NNN 就是版本号（从 002 开始，连续不重复）。
 * - 用 `PRAGMA user_version` 记录当前版本；每个迁移在一个事务里执行，失败回滚并抛错（启动失败比数据损坏好）。
 * - 升级前（已有库）用 VACUUM INTO 备份一份。
 * - 迁移文件第一行是 `-- @foreign-keys-off` 时，在事务外关掉外键（重建表时需要），跑完做 foreign_key_check。
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './connection.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  foreignKeysOff: boolean;
}

const FILE_RE = /^(\d{3})_.+\.sql$/;

export function loadMigrations(dir = import.meta.dirname): Migration[] {
  const list: Migration[] = [];
  const schema = readFileSync(path.join(dir, 'schema.sql'), 'utf8');
  list.push({ version: 1, name: 'schema.sql', sql: schema, foreignKeysOff: false });

  const migDir = path.join(dir, 'migrations');
  if (existsSync(migDir)) {
    for (const file of readdirSync(migDir).sort()) {
      const m = FILE_RE.exec(file);
      if (!m) continue;
      const sql = readFileSync(path.join(migDir, file), 'utf8');
      list.push({
        version: Number(m[1]),
        name: file,
        sql,
        foreignKeysOff: sql.trimStart().startsWith('-- @foreign-keys-off'),
      });
    }
  }

  list.sort((a, b) => a.version - b.version);
  list.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`迁移版本号必须从 1 开始连续且不重复：第 ${i + 1} 个是 ${m.name}（v${m.version}）`);
    }
  });
  return list;
}

export function migrate(
  db: Db,
  opts: { dir?: string; backupDir?: string; log?: (msg: string) => void } = {},
): { from: number; to: number } {
  const migrations = loadMigrations(opts.dir);
  const latest = migrations[migrations.length - 1]!.version;
  const current = db.pragma('user_version', { simple: true }) as number;

  if (current > latest) {
    throw new Error(`数据库版本 v${current} 比程序支持的 v${latest} 新，请升级 Emaki`);
  }
  const pending = migrations.filter((m) => m.version > current);
  if (!pending.length) return { from: current, to: current };

  if (current >= 1 && opts.backupDir) {
    const backup = path.join(opts.backupDir, `emaki.v${current}.bak.sqlite`);
    rmSync(backup, { force: true });
    // VACUUM 不能在事务里执行
    db.exec(`VACUUM INTO '${backup.replace(/\\/g, '/').replace(/'/g, "''")}'`);
    opts.log?.(`已备份数据库：${backup}`);
  }

  for (const m of pending) {
    if (m.foreignKeysOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (m.foreignKeysOff) {
          const problems = db.pragma('foreign_key_check') as unknown[];
          if (problems.length) throw new Error(`迁移 ${m.name} 之后外键检查失败：${JSON.stringify(problems.slice(0, 5))}`);
        }
        db.pragma(`user_version = ${m.version}`);
      })();
    } finally {
      if (m.foreignKeysOff) db.pragma('foreign_keys = ON');
    }
    opts.log?.(`数据库迁移：v${m.version} ${m.name}`);
  }

  // SQLite 官方建议：改结构或建索引后跑一次
  db.pragma('optimize');
  return { from: current, to: latest };
}
