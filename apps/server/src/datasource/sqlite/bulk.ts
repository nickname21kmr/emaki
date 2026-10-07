/**
 * 批量操作（T18）。assign / unassign / exclude / restore / favorite / rating / kind / artist 可撤销；
 * trash 把文件移到系统回收站（绝不永久删除，逐个核实），不可撤销——用户可以从回收站还原，扫描后原 id 回来。
 */
import type { BulkImagesBody, MutationResult, Rating } from '@emaki/shared';
import { ConflictError, NotFoundError } from '../../http/errors.ts';
import { toAbs } from '../../services/fs/paths.ts';
import { assertRecyclable } from '../../services/trash/driveType.ts';
import { moveToRecycleBin } from '../../services/trash/recycleBin.ts';
import type { SqliteContext } from './context.ts';
import { artistAutoMessage, artistEditMessage, normArtists } from '../artistEdits.ts';
import { artistGroupMap, artistNames } from './artists.ts';
import { createExclusionInTx } from './exclusions.ts';
import { assertKindValue, setKindInTx, type KindDeps } from './kinds.ts';
import type { CollectionsHook } from '../../services/collections/CollectionService.ts';
import { iso, parseId } from './sql.ts';

const RATING_LABEL: Record<Rating, string> = { general: '全年龄', sensitive: '轻微', questionable: '较敏感', explicit: '限制级' };

export class BulkOps {
  constructor(
    private readonly ctx: SqliteContext,
    /** T05 的 requireVisibleImages：任意一个不可见或不存在 → NotFoundError，不做任何改动 */
    private readonly requireVisible: (ids: string[]) => number[],
    private readonly kindDeps: KindDeps,
    /** 排除 / 恢复 / 改类型 / 回收站之后重算合集（T38b） */
    private readonly collections: CollectionsHook = () => {},
  ) {}

  private characterName(idStr: string): { id: number; name: string } {
    const id = parseId(idStr);
    const row = id === null ? undefined : this.ctx.stmt('SELECT id, name FROM characters WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('角色');
    return row as { id: number; name: string };
  }

  async run(body: BulkImagesBody): Promise<MutationResult> {
    const ids = this.requireVisible([...new Set(body.ids)]);
    const n = ids.length;
    const db = this.ctx.db;
    const json = JSON.stringify(ids);
    const now = iso(this.ctx.clock());
    const a = body.action;

    switch (a.type) {
      case 'assign': {
        const ch = this.characterName(a.characterId);
        return this.ctx.mutate((u) => {
          const fresh = db
            .prepare('SELECT value FROM json_each(?) WHERE value NOT IN (SELECT image_id FROM image_characters WHERE character_id = ?)')
            .pluck()
            .all(json, ch.id) as number[];
          db.prepare(
            "INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at) SELECT value, ?, 'manual', NULL, ? FROM json_each(?)",
          ).run(ch.id, now, json);
          if (fresh.length) u.sql('DELETE FROM image_characters WHERE character_id = ? AND image_id IN (SELECT value FROM json_each(?))', [ch.id, JSON.stringify(fresh)]);
          return { message: `已将 ${n} 张图归到「${ch.name}」` };
        });
      }
      case 'unassign': {
        const ch = this.characterName(a.characterId);
        return this.ctx.mutate((u) => {
          u.set('image_characters', 'character_id = ? AND image_id IN (SELECT value FROM json_each(?))', [ch.id, json]);
          db.prepare('DELETE FROM image_characters WHERE character_id = ? AND image_id IN (SELECT value FROM json_each(?))').run(ch.id, json);
          return { message: `已从「${ch.name}」移除 ${n} 张图` };
        });
      }
      case 'exclude':
        return this.ctx.mutate((u) => {
          const todo = db.prepare('SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?)) AND excluded_by IS NULL').pluck().all(json) as number[];
          for (const id of todo) createExclusionInTx(this.ctx, u, 'image', String(id));
          this.collections(u, ids);
          return { message: `已排除 ${n} 张图` };
        });
      case 'restore':
        return this.ctx.mutate((u) => {
          u.columns('images', ['excluded_by', 'exclude_exempt'], ids);
          const rows = db
            .prepare(
              `SELECT i.id, i.excluded_by, e.kind FROM images i LEFT JOIN exclusions e ON e.id = i.excluded_by
               WHERE i.id IN (SELECT value FROM json_each(?)) AND i.excluded_by IS NOT NULL`,
            )
            .all(json) as { id: number; excluded_by: number; kind: string | null }[];
          for (const r of rows) {
            if (r.kind === 'image') {
              u.set('exclusions', 'id = ?', [r.excluded_by]);
              db.prepare('UPDATE images SET excluded_by = NULL WHERE excluded_by = ?').run(r.excluded_by);
              db.prepare('DELETE FROM exclusions WHERE id = ?').run(r.excluded_by);
            } else {
              // 被文件夹 / 标签 / 角色规则排除：以后规则重新应用时也不再排除它
              db.prepare('UPDATE images SET exclude_exempt = 1 WHERE id = ?').run(r.id);
            }
          }
          db.prepare('UPDATE images SET excluded_by = NULL WHERE id IN (SELECT value FROM json_each(?))').run(json);
          this.collections(u, ids);
          return { message: `已恢复 ${n} 张图` };
        });
      case 'favorite':
        return this.ctx.mutate((u) => {
          u.columns('images', ['favorite'], ids);
          db.prepare('UPDATE images SET favorite = ? WHERE id IN (SELECT value FROM json_each(?))').run(a.value ? 1 : 0, json);
          return { message: a.value ? `已收藏 ${n} 张图` : `已取消收藏 ${n} 张图` };
        });
      case 'shelve': {
        const now = iso(this.ctx.clock());
        return this.ctx.mutate((u) => {
          u.columns('images', ['shelved_at'], ids);
          db.prepare('UPDATE images SET shelved_at = ? WHERE id IN (SELECT value FROM json_each(?))').run(a.value ? now : null, json);
          return { message: a.value ? `已放下 ${n} 张图，不再出现在未识别` : `已把 ${n} 张图放回未识别` };
        });
      }
      case 'original': {
        const now = iso(this.ctx.clock());
        // 「原创」作品（标签 original）没有就建；手动挂的关联 score 为 NULL，移出时只删手动挂的（识别器认出的保留）
        return this.ctx.mutate((u) => {
          let wid = db.prepare("SELECT id FROM works WHERE danbooru_tag = 'original'").pluck().get() as number | undefined;
          if (wid === undefined) {
            wid = Number(db.prepare("INSERT INTO works (name, danbooru_tag, created_at) VALUES ('原创', 'original', ?)").run(now).lastInsertRowid);
            u.inserted('works', wid);
          }
          u.columns('images', ['original_at'], ids);
          u.set('image_copyrights', 'work_id = ? AND image_id IN (SELECT value FROM json_each(?))', [wid, json]);
          db.prepare('UPDATE images SET original_at = ? WHERE id IN (SELECT value FROM json_each(?))').run(a.value ? now : null, json);
          if (a.value) {
            db.prepare('INSERT OR IGNORE INTO image_copyrights (image_id, work_id, score) SELECT value, ?, NULL FROM json_each(?)').run(wid, json);
          } else {
            db.prepare('DELETE FROM image_copyrights WHERE work_id = ? AND score IS NULL AND image_id IN (SELECT value FROM json_each(?))').run(wid, json);
          }
          return { message: a.value ? `已把 ${n} 张图归为原创，不再出现在未识别` : `已把 ${n} 张图移出原创` };
        });
      }
      case 'rating':
        return this.ctx.mutate((u) => {
          u.columns('images', ['rating', 'rating_manual'], ids);
          db.prepare('UPDATE images SET rating = ?, rating_manual = 1 WHERE id IN (SELECT value FROM json_each(?))').run(a.value, json);
          return { message: `已把 ${n} 张图设为「${RATING_LABEL[a.value]}」` };
        });
      case 'kind': {
        const value = a.value;
        assertKindValue(value);
        return this.ctx.mutate((u) => {
          const message = setKindInTx(this.ctx, u, ids, value, this.kindDeps);
          this.collections(u, ids);
          return { message };
        });
      }
      case 'trash':
        return this.trash(ids, now);
      case 'artist': {
        // 手动改画师：改过的图记 artist_manual，之后识别、补跑都不再动它（writeArtists）
        const tags = normArtists(a.mode, a.artists);
        const names = artistNames(db, tags);
        const tj = JSON.stringify(tags);
        return this.ctx.mutate((u) => {
          u.set('image_artists', 'image_id IN (SELECT value FROM json_each(?))', [json]);
          u.columns('images', ['artist_manual', 'artist_checked_at'], ids);
          if (a.mode === 'set') db.prepare('DELETE FROM image_artists WHERE image_id IN (SELECT value FROM json_each(?))').run(json);
          if (a.mode === 'remove') {
            // 同一个人的旧名、社团名等标签一起去掉（和按画师筛图的 tagsOfArtist 是同一组）
            const groups = artistGroupMap(db);
            const reps = new Set(tags.map((t) => groups.get(t) ?? t));
            const all = [...new Set([...tags, ...[...groups].filter(([, g]) => reps.has(g)).map(([t]) => t)])];
            db.prepare('DELETE FROM image_artists WHERE image_id IN (SELECT value FROM json_each(?)) AND artist IN (SELECT value FROM json_each(?))').run(json, JSON.stringify(all));
          } else {
            db.prepare('INSERT OR IGNORE INTO image_artists (image_id, artist, score) SELECT i.value, t.value, 1 FROM json_each(?) i, json_each(?) t').run(json, tj);
          }
          db.prepare('UPDATE images SET artist_manual = 1, artist_checked_at = COALESCE(artist_checked_at, ?) WHERE id IN (SELECT value FROM json_each(?))').run(now, json);
          return { message: artistEditMessage(a.mode, n, names) };
        });
      }
      case 'artist-auto': {
        // 改回自动：只动手动改过的图，清掉手动改的、artist_checked_at 置空，「识别画师」会重新认；没改过的图不动
        const manual = db.prepare('SELECT id FROM images WHERE artist_manual = 1 AND id IN (SELECT value FROM json_each(?))').pluck().all(json) as number[];
        const mj = JSON.stringify(manual);
        return this.ctx.mutate((u) => {
          if (manual.length) {
            u.set('image_artists', 'image_id IN (SELECT value FROM json_each(?))', [mj]);
            u.columns('images', ['artist_manual', 'artist_checked_at'], manual);
            db.prepare('DELETE FROM image_artists WHERE image_id IN (SELECT value FROM json_each(?))').run(mj);
            db.prepare('UPDATE images SET artist_manual = 0, artist_checked_at = NULL WHERE id IN (SELECT value FROM json_each(?))').run(mj);
          }
          return { message: artistAutoMessage(n, manual.length) };
        });
      }
    }
  }

  private async trash(ids: number[], now: string): Promise<MutationResult> {
    const rows = this.ctx.db
      .prepare(
        `SELECT i.id, i.rel_path, r.path AS root FROM images i JOIN library_roots r ON r.id = i.root_id
         WHERE i.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as { id: number; rel_path: string; root: string }[];
    // 任一文件夹没有回收站 → 400，一张都不删
    for (const root of new Set(rows.map((r) => r.root))) await assertRecyclable(root);
    const byPath = new Map(rows.map((r) => [toAbs(r.root, r.rel_path), r.id]));
    const res = await moveToRecycleBin([...byPath.keys()]);
    const done = [...res.trashed, ...res.alreadyGone].map((p) => byPath.get(p)!);
    if (!done.length) throw new ConflictError(`没有文件被移到回收站：${res.failed[0]?.reason ?? '未知原因'}`);
    return this.ctx.write(() => {
      this.ctx.db.prepare('UPDATE images SET trashed_at = ? WHERE id IN (SELECT value FROM json_each(?))').run(now, JSON.stringify(done));
      this.collections(null, done);
      const tail = res.failed.length ? `，${res.failed.length} 张失败（文件可能被其他程序占用）` : '';
      return `已把 ${done.length} 张图移到回收站（可在系统回收站还原）${tail}`;
    });
  }
}
