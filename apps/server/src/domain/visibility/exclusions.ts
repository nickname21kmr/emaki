/**
 * 可见性（T17，docs/core-architecture.md 第 2.4 节）：排除规则（image / folder / tag / character）和排除例外是决定，
 * 排除结果 images.excluded_by 是派生的——只由 reevaluateExclusions 写，排除和解除排除都走它（附录 #14、#15）：
 *
 *   有排除例外（exclude_exempt = 1，用户点过「恢复」）的图不排除；否则是命中的规则里最早建的那条（created_at, id）。
 *
 * 规则变了、角色或标签变了、图移动或新入库了，声明对应的变化，反应 reevaluateExclusions 按 id 集合重算，
 * 再声明 visibility.changed（新排除的、放出来的），合集、识别排队、查重标记都订阅它。
 */
import type { Exclusion, ExclusionKind } from '@emaki/shared';
import { BadRequestError, ConflictError, NotFoundError } from '../../http/errors.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { normalizeRootPath } from '../../datasource/sqlite/settings.ts';
import { parseId, toId } from '../../datasource/sqlite/sql.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import type { Reaction } from '../../propagation/registry.ts';

/** 完整路径表达式（盘符根目录 `D:/` 已带结尾斜杠） */
export const FULL_PATH_SQL = `CASE WHEN substr(r.path, -1) = '/' THEN r.path || i.rel_path ELSE r.path || '/' || i.rel_path END`;

const folderPrefix = (p: string) => (p.endsWith('/') ? p : `${p}/`);

interface Rule {
  id: number;
  kind: ExclusionKind;
  target: string;
}

/** 范围内只按 id 列表查；scope 为 null 时全库 */
const inScope = (col: string, scope: string | null) => (scope === null ? '' : `AND ${col} IN (SELECT value FROM json_each(@scope))`);

/**
 * 一条（非单张）规则命中的图。从规则这边出发走索引：标签 → image_tags，角色 → image_characters；
 * 文件夹前缀不用 LIKE（路径里的 _ / % 是通配符）
 */
function ruleHits(ctx: SqliteContext, rule: Rule, scope: string | null): number[] {
  const p = { target: rule.target, prefix: rule.kind === 'folder' ? folderPrefix(rule.target) : null, scope };
  switch (rule.kind) {
    case 'image':
      return ctx.stmt(`SELECT id FROM images WHERE id = CAST(@target AS INTEGER) ${inScope('id', scope)}`).pluck().all(p) as number[];
    case 'tag':
      return ctx
        .stmt(`SELECT it.image_id FROM image_tags it WHERE it.tag_id IN (SELECT id FROM tags WHERE name = @target) ${inScope('it.image_id', scope)}`)
        .pluck()
        .all(p) as number[];
    case 'character':
      return ctx
        .stmt(`SELECT image_id FROM image_characters WHERE character_id = CAST(@target AS INTEGER) ${inScope('image_id', scope)}`)
        .pluck()
        .all(p) as number[];
    case 'folder':
      return ctx
        .stmt(
          `SELECT i.id FROM images i JOIN library_roots r ON r.id = i.root_id
           WHERE substr(lower(${FULL_PATH_SQL}), 1, length(@prefix)) = lower(@prefix) ${inScope('i.id', scope)}`,
        )
        .pluck()
        .all(p) as number[];
  }
}

/**
 * 每张图命中的最早的规则（不看排除例外）。单张规则一次查完（「批量排除」一下会建上千条），其余规则逐条查。
 * ids = 'all' 是全库
 */
export function firstMatchingRules(ctx: SqliteContext, ids: number[] | 'all'): Map<number, number> {
  const scope = ids === 'all' ? null : JSON.stringify(ids);
  const rules = ctx.stmt('SELECT id, kind, target FROM exclusions ORDER BY created_at, id').all() as Rule[];
  const order = new Map(rules.map((r, i) => [r.id, i]));
  const best = new Map<number, number>();
  const take = (imageId: number, ruleId: number) => {
    const cur = best.get(imageId);
    if (cur === undefined || order.get(ruleId)! < order.get(cur)!) best.set(imageId, ruleId);
  };
  const single = ctx
    .stmt(
      `SELECT CAST(e.target AS INTEGER) AS image_id, e.id FROM exclusions e
       WHERE e.kind = 'image' ${inScope('CAST(e.target AS INTEGER)', scope)}`,
    )
    .all({ scope }) as { image_id: number; id: number }[];
  for (const r of single) take(r.image_id, r.id);
  for (const rule of rules) if (rule.kind !== 'image') for (const id of ruleHits(ctx, rule, scope)) take(id, rule.id);
  return best;
}

export interface VisibilityDelta {
  excluded: number[];
  released: number[];
  /** excluded_by 改了的行（包括换了一条规则排除） */
  rewritten: number;
}

/**
 * 按现在的规则和排除例外重算这些图的 excluded_by（ids = 'all' 全库），只写真的变了的行。
 * 唯一写 excluded_by 的地方（创建规则时的计数、恢复时的判断只读）；必须在事务里调用，一般由反应调用
 */
export function reevaluateExclusions(ctx: SqliteContext, ids: number[] | 'all', before?: ReadonlyMap<number, number | null>): VisibilityDelta {
  const out: VisibilityDelta = { excluded: [], released: [], rewritten: 0 };
  if (ids !== 'all' && !ids.length) return out;
  const best = firstMatchingRules(ctx, ids);
  const rows = (
    ids === 'all'
      ? ctx.stmt('SELECT id, excluded_by, exclude_exempt FROM images').all()
      : ctx.stmt('SELECT id, excluded_by, exclude_exempt FROM images WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids))
  ) as { id: number; excluded_by: number | null; exclude_exempt: number }[];
  const set = ctx.stmt('UPDATE images SET excluded_by = ? WHERE id = ?');
  for (const r of rows) {
    const next = r.exclude_exempt ? null : (best.get(r.id) ?? null);
    if (next !== r.excluded_by) {
      set.run(next, r.id);
      out.rewritten++;
    }
    // 排除 / 放出按「这次操作之前」算：删规则时外键已经先把 excluded_by 清空了
    const was = before?.has(r.id) ? before.get(r.id)! : r.excluded_by;
    if (was === null && next !== null) out.excluded.push(r.id);
    else if (was !== null && next === null) out.released.push(r.id);
  }
  return out;
}

/**
 * 反应：排除规则、例外、角色、标签、路径变了的图重新判定排除；启动时全库对一遍（旧版本只加不减留下的排除会放出来）。
 * 声明 visibility.changed
 */
export const reevaluateExclusionsReaction: Reaction = {
  name: 'reevaluateExclusions',
  on: [
    'visibility.rulesChanged',
    'curation.charactersChanged',
    'evidence.changed',
    'image.added',
    'image.moved',
    'library.opened',
  ],
  phase: 'tx',
  emits: ['visibility.changed'],
  // 声明变化时记下这些图当时的排除结果（删规则、撤销时外键会先把 excluded_by 清掉，要按改之前的算谁被放出来）
  snapshot(ctx, change) {
    if (change.type === 'library.opened' || !change.ids.length) return [];
    return ctx.db.prepare('SELECT id, excluded_by FROM images WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(change.ids));
  },
  run({ ctx, changes, emit, snapshots }) {
    const all = changes.has('library.opened');
    // 只有模型标签会影响「标签」规则；Pixiv、画师的证据不影响
    const evidence = changes.of('evidence.changed').filter((c) => c.provider === 'tagger').flatMap((c) => c.ids);
    const ids = all
      ? 'all'
      : [...new Set([...changes.ids('visibility.rulesChanged', 'curation.charactersChanged', 'image.added', 'image.moved'), ...evidence])];
    const before = new Map<number, number | null>();
    for (const list of snapshots as { id: number; excluded_by: number | null }[][]) for (const r of list) if (!before.has(r.id)) before.set(r.id, r.excluded_by);
    const d = reevaluateExclusions(ctx, ids, before);
    if (d.excluded.length || d.released.length) {
      emit({ type: 'visibility.changed', ids: [...d.excluded, ...d.released], excluded: d.excluded, released: d.released });
    }
  },
};

/**
 * 新建一条规则（规范化 + 插入 + 记录撤销），声明 visibility.rulesChanged（命中的图由反应重新判定）。
 * 在 ctx.mutate 里调用；T18 批量排除复用（多张图一个撤销记录）。changed 是这条规则会新排除的张数
 */
export function createExclusionInTx(
  ctx: SqliteContext,
  u: UndoRecorder,
  kind: ExclusionKind,
  rawTarget: string,
): { eid: number; label: string; changed: number } {
  const t = rawTarget.trim();
  if (!t) throw new BadRequestError('排除目标不能为空');
  let target: string;
  let label: string;
  switch (kind) {
    case 'tag':
      target = t;
      label = `标签 · ${t}`;
      break;
    case 'folder':
      target = normalizeRootPath(t);
      label = `文件夹 · ${target}`;
      break;
    case 'character': {
      const id = parseId(t);
      const row = id === null ? undefined : (ctx.stmt('SELECT id, name FROM characters WHERE id = ?').get(id) as { id: number; name: string } | undefined);
      if (!row) throw new NotFoundError('角色');
      target = toId(row.id);
      label = `角色 · ${row.name}`;
      break;
    }
    case 'image': {
      const id = parseId(t);
      const row =
        id === null
          ? undefined
          : (ctx
              .stmt(
                `SELECT i.id, i.file_name FROM images i JOIN library_roots r ON r.id = i.root_id
                 WHERE i.id = ? AND i.missing = 0 AND i.trashed_at IS NULL AND r.enabled = 1 AND r.removed_at IS NULL`,
              )
              .get(id) as { id: number; file_name: string } | undefined);
      if (!row) throw new NotFoundError('图片');
      target = toId(row.id);
      label = `单张 · ${row.file_name}`;
      break;
    }
  }

  if (ctx.stmt('SELECT 1 FROM exclusions WHERE kind = ? AND target = ?').get(kind, target)) {
    throw new ConflictError('已经有这条排除规则了');
  }

  const eid = Number(
    ctx
      .stmt('INSERT INTO exclusions (kind, target, label, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, target, label, new Date(ctx.clock()).toISOString()).lastInsertRowid,
  );
  u.inserted('exclusions', eid);
  if (kind === 'image') {
    // 用户明确要排除它：之前「恢复」时加的例外作废
    u.columns('images', ['exclude_exempt'], [Number(target)]);
    ctx.stmt('UPDATE images SET exclude_exempt = 0 WHERE id = ?').run(Number(target));
  }
  const hits = ruleHits(ctx, { id: eid, kind, target }, null);
  // 新规则建得最晚：只有现在没被排除、也没有例外的命中图会被它排除
  const changed = hits.length
    ? (ctx
        .stmt('SELECT COUNT(*) FROM images WHERE excluded_by IS NULL AND exclude_exempt = 0 AND id IN (SELECT value FROM json_each(?))')
        .pluck()
        .get(JSON.stringify(hits)) as number)
    : 0;
  ctx.changed({ type: 'visibility.rulesChanged', ids: hits });
  return { eid, label, changed };
}

/**
 * 「恢复」选中的图（在 ctx.mutate 里调用）：被单张规则排除的删掉那条规则；删完还被别的规则命中的记排除例外（以后规则重新判定也不排除）。
 * 返回恢复的张数
 */
export function restoreImagesInTx(ctx: SqliteContext, u: UndoRecorder, ids: number[]): number {
  const db = ctx.db;
  const rows = db
    .prepare(
      `SELECT i.id, i.excluded_by, e.kind FROM images i LEFT JOIN exclusions e ON e.id = i.excluded_by
       WHERE i.id IN (SELECT value FROM json_each(?)) AND i.excluded_by IS NOT NULL`,
    )
    .all(JSON.stringify(ids)) as { id: number; excluded_by: number; kind: ExclusionKind | null }[];
  if (!rows.length) return 0;
  const excluded = rows.map((r) => r.id);
  // 先声明（记下改之前的排除结果），再删规则：外键会顺手把 excluded_by 清掉
  ctx.changed({ type: 'visibility.rulesChanged', ids: excluded });
  for (const r of rows) {
    if (r.kind !== 'image') continue;
    u.set('exclusions', 'id = ?', [r.excluded_by]);
    db.prepare('DELETE FROM exclusions WHERE id = ?').run(r.excluded_by);
  }
  const still = firstMatchingRules(ctx, excluded);
  const exempt = excluded.filter((id) => still.has(id));
  u.columns('images', ['exclude_exempt'], exempt);
  db.prepare('UPDATE images SET exclude_exempt = 1 WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(exempt));
  return rows.length;
}

export class ExclusionQueries {
  constructor(private readonly ctx: SqliteContext) {}

  list(): Exclusion[] {
    const rows = this.ctx
      .stmt(
        `SELECT e.id, e.kind, e.target, e.label, e.created_at,
                (SELECT COUNT(*) FROM v_images v WHERE v.excluded_by = e.id) AS image_count
         FROM exclusions e ORDER BY e.created_at DESC, e.id DESC`,
      )
      .all() as { id: number; kind: ExclusionKind; target: string; label: string; created_at: string; image_count: number }[];
    // 指定排除索引：统计里 excluded_by 每个值被估成几万行（NULL 占绝大多数），SQLite 会改走时间索引扫全表（T22 复测）
    const preview = this.ctx
      .stmt(
        `SELECT i.id FROM images i INDEXED BY idx_images_excluded JOIN library_roots r ON r.id = i.root_id
         WHERE i.excluded_by = ? AND r.enabled = 1 AND r.removed_at IS NULL AND i.trashed_at IS NULL AND i.missing = 0
         ORDER BY i.added_at DESC, i.id DESC LIMIT 4`,
      )
      .pluck();
    return rows.map((r) => ({
      id: toId(r.id),
      kind: r.kind,
      target: r.target,
      label: r.label,
      imageCount: r.image_count,
      previewImageIds: (preview.all(r.id) as number[]).map(toId),
      createdAt: r.created_at,
    }));
  }

  create(kind: ExclusionKind, target: string) {
    return this.ctx.mutate((u) => {
      const { label, changed } = createExclusionInTx(this.ctx, u, kind, target);
      return { message: `已排除：${label}（${changed} 张）` };
    });
  }

  delete(id: string) {
    const eid = parseId(id);
    const row =
      eid === null ? undefined : (this.ctx.stmt('SELECT id, label FROM exclusions WHERE id = ?').get(eid) as { id: number; label: string } | undefined);
    if (!row) throw new NotFoundError('排除规则');
    return this.ctx.mutate((u) => {
      const affected = this.ctx.stmt('SELECT id FROM images WHERE excluded_by = ?').pluck().all(row.id) as number[];
      u.set('exclusions', 'id = ?', [row.id]);
      // 先声明（记下改之前的排除结果）再删：外键 ON DELETE SET NULL 先放开；同时被其他规则命中的图由反应重新排除
      this.ctx.changed({ type: 'visibility.rulesChanged', ids: affected });
      this.ctx.stmt('DELETE FROM exclusions WHERE id = ?').run(row.id);
      return { message: `已恢复：${row.label}（${affected.length} 张）` };
    });
  }
}

/** 指向已经删掉的图的单张排除规则（启动时清理移除的文件夹之后）；返回删了几条 */
export function dropOrphanImageRules(db: SqliteContext['db']): number {
  return db.prepare("DELETE FROM exclusions WHERE kind = 'image' AND CAST(target AS INTEGER) NOT IN (SELECT id FROM images)").run().changes;
}
