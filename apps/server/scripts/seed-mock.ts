/**
 * 把 mock 的默认假数据导入一个空的 SQLite 库（开发 / 演示用）。
 *   npx tsx apps/server/scripts/seed-mock.ts <dataDir>
 * 库里已有图片时拒绝执行，避免覆盖真实数据。
 */
import { EventBus } from '../src/core/events.ts';
import { buildMockDb } from '../src/datasource/mock/fixtures.ts';
import { seedFromMockDb } from '../src/datasource/sqlite/seed.ts';
import { SqliteDataSource } from '../src/datasource/sqlite/SqliteDataSource.ts';

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('用法：npx tsx apps/server/scripts/seed-mock.ts <dataDir>');
  process.exit(1);
}

const ds = await SqliteDataSource.open(new EventBus(), dataDir, { autoJobs: false });
const db = ds.ctx.db;
const existing = db.prepare('SELECT (SELECT count(*) FROM images) + (SELECT count(*) FROM library_roots)').pluck().get() as number;
if (existing > 0) {
  console.error(`拒绝导入：${dataDir} 里的数据库不是空的（已有 ${existing} 条图片 / 文件夹记录）`);
  await ds.close();
  process.exit(1);
}

const now = Date.now();
const map = seedFromMockDb(db, buildMockDb(now), { now });
console.log(
  `已导入：${map.roots.size} 个文件夹、${map.works.size} 部作品、${map.characters.size} 个角色、` +
    `${map.images.size} 张图片、${map.exclusions.size} 条排除、${map.duplicates.size} 个重复组`,
);
await ds.close();
