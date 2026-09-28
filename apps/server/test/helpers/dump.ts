import type { Db } from '../../src/db/connection.ts';

/** 「执行 → 撤销 → 状态相同」断言用：按主键顺序导出核心表的全部行（还没建的表跳过） */
const CORE_TABLES: [table: string, orderBy: string][] = [
  ['library_roots', 'id'],
  ['works', 'id'],
  ['characters', 'id'],
  ['character_works', 'character_id, work_id'],
  ['aliases', 'owner_type, owner_id, alias'],
  ['images', 'id'],
  ['tags', 'id'],
  ['image_tags', 'image_id, tag_id'],
  ['image_characters', 'image_id, character_id'],
  ['image_copyrights', 'image_id, work_id'],
  ['character_suggestions', 'image_id, danbooru_tag'],
  ['exclusions', 'id'],
  ['duplicate_groups', 'id'],
  ['duplicate_members', 'group_id, image_id'],
  ['danbooru_tag_redirects', 'tag'],
  ['custom_character_matches', 'character_id'],
  ['collections', 'id'],
  ['collection_characters', 'collection_id, character_id'],
  ['collection_works', 'collection_id, work_id'],
];

export function dumpCore(db: Db): Record<string, unknown[]> {
  const existing = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
  );
  const out: Record<string, unknown[]> = {};
  for (const [table, orderBy] of CORE_TABLES) {
    if (existing.has(table)) out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
  }
  return out;
}
