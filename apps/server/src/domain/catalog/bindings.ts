/**
 * 角色和 Danbooru 标签的绑定 / 解绑（编目）。可撤销的都在调用方的 ctx.mutate 里，按这里的顺序记撤销。
 */
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';

/** 撤回一次自动绑定需要的信息（change_log 里 auto-associate 的 payload 的一部分） */
export interface AutoBinding {
  characterId: number;
  tag: string;
  /** 绑定时改了作品（没手动指定作品的才会改）：撤回时放回原来的 */
  worksChanged: boolean;
  worksBefore: { work_id: number; position: number }[];
  createdWorkIds: number[];
}

/**
 * 撤回自动绑定在编目这边的部分：作品放回绑定前的（期间用户手动改过作品的不动）、绑定时新建且现在没人用的作品删掉、
 * 解绑并改回自建、记成「忽略这个匹配」（以后不再自动绑同一个标签）。图上的关联由调用方先经归类模块去掉
 */
export function revertAutoBinding(db: Db, u: UndoRecorder, a: AutoBinding, now: string): void {
  const cid = a.characterId;
  if (a.worksChanged && db.prepare('SELECT works_locked FROM characters WHERE id = ?').pluck().get(cid) === 0) {
    u.set('character_works', 'character_id = ?', [cid]);
    db.prepare('DELETE FROM character_works WHERE character_id = ?').run(cid);
    const ins = db.prepare('INSERT OR IGNORE INTO character_works (character_id, work_id, position) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM works WHERE id = ?)');
    for (const w of a.worksBefore) ins.run(cid, w.work_id, w.position, w.work_id);
    // 绑定时新建、现在没人用的作品删掉
    for (const wid of a.createdWorkIds) {
      const used = db
        .prepare(
          `SELECT 1 FROM character_works WHERE work_id = @w UNION ALL SELECT 1 FROM image_copyrights WHERE work_id = @w
           UNION ALL SELECT 1 FROM collection_works WHERE work_id = @w LIMIT 1`,
        )
        .get({ w: wid });
      if (used || !db.prepare('SELECT 1 FROM works WHERE id = ?').get(wid)) continue;
      u.set('aliases', "owner_type = 'work' AND owner_id = ?", [wid]);
      u.set('works', 'id = ?', [wid]);
      db.prepare("DELETE FROM aliases WHERE owner_type = 'work' AND owner_id = ?").run(wid);
      db.prepare('DELETE FROM works WHERE id = ?').run(wid);
    }
  }
  u.set('custom_character_matches', 'character_id = ?', [cid]);
  u.columns('characters', ['danbooru_tag', 'source'], [cid]);
  db.prepare("UPDATE characters SET danbooru_tag = NULL, source = 'custom' WHERE id = ?").run(cid);
  // 记成「忽略这个匹配」，以后不再自动绑同一个标签
  db.prepare(
    `INSERT INTO custom_character_matches (character_id, danbooru_tag, score, reason, existing_character_id, dismissed, computed_at)
     VALUES (?, ?, 1, 'reverted', NULL, 1, ?)
     ON CONFLICT(character_id) DO UPDATE SET danbooru_tag = excluded.danbooru_tag, dismissed = 1`,
  ).run(cid, a.tag, now);
}
