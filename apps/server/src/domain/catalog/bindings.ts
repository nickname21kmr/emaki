/**
 * 角色和 Danbooru 标签的绑定 / 解绑（编目，附录 #37）。可撤销的都在调用方的 ctx.mutate 里，按这里的顺序记撤销。
 *
 * 规则（手动、自动一样）：
 * - 绑定：标签和来源一起改（source = 'danbooru'）；没手动指定过作品（works_locked = 0）就按 Danbooru 补作品
 * - 解绑：标签清掉、改回自建（source = 'custom'），并记成「忽略这个匹配」——自建角色会被重新匹配，
 *   不记的话自动关联会把用户刚解掉的标签又绑回去
 * 所以 source = 'danbooru' 当且仅当有 Danbooru 标签（迁移 036 之前手动解绑、认不出原来标签的旧数据除外）。
 */
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import type { CharacterCatalog } from './characterCatalog.ts';

/** 绑定时对作品做了什么：撤回自动绑定时按它放回 */
export interface WorksChange {
  /** 绑定时改了作品（没手动指定作品的才会改）：撤回时放回原来的 */
  worksChanged: boolean;
  worksBefore: { work_id: number; position: number }[];
  createdWorkIds: number[];
}

/** 撤回一次自动绑定需要的信息（change_log 里 auto-associate 的 payload 的一部分） */
export interface AutoBinding extends WorksChange {
  characterId: number;
  tag: string;
}

/**
 * 按 Danbooru 给角色补作品：用户没手动指定过作品（works_locked = 0）时，追加 tag 所属、还没挂上的作品，必要时新建。
 * 撤销记录：先快照角色的作品，再记新建的作品（撤销时先删新建的作品和它们的别名，再还原角色的作品）
 */
export function linkDanbooruWorks(db: Db, u: UndoRecorder, catalog: CharacterCatalog, characterId: number, tag: string, now: string): WorksChange {
  const worksBefore = db
    .prepare('SELECT work_id, position FROM character_works WHERE character_id = ? ORDER BY position')
    .all(characterId) as WorksChange['worksBefore'];
  const locked = db.prepare('SELECT works_locked FROM characters WHERE id = ?').pluck().get(characterId) !== 0;
  const createdWorkIds: number[] = [];
  if (!locked) {
    u.set('character_works', 'character_id = ?', [characterId]);
    for (const wid of catalog.linkWorks(characterId, tag, now)) {
      createdWorkIds.push(wid);
      u.inserted('works', wid);
      u.sql("DELETE FROM aliases WHERE owner_type = 'work' AND owner_id = ?", [wid]);
    }
  }
  return { worksChanged: !locked, worksBefore, createdWorkIds };
}

/** 绑定 Danbooru 标签（手动编辑、自建角色自动关联都走这里）。调用方先确认标签没有别的主人 */
export function bindDanbooru(db: Db, u: UndoRecorder, catalog: CharacterCatalog, characterId: number, tag: string, now: string): WorksChange {
  u.columns('characters', ['danbooru_tag', 'source'], [characterId]);
  db.prepare("UPDATE characters SET danbooru_tag = ?, source = 'danbooru' WHERE id = ?").run(tag, characterId);
  return linkDanbooruWorks(db, u, catalog, characterId, tag, now);
}

/**
 * 解绑（手动清掉标签、撤回自动绑定都走这里）：改回自建，记成「忽略这个匹配」（以后不再自动绑同一个标签）。
 * reason 记在匹配上：unbound = 用户解绑，reverted = 撤回自动绑定
 */
export function unbindDanbooru(db: Db, u: UndoRecorder, characterId: number, tag: string, now: string, reason: 'unbound' | 'reverted'): void {
  u.set('custom_character_matches', 'character_id = ?', [characterId]);
  u.columns('characters', ['danbooru_tag', 'source'], [characterId]);
  db.prepare("UPDATE characters SET danbooru_tag = NULL, source = 'custom' WHERE id = ?").run(characterId);
  db.prepare(
    `INSERT INTO custom_character_matches (character_id, danbooru_tag, score, reason, existing_character_id, dismissed, computed_at)
     VALUES (?, ?, 1, ?, NULL, 1, ?)
     ON CONFLICT(character_id) DO UPDATE SET danbooru_tag = excluded.danbooru_tag, dismissed = 1`,
  ).run(characterId, tag, reason, now);
}

/**
 * 撤回自动绑定在编目这边的部分：作品放回绑定前的（期间用户手动改过作品的不动）、绑定时新建且现在没人用的作品删掉、
 * 解绑。图上的关联由调用方先经归类模块去掉
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
  unbindDanbooru(db, u, cid, a.tag, now, 'reverted');
}
