/**
 * 最近的改动（change_log 表，迁移 028）：后台自动关联 Danbooru 标签、一轮 Pixiv 补充、移动到文件夹。
 * payload 里存撤回需要的全部信息，重启后也能撤回；撤回自动改动走 ctx.mutate，撤回本身还能撤销。
 */
import type { ChangeEntry, ChangeGroup, ChangeKind, ID, MutationResult } from '@emaki/shared';
import { done } from '../../core/undo.ts';
import type { EventBus } from '../../core/events.ts';
import type { Db } from '../../db/connection.ts';
import { ConflictError, NotFoundError } from '../../http/errors.ts';
import { dismissPixivCharacterChecks } from './pixivChecks.ts';
import type { SqliteContext } from './context.ts';
import { moveBack, type MoveBackFailure, type Moved } from './move.ts';
import { iso, parseId } from './sql.ts';
import { linkEach, unlink, unlinkEach } from '../../domain/curation/links.ts';
import { fromLegacySnapshot, fromRow, LEGACY_RULE_PREFIX, type LinkRow } from '../../domain/curation/provenance.ts';

/** 每类最多留这么多条，更早的删掉 */
const KEEP = 100;

export interface AssociatePayload {
  characterId: number;
  name: string;
  tag: string;
  /** 角色的 created_at：编号被别的角色占用时认得出来 */
  characterCreatedAt: string;
  /** 绑定时改了作品（没手动指定作品的才会改）：撤回时放回原来的 */
  worksChanged: boolean;
  worksBefore: { work_id: number; position: number }[];
  createdWorkIds: number[];
}

export interface PixivPayload {
  /** [图, 角色, added_at] */
  links: [number, number, string][];
  /** [图, 作品, original_at, 这轮新加了 image_copyrights 行 1/0] */
  originals: [number, number, string, number][];
  /** [图, 原标记时间, 本次检查时间, 随原标记删除的作品（如果有）] */
  correctedOriginals?: [number, string, string, number | null][];
}

export interface MovePayload {
  where: string;
  /** 还没移回的；移回一张去掉一张 */
  items: Moved[];
  /** 移动时漫画区同步去掉的自动关联（整行，带来历）；迁移 034 之前记的是 origin / score 的旧形状 */
  charSnap: (LinkRow | LegacyCharSnap)[];
  retagSnap: { id: number; retag: number }[];
  /** P2 之前记的「移动时新排除的图」；现在排除结果由反应按新位置重算，不再用它（旧记录里可能还有） */
  excluded?: unknown;
}

/** 迁移 034 之前的关联快照 */
interface LegacyCharSnap {
  image_id: number;
  character_id: number;
  origin: string;
  score: number | null;
  added_at: string;
}

interface Row {
  id: number;
  kind: ChangeKind;
  created_at: string;
  summary: string;
  payload: string;
  reverted_at: string | null;
  note: string | null;
}

const GROUP_KINDS: Record<ChangeGroup, ChangeKind[]> = { auto: ['auto-associate', 'pixiv-sync'], move: ['move'] };

/** 记一条改动；自动改动顺带推一条 SSE（前端弹提示）。可以在事务里调用 */
export function recordChange(
  ctx: { db: Db; clock: () => number; bus: EventBus },
  kind: ChangeKind,
  summary: string,
  payload: object,
  announce?: { count: number; hint: string },
): number {
  const now = iso(ctx.clock());
  const id = Number(
    ctx.db.prepare('INSERT INTO change_log (kind, created_at, summary, payload) VALUES (?, ?, ?, ?)').run(kind, now, summary, JSON.stringify(payload))
      .lastInsertRowid,
  );
  ctx.db
    .prepare('DELETE FROM change_log WHERE kind = ? AND id NOT IN (SELECT id FROM change_log WHERE kind = ? ORDER BY id DESC LIMIT ?)')
    .run(kind, kind, KEEP);
  if (announce) {
    ctx.bus.emit({
      type: 'auto-change',
      change: { id: String(id), kind, createdAt: now, summary, revertedAt: null, note: null, count: announce.count, revertHint: announce.hint, revertable: true },
    });
  }
  return id;
}

const fileList = (failed: MoveBackFailure[]) =>
  `${failed.slice(0, 5).map((f) => `${f.name}（${f.reason}）`).join('、')}${failed.length > 5 ? ` 等 ${failed.length} 张` : ''}`;

export class ChangeLog {
  /** 移动批次 → 进程内的撤销 token：在列表里移回后让 toast 里的撤销失效 */
  private readonly moveTokens = new Map<number, string>();

  constructor(private readonly ctx: SqliteContext) {}

  private get db(): Db {
    return this.ctx.db;
  }

  private row(id: ID): Row {
    const n = parseId(id);
    const row = n === null ? undefined : (this.db.prepare('SELECT * FROM change_log WHERE id = ?').get(n) as Row | undefined);
    if (!row) throw new NotFoundError('这条改动记录');
    return row;
  }

  rememberMoveToken(id: number, token: string): void {
    this.moveTokens.set(id, token);
  }

  list(group: ChangeGroup, limit = 20): ChangeEntry[] {
    const kinds = GROUP_KINDS[group];
    const rows = this.db
      .prepare('SELECT * FROM change_log WHERE kind IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT ?')
      .all(JSON.stringify(kinds), Math.min(Math.max(limit, 1), 100)) as Row[];
    return rows.map((r) => this.toEntry(r));
  }

  private toEntry(r: Row): ChangeEntry {
    const base = { id: String(r.id), kind: r.kind, createdAt: r.created_at, summary: r.summary, revertedAt: r.reverted_at, note: r.note };
    if (r.reverted_at) return { ...base, count: 0, revertHint: '已经撤回了', revertable: false };
    const p = JSON.parse(r.payload) as unknown;
    if (r.kind === 'auto-associate') {
      const a = p as AssociatePayload;
      if (!this.stillBound(a)) return { ...base, count: 0, revertHint: `「${a.name}」之后改过标签或已经合并、删除，不能自动撤回`, revertable: false };
      const n = this.assocImages(a, r.created_at).length;
      return {
        ...base,
        count: n,
        revertHint: `解除「${a.name}」和 ${a.tag} 的绑定${n ? `，去掉之后经这个标签自动归进来的 ${n} 张图` : ''}。手动归的图不动，以后也不再自动绑这个标签。`,
        revertable: true,
      };
    }
    if (r.kind === 'pixiv-sync') {
      const { links, originals, correctedOriginals } = this.pixivIntact(p as PixivPayload);
      const n = new Set([...links, ...originals, ...correctedOriginals].map(row => row[0])).size;
      if (!n) return { ...base, count: 0, revertHint: '这轮加的角色和原创标记之后都改过了，没有可撤回的', revertable: false };
      const parts = [
        links.length && `去掉 ${links.length} 个角色关联`,
        originals.length && `去掉 ${originals.length} 张原创标记`,
        correctedOriginals.length && `恢复 ${correctedOriginals.length} 张的原创标记`,
      ].filter(Boolean).join('，');
      return {
        ...base,
        count: n,
        revertHint: `${parts}（${n} 张图）。`,
        revertable: true,
      };
    }
    const m = p as MovePayload;
    const n = this.moveIntact(m).length;
    if (!n) return { ...base, count: 0, revertHint: '这批图之后都移动或删除过了，没有可移回的', revertable: false };
    return { ...base, count: n, revertHint: `把 ${n} 张图移回原来的位置。原位置已经有同名文件、文件不在了的会跳过并列出来。`, revertable: true };
  }

  // ------------------------------------------------------------ 自动关联

  private stillBound(a: AssociatePayload): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM characters WHERE id = ? AND created_at = ? AND danbooru_tag = ?')
      .get(a.characterId, a.characterCreatedAt, a.tag);
  }

  /**
   * 这次绑定造成的自动关联（附录 #6）：绑定之后、依据的证据就是这个标签的自动关联。手动归的、按别的标签（合并重定向）
   * 或 Pixiv 按名字对上自建角色的都不算。迁移 034 之前的模型关联不知道当时的标签（evidence_tag 为空），按以前的办法算进来
   */
  private assocImages(a: AssociatePayload, since: string): number[] {
    return this.db
      .prepare(
        `SELECT image_id FROM image_characters WHERE character_id = @cid AND decision = 'auto' AND added_at >= @since
           AND (evidence_tag = @tag OR (evidence_tag IS NULL AND evidence_provider = 'tagger' AND rule LIKE @legacy))`,
      )
      .pluck()
      .all({ cid: a.characterId, since, tag: a.tag, legacy: `${LEGACY_RULE_PREFIX}%` }) as number[];
  }

  private revertAssociate(r: Row, a: AssociatePayload): MutationResult {
    if (!this.stillBound(a)) throw new ConflictError(`「${a.name}」之后改过标签或已经合并、删除，不能自动撤回`);
    const db = this.db;
    const now = iso(this.ctx.clock());
    let removed: number[] = [];
    const result = this.ctx.mutate((u) => {
      const cid = a.characterId;
      removed = this.assocImages(a, r.created_at);
      // 只去掉这次绑定造成的自动关联；记成否决：重新识别、Pixiv 补充都不再加回
      unlink(this.ctx, u, removed, [cid], { veto: true, at: now, only: (row) => row.decision === 'auto' });
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
      this.markReverted(u, r.id, now, null);
      // 排除结果、合集、「自建角色能对上 Danbooru」都由反应重算；撤销这次撤回时同样重放
      this.ctx.changed({ type: 'catalog.bindingChanged', characterIds: [cid], ids: removed });
      return { message: `已撤回自动关联：「${a.name}」不再绑 ${a.tag}${removed.length ? `，去掉了 ${removed.length} 张自动归进来的图` : ''}` };
    });
    return result;
  }

  // ------------------------------------------------------------ Pixiv 补充

  /** 这轮加的、之后没被改过的 */
  private pixivIntact(p: PixivPayload): Required<PixivPayload> {
    // 这轮加的那条还在：同一对、同一个时间、还是 Pixiv 的自动关联（之后被用户改成手动的不算）
    const link = this.db.prepare(
      "SELECT 1 FROM image_characters WHERE image_id = ? AND character_id = ? AND decision = 'auto' AND evidence_provider = 'pixiv' AND added_at = ?",
    );
    const orig = this.db.prepare('SELECT 1 FROM images WHERE id = ? AND original_at = ?');
    const corrected = this.db.prepare(`SELECT 1 FROM images i JOIN pixiv_character_checks p ON p.image_id=i.id
      WHERE i.id=? AND i.original_at IS NULL AND i.source_site='pixiv' AND i.source_post_id=p.post_id
        AND i.modified_at=p.modified_at AND p.checked_at=?
        AND NOT EXISTS (SELECT 1 FROM image_characters c WHERE c.image_id=i.id AND c.decision='manual')`);
    return {
      links: p.links.filter(([img, ch, at]) => link.get(img, ch, at)),
      originals: p.originals.filter(([img, , at]) => orig.get(img, at)),
      correctedOriginals: (p.correctedOriginals ?? []).filter(([img, , checkedAt]) => corrected.get(img, checkedAt)),
    };
  }

  private revertPixiv(r: Row, p: PixivPayload): MutationResult {
    const db = this.db;
    const now = iso(this.ctx.clock());
    const result = this.ctx.mutate((u) => {
      const { links, originals, correctedOriginals } = this.pixivIntact(p);
      const linkImgs = [...new Set(links.map((l) => l[0]))];
      const origImgs = [...new Set(originals.map((o) => o[0]))];
      const all = [...new Set([...linkImgs, ...origImgs, ...correctedOriginals.map(o => o[0])])];
      if (!all.length) throw new ConflictError('这轮加的角色和原创标记之后都改过了，没有可撤回的');
      // 撤回后不再自动补这几张（手动补跑也跳过），撤销时一起恢复
      dismissPixivCharacterChecks(db, u, all, now);
      // 只去掉这轮 Pixiv 加的自动关联（按来历精确删除），记成否决
      unlinkEach(
        this.ctx,
        u,
        links.map(([imageId, characterId]) => ({ imageId, characterId })),
        { veto: true, at: now, only: (row) => row.decision === 'auto' && row.evidence_provider === 'pixiv' },
      );
      if (origImgs.length) {
        u.set('image_copyrights', 'image_id IN (SELECT value FROM json_each(?))', [JSON.stringify(origImgs)]);
        u.columns('images', ['original_at'], origImgs);
        const clear = db.prepare('UPDATE images SET original_at = NULL WHERE id = ?');
        const delWork = db.prepare('DELETE FROM image_copyrights WHERE image_id = ? AND work_id = ?');
        for (const [img, work, , added] of originals) {
          clear.run(img);
          if (added) delWork.run(img, work);
        }
      }
      if (correctedOriginals.length) {
        const ids = correctedOriginals.map(o => o[0]);
        u.set('image_copyrights', 'image_id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)]);
        u.columns('images', ['original_at'], ids);
        const restore = db.prepare('UPDATE images SET original_at=? WHERE id=?');
        const work = db.prepare(`INSERT OR IGNORE INTO image_copyrights(image_id,work_id,score)
          SELECT ?,id,NULL FROM works WHERE id=? AND danbooru_tag='original'`);
        for (const [img, markedAt, , workId] of correctedOriginals) {
          restore.run(markedAt, img);
          if (workId !== null) work.run(img, workId);
        }
      }
      this.markReverted(u, r.id, now, null);
      this.ctx.changed({ type: 'curation.originalChanged', ids: [...origImgs, ...correctedOriginals.map((o) => o[0])] });
      const removed = [links.length && `${links.length} 个角色关联`, originals.length && `${originals.length} 张原创标记`].filter(Boolean).join('、');
      const parts = [removed && `去掉了${removed}`, correctedOriginals.length && `恢复 ${correctedOriginals.length} 张的原创标记`].filter(Boolean).join('，');
      return { message: `已撤回 Pixiv 补充：${parts}（${all.length} 张图）` };
    });
    return result;
  }

  // ------------------------------------------------------------ 移动

  private moveIntact(m: MovePayload): Moved[] {
    const cur = this.db.prepare('SELECT 1 FROM images WHERE id = ? AND root_id = ? AND rel_path = ?');
    return m.items.filter((it) => cur.get(it.id, it.to.rootId, it.to.rel));
  }

  /**
   * 把一批移回原处。strict（toast 里的撤销）：有没移回的就报错；否则只在一张都没移回时报错，其余列在提示里。
   * 移回的从 payload 里去掉，全部移回才算撤回完
   */
  async revertMove(id: number, strict: boolean): Promise<MutationResult> {
    const r = this.row(String(id));
    if (r.reverted_at) throw new ConflictError('这批已经移回去了');
    if (this.ctx.jobs.list().some((j) => j.status === 'running' && j.kind === 'scan')) {
      throw new ConflictError('正在扫描图库，等扫描结束再移回');
    }
    const m = JSON.parse(r.payload) as MovePayload;
    const back = moveBack(this.db, m.items);
    const restored = new Set(back.restoredIds);
    const now = iso(this.ctx.clock());
    // 移回原位也是一次移动：来源、路径相关的分类、排除规则、合集都由反应按原位置重算（附录 #17）
    this.ctx.apply(() => {
      if (restored.size) {
        const ids = [...restored];
        this.ctx.changed({ type: 'image.moved', ids, reason: 'revertMove' });
        // 按原来的来历放回（归类模块；用户这期间否决过的不放回），角色这期间被删掉、合并掉的放不回，这几页留着重新识别
        const res = linkEach(
          this.ctx,
          null,
          m.charSnap
            .filter((c) => restored.has(c.image_id))
            .map((c) => ({ imageId: c.image_id, characterId: c.character_id, provenance: 'decision' in c ? fromRow(c) : fromLegacySnapshot(c) })),
          { vetoes: 'respect' },
        );
        const lost = new Set([...res.missing, ...res.vetoed].map((x) => x.imageId));
        // 重新识别的标记按移动前写回（移回原位后漫画文件夹的同步不会再标：它只标漫画文件夹里还挂着识别器角色的页）
        const setRetag = this.db.prepare('UPDATE images SET retag = @retag WHERE id = @id');
        for (const s of m.retagSnap) if (restored.has(s.id)) setRetag.run({ id: s.id, retag: lost.has(s.id) ? 1 : s.retag });
      }
      const left = m.items.filter((it) => !restored.has(it.id));
      const note = back.failed.length ? `没能移回：${fileList(back.failed)}` : null;
      if (!left.length) {
        this.db.prepare('UPDATE change_log SET reverted_at = ?, note = ?, payload = ? WHERE id = ?').run(now, note, JSON.stringify({ ...m, items: [] }), id);
      } else {
        this.db.prepare('UPDATE change_log SET note = ?, payload = ? WHERE id = ?').run(note, JSON.stringify({ ...m, items: left }), id);
      }
    });
    const token = this.moveTokens.get(id);
    if (token && !strict) {
      this.ctx.undo.expire(token, '这批已经在「最近的移动」里移回原处了');
      this.moveTokens.delete(id);
    }
    if (back.failed.length && (strict || !restored.size)) {
      throw new ConflictError(`移回了 ${back.restored} 张，${back.failed.length} 张没能移回：${fileList(back.failed)}`);
    }
    return done(back.failed.length ? `移回了 ${back.restored} 张；${back.failed.length} 张没能移回：${fileList(back.failed)}` : `已把 ${back.restored} 张移回原处`);
  }

  // ------------------------------------------------------------ 公共

  private markReverted(u: { columns: (t: 'change_log', c: string[], ids: number[]) => void }, id: number, now: string, note: string | null): void {
    u.columns('change_log', ['reverted_at', 'note'], [id]);
    this.db.prepare('UPDATE change_log SET reverted_at = ?, note = ? WHERE id = ?').run(now, note, id);
  }

  async revert(id: ID): Promise<MutationResult> {
    const r = this.row(id);
    if (r.reverted_at) throw new ConflictError('这条已经撤回了');
    const p = JSON.parse(r.payload) as unknown;
    if (r.kind === 'auto-associate') return this.revertAssociate(r, p as AssociatePayload);
    if (r.kind === 'pixiv-sync') return this.revertPixiv(r, p as PixivPayload);
    return this.revertMove(r.id, false);
  }
}
