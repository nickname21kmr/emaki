/**
 * T17：排除规则（image / folder / tag / character）。
 * 一张图只记一个 excluded_by（先到先得）；删规则时要把其余规则重新应用到受影响的图上。
 */
import type { Exclusion, ExclusionKind } from '@emaki/shared';
import { BadRequestError, ConflictError, NotFoundError } from '../../http/errors.ts';
import type { SqliteContext } from './context.ts';
import { normalizeRootPath } from './settings.ts';
import { parseId, toId } from './sql.ts';
import type { CollectionsHook } from '../../services/collections/CollectionService.ts';
import type { UndoRecorder } from './undo.ts';

/** 完整路径表达式（盘符根目录 `D:/` 已带结尾斜杠） */
export const FULL_PATH_SQL = `CASE WHEN substr(r.path, -1) = '/' THEN r.path || i.rel_path ELSE r.path || '/' || i.rel_path END`;

/** 各类规则的谓词（i = images，r = library_roots）。文件夹前缀不用 LIKE：路径里的 _ / % 是通配符 */
function predicate(kind: ExclusionKind): string {
  switch (kind) {
    case 'image':
      return 'i.id = CAST(@target AS INTEGER)';
    case 'folder':
      return `substr(lower(${FULL_PATH_SQL}), 1, length(@prefix)) = lower(@prefix)`;
    case 'tag':
      return 'EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = i.id AND t.name = @target)';
    case 'character':
      return 'EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id AND ic.character_id = CAST(@target AS INTEGER))';
  }
}

const folderPrefix = (p: string) => (p.endsWith('/') ? p : `${p}/`);

/** 把一条规则应用到图上（scope = null 表示全库），返回新排除的张数 */
function applyRule(
  ctx: SqliteContext,
  rule: { id: number; kind: ExclusionKind; target: string },
  scope: number[] | null,
): number {
  return ctx
    .stmt(
      `UPDATE images SET excluded_by = @eid
       WHERE excluded_by IS NULL AND exclude_exempt = 0
         AND id IN (SELECT i.id FROM images i JOIN library_roots r ON r.id = i.root_id
                    WHERE ${predicate(rule.kind)}
                      AND (@scope IS NULL OR i.id IN (SELECT value FROM json_each(@scope))))`,
    )
    .run({
      eid: rule.id,
      target: rule.target,
      prefix: rule.kind === 'folder' ? folderPrefix(rule.target) : null,
      scope: scope ? JSON.stringify(scope) : null,
    }).changes;
}

/** 按 created_at 顺序把现有规则应用到指定图（不传 imageIds = 全部）；返回新排除的张数。必须在事务内调用。 */
export function applyExclusionRules(ctx: SqliteContext, scope: { imageIds?: number[] } = {}): number {
  if (scope.imageIds && !scope.imageIds.length) return 0;
  const rules = ctx.stmt('SELECT id, kind, target FROM exclusions ORDER BY created_at, id').all() as {
    id: number;
    kind: ExclusionKind;
    target: string;
  }[];
  let n = 0;
  for (const rule of rules) n += applyRule(ctx, rule, scope.imageIds ?? null);
  return n;
}

/** 规范化 + 插入 + 应用 + 记录撤销。T18 批量排除复用（多张图一个撤销记录） */
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
    // 用户明确要排除它：之前「恢复」时加的豁免作废
    u.columns('images', ['exclude_exempt'], [Number(target)]);
    ctx.stmt('UPDATE images SET exclude_exempt = 0 WHERE id = ?').run(Number(target));
  }
  const changed = applyRule(ctx, { id: eid, kind, target }, null);
  // 撤销逆序：先把图还原，再删规则
  u.sql('UPDATE images SET excluded_by = NULL WHERE excluded_by = ?', [eid]);
  return { eid, label, changed };
}

export class ExclusionQueries {
  constructor(
    private readonly ctx: SqliteContext,
    /** 规则影响面不定：增删规则后全量重算合集（T38b） */
    private readonly collections: CollectionsHook = () => {},
  ) {}

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
      this.collections(u, 'all');
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
      u.columns('images', ['excluded_by'], affected);
      u.set('exclusions', 'id = ?', [row.id]);
      this.ctx.stmt('UPDATE images SET excluded_by = NULL WHERE excluded_by = ?').run(row.id);
      this.ctx.stmt('DELETE FROM exclusions WHERE id = ?').run(row.id);
      // 同时被其他规则覆盖的图继续保持排除（与 mock 的有意差异：mock 全部恢复）
      applyExclusionRules(this.ctx, { imageIds: affected });
      this.collections(u, 'all');
      return { message: `已恢复：${row.label}（${affected.length} 张）` };
    });
  }
}
