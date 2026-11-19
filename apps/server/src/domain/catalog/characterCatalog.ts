/**
 * 「标签 → 角色 / 作品」的唯一实现（T10、T11、T14、T15 共用；附录 #37）。全是同步 API：要在 better-sqlite3 事务里调用。
 * 缓存只在一次任务或一次请求内有效——每次用都 new 一个（合并 / 删除角色后长期缓存会过期）。
 *
 * 编目里的标签规范化和解析都从这里走：
 * - normalizeTag：角色标签 → 身份（改名、服装变体归本体、核验过的身份）。解析、建角色、收拢都用它
 * - normalizeWorkTag：作品标签只按改名表（作品没有服装变体和核验身份，套角色的规则会把带括号的作品名拆坏）
 * - resolveCharacterId：标签 → 角色（规范化 → 角色自己的标签 → 合并重定向 → 核验过的形态）
 * 生产环境用 createCatalog 建（规则来自 Danbooru 缓存）；直接 new 时不给规则就是原样返回，测试用。
 */
import type { Db, Statement } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import type { DanbooruCatalog } from '../../services/danbooru/catalog.ts';
import type { CharacterVerifications } from '../../services/catalog/characterVerification.ts';
import type { CopyrightSource } from '../../services/catalog/copyrights.ts';
import { HumanizeLocalizer, type Localizer } from '../../services/i18n/localizer.ts';
import { colorFromTag } from '../../util/color.ts';
import { replaceAutoAliases } from './aliases.ts';

export interface CatalogOptions {
  copyrights: CopyrightSource;
  /** 默认 new HumanizeLocalizer() */
  localizer?: Localizer;
  /** 角色标签的规范化。默认原样返回；createCatalog 给的是 DanbooruCatalog.normalizeTag（改名 + 服装变体归本体 + 核验过的身份） */
  normalizeTag?: (tag: string) => string;
  /** 作品标签的规范化。默认原样返回；createCatalog 给的是 DanbooruCatalog.canonicalize（只按改名表） */
  normalizeWorkTag?: (tag: string) => string;
  verifications?: CharacterVerifications;
}

/** 自建角色（没有 danbooru_tag）建议的主键占位前缀；真正的引用在 character_suggestions.character_id */
export const CUSTOM_TAG_PREFIX = 'emaki:character:';

export class CharacterCatalog {
  /** 自建角色的占位标签 */
  static customTag(id: number): string {
    return `${CUSTOM_TAG_PREFIX}${id}`;
  }

  /** 占位标签里的编号；不是占位标签返回 null。只解析，不查库，也不保证这个编号还是原来那个角色 */
  static customId(tag: string): number | null {
    if (!tag.startsWith(CUSTOM_TAG_PREFIX)) return null;
    const s = tag.slice(CUSTOM_TAG_PREFIX.length);
    const id = Number(s);
    return /^[1-9]\d*$/.test(s) && Number.isSafeInteger(id) ? id : null;
  }

  /** 带占位前缀的都不是 Danbooru 标签：不能拿去新建角色，也不能发给 Danbooru */
  static isCustomTag(tag: string): boolean {
    return tag.startsWith(CUSTOM_TAG_PREFIX);
  }

  private readonly cache = new Map<string, number | null>();
  private cachedRevision = 0;
  private readonly localizer: Localizer;
  private readonly normalize: (tag: string) => string;
  private readonly normalizeWork: (tag: string) => string;
  private readonly s: Record<string, Statement>;

  constructor(
    private readonly db: Db,
    private readonly o: CatalogOptions,
  ) {
    this.localizer = o.localizer ?? new HumanizeLocalizer();
    this.normalize = o.normalizeTag ?? ((t) => t);
    this.normalizeWork = o.normalizeWorkTag ?? ((t) => t);
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

  /** 角色标签 → 身份标签（见文件头） */
  normalizeTag(tag: string): string {
    return this.normalize(tag);
  }

  /** 作品标签 → 现在的名字（见文件头） */
  normalizeWorkTag(tag: string): string {
    return this.normalizeWork(tag);
  }

  get verificationRevision(): number {
    return this.o.verifications?.revision ?? 0;
  }

  /** 丢掉 tag → id 缓存。识别任务一跑几个小时，每批开头清一次：中途合并 / 采纳 / 撤销都会改 characters 表 */
  clearCache(): void {
    this.cache.clear();
  }

  /** normalizeTag → characters.danbooru_tag → danbooru_tag_redirects（合并重定向）；规范化后找不到时再按原标签找 */
  resolveCharacterId(tag: string): number | null {
    // 占位标签按编号找：编号会被复用，只适合刚从 characters 生成占位标签的同一个任务；读建议行要用 character_id
    if (CharacterCatalog.isCustomTag(tag)) {
      const id = CharacterCatalog.customId(tag);
      return id !== null && this.db.prepare('SELECT 1 FROM characters WHERE id=?').get(id) ? id : null;
    }
    const revision = this.verificationRevision;
    if (this.cachedRevision !== revision) {
      this.clearCache();
      this.cachedRevision = revision;
    }
    const t = this.normalize(tag);
    const existing = this.lookup(t) ?? (t !== tag ? this.lookup(tag) : null);
    if (existing !== null) return existing;
    for (const form of this.o.verifications?.formsOf(t) ?? []) {
      const id = this.lookup(form.tag);
      if (id !== null) return id;
    }
    return null;
  }

  /**
   * 一批已经规范化过的标签（证据里的候选）→ 角色。先一条语句按标签找（角色自己的标签、合并重定向），找不到的再走 resolveCharacterId
   * （规范化、核验过的变体）。证据里的标签写入时已经规范化，逐个再规范化一遍要慢上一截（reevaluateAuto 每批识别都要解析）
   */
  resolveNormalized(tags: Iterable<string>): Map<string, number | null> {
    const out = new Map<string, number | null>();
    const list = [...new Set(tags)].filter((t) => !CharacterCatalog.isCustomTag(t));
    if (list.length) {
      const rows = this.db
        .prepare(
          `SELECT j.value, COALESCE((SELECT c.id FROM characters c WHERE c.danbooru_tag = j.value),
             (SELECT r.character_id FROM danbooru_tag_redirects r WHERE r.tag = j.value)) FROM json_each(?) j`,
        )
        .raw()
        .all(JSON.stringify(list)) as [string, number | null][];
      for (const [tag, id] of rows) if (id !== null) out.set(tag, id);
    }
    for (const tag of list) if (!out.has(tag)) out.set(tag, this.resolveCharacterId(tag));
    return out;
  }

  private lookup(tag: string): number | null {
    if (this.cache.has(tag)) return this.cache.get(tag)!;
    const row = this.s.resolve!.get({ tag }) as { id: number } | undefined;
    const id = row?.id ?? null;
    this.cache.set(tag, id);
    return id;
  }

  /** 已存在就返回；否则新建 danbooru 角色（名字、别名、作品）。不写封面：封面由 derived 自动选，用户设的才存（T25.5） */
  ensureCharacter(rawTag: string, now: string): { id: number; created: boolean; createdWorkIds: number[] } {
    const tag = this.normalize(rawTag);
    // 按原标签查（内部会规范化一次）：规范化不一定一步到位，对 tag 再规范化可能变成别的名字，查不到已建的 tag 就会重复插入
    const existing = this.resolveCharacterId(rawTag) ?? this.lookup(tag);
    if (existing !== null) {
      return { id: existing, created: false, createdWorkIds: [] };
    }
    // 占位标签绝不新建角色（会建出一个叫 Emaki:character:N 的 danbooru 角色）
    if (CharacterCatalog.isCustomTag(rawTag)) throw new Error('候选角色已被删除，请重新匹配');
    const name = this.localizer.characterName(tag).name;
    const id = Number(this.s.insChar!.run({ name, tag, now }).lastInsertRowid);
    this.cache.set(tag, id);
    const createdWorkIds = this.linkWorks(id, tag, now);
    replaceAutoAliases(this.db, 'character', id, this.localizer.aliasesFor(tag, 'character', name));
    return { id, created: true, createdWorkIds };
  }

  /** 已存在就返回；否则新建作品（名字、颜色、自动别名）。标签先按改名表换成现在的名字 */
  ensureWork(rawTag: string, now: string): { id: number; created: boolean } {
    const copyright = this.normalizeWork(rawTag);
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
    const id = this.resolveCharacterId(tag);
    if (id !== null) {
      const info = this.s.charInfo!.get(id) as { name: string; work: string | null };
      return { characterId: id, name: info.name, workName: info.work };
    }
    const primary = this.o.copyrights.copyrights(t)[0];
    const workName = primary ? ((this.s.workName!.get(primary) as string | undefined) ?? this.localizer.workName(primary).name) : null;
    return { characterId: null, name: this.localizer.characterName(t).name, workName };
  }

  /** 搜索可用建议与建档时用同一份本地名字资料。 */
  namesForTag(tag: string, displayName: string): string[] {
    return [displayName, tag, ...this.localizer.aliasesFor(tag, 'character', displayName).map(a => a.alias)];
  }
}

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
    // 同 create：合并掉以后编号可能被新角色拿走，按建立时间认是不是原来那个
    u.guard('SELECT 1 FROM characters WHERE id = ? AND created_at <> ?', [r.id, opts.now], `无法撤销：新建的角色 ${tag} 已经合并掉了，原来的编号给了之后新建的角色`);
  }
  return { id: r.id, created: r.created };
}

/** 可撤销地按标签找 / 建作品（例如「原创」）。调用方必须在 ctx.mutate 里调用；撤销时先删作品的别名再删作品 */
export function insertWork(u: UndoRecorder, catalog: CharacterCatalog, tag: string, opts: { now: string }): { id: number; created: boolean } {
  const w = catalog.ensureWork(tag, opts.now);
  if (w.created) {
    u.inserted('works', w.id);
    u.sql("DELETE FROM aliases WHERE owner_type = 'work' AND owner_id = ?", [w.id]);
  }
  return w;
}

/** 生产环境的编目：角色、作品标签的规范化和角色 → 作品的回退链都来自 Danbooru 缓存（SqliteDataSource.makeCatalog 也用这个） */
export function createCatalog(db: Db, danbooru: DanbooruCatalog, localizer?: Localizer): CharacterCatalog {
  return new CharacterCatalog(db, {
    copyrights: danbooru,
    localizer,
    verifications: danbooru.verifications,
    normalizeTag: (t) => danbooru.normalizeTag(t),
    normalizeWorkTag: (t) => danbooru.canonicalize(t),
  });
}
