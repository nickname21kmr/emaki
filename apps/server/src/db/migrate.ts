/**
 * 迁移执行器。
 *
 * - `schema.sql` 是 v1；之后的改动放在 `migrations/NNN_名字.sql`，NNN 就是版本号（从 002 开始，连续不重复）。
 * - 用 `PRAGMA user_version` 记录当前版本；每个迁移在一个事务里执行，失败回滚并抛错（启动失败比数据损坏好）。
 * - 升级前（已有库）用 VACUUM INTO 备份一份；成功后只留这份和之前最近的一份，更早的 emaki.v<N>.bak.sqlite 删掉。
 * - 迁移文件第一行是 `-- @foreign-keys-off` 时，在事务外关掉外键（重建表时需要），跑完做 foreign_key_check。
 * - 迁移文件里有一行 `-- @skip-if-table 表名` 时，这张表已经在就不执行这份 SQL（只记版本号），给能重复跑的迁移用。
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './connection.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  foreignKeysOff: boolean;
  /** 这张表已经在就跳过（`-- @skip-if-table`） */
  skipIfTable: string | null;
}

const FILE_RE = /^(\d{3})_.+\.sql$/;
const BACKUP_RE = /^emaki\.v(\d+)\.bak\.sqlite$/;
const SKIP_RE = /^-- @skip-if-table (\w+)\s*$/m;

const hasTable = (db: Db, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/**
 * 一次性修复（本机分支的旧编号）：按姿势找图早先在本地按 041_pose、042_posewear、043_posewear_multi 编号，
 * 上游后来也用了 041–044（devices、uploads、album_sync、upload_rejected）。本地的挪到 045–047 之后，
 * 跑过旧编号的库停在 v41–v43，上游的 041–044 会被当成已经跑过。
 * 认法：版本在 41–43，有姿势的表（image_poses 或 posewear_poses），却没有上游 041 建的 lan_access / devices。
 * 这样的库把版本退回 40：上游 041–044 照常跑，045–047 能重复跑（IF NOT EXISTS、@skip-if-table），已有的姿势数据不动。
 * 不需要修复时返回 null。
 */
export function legacyPoseRepair(db: Db, version: number): number | null {
  if (version < 41 || version > 43) return null;
  const hasPose = hasTable(db, 'image_poses') || hasTable(db, 'posewear_poses');
  const hasUpstream041 = hasTable(db, 'lan_access') || hasTable(db, 'devices');
  return hasPose && !hasUpstream041 ? 40 : null;
}

/**
 * 每次升级都留一份几百 MB 的备份，不清理会越积越多。
 * 版本号比 current 小的只留最新一份，其余删掉；比 current 新的（恢复过旧库时会有）不动。
 * 尽力而为：删不掉只记一行日志，不影响迁移。
 */
function pruneBackups(dir: string, current: number, log?: (msg: string) => void): void {
  let old: { file: string; version: number }[];
  try {
    old = readdirSync(dir)
      .map((name) => ({ file: path.join(dir, name), version: Number(BACKUP_RE.exec(name)?.[1] ?? NaN) }))
      .filter((b) => b.version < current) // 不匹配的是 NaN，比较结果为 false
      .sort((a, b) => b.version - a.version)
      .slice(1); // 留之前最近的一份
  } catch (e) {
    log?.(`清理旧备份失败：${(e as Error).message}`);
    return;
  }
  for (const b of old) {
    try {
      rmSync(b.file, { force: true });
      log?.(`已删除旧备份：${b.file}`);
    } catch (e) {
      log?.(`删除旧备份失败：${b.file}（${(e as Error).message}）`);
    }
  }
}

export function loadMigrations(dir = import.meta.dirname): Migration[] {
  const list: Migration[] = [];
  const schema = readFileSync(path.join(dir, 'schema.sql'), 'utf8');
  list.push({ version: 1, name: 'schema.sql', sql: schema, foreignKeysOff: false, skipIfTable: null });

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
        skipIfTable: SKIP_RE.exec(sql)?.[1] ?? null,
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
  const found = db.pragma('user_version', { simple: true }) as number;

  if (found > latest) {
    throw new Error(`数据库版本 v${found} 比程序支持的 v${latest} 新，请升级 Emaki`);
  }
  // 姿势迁移旧编号的库：从 v40 往后跑（见 legacyPoseRepair）
  const repairTo = legacyPoseRepair(db, found);
  const current = repairTo ?? found;
  const pending = migrations.filter((m) => m.version > current);
  if (!pending.length) return { from: found, to: found };

  // 备份在退回版本之前，文件名用库原来的版本号
  if (found >= 1 && opts.backupDir) {
    const backup = path.join(opts.backupDir, `emaki.v${found}.bak.sqlite`);
    rmSync(backup, { force: true });
    // VACUUM 不能在事务里执行
    db.exec(`VACUUM INTO '${backup.replace(/\\/g, '/').replace(/'/g, "''")}'`);
    opts.log?.(`已备份数据库：${backup}`);
    pruneBackups(opts.backupDir, found, opts.log);
  }
  if (repairTo !== null) {
    db.pragma(`user_version = ${repairTo}`);
    opts.log?.(`数据库 v${found} 用的是姿势迁移的旧编号（041–043），退回 v${repairTo}，补跑上游的 041–044`);
  }

  for (const m of pending) {
    if (m.skipIfTable && hasTable(db, m.skipIfTable)) {
      db.pragma(`user_version = ${m.version}`);
      opts.log?.(`数据库迁移：v${m.version} ${m.name}（${m.skipIfTable} 已经在，跳过）`);
      continue;
    }
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
  return { from: found, to: latest };

}
