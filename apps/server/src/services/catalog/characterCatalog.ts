/**
 * 「标签 → 角色 / 作品」的唯一实现（T10、T11、T14、T15 共用）。全是同步 API：要在 better-sqlite3 事务里调用。
 * 缓存只在一次任务或一次请求内有效——每次用都 new 一个（合并 / 删除角色后长期缓存会过期）。
 */
import type { Db, Statement } from '../../db/connection.ts';
import { colorFromTag } from '../../util/color.ts';
import { replaceAutoAliases } from '../aliases.ts';
import { HumanizeLocalizer, type Localizer } from '../i18n/localizer.ts';
import type { CopyrightSource } from './copyrights.ts';

export interface CatalogOptions {
  copyrights: CopyrightSource;
  /** 默认 new HumanizeLocalizer() */
  localizer?: Localizer;
  /** 默认原样返回；T11 换成「改名解析 + 服装变体归本体」 */
  normalizeTag?: (tag: string) => string;
}

export class CharacterCatalog {
  private readonly cache = new Map<string, number | null>();
  private readonly localizer: Localizer;
  private readonly normalize: (tag: string) => string;
  private readonly s: Record<string, Statement>;

  constructor(
    private readonly db: Db,
    private readonly o: CatalogOptions,
  ) {
    this.localizer = o.localizer ?? new HumanizeLocalizer();
    this.normalize = o.normalizeTag ?? ((t) => t);
    this.s = {
      resolve: db.prepare(
        'SELECT id FROM characters WHERE danbooru_tag = @tag UNION ALL SELECT character_id FROM danbooru_tag_redirects WHERE tag = @tag LIMIT 1',
      ),
      insChar: db.prepare(
        "INSERT INTO characters (name, danbooru_tag, source, created_at) VALUES (@name, @tag, 'danbooru', @now)",
      ),
      workByTag: db.prepare('SELECT id FROM works WHERE danbooru_tag = ?'),
      insWork: db.prepare('INSERT INTO works (name, danbooru_tag, color, created_at) VALUES (@name, @tag, @color, @now)'),
      nextPos: db.prepare('SELECT COALESCE(MAX(position) + 1, 0) FROM character_works WHERE character_id = ?').pluck(),
      link: db.prepare('INSERT OR IGNORE INTO character_works (character_id, work_id, position) VALUES (?, ?, ?)'),
      orphans: db.prepare(`SELECT c.id, c.danbooru_tag AS tag FROM characters c
        WHERE c.danbooru_tag IS NOT NULL AND c.works_locked = 0
          AND NOT EXISTS (SELECT 1 FROM character_works cw WHERE cw.character_id = c.id)`),
      charInfo: db.prepare(`SELECT c.name, (SELECT w.name FROM character_works cw JOIN works w ON w.id = cw.work_id
          WHERE cw.character_id = c.id ORDER BY cw.position LIMIT 1) AS work FROM characters c WHERE c.id = ?`),
      workName: db.prepare('SELECT name FROM works WHERE danbooru_tag = ?').pluck(),
    };
  }

  normalizeTag(tag: string): string {
    return this.normalize(tag);
  }

  /** normalizeTag → characters.danbooru_tag → danbooru_tag_redirects（合并重定向） */
  resolveCharacterId(tag: string): number | null {
    const t = this.normalize(tag);
    if (this.cache.has(t)) return this.cache.get(t)!;
    const row = this.s.resolve!.get({ tag: t }) as { id: number } | undefined;
    const id = row?.id ?? null;
    this.cache.set(t, id);
    return id;
  }

  /** 已存在就返回；否则新建 danbooru 角色（名字、别名、作品）。不写封面：封面由 derived 自动选，用户设的才存（T25.5） */
  ensureCharacter(rawTag: string, now: string): { id: number; created: boolean; createdWorkIds: number[] } {
    const tag = this.normalize(rawTag);
    const existing = this.resolveCharacterId(tag);
    if (existing !== null) {
      return { id: existing, created: false, createdWorkIds: [] };
    }
    const name = this.localizer.characterName(tag).name;
    const id = Number(this.s.insChar!.run({ name, tag, now }).lastInsertRowid);
    this.cache.set(tag, id);
    const createdWorkIds = this.linkWorks(id, tag, now);
    replaceAutoAliases(this.db, 'character', id, this.localizer.aliasesFor(tag, 'character', name));
    return { id, created: true, createdWorkIds };
  }

  ensureWork(copyright: string, now: string): { id: number; created: boolean } {
    const row = this.s.workByTag!.get(copyright) as { id: number } | undefined;
    if (row) return { id: row.id, created: false };
    const name = this.localizer.workName(copyright).name;
    const id = Number(this.s.insWork!.run({ name, tag: copyright, color: colorFromTag(copyright), now }).lastInsertRowid);
    replaceAutoAliases(this.db, 'work', id, this.localizer.aliasesFor(copyright, 'work', name));
    return { id, created: true };
  }

  /** 按 copyrights(tag) 追加挂作品（position 接着现有最大值），返回新建的作品 id */
  linkWorks(characterId: number, tag: string, now: string): number[] {
    const created: number[] = [];
    let pos = this.s.nextPos!.get(characterId) as number;
    for (const c of this.o.copyrights.copyrights(this.normalize(tag))) {
      const w = this.ensureWork(c, now);
      if (w.created) created.push(w.id);
      if (this.s.link!.run(characterId, w.id, pos).changes) pos++;
    }
    return created;
  }

  /** 用给定的作品列表替换角色的作品（顺序即 position）；列表为空、与现有顺序相同、或 works_locked = 1 时都不动 */
  relinkWorks(characterId: number, copyrightTags: string[], now: string): void {
    if (!copyrightTags.length) return;
    const locked = this.db.prepare('SELECT works_locked FROM characters WHERE id = ?').pluck().get(characterId) as number | undefined;
    if (locked !== 0) return;
    const current = this.db
      .prepare('SELECT w.danbooru_tag FROM character_works cw JOIN works w ON w.id = cw.work_id WHERE cw.character_id = ? ORDER BY cw.position')
      .pluck()
      .all(characterId) as (string | null)[];
    if (current.length === copyrightTags.length && current.every((t, i) => t === copyrightTags[i])) return;
    this.db.prepare('DELETE FROM character_works WHERE character_id = ?').run(characterId);
    copyrightTags.forEach((c, i) => this.s.link!.run(characterId, this.ensureWork(c, now).id, i));
  }

  /** 给没有作品的 danbooru 角色补挂，返回补挂上的角色数 */
  backfillWorks(now: string): number {
    let n = 0;
    for (const r of this.s.orphans!.all() as { id: number; tag: string }[]) {
      this.linkWorks(r.id, r.tag, now);
      if ((this.s.nextPos!.get(r.id) as number) > 0) n++;
    }
    return n;
  }

  /** 给 T15 拼 CharacterSuggestion；只查不写 */
  describeTag(tag: string): { characterId: number | null; name: string; workName: string | null } {
    const t = this.normalize(tag);
    const id = this.resolveCharacterId(t);
    if (id !== null) {
      const info = this.s.charInfo!.get(id) as { name: string; work: string | null };
      return { characterId: id, name: info.name, workName: info.work };
    }
    const primary = this.o.copyrights.copyrights(t)[0];
    const workName = primary ? ((this.s.workName!.get(primary) as string | undefined) ?? this.localizer.workName(primary).name) : null;
    return { characterId: null, name: this.localizer.characterName(t).name, workName };
  }
}

/** 给 T14 / T15 用的便捷函数 */
export function resolveCharacterIdByTag(db: Db, tag: string, normalize: (t: string) => string = (t) => t): number | null {
  const t = normalize(tag);
  const row = db
    .prepare('SELECT id FROM characters WHERE danbooru_tag = @tag UNION ALL SELECT character_id FROM danbooru_tag_redirects WHERE tag = @tag LIMIT 1')
    .get({ tag: t }) as { id: number } | undefined;
  return row?.id ?? null;
}
