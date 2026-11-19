/**
 * 图库文件夹：添加（含合并、复活、接管）、启停、按漫画导入（整个文件夹或里面的子文件夹）、移除，以及撤销。
 * 从 SqliteDataSource 拆出来；它只负责把请求转过来。
 */
import type { AddLibraryRootBody, ID, LibraryRoot, MutationResult, Rating, UpdateLibraryRootBody } from '@emaki/shared';
import { REMOVED_ROOT_KEEP_DAYS } from '@emaki/shared';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { done } from '../../core/undo.ts';
import { transact } from '../../db/connection.ts';
import { BadRequestError, NeedsConfirmError, NotFoundError } from '../../http/errors.ts';
import { ComicAreas } from '../../services/classify/comicAreas.ts';
import { recordRootModeUndo, syncRootModes } from '../../services/classify/rootMode.ts';
import type { CollectionsHook } from '../../services/collections/CollectionService.ts';
import type { Pipeline } from '../../services/pipeline.ts';
import type { ScanRequests } from '../../services/scan/ScanRequests.ts';
import { RATING_LABEL } from './bulk.ts';
import type { SqliteContext } from './context.ts';
import { adoptFromRemovedParents, diskCaseRel, mergeChildRoots, relUnder, type ChildRoot } from './roots.ts';
import { isInside, normalizeRootPath, readSettings, rootPathKey, samePath } from './settings.ts';
import { iso, parseId, toId } from './sql.ts';
import type { UndoRecorder } from './undo.ts';

/** 改图库文件夹的导入方式会改这些列（撤销用） */
const ROOT_MODE_COLS = ['content_kind', 'content_kind_source', 'content_kind_evidence', 'content_kind_version', 'theme', 'art_score', 'rating'];
type RootImageSnap = { id: number; tagged_at: string | null } & Record<string, unknown>;

export class LibraryRoots {
  constructor(
    private readonly ctx: SqliteContext,
    private readonly requests: ScanRequests,
    private readonly pipeline: Pipeline,
    private readonly collectionsHook: CollectionsHook,
    /** 改回插画后排识别（测试里不排，见 SqliteDataSource.autoTag） */
    private readonly requestTag: () => void,
  ) {}

  /**
   * 文件夹重新显示（启用、撤销停用或移除）：隐藏期间跑过查重的话，它的未处理重复组已在对账时删掉，排一次查重找回来。
   * since 是开始隐藏的时间，不知道时传 null（查过重就排）
   */
  redupeAfterHidden(since: string | null): void {
    const last = readSettings(this.ctx.db).dedupe.lastRunAt;
    if (last === null || (since !== null && last < since)) return;
    this.pipeline.markDedupeDirty();
    this.ctx.jobs.enqueue('dedupe');
  }

  private readonly rootsListeners = new Set<() => void>();

  /** 图库文件夹增删启停（T08 据此调整监听） */
  onRootsChanged(fn: () => void): () => void {
    this.rootsListeners.add(fn);
    return () => this.rootsListeners.delete(fn);
  }

  private notifyRoots(): void {
    for (const fn of this.rootsListeners) fn();
  }

  /**
   * 启动时真正删除移除超过 30 天的文件夹（级联删除它的图）和指向已删除图片的单张排除规则。
   * 30 天内的留着：重新添加同一个文件夹时角色、收藏、分级等整理结果都能找回
   */
  purgeRemovedRoots(): void {
    const db = this.ctx.db;
    const cutoff = iso(this.ctx.clock() - REMOVED_ROOT_KEEP_DAYS * 86_400_000);
    db.transaction(() => {
      // A cross-folder selection outlives removal of its original anchor root.
      db.prepare(`UPDATE collections SET root_id = (SELECT i.root_id FROM images i JOIN library_roots r ON r.id = i.root_id
          WHERE i.collection_id = collections.id AND r.removed_at IS NULL ORDER BY i.id LIMIT 1)
        WHERE membership <> 'folder' AND root_id IN (SELECT id FROM library_roots WHERE removed_at IS NOT NULL AND removed_at < ?)
          AND EXISTS (SELECT 1 FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.collection_id = collections.id AND r.removed_at IS NULL)`).run(cutoff);
      const roots = db.prepare('DELETE FROM library_roots WHERE removed_at IS NOT NULL AND removed_at < ?').run(cutoff).changes;
      const ex = db
        .prepare("DELETE FROM exclusions WHERE kind = 'image' AND CAST(target AS INTEGER) NOT IN (SELECT id FROM images)")
        .run().changes;
      if (roots || ex) console.log(`已清理移除的文件夹 ${roots} 个、失效的单张排除 ${ex} 条`);
    })();
  }

  /** 设置页的图库文件夹列表（移除了的不算） */
  list(): LibraryRoot[] {
  const rows = this.ctx
    .stmt(
      `SELECT r.id, r.path, r.enabled, r.last_scan_at, r.imported_at, r.content_mode, r.comic_rating,
         (SELECT COUNT(*) FROM images i
           WHERE i.root_id = r.id AND i.trashed_at IS NULL AND i.missing = 0 AND i.excluded_by IS NULL) AS image_count
       FROM library_roots r
       WHERE r.removed_at IS NULL
       ORDER BY r.id`,
    )
    .all() as {
    id: number;
    path: string;
    enabled: number;
    last_scan_at: string | null;
    imported_at: string | null;
    content_mode: string;
    comic_rating: string;
    image_count: number;
  }[];
  const folders = this.ctx.db.prepare('SELECT root_id, rel_dir, comic_rating FROM comic_folders ORDER BY rel_dir').all() as {
    root_id: number;
    rel_dir: string;
    comic_rating: Rating;
  }[];
    return rows.map((r) => ({
      id: toId(r.id),
      path: r.path,
      enabled: !!r.enabled,
      imageCount: r.image_count,
      lastScanAt: r.last_scan_at,
      importedAt: r.imported_at,
      mode: r.content_mode === 'comic' ? 'comic' : 'auto',
      comicRating: r.comic_rating as Rating,
      comicFolders: folders.filter((f) => f.root_id === r.id).map((f) => ({ relDir: f.rel_dir, comicRating: f.comic_rating })),
    }));
  }

  requireRoot(id: ID): { id: number; path: string; enabled: number } {
    const n = parseId(id);
    const row =
      n === null
        ? undefined
        : (this.ctx.stmt('SELECT id, path, enabled FROM library_roots WHERE id = ? AND removed_at IS NULL').get(n) as
            | { id: number; path: string; enabled: number }
            | undefined);
    if (!row) throw new NotFoundError('图库文件夹');
    return row;
  }

  async addLibraryRoot(body: AddLibraryRootBody): Promise<MutationResult> {
    const input = normalizeRootPath(body.path);
    try {
      const st = await stat(input);
      if (!st.isDirectory()) throw new BadRequestError('这不是一个文件夹');
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') throw new BadRequestError('没有权限读取这个文件夹');
      throw new BadRequestError(`找不到这个文件夹：${input}`);
    }
    // 同一个文件夹换种写法（联接点、subst 盘、\\?\ 前缀、映射盘和 UNC 路径）也要认出来：下面的判断都按真实位置比较。
    // 存的还是用户选的写法，只有 \\?\、\\.\ 开头的换成普通路径
    const pk = await rootPathKey(input);
    const p = /^\/\/[?.]\//.test(input) ? pk : input;

    const db = this.ctx.db;
    const mode = body.mode === 'comic' ? 'comic' : 'auto';
    const comicRating = body.comicRating ?? 'general';
    const rawRows = db.prepare('SELECT id, path, enabled, removed_at, imported_at, content_mode FROM library_roots').all() as (ChildRoot & {
      enabled: number;
      content_mode: string;
    })[];
    const rows = await Promise.all(rawRows.map(async (r) => ({ ...r, key: await rootPathKey(r.path) })));
    const active = rows.filter((r) => r.removed_at === null);
    if (active.some((r) => samePath(r.key, pk))) throw new BadRequestError('这个文件夹已经在图库里了');
    const parent = active.find((r) => isInside(pk, r.key));
    // 已有图库文件夹里面的子文件夹：选了漫画就把这个子文件夹按漫画导入，不另加图库文件夹
    if (parent && mode === 'comic') return this.setComicFolder(parent, await diskCaseRel(parent.path, relUnder(parent.key, pk)), comicRating);
    if (parent) throw new BadRequestError(`已经包含在「${parent.path}」里了，不用单独添加。要把它当漫画，选「漫画 · 跳过识别」再添加`);
    const d = await rootPathKey(normalizeRootPath(this.ctx.dataDir));
    if (samePath(pk, d) || isInside(pk, d) || isInside(d, pk)) throw new BadRequestError('不能把 Emaki 的数据目录加入图库');

    // 新文件夹包含已有的文件夹：问一下再合并。以前移除过的子文件夹直接接管，找回当时的整理结果
    const children = rows.filter((r) => isInside(r.key, pk));
    const activeChildren = children.filter((r) => r.removed_at === null);
    if (activeChildren.length && !body.merge) {
      const names = activeChildren.map((r) => `「${r.path}」`).join('');
      const disabled = activeChildren.filter((r) => !r.enabled).map((r) => `「${r.path}」`);
      const comics = activeChildren.filter((r) => r.content_mode === 'comic').map((r) => `「${r.path}」`);
      throw new NeedsConfirmError(
        `这个文件夹包含图库里已有的${names}，合并成一个吗？${mode === 'comic' ? '原来的整理结果都会保留；按漫画导入后，里面识别器认出的角色会去掉（手动加的留着），以后改回插画会重新识别。' : '原来的识别和整理结果都会保留。'}` +
          (disabled.length ? `其中${disabled.join('')}现在是停用的，合并后会重新显示。` : '') +
          (comics.length && mode !== 'comic' ? `${comics.join('')}按漫画导入的设置会保留（变成里面的漫画子文件夹）。` : ''),
      );
    }
    // 合并前照例备份（VACUUM INTO 不能在事务里，目标文件已存在会报错）
    if (activeChildren.length) {
      const backup = path.join(this.ctx.dataDir, 'emaki.before-merge.bak.sqlite');
      await rm(backup, { force: true });
      db.exec(`VACUUM INTO '${backup.replace(/\\/g, '/').replace(/'/g, "''")}'`);
    }

    const removed = rows.find((r) => r.removed_at !== null && samePath(r.key, pk));
    // 在移除过的父文件夹里面添加：接管父文件夹在这里面的旧记录，由内往外
    const removedParents = await Promise.all(
      rows
        .filter((r) => r.removed_at !== null && isInside(pk, r.key))
        .sort((a, b) => b.key.length - a.key.length)
        .map(async (r) => ({ id: r.id, imported_at: r.imported_at, prefix: await diskCaseRel(r.path, relUnder(r.key, pk)) })),
    );
    let rootId = 0;
    let merged = 0;
    let adopted = 0;
    let revived = 0;
    db.transaction(() => {
      if (removed) {
        // 复活：旧图和识别结果全部回来
        db.prepare('UPDATE library_roots SET removed_at = NULL, enabled = 1, path = ?, content_mode = ?, comic_rating = ? WHERE id = ?').run(
          p,
          mode,
          comicRating,
          removed.id,
        );
        rootId = removed.id;
        revived = db.prepare('SELECT COUNT(*) FROM images WHERE root_id = ?').pluck().get(rootId) as number;
      } else {
        rootId = Number(
          db.prepare('INSERT INTO library_roots (path, enabled, content_mode, comic_rating) VALUES (?, 1, ?, ?)').run(p, mode, comicRating).lastInsertRowid,
        );
      }
      // 子文件夹在新文件夹下的相对路径按真实位置算（两边可能是不同写法）
      if (children.length) merged = mergeChildRoots(db, rootId, pk, children.map((c) => ({ ...c, path: c.key }))).images;
      if (removedParents.length) adopted = adoptFromRemovedParents(db, rootId, removedParents).images;
      // 复活、合并、接管进来的旧图按这次的设置重判类型（按漫画导入：归漫画、用选的分级）
      if (removed || children.length || adopted) this.applyRootMode(rootId);
    })();
    if (children.length || removed || adopted) {
      this.collectionsHook(null, 'all');
      // 这些旧图隐藏期间跑过的查重会把它们的未处理重复组删掉：这次扫描完（哪怕没有新图）再查一次
      this.pipeline.markDedupeDirty();
    }
    this.ctx.touch();
    this.notifyRoots();
    // 只扫新文件夹；扫描正在跑时也再排一次，别丢了这个请求
    this.requests.addDirty({ rootId, relDir: '', recursive: true });
    this.ctx.jobs.enqueue('scan', { requeueIfRunning: true });
    // 复活的、接管的、并进来的移除过的子文件夹，都算找回
    const back = revived + adopted + merged;
    const found = back ? `（找回了 ${back} 张图以前的整理结果）` : '';
    return done(
      activeChildren.length
        ? `已合并成一个文件夹（保留了 ${back} 张图的整理结果），开始扫描其余部分：${p}`
        : mode === 'comic'
          ? `已按漫画导入${found}，开始扫描（不识别，每个子文件夹成一本）：${p}`
          : `已添加文件夹${found}，开始扫描：${p}`,
    );
  }

  /** 按图库文件夹的设置重判这个文件夹里所有图的类型；按漫画导入的，没识别过、没手动改过分级的页用选的分级。在事务里调用 */
  private applyRootMode(rootId: number, relDir?: string, u?: UndoRecorder): number[] {
    const ids = this.imagesUnder(rootId, relDir);
    if (u) recordRootModeUndo(u, ids);
    if (ids.length) syncRootModes(this.ctx.db, ids);
    return ids;
  }

  /** 图库文件夹里（relDir 给了就是这个子文件夹里）的全部图 */
  private imagesUnder(rootId: number, relDir?: string): number[] {
    const under = relDir ? "AND substr(rel_path, 1, length(@dir) + 1) = @dir || '/'" : '';
    return this.ctx.db.prepare(`SELECT id FROM images WHERE root_id = @root ${under}`).pluck().all({ root: rootId, dir: relDir ?? '' }) as number[];
  }

  /**
   * 图库文件夹里的子文件夹按漫画导入（rating = null：不再按漫画导入）；可撤销。
   * 里面的图按新设置重判类型和分级，合集在事务之后重算；不再按漫画导入时没识别过的图接着识别
   */
  private setComicFolder(root: { id: number; path: string }, rawDir: string, rating: Rating | null): MutationResult {
    const db = this.ctx.db;
    const relDir = rawDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!relDir) throw new BadRequestError('要选图库文件夹里面的子文件夹');
    const cur = db.prepare('SELECT comic_rating FROM comic_folders WHERE root_id = ? AND rel_dir = ?').get(root.id, relDir) as { comic_rating: Rating } | undefined;
    if (rating === null && !cur) throw new NotFoundError('按漫画导入的子文件夹');
    if (rating !== null) {
      const area = ComicAreas.load(db).of(root.id, relDir);
      if (area && area.relDir !== relDir) throw new BadRequestError(`已经在按漫画导入的「${area.path}」里了`);
      if (cur?.comic_rating === rating) return done('没有变化');
    }
    const snap = db
      .prepare(`SELECT id, tagged_at, ${ROOT_MODE_COLS.join(', ')} FROM images WHERE root_id = @root AND substr(rel_path, 1, length(@dir) + 1) = @dir || '/'`)
      .all({ root: root.id, dir: relDir }) as RootImageSnap[];
    const where = `${root.path.replace(/\/+$/, '')}/${relDir}`;
    const result = this.ctx.mutate((u) => {
      u.set('comic_folders', 'root_id = ? AND rel_dir = ?', [root.id, relDir]);
      if (rating === null) db.prepare('DELETE FROM comic_folders WHERE root_id = ? AND rel_dir = ?').run(root.id, relDir);
      else
        db.prepare(
          'INSERT INTO comic_folders (root_id, rel_dir, comic_rating, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(root_id, rel_dir) DO UPDATE SET comic_rating = excluded.comic_rating',
        ).run(root.id, relDir, rating, iso(this.ctx.clock()));
      this.applyRootMode(root.id, relDir, u);
      u.onUndo(() => {
        if (snap.length) this.restoreRootImages(root.id, snap, relDir);
        this.collectionsHook(null, 'all');
        this.ctx.touch();
        this.notifyRoots();
        // 撤销「按漫画导入」：回到插画，没识别过的接着识别
        if (rating !== null && !cur) this.requestTag();
      });
      const message =
        rating === null
          ? `「${where}」不再按漫画导入：没识别过的图会开始识别`
          : cur
            ? `「${where}」的分级改成了「${RATING_LABEL[rating]}」`
            : `已把「${where}」按漫画导入：${snap.length} 张归到漫画，不再识别`;
      return { message };
    });
    this.collectionsHook(null, 'all');
    this.ctx.touch();
    this.notifyRoots();
    if (rating === null) this.requestTag();
    return result;
  }

  async updateLibraryRoot(id: ID, body: UpdateLibraryRootBody): Promise<MutationResult> {
    const root = this.requireRoot(id);
    const db = this.ctx.db;
    // 里面的漫画子文件夹：单独一步（各自可以撤销）
    if (body.comicFolder) {
      const cur = db.prepare('SELECT comic_rating FROM comic_folders WHERE root_id = ? AND rel_dir = ?').pluck().get(root.id, body.comicFolder.relDir) as Rating | undefined;
      return this.setComicFolder(root, body.comicFolder.relDir, body.comicFolder.comicRating ?? cur ?? 'general');
    }
    if (body.removeComicFolder !== undefined) return this.setComicFolder(root, body.removeComicFolder, null);
    const cur = db.prepare('SELECT enabled, content_mode, comic_rating FROM library_roots WHERE id = ?').get(root.id) as {
      enabled: number;
      content_mode: string;
      comic_rating: string;
    };
    const enabled = body.enabled === undefined ? cur.enabled : body.enabled ? 1 : 0;
    const mode = body.mode ?? (cur.content_mode === 'comic' ? 'comic' : 'auto');
    const rating = body.comicRating ?? cur.comic_rating;
    const modeChanged = mode !== cur.content_mode;
    const ratingChanged = rating !== cur.comic_rating;
    const cols = [enabled !== cur.enabled && 'enabled', modeChanged && 'content_mode', ratingChanged && 'comic_rating'].filter(
      (c): c is string => !!c,
    );
    if (!cols.length) return done('没有变化');
    const touchesImages = modeChanged || (ratingChanged && mode === 'comic');
    // 撤销用：改之前这个文件夹里每张图的类型、分级（连同当时的识别时间，见 restoreRootImages）
    const snap = touchesImages
      ? (db.prepare(`SELECT id, tagged_at, ${ROOT_MODE_COLS.join(', ')} FROM images WHERE root_id = ?`).all(root.id) as RootImageSnap[])
      : [];
    const at = iso(this.ctx.clock());
    const result = this.ctx.mutate((u) => {
      u.columns('library_roots', cols, [root.id]);
      db.prepare('UPDATE library_roots SET enabled = ?, content_mode = ?, comic_rating = ? WHERE id = ?').run(enabled, mode, rating, root.id);
      if (touchesImages) this.applyRootMode(root.id, undefined, u);
      // 撤销时先由上面的 columns 恢复文件夹设置，再恢复图片、重算合集、同步监听、需要的话接着识别
      u.onUndo(() => {
        if (snap.length) this.restoreRootImages(root.id, snap);
        this.collectionsHook(null, 'all');
        this.ctx.touch();
        this.notifyRoots();
        // 撤销停用：重新启用了，停用期间的变化要扫进来
        if (!enabled && cur.enabled) this.rescanRoot(root.id);
        if (!enabled && cur.enabled) this.redupeAfterHidden(at);
        // 撤销「改成漫画」回到插画：没识别过的图接着识别
        if (modeChanged && cur.content_mode !== 'comic') this.requestTag();
      });
      const message =
        enabled !== cur.enabled
          ? enabled
            ? `已启用：${root.path}`
            : `已停用：${root.path}`
          : modeChanged
            ? mode === 'comic'
              ? `已改成按漫画导入：${snap.length} 张归到漫画，不再识别`
              : `已改回按插画识别：没识别过的图会开始识别`
            : `按漫画导入的分级改成了「${RATING_LABEL[rating as Rating]}」`;
      return { message };
    });
    // 合集在事务提交之后重算：放在 mutate 里会变成嵌套事务，大文件夹逐行写页码会卡几十秒
    this.collectionsHook(null, 'all');
    this.ctx.touch();
    this.notifyRoots();
    if (enabled && !cur.enabled) this.rescanRoot(root.id);
    if (enabled && !cur.enabled) this.redupeAfterHidden(null);
    // 改回插画：没识别过的图接着识别（模型在、用户没暂停时；正在识别也再排一轮）
    if (modeChanged && mode === 'auto') this.requestTag();
    return result;
  }

  /**
   * 撤销切换导入方式时恢复这个文件夹的图：期间没重新识别过的行按快照写回（手动改过的类型、分级不动）；
   * 期间识别过的、新扫进来的行按现在（已经恢复）的设置重判，免得把新的识别结果盖回旧值
   */
  private restoreRootImages(rootId: number, snap: RootImageSnap[], relDir?: string): void {
    const db = this.ctx.db;
    const under = relDir ? "AND substr(rel_path, 1, length(@dir) + 1) = @dir || '/'" : '';
    transact(db, () => {
      const now = new Map(
        (
          db.prepare(`SELECT id, tagged_at, content_kind_manual, rating_manual FROM images WHERE root_id = @root ${under}`).all({ root: rootId, dir: relDir ?? '' }) as {
            id: number;
            tagged_at: string | null;
            content_kind_manual: number;
            rating_manual: number;
          }[]
        ).map((r) => [r.id, r]),
      );
      const kindCols = ROOT_MODE_COLS.filter((c) => c !== 'rating');
      const setKind = db.prepare(`UPDATE images SET ${kindCols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`);
      const setRating = db.prepare('UPDATE images SET rating = @rating WHERE id = @id');
      const recompute: number[] = [];
      for (const s of snap) {
        const n = now.get(s.id);
        now.delete(s.id);
        if (!n) continue;
        if (n.tagged_at !== s.tagged_at) {
          recompute.push(s.id);
          continue;
        }
        if (!n.content_kind_manual) setKind.run(s);
        if (!n.rating_manual) setRating.run(s);
      }
      recompute.push(...now.keys());
      // 写回的行也对一遍：不按顺序撤销时（先撤里层的漫画子文件夹，外层的还在），快照里的「插画」已经不对了
      syncRootModes(db, [...recompute, ...snap.map((x) => x.id)]);
    });
  }

  /**
   * 停用、移除期间磁盘上的变化监听器收不到，全量扫描也跳过这个文件夹：重新启用（包括撤销停用、撤销移除）时整个扫一遍。
   * 扫描正在跑时也再排一次，别丢了这个请求
   */
  private rescanRoot(rootId: number): void {
    this.requests.addDirty({ rootId, relDir: '', recursive: true });
    this.ctx.jobs.enqueue('scan', { requeueIfRunning: true });
  }

  async removeLibraryRoot(id: ID): Promise<MutationResult> {
    const root = this.requireRoot(id);
    const set = this.ctx.db.prepare('UPDATE library_roots SET removed_at = ? WHERE id = ?');
    const at = iso(this.ctx.clock());
    set.run(at, root.id);
    this.collectionsHook(null, 'all');
    this.ctx.touch();
    this.notifyRoots();
    return this.ctx.undo.result(`已移除文件夹：${root.path}。磁盘上的文件没动，${REMOVED_ROOT_KEEP_DAYS} 天内重新添加它能找回整理结果`, () => {
      set.run(null, root.id);
      this.collectionsHook(null, 'all');
      this.ctx.touch();
      this.notifyRoots();
      if (this.ctx.db.prepare('SELECT enabled FROM library_roots WHERE id = ?').pluck().get(root.id)) {
        this.rescanRoot(root.id);
        this.redupeAfterHidden(at);
      }
    });
  }
}
