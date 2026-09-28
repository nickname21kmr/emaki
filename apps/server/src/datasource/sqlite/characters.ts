/**
 * 角色编辑、合并、自建角色（T14）。所有写操作都在 ctx.mutate 里（一个事务 + 撤销记录）；
 * 编辑之后重算「自建角色能对上 Danbooru」（recomputeCustomMatches 自己开事务，放在 mutate 之后）。
 */
import { searchKey, type Character, type CreateCharacterBody, type ID, type MutationResult, type UpdateCharacterBody } from '@emaki/shared';
import { BadRequestError, ConflictError, NotFoundError } from '../../http/errors.ts';
import type { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import type { DanbooruCatalog } from '../../services/danbooru/catalog.ts';
import { recomputeCustomMatches } from '../../services/danbooru/matcher.ts';
import type { SqliteContext } from './context.ts';
import type { Derived } from './derived.ts';
import { toCharacter } from './library.ts';
import { iso, parseId } from './sql.ts';
import type { UndoRecorder } from './undo.ts';

/** 可撤销地按标签新建 danbooru 角色（必要时新建作品）。调用方必须在 ctx.mutate 里调用 */
export function insertDanbooruCharacter(
  u: UndoRecorder,
  catalog: CharacterCatalog,
  tag: string,
  opts: { now: string },
): { id: number; created: boolean } {
  const r = catalog.ensureCharacter(tag, opts.now);
  if (r.created) {
    // 记录顺序决定撤销顺序（撤销时逆序）：先删角色别名 → 删角色（级联 character_works）→ 删作品别名 → 删作品
    for (const wid of r.createdWorkIds) {
      u.inserted('works', wid);
      u.sql("DELETE FROM aliases WHERE owner_type = 'work' AND owner_id = ?", [wid]);
    }
    u.inserted('characters', r.id);
    u.sql("DELETE FROM aliases WHERE owner_type = 'character' AND owner_id = ?", [r.id]);
  }
  return { id: r.id, created: r.created };
}

/** trim、去空、保序去重、最多 50 个、每个 ≤ 100 字 */
function normalizeAliases(xs: string[] | undefined): string[] {
  const out: string[] = [];
  for (const x of xs ?? []) {
    const a = x.trim().slice(0, 100);
    if (a && !out.includes(a)) out.push(a);
    if (out.length >= 50) break;
  }
  return out;
}

export class CharacterMutations {
  constructor(
    private readonly ctx: SqliteContext,
    private readonly derived: Derived,
    private readonly danbooru: () => DanbooruCatalog,
    private readonly catalog: () => CharacterCatalog,
  ) {}

  private get db() {
    return this.ctx.db;
  }

  private requireCharacter(id: ID): { id: number; name: string; danbooru_tag: string | null; source: string } {
    const n = parseId(id);
    const row = n === null ? undefined : this.ctx.stmt('SELECT id, name, danbooru_tag, source FROM characters WHERE id = ?').get(n);
    if (!row) throw new NotFoundError('角色');
    return row as { id: number; name: string; danbooru_tag: string | null; source: string };
  }

  private parseWorkIds(ids: ID[]): number[] {
    const nums = ids.map((w) => {
      const n = parseId(w);
      if (n === null) throw new NotFoundError(`作品 ${w}`);
      return n;
    });
    const found = new Set(this.db.prepare('SELECT id FROM works WHERE id IN (SELECT value FROM json_each(?))').pluck().all(JSON.stringify(nums)) as number[]);
    const missing = nums.find((n) => !found.has(n));
    if (missing !== undefined) throw new NotFoundError(`作品 ${missing}`);
    return [...new Set(nums)];
  }

  /** 标签被别的角色占用（本身或合并重定向）→ 409，提示合并 */
  private assertTagFree(tag: string, exceptCharacterId?: number): void {
    const owner = this.catalog().resolveCharacterId(tag);
    if (owner !== null && owner !== exceptCharacterId) {
      const name = this.db.prepare('SELECT name FROM characters WHERE id = ?').pluck().get(owner) as string;
      throw new ConflictError(`标签 ${tag} 已属于「${name}」，可以用「合并」把两个角色合在一起`);
    }
  }

  /** 用户编辑别名：替换 origin='user' 的行，自动别名改成只供搜索 */
  private writeUserAliases(ownerId: number, aliases: string[]): void {
    this.db.prepare("DELETE FROM aliases WHERE owner_type = 'character' AND owner_id = ? AND origin = 'user'").run(ownerId);
    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES ('character', ?, ?, ?, 'user', 1, ?)",
    );
    aliases.forEach((a, i) => ins.run(ownerId, a, searchKey(a), i));
    this.db.prepare("UPDATE aliases SET visible = 0 WHERE owner_type = 'character' AND owner_id = ? AND origin <> 'user'").run(ownerId);
  }

  private writeCharacterWorks(characterId: number, workIds: number[]): void {
    this.db.prepare('DELETE FROM character_works WHERE character_id = ?').run(characterId);
    const ins = this.db.prepare('INSERT INTO character_works (character_id, work_id, position) VALUES (?, ?, ?)');
    workIds.forEach((w, i) => ins.run(characterId, w, i));
  }

  private toCharacter(id: number): Character {
    this.derived.invalidate();
    return toCharacter(this.derived.get().characters.get(id)!);
  }

  create(body: CreateCharacterBody): MutationResult & { character: Character } {
    const name = body.name.trim();
    if (!name) throw new BadRequestError('角色名不能为空');
    const workIds = this.parseWorkIds(body.workIds);
    const tag = body.danbooruTag?.trim() || null;
    if (tag) this.assertTagFree(tag);
    const now = iso(this.ctx.clock());
    let id = 0;
    const result = this.ctx.mutate((u) => {
      id = Number(
        this.db
          .prepare(
            'INSERT INTO characters (name, danbooru_tag, source, pinned, name_locked, works_locked, last_seen_at, created_at) VALUES (?, ?, ?, 0, 1, ?, ?, ?)',
          )
          .run(name, tag, tag ? 'danbooru' : 'custom', workIds.length ? 1 : 0, now, now).lastInsertRowid,
      );
      u.inserted('characters', id);
      u.sql("DELETE FROM aliases WHERE owner_type = 'character' AND owner_id = ?", [id]); // aliases 没有外键，撤销时手动删
      this.writeCharacterWorks(id, workIds);
      this.writeUserAliases(id, normalizeAliases(body.aliases));
      u.onUndo(() => recomputeCustomMatches(this.db, this.danbooru(), [id]));
      return { message: `已新建角色「${name}」` };
    });
    recomputeCustomMatches(this.db, this.danbooru(), [id]);
    return { ...result, character: this.toCharacter(id) };
  }

  update(idStr: ID, body: UpdateCharacterBody): MutationResult {
    const cur = this.requireCharacter(idStr);
    const id = cur.id;
    const workIds = body.workIds ? this.parseWorkIds(body.workIds) : null;
    const tag = body.danbooruTag === undefined ? undefined : body.danbooruTag?.trim() || null;
    if (tag) this.assertTagFree(tag, id);
    const cover = body.coverImageId === undefined ? undefined : body.coverImageId === null ? null : parseId(body.coverImageId);
    if (cover === null && body.coverImageId !== null && body.coverImageId !== undefined) throw new NotFoundError('图片');
    if (cover != null && !this.db.prepare('SELECT 1 FROM images WHERE id = ?').get(cover)) throw new NotFoundError('图片');

    let newName = cur.name;
    const result = this.ctx.mutate((u) => {
      if (workIds) u.set('character_works', 'character_id = ?', [id]);
      if (body.aliases !== undefined) u.set('aliases', "owner_type = 'character' AND owner_id = ?", [id]);
      u.columns(
        'characters',
        ['name', 'danbooru_tag', 'source', 'cover_image_id', 'cover_manual', 'cover_focus_x', 'cover_focus_y', 'pinned', 'name_locked', 'works_locked'],
        [id],
      );
      const set = (sql: string, ...args: unknown[]) => this.db.prepare(`UPDATE characters SET ${sql} WHERE id = ?`).run(...args, id);
      if (body.name !== undefined) {
        const n = body.name.trim();
        if (n && n !== cur.name) {
          set('name = ?, name_locked = 1', n);
          newName = n;
        }
      }
      if (body.aliases !== undefined) this.writeUserAliases(id, normalizeAliases(body.aliases));
      if (tag !== undefined) set(tag ? "danbooru_tag = ?, source = 'danbooru'" : 'danbooru_tag = ?', tag);
      if (workIds) {
        this.writeCharacterWorks(id, workIds);
        set('works_locked = 1');
      }
      // 设封面 = 手动（自动选图不再换掉它）；设为 null = 恢复自动封面
      if (cover !== undefined) set('cover_image_id = ?, cover_manual = ?', cover, cover === null ? 0 : 1);
      if (body.coverFocus !== undefined) set('cover_focus_x = ?, cover_focus_y = ?', body.coverFocus?.x ?? null, body.coverFocus?.y ?? null);
      if (body.pinned !== undefined) set('pinned = ?', body.pinned ? 1 : 0);
      u.onUndo(() => recomputeCustomMatches(this.db, this.danbooru(), [id]));
      return { message: `已更新「${newName}」` };
    });
    recomputeCustomMatches(this.db, this.danbooru(), [id]);
    return result;
  }

  markSeen(idStr: ID): void {
    const { id } = this.requireCharacter(idStr);
    if ((this.derived.get().characters.get(id)?.newCount ?? 0) === 0) return; // mock 不发事件
    this.db.prepare('UPDATE characters SET last_seen_at = ? WHERE id = ?').run(iso(this.ctx.clock()), id);
    this.ctx.touch();
  }

  merge(fromStr: ID, toStr: ID): MutationResult {
    if (fromStr === toStr) throw new BadRequestError('不能合并到自己');
    const from = this.requireCharacter(fromStr);
    const to = this.requireCharacter(toStr);
    if (from.id === to.id) throw new BadRequestError('不能合并到自己');
    if (this.db.prepare("SELECT 1 FROM exclusions WHERE kind = 'character' AND target = ?").get(String(from.id))) {
      throw new BadRequestError('这个角色有排除规则，请先在「已排除」里恢复');
    }
    const n = this.db.prepare('SELECT count(*) FROM image_characters WHERE character_id = ?').pluck().get(from.id) as number;
    const p = { from: from.id, to: to.id };

    const result = this.ctx.mutate((u) => {
      // 严格按此顺序记录（撤销逆序：先还原目标的标签，再插回被合并的角色，再恢复各子表）
      u.set('image_characters', 'character_id = ?', [to.id]);
      u.set('image_characters', 'character_id = ?', [from.id]);
      // 合集的整本关联（T38b，RV-C-6）：必须在 characters 之前记录，撤销时 characters 先插回，外键才不失败
      u.set('collection_characters', 'character_id = ?', [to.id]);
      u.set('collection_characters', 'character_id = ?', [from.id]);
      u.set('aliases', "owner_type = 'character' AND owner_id IN (?, ?)", [from.id, to.id]);
      u.set('character_works', 'character_id = ?', [from.id]);
      u.set('danbooru_tag_redirects', 'character_id IN (?, ?)', [from.id, to.id]);
      u.set('custom_character_matches', 'character_id IN (?, ?) OR existing_character_id IN (?, ?)', [from.id, to.id, from.id, to.id]);
      u.set('characters', 'id = ?', [from.id]);
      u.columns('characters', ['danbooru_tag', 'source'], [to.id]); // 必须在上一行之后，避免撤销时 UNIQUE 冲突

      // 1 关联搬家（目标已有的保持目标自己的）
      this.db
        .prepare(
          `INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at)
           SELECT image_id, @to, origin, score, added_at FROM image_characters WHERE character_id = @from`,
        )
        .run(p);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO collection_characters (collection_id, character_id, added_at)
           SELECT collection_id, @to, added_at FROM collection_characters WHERE character_id = @from`,
        )
        .run(p);
      // 2 指向被合并角色的重定向改指向目标
      this.db.prepare('UPDATE danbooru_tag_redirects SET character_id = @to WHERE character_id = @from').run(p);
      // 3 标签：目标没有就接过来；目标已有就留一条重定向（否则下次打标签会把被合并的角色重新建出来）
      if (from.danbooru_tag) {
        if (!to.danbooru_tag) {
          this.db.prepare('UPDATE characters SET danbooru_tag = NULL WHERE id = ?').run(from.id);
          this.db.prepare("UPDATE characters SET danbooru_tag = ?, source = 'danbooru' WHERE id = ?").run(from.danbooru_tag, to.id);
        } else {
          this.db.prepare('INSERT OR REPLACE INTO danbooru_tag_redirects (tag, character_id) VALUES (?, ?)').run(from.danbooru_tag, to.id);
        }
      }
      // 4 别名：目标 = 目标原别名 + 被合并角色的名字 + 它的别名
      this.db
        .prepare(
          "INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES ('character', ?, ?, ?, 'user', 1, 50)",
        )
        .run(to.id, from.name, searchKey(from.name));
      this.db
        .prepare(
          `INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position)
           SELECT 'character', @to, alias, search_key, origin, visible, position + 1000 FROM aliases WHERE owner_type = 'character' AND owner_id = @from`,
        )
        .run(p);
      this.db.prepare("DELETE FROM aliases WHERE owner_type = 'character' AND owner_id = ?").run(from.id);
      // 5 删除（级联 image_characters / character_works / custom_character_matches）
      this.db.prepare('DELETE FROM characters WHERE id = ?').run(from.id);
      u.onUndo(() => recomputeCustomMatches(this.db, this.danbooru(), [from.id, to.id]));
      return { message: `已把「${from.name}」合并进「${to.name}」（${n} 张）` };
    });
    recomputeCustomMatches(this.db, this.danbooru(), [to.id]);
    return result;
  }
}
