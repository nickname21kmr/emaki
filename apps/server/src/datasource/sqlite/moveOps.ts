/**
 * 移动到文件夹：先数（对话框显示的就是会移的），再移。移动记进「最近的改动」，重启后也能移回原处。
 * 从 SqliteDataSource 拆出来；它只负责把请求转过来。
 */
import type { MovePreview, MoveImagesBody, MutationResult } from '@emaki/shared';
import { done } from '../../core/undo.ts';
import { BadRequestError, ConflictError } from '../../http/errors.ts';
import { IN_COMIC } from '../../services/classify/comicAreas.ts';
import { syncRootModes } from '../../services/classify/rootMode.ts';
import { parentRel, toAbs } from '../../services/fs/paths.ts';
import { recordChange, type ChangeLog, type MovePayload } from './changeLog.ts';
import type { SqliteContext } from './context.ts';
import { applyExclusionRulesTracked, type NewlyExcluded } from './exclusions.ts';
import { requireCharacterId, requireVisibleImages } from './guards.ts';
import type { LibraryRoots } from './libraryRoots.ts';
import { moveImageFiles, normalizeSubdir, type MoveRow } from './move.ts';
import { toId } from './sql.ts';

export class MoveOps {
  constructor(
    private readonly ctx: SqliteContext,
    private readonly roots: LibraryRoots,
    private readonly changes: ChangeLog,
  ) {}

  /** 移动要处理的图：按角色时是这个角色现在可见的图，否则是给的 ids */
  private moveRows(body: MoveImagesBody) {
    const root = this.roots.requireRoot(body.rootId);
    if (!root.enabled) throw new BadRequestError('这个图库文件夹停用了，先启用再移动');
    const dir = normalizeSubdir(body.dir);
    const cols = `i.id, i.root_id, i.rel_path, i.file_name, CASE WHEN EXISTS (SELECT 1 FROM collections c WHERE c.id = i.collection_id AND c.membership = 'folder') THEN i.collection_id ELSE NULL END AS collection_id, i.tagged_at, i.retag, ${IN_COMIC('i')} AS in_comic, r.path AS root_path`;
    let rows: (MoveRow & { tagged_at: string | null; retag: number; in_comic: number })[];
    if (body.characterId !== undefined && body.ids === undefined) {
      const c = requireCharacterId(this.ctx, body.characterId);
      rows = this.ctx
        .stmt(
          `SELECT ${cols} FROM v_counted_images i JOIN library_roots r ON r.id = i.root_id
           WHERE EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id AND ic.character_id = ?) ORDER BY i.id`,
        )
        .all(c) as typeof rows;
    } else {
      const ids = requireVisibleImages(this.ctx, body.ids ?? []);
      rows = this.ctx
        .stmt(`SELECT ${cols} FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id IN (SELECT value FROM json_each(?)) ORDER BY i.id`)
        .all(JSON.stringify(ids)) as typeof rows;
    }
    return { root, dir, rows };
  }

  /** 移动前先数（对话框显示的就是服务端会移的） */
  async previewMove(body: MoveImagesBody): Promise<MovePreview> {
    const { root, dir, rows } = this.moveRows(body);
    let alreadyThere = 0;
    let inCollection = 0;
    const ids: number[] = [];
    for (const r of rows) {
      if (r.collection_id !== null) inCollection++;
      else if (r.root_id === root.id && parentRel(r.rel_path).toLowerCase() === dir.toLowerCase()) alreadyThere++;
      else ids.push(r.id);
    }
    const cid = body.characterId === undefined ? null : requireCharacterId(this.ctx, body.characterId);
    const json = JSON.stringify(ids);
    const otherCharacters = (
      cid === null
        ? this.ctx.db.prepare('SELECT COUNT(*) FROM (SELECT image_id FROM image_characters WHERE image_id IN (SELECT value FROM json_each(?)) GROUP BY image_id HAVING COUNT(*) > 1)').pluck().get(json)
        : this.ctx.db.prepare('SELECT COUNT(DISTINCT image_id) FROM image_characters WHERE image_id IN (SELECT value FROM json_each(?)) AND character_id <> ?').pluck().get(json, cid)
    ) as number;
    return { ids: ids.map(toId), alreadyThere, inCollection, otherCharacters };
  }

  async moveImages(body: MoveImagesBody): Promise<MutationResult> {
    const { root, dir, rows } = this.moveRows(body);
    if (!rows.length) throw new BadRequestError('没有可以移动的图');

    // 扫描、识别正在读这些文件时不能移（扫描会把移走的图当成丢失）
    const running = (await this.ctx.jobs.list()).filter((j) => j.status === 'running').map((j) => j.kind);
    if (running.includes('scan')) throw new ConflictError('正在扫描图库，等扫描结束再移动');
    if (running.includes('tag') && rows.some((r) => !r.in_comic && (r.tagged_at === null || r.retag))) {
      throw new ConflictError('正在识别，选中的图里有还没识别完的，等识别结束再移动');
    }

    const dest = { rootId: root.id, rootPath: root.path, dir };
    const out = moveImageFiles(this.ctx.db, rows, dest);
    const ids = out.moved.map((m) => m.id);
    // 移进漫画文件夹会清掉识别器认的角色、移出会标重新识别：撤销时放回去
    const json = JSON.stringify(ids);
    const charSnap = this.ctx.db.prepare("SELECT * FROM image_characters WHERE origin = 'tagger' AND image_id IN (SELECT value FROM json_each(?))").all(json);
    const retagSnap = this.ctx.db.prepare('SELECT id, retag FROM images WHERE id IN (SELECT value FROM json_each(?))').all(json);
    // 移进了被排除的文件夹：照规则排除（记下新排除的，撤销时放出来）；移进 / 移出按漫画导入的文件夹：类型、分级跟着文件夹
    let excluded: NewlyExcluded = [];
    if (ids.length)
      this.ctx.db.transaction(() => {
        excluded = applyExclusionRulesTracked(this.ctx, ids);
        syncRootModes(this.ctx.db, ids);
      })();
    this.ctx.touch();

    const where = dir ? toAbs(root.path, dir).replace(/\\/g, '/') : root.path;
    const notes = [
      out.alreadyThere && `${out.alreadyThere} 张本来就在这里`,
      out.inCollection && `合集里的 ${out.inCollection} 张没动`,
      out.failed.length && `${out.failed.length} 张移动失败：${out.failed.slice(0, 3).join('、')}${out.failed.length > 3 ? ' 等' : ''}`,
    ].filter(Boolean);
    const message = `已移动 ${out.moved.length} 张到 ${where}${notes.length ? `（${notes.join('；')}）` : ''}`;
    if (!out.moved.length) {
      if (out.failed.length) throw new ConflictError(message);
      return done(message);
    }
    // 记进库里：重启后也能在「最近的移动」里移回原处
    const payload: MovePayload = { where, items: out.moved, charSnap: charSnap as MovePayload['charSnap'], retagSnap: retagSnap as MovePayload['retagSnap'], excluded };
    const logId = recordChange(this.ctx, 'move', `${out.moved.length} 张移到 ${where}`, payload);
    const result = this.ctx.undo.result(message, async () => {
      await this.changes.revertMove(logId, true);
    });
    this.changes.rememberMoveToken(logId, result.undoToken!);
    return result;
  }
}
