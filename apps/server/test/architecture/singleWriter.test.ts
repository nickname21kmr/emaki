/**
 * 单一写入者（P0 护栏，docs/core-architecture.md 第 1 节原则 3、第 12 节）。
 *
 * 扫描 apps/server/src 下所有非测试源码里的 SQL 写入（见 sqlWrites.ts），按 owners.ts 的「表 → 主人模块」判断：
 * - 写入发生在主人目录里：可以；
 * - 不在主人目录里：必须在允许清单（writers.allowlist.ts）里，否则失败；
 * - 允许清单里的某一项已经不再出现：也失败，提醒把它从清单里删掉（清单只许变短）。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.ts';
import { migrate } from '../../src/db/migrate.ts';
import { EXEMPT_DIRS, MODULES, TABLE_OWNERS } from './owners.ts';
import { DYNAMIC_TABLE, IMAGE_COLUMN_GROUPS, scanSource, scanTree, sqlWritesIn, type SqlWrite } from './sqlWrites.ts';
import { ALLOWED_WRITES } from './writers.allowlist.ts';

const SRC = path.resolve(import.meta.dirname, '../../src');

function schema(): { tables: Set<string>; imageColumns: string[] } {
  const db = openDatabase(':memory:');
  try {
    migrate(db, {});
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[]);
    const imageColumns = db.prepare("SELECT name FROM pragma_table_info('images')").pluck().all() as string[];
    return { tables, imageColumns };
  } finally {
    db.close();
  }
}

const key = (file: string, table: string) => `${file} | ${table}`;

/** 不在主人目录（也不在例外目录）里的写入 */
function violations(writes: SqlWrite[]): Map<string, SqlWrite[]> {
  const out = new Map<string, SqlWrite[]>();
  for (const w of writes) {
    if (EXEMPT_DIRS.some((e) => w.file.startsWith(e.dir))) continue;
    const owner = TABLE_OWNERS[w.table];
    if (owner && w.file.startsWith(MODULES[owner].dir)) continue;
    const k = key(w.file, w.table);
    out.set(k, [...(out.get(k) ?? []), w]);
  }
  return out;
}

describe('单一写入者', () => {
  const { tables, imageColumns } = schema();
  const writes = scanTree(SRC, tables);

  it('每张表、images 的每一列都登记了主人', () => {
    const unowned = [...tables].filter((t) => t !== 'images' && !TABLE_OWNERS[t]);
    expect(unowned, '新表要在 test/architecture/owners.ts 里登记主人').toEqual([]);
    const ungrouped = imageColumns.filter((c) => !IMAGE_COLUMN_GROUPS[c]);
    expect(ungrouped, 'images 的新列要在 test/architecture/sqlWrites.ts 的 IMAGE_COLUMN_GROUPS 里登记列组').toEqual([]);
    const groups = new Set(Object.values(IMAGE_COLUMN_GROUPS).map((g) => `images#${g}`));
    expect([...groups].filter((g) => !TABLE_OWNERS[g])).toEqual([]);
  });

  it('写到的都是存在的表（拼出来的表名除外）', () => {
    const known = new Set([...Object.keys(TABLE_OWNERS), 'images#?']);
    const unknown = writes.filter((w) => !known.has(w.table)).map((w) => `${w.file}:${w.line} ${w.table}：${w.snippet}`);
    expect(unknown).toEqual([]);
  });

  it('主人目录之外的写入都在允许清单里，允许清单里没有过时的项', () => {
    const found = violations(writes);
    const allowed = new Map(ALLOWED_WRITES.map((a) => [key(a.file, a.table), a]));
    expect(allowed.size, '允许清单里有重复项').toBe(ALLOWED_WRITES.length);
    const added = [...found.keys()]
      .filter((k) => !allowed.has(k))
      .map((k) => {
        const w = found.get(k)![0]!;
        const owner = TABLE_OWNERS[w.table];
        const where = owner ? `主人是「${MODULES[owner].name}」（${MODULES[owner].dir}）` : '没有主人（看不出写哪些列 / 哪张表）';
        return `${w.file}:${w.line} 写 ${w.table}，${where}：${w.snippet}`;
      });
    const stale = [...allowed.keys()].filter((k) => !found.has(k));
    expect(added, '新增的越权写入：改成调用主人模块的命令；确实需要暂时保留的，加进 writers.allowlist.ts 并说明').toEqual([]);
    expect(stale, '这些写入已经不在了：从 writers.allowlist.ts 里删掉').toEqual([]);
  });

  it('设备与访问的表（devices、lan_access，docs/mobile.md 2.8）只有 access/ 写，允许清单里没有它们', () => {
    const own = new Set(['devices', 'lan_access']);
    expect(TABLE_OWNERS.devices).toBe('access');
    expect(TABLE_OWNERS.lan_access).toBe('access');
    const touched = writes.filter((w) => own.has(w.table));
    expect(new Set(touched.map((w) => w.table))).toEqual(own);
    expect(touched.filter((w) => !w.file.startsWith('access/')).map((w) => `${w.file}:${w.line} ${w.table}`)).toEqual([]);
    expect(ALLOWED_WRITES.filter((a) => own.has(a.table))).toEqual([]);
  });
});

describe('扫描器本身', () => {
  const tables = new Set(['images', 'image_characters', 'settings', 'collections']);
  const scan = (src: string) => scanSource(src, 'x.ts', tables).map((w) => w.table);

  it('认得各种写法：多行模板、INSERT OR、REPLACE、UPDATE … SET、DELETE、ON CONFLICT', () => {
    expect(
      scan(`
        db.prepare(\`INSERT OR IGNORE
          INTO image_characters (image_id) VALUES (?)\`);
        ctx.stmt("REPLACE INTO settings (key, value) VALUES (?, ?)");
        db.exec('delete from collections where id = 1');
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      `),
    ).toEqual(['image_characters', 'settings', 'collections', 'settings']);
  });

  it('images 按 SET 的列分组；列名拼出来时记成 images#?', () => {
    expect(sqlWritesIn('UPDATE images SET favorite = 1, excluded_by = NULL WHERE id = ?').map((w) => w.table)).toEqual([
      'images#curation',
      'images#visibility',
    ]);
    expect(sqlWritesIn('UPDATE images AS i SET (source_site, source_url) = (?, ?) WHERE i.id = ?').map((w) => w.table)).toEqual(['images#evidence']);
    expect(scan('db.prepare(`UPDATE images SET ${cols} WHERE id = ?`)')).toEqual(['images#?']);
    expect(scan("db.prepare('INSERT INTO images (id) VALUES (1)')")).toEqual(['images#library']);
  });

  it('表名拼出来的记成 <dynamic>；撤销快照也算写入', () => {
    expect(scan('db.prepare(`DELETE FROM ${table} WHERE id = ?`)')).toEqual([DYNAMIC_TABLE]);
    expect(scan("u.set('image_characters', 'image_id = ?', [1]); u.columns('images', ['favorite'], ids); u.inserted('collections', 3)")).toEqual([
      'image_characters',
      'images#curation',
      'collections',
    ]);
    expect(scan("u.columns('images', cols, ids)")).toEqual(['images#?']);
    expect(scan('for (const t of list) u.set(t, "x = 1")')).toEqual([DYNAMIC_TABLE]);
    expect(scan("u.sql('UPDATE settings SET value = ? WHERE key = ?', [a, b])")).toEqual(['settings']);
    // Map.set 不算：键不是表名，变量名也不是撤销记录器常用的名字（键恰好是表名时宁可多报）
    expect(scan("cache.set('theme', 1); m.set(key, 2)")).toEqual([]);
  });

  it('注释、正则、除号、非空断言不会让它读错字符串', () => {
    expect(
      scan(`
        // db.prepare('DELETE FROM settings')
        /* UPDATE images SET favorite = 1 */
        const re = /['"]/g; const x = a[i]! / 3; const y = (b) / 2;
        const q = \`\${'\`'}\`; db.prepare('DELETE FROM collections');
      `),
    ).toEqual(['collections']);
  });

  it('读不懂的文件直接报错，不悄悄漏掉', () => {
    expect(() => scan("const s = 'abc")).toThrow('扫描失败');
  });
});
