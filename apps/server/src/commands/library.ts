/**
 * 图库与文件的命令（docs/core-architecture.md 第 2.4 节）：导入、替换、移到回收站、移动、在资源管理器中显示，图库文件夹的增删改。
 * 写入在图库与文件模块（domain/library/）；这些命令都要动文件或者是异步的（查盘、读文件夹），自己管撤销（run），
 * 命令层负责 actor、operationId、审计和事件。
 *
 * 图库文件夹（以前在 SqliteDataSource 里）：添加时按真实位置认出同一个文件夹、合并子文件夹、接管移除过的父文件夹；
 * 漫画区设置变了声明 root.modeChanged，类型、分级、识别器的角色由反应按新设置重算，撤销时按快照写回。
 */
import {
  REMOVED_ROOT_KEEP_DAYS,
  RATING_LABEL,
  type AddLibraryRootBody,
  type ID,
  type MoveImagesBody,
  type MovePreview,
  type MutationResult,
  type Rating,
  type UpdateLibraryRootBody,
} from '@emaki/shared';
import {
  AddRootInput,
  IdInput,
  ImagesInput,
  ImportImagesInput,
  MoveImagesInput,
  MovePreviewInput,
  ReplaceImageInput,
  UpdateRootInput,
} from '@emaki/shared/schemas';
import { access, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { done } from '../core/undo.ts';
import { recordRootModeUndo, syncRootModes } from '../domain/analysis/rootMode.ts';
import { restoreKinds, type KindSnapshot } from '../domain/analysis/analyze.ts';
import { restoreAutoRatings } from '../domain/curation/marks.ts';
import { markTrashed } from '../domain/library/images.ts';
import { importImages } from '../domain/library/import.ts';
import { declareMoved, moveImages as relocateImages, normalizeSubdir, type MoveRow } from '../domain/library/move.ts';
import { replaceImage } from '../domain/library/replace.ts';
import {
  adoptFromRemovedParents,
  diskCaseRel,
  insertRoot,
  mergeChildRoots,
  relUnder,
  reviveRoot,
  setComicFolderRow,
  setRootRemoved,
  updateRoot,
  type ChildRoot,
} from '../domain/library/roots.ts';
import { isInside, normalizeRootPath, rootPathKey, samePath } from '../datasource/sqlite/settings.ts';
import { iso, toId } from '../datasource/sqlite/sql.ts';
import type { UndoRecorder } from '../datasource/sqlite/undo.ts';
import { BadRequestError, ConflictError, NeedsConfirmError, NotFoundError } from '../http/errors.ts';
import { ComicAreas, IN_COMIC } from '../services/classify/comicAreas.ts';
import { parentRel, toAbs } from '../services/fs/paths.ts';
import { revealInFileManager } from '../services/fs/reveal.ts';
import { byId, byIds, defineCommand, defineQuery, type Engine } from './registry.ts';

/** 改图库文件夹的导入方式会改这些列（撤销用） */
const ROOT_MODE_COLS = [
  'content_kind',
  'content_kind_source',
  'content_kind_evidence',
  'content_kind_version',
  'theme',
  'art_score',
  'rating',
];
type RootImageSnap = { id: number; tagged_at: string | null } & Record<string, unknown>;

export async function addLibraryRoot(e: Engine, body: AddLibraryRootBody): Promise<MutationResult> {
  e.requireLibraryFiles('添加图库文件夹');
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

  const db = e.ctx.db;
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
  if (parent && mode === 'comic') return setComicFolder(e, parent, await diskCaseRel(parent.path, relUnder(parent.key, pk)), comicRating);
  if (parent) throw new BadRequestError(`已经包含在「${parent.path}」里了，不用单独添加。要把它当漫画，选「漫画 · 跳过识别」再添加`);
  const d = await rootPathKey(normalizeRootPath(e.ctx.dataDir));
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
    const backup = path.join(e.ctx.dataDir, 'emaki.before-merge.bak.sqlite');
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
  // 文件夹重新显示：合集全量重算、文件监听、查重标记都由反应做
  e.ctx.apply(() => {
    if (removed) {
      // 复活：旧图和识别结果全部回来
      reviveRoot(db, removed.id, { path: p, mode, rating: comicRating });
      rootId = removed.id;
      revived = db.prepare('SELECT COUNT(*) FROM images WHERE root_id = ?').pluck().get(rootId) as number;
    } else {
      rootId = insertRoot(db, { path: p, mode, rating: comicRating });
    }
    // 子文件夹在新文件夹下的相对路径按真实位置算（两边可能是不同写法）
    if (children.length)
      merged = mergeChildRoots(
        db,
        rootId,
        pk,
        children.map((c) => ({ ...c, path: c.key })),
      ).images;
    if (removedParents.length) adopted = adoptFromRemovedParents(db, rootId, removedParents).images;
    // 合并、接管进来的旧图换了文件夹（路径变了）；复活、合并、接管进来的旧图按这次的设置重判类型（按漫画导入：归漫画、用选的分级）
    const ids = removed || children.length || adopted ? imagesUnder(e, rootId) : [];
    if (children.length || adopted) declareMoved(e.ctx, ids, 'root');
    e.ctx.changed({ type: 'root.visibilityChanged', rootIds: [rootId], ids });
    e.ctx.changed({ type: 'root.modeChanged', rootIds: [rootId], ids });
  });
  // 这些旧图隐藏期间跑过的查重会把它们的未处理重复组删掉：这次扫描完（哪怕没有新图）再查一次（反应已经标了「要查重」）
  // 只扫新文件夹（扫描正在跑时也再排一次）：反应 rescanRoots 对重新显示的文件夹做
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

/**
 * 这个文件夹（relDir 给了就是里面的子文件夹）的漫画设置变了：声明 root.modeChanged，反应按新设置重判类型、分级、去掉识别器的角色，
 * 合集全量重算，监听者、识别排队跟着走。先记下会动的识别器角色和重新识别标记（撤销用）
 */
function rootModeChanged(e: Engine, rootId: number, relDir: string | undefined, u: UndoRecorder): void {
  const ids = imagesUnder(e, rootId, relDir);
  recordRootModeUndo(u, ids);
  e.ctx.changed({ type: 'root.modeChanged', rootIds: [rootId], ids });
}

/**
 * 撤销切换导入方式时，文件夹设置、识别器角色都还原之后，按快照写回类型和分级（restoreRootImages）。
 * 撤销逆序执行，所以要在 mutate 里最先记录
 */
function restoreRootImagesOnUndo(e: Engine, u: UndoRecorder, rootId: number, snap: RootImageSnap[], relDir?: string): void {
  if (snap.length) u.custom(() => restoreRootImages(e, rootId, snap, relDir));
}

/** 图库文件夹里（relDir 给了就是这个子文件夹里）的全部图 */
function imagesUnder(e: Engine, rootId: number, relDir?: string): number[] {
  const under = relDir ? "AND substr(rel_path, 1, length(@dir) + 1) = @dir || '/'" : '';
  return e.ctx.db
    .prepare(`SELECT id FROM images WHERE root_id = @root ${under}`)
    .pluck()
    .all({ root: rootId, dir: relDir ?? '' }) as number[];
}

/**
 * 图库文件夹里的子文件夹按漫画导入（rating = null：不再按漫画导入）；可撤销。
 * 里面的图按新设置重判类型和分级、合集重算、不再按漫画导入时没识别过的图接着识别，都由反应做（撤销时同样）
 */
function setComicFolder(e: Engine, root: { id: number; path: string }, rawDir: string, rating: Rating | null): MutationResult {
  const db = e.ctx.db;
  const relDir = rawDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!relDir) throw new BadRequestError('要选图库文件夹里面的子文件夹');
  const cur = db.prepare('SELECT comic_rating FROM comic_folders WHERE root_id = ? AND rel_dir = ?').get(root.id, relDir) as
    { comic_rating: Rating } | undefined;
  if (rating === null && !cur) throw new NotFoundError('按漫画导入的子文件夹');
  if (rating !== null) {
    const area = ComicAreas.load(db).of(root.id, relDir);
    if (area && area.relDir !== relDir) throw new BadRequestError(`已经在按漫画导入的「${area.path}」里了`);
    if (cur?.comic_rating === rating) return done('没有变化');
  }
  const snap = db
    .prepare(
      `SELECT id, tagged_at, ${ROOT_MODE_COLS.join(', ')} FROM images WHERE root_id = @root AND substr(rel_path, 1, length(@dir) + 1) = @dir || '/'`,
    )
    .all({ root: root.id, dir: relDir }) as RootImageSnap[];
  const where = `${root.path.replace(/\/+$/, '')}/${relDir}`;
  return e.ctx.mutate((u) => {
    restoreRootImagesOnUndo(e, u, root.id, snap, relDir);
    setComicFolderRow(db, u, root.id, relDir, rating, iso(e.ctx.clock()));
    rootModeChanged(e, root.id, relDir, u);
    const message =
      rating === null
        ? `「${where}」不再按漫画导入：没识别过的图会开始识别`
        : cur
          ? `「${where}」的分级改成了「${RATING_LABEL[rating]}」`
          : `已把「${where}」按漫画导入：${snap.length} 张归到漫画，不再识别`;
    return { message };
  });
}

export async function updateLibraryRoot(e: Engine, id: ID, body: UpdateLibraryRootBody): Promise<MutationResult> {
  const root = e.requireRoot(id);
  const db = e.ctx.db;
  // 里面的漫画子文件夹：单独一步（各自可以撤销）
  if (body.comicFolder) {
    const cur = db
      .prepare('SELECT comic_rating FROM comic_folders WHERE root_id = ? AND rel_dir = ?')
      .pluck()
      .get(root.id, body.comicFolder.relDir) as Rating | undefined;
    return setComicFolder(e, root, body.comicFolder.relDir, body.comicFolder.comicRating ?? cur ?? 'general');
  }
  if (body.removeComicFolder !== undefined) return setComicFolder(e, root, body.removeComicFolder, null);
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
  // 合集全量重算（提交后）、文件监听、重新启用后的整根扫描和查重、改回插画后的识别，都由反应做；撤销时重放同样的变化
  return e.ctx.mutate((u) => {
    restoreRootImagesOnUndo(e, u, root.id, snap);
    updateRoot(db, u, root.id, cols, { enabled, mode, rating });
    if (enabled !== cur.enabled) e.ctx.changed({ type: 'root.visibilityChanged', rootIds: [root.id], ids: [] });
    if (touchesImages) rootModeChanged(e, root.id, undefined, u);
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
}

/**
 * 撤销切换导入方式时恢复这个文件夹的图：期间没重新识别过的行按快照写回（手动改过的类型、分级不动）；
 * 期间识别过的、新扫进来的行按现在（已经恢复）的设置重判，免得把新的识别结果盖回旧值。在撤销事务里执行
 */
function restoreRootImages(e: Engine, rootId: number, snap: RootImageSnap[], relDir?: string): void {
  const db = e.ctx.db;
  const under = relDir ? "AND substr(rel_path, 1, length(@dir) + 1) = @dir || '/'" : '';
  const now = new Map(
    (
      db
        .prepare(`SELECT id, tagged_at, content_kind_manual, rating_manual FROM images WHERE root_id = @root ${under}`)
        .all({ root: rootId, dir: relDir ?? '' }) as {
        id: number;
        tagged_at: string | null;
        content_kind_manual: number;
        rating_manual: number;
      }[]
    ).map((r) => [r.id, r]),
  );
  const kinds: KindSnapshot[] = [];
  const ratings: { id: number; rating: Rating }[] = [];
  const recompute: number[] = [];
  for (const s of snap) {
    const n = now.get(s.id);
    now.delete(s.id);
    if (!n) continue;
    if (n.tagged_at !== s.tagged_at) {
      recompute.push(s.id);
      continue;
    }
    if (!n.content_kind_manual) kinds.push(s as unknown as KindSnapshot);
    if (!n.rating_manual) ratings.push({ id: s.id, rating: s.rating as Rating });
  }
  // 类型由分析模块写回（手动改过的不动）
  restoreKinds(db, kinds);
  // 漫画区给的分级是自动分级（归类模块），手动改过的不动
  restoreAutoRatings(db, ratings);
  recompute.push(...now.keys());
  // 写回的行也对一遍：不按顺序撤销时（先撤里层的漫画子文件夹，外层的还在），快照里的「插画」已经不对了
  syncRootModes(db, [...recompute, ...snap.map((x) => x.id)], (c) => e.ctx.changed(c));
}

export async function removeLibraryRoot(e: Engine, id: ID): Promise<MutationResult> {
  const root = e.requireRoot(id);
  const set = { run: (when: string | null, rootId: number) => setRootRemoved(e.ctx.db, rootId, when) };
  const at = iso(e.ctx.clock());
  // 合集全量重算、文件监听、撤销移除后的整根扫描和查重都由反应做
  const removed = () => e.ctx.changed({ type: 'root.visibilityChanged', rootIds: [root.id], ids: [] });
  e.ctx.apply(() => {
    set.run(at, root.id);
    removed();
  });
  return e.ctx.undo.result(`已移除文件夹：${root.path}。磁盘上的文件没动，${REMOVED_ROOT_KEEP_DAYS} 天内重新添加它能找回整理结果`, () => {
    e.ctx.apply(() => {
      set.run(null, root.id);
      removed();
    });
  });
}

/** 移动要处理的图：按角色时是这个角色现在可见的图，否则是给的 ids */
function moveRows(e: Engine, body: MoveImagesBody) {
  const root = e.requireRoot(body.rootId);
  if (!root.enabled) throw new BadRequestError('这个图库文件夹停用了，先启用再移动');
  const dir = normalizeSubdir(body.dir);
  const cols = `i.id, i.root_id, i.rel_path, i.file_name, CASE WHEN EXISTS (SELECT 1 FROM collections c WHERE c.id = i.collection_id AND c.membership = 'folder') THEN i.collection_id ELSE NULL END AS collection_id, i.tagged_at, i.retag, ${IN_COMIC('i')} AS in_comic, r.path AS root_path`;
  let rows: (MoveRow & { tagged_at: string | null; retag: number; in_comic: number })[];
  if (body.characterId !== undefined && body.ids === undefined) {
    const c = e.requireCharacterId(body.characterId);
    rows = e.ctx
      .stmt(
        `SELECT ${cols} FROM v_counted_images i JOIN library_roots r ON r.id = i.root_id
         WHERE EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id AND ic.character_id = ?) ORDER BY i.id`,
      )
      .all(c) as typeof rows;
  } else {
    const ids = e.requireVisibleImages(body.ids ?? []);
    rows = e.ctx
      .stmt(
        `SELECT ${cols} FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id IN (SELECT value FROM json_each(?)) ORDER BY i.id`,
      )
      .all(JSON.stringify(ids)) as typeof rows;
  }
  return { root, dir, rows };
}

/** 移动前先数（对话框显示的就是服务端会移的） */
export async function previewMove(e: Engine, body: MoveImagesBody): Promise<MovePreview> {
  const { root, dir, rows } = moveRows(e, body);
  let alreadyThere = 0;
  let inCollection = 0;
  const ids: number[] = [];
  for (const r of rows) {
    if (r.collection_id !== null) inCollection++;
    else if (r.root_id === root.id && parentRel(r.rel_path).toLowerCase() === dir.toLowerCase()) alreadyThere++;
    else ids.push(r.id);
  }
  const cid = body.characterId === undefined ? null : e.requireCharacterId(body.characterId);
  const json = JSON.stringify(ids);
  const otherCharacters = (
    cid === null
      ? e.ctx.db
          .prepare(
            'SELECT COUNT(*) FROM (SELECT image_id FROM image_characters WHERE image_id IN (SELECT value FROM json_each(?)) GROUP BY image_id HAVING COUNT(*) > 1)',
          )
          .pluck()
          .get(json)
      : e.ctx.db
          .prepare(
            'SELECT COUNT(DISTINCT image_id) FROM image_characters WHERE image_id IN (SELECT value FROM json_each(?)) AND character_id <> ?',
          )
          .pluck()
          .get(json, cid)
  ) as number;
  return { ids: ids.map(toId), alreadyThere, inCollection, otherCharacters };
}

export async function moveImages(e: Engine, body: MoveImagesBody): Promise<MutationResult> {
  const { root, dir, rows } = moveRows(e, body);
  e.requireLibraryFiles('移动文件');
  if (!rows.length) throw new BadRequestError('没有可以移动的图');
  const where = dir ? toAbs(root.path, dir).replace(/\\/g, '/') : root.path;
  // 移动只有一条路径（domain/library/move.ts）：扫描、识别正在读这些文件时不能移；改文件、改路径、声明 image.moved、记 change_log。
  // 来源、路径相关的分类（漫画文件夹）、排除规则、合集都由反应按新位置重算，和扫描发现的移动、整理到子文件夹一样（附录 #11、#17）
  const out = relocateImages(e.ctx, [{ rows, dest: { rootId: root.id, rootPath: root.path, dir } }], {
    reason: 'move',
    where,
    summary: (n) => `${n} 张移到 ${where}`,
  });
  const notes = [
    out.alreadyThere && `${out.alreadyThere} 张本来就在这里`,
    out.inCollection && `合集里的 ${out.inCollection} 张没动`,
    out.failed.length && `${out.failed.length} 张移动失败：${out.failed.slice(0, 3).join('、')}${out.failed.length > 3 ? ' 等' : ''}`,
  ].filter(Boolean);
  const message = `已移动 ${out.moved.length} 张到 ${where}${notes.length ? `（${notes.join('；')}）` : ''}`;
  if (out.logId === null) {
    if (out.failed.length) throw new ConflictError(message);
    return done(message);
  }
  // 记进库里了：重启后也能在「最近的移动」里移回原处
  const logId = out.logId;
  const result = e.ctx.undo.result(message, async () => {
    await e.changes.revertMove(logId, true);
  });
  e.changes.rememberMoveToken(logId, result.undoToken!);
  return result;
}

export async function revealImage(e: Engine, id: ID): Promise<void> {
  const n = e.requireVisibleImages([id])[0]!;
  e.requireLibraryFiles('在资源管理器中显示文件');
  const row = e.ctx
    .stmt('SELECT i.rel_path, r.path AS root_path FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ?')
    .get(n) as { rel_path: string; root_path: string };
  const abs = toAbs(row.root_path, row.rel_path);
  try {
    await access(abs);
  } catch {
    throw new NotFoundError('文件（可能已被移动或删除）');
  }
  await revealInFileManager(abs);
}

/** 移到回收站：先只在库里标记、记一批待移，最近几次可撤销；挤出窗口后才真的移到系统回收站（绝不永久删除） */
/** 移到回收站（可撤销）；手机上传的「撤销这一批」也用它（commands/upload.ts） */
export async function trashImages(e: Engine, ids: number[]): Promise<MutationResult> {
  const now = iso(e.ctx.clock());
  const rows = e.ctx.db
    .prepare(
      `SELECT i.id, i.rel_path, r.path AS root FROM images i JOIN library_roots r ON r.id = i.root_id
       WHERE i.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as { id: number; rel_path: string; root: string }[];
  // 任一文件夹没有回收站 → 400，一张都不动（点的时候就报，不等真的移文件）
  for (const root of new Set(rows.map((r) => r.root))) await e.pendingTrash.checkRoot(root);
  let batch = 0;
  const res = e.ctx.mutate((u) => {
    markTrashed(e.ctx, u, ids, now);
    batch = e.pendingTrash.record(
      u,
      rows.map((r) => ({ id: r.id, abs: toAbs(r.root, r.rel_path) })),
    );
    return { message: `已把 ${ids.length} 张图移到回收站` };
  });
  return e.pendingTrash.added(batch, res);
}

export const libraryCommands = [
  defineCommand({
    name: 'library.import',
    summary:
      '把下载好的本地图片新增入库（每次 1–20 张，每张最多 128 MiB）：完全相同的复用已有 id；重名默认返回 needs_confirm，keepBoth 保留两个版本。撤销把新增的副本移到回收站，下载的文件保留',
    input: ImportImagesInput,
    scope: 'import',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/images/import' }],
    run(e, body) {
      e.requireLibraryFiles('导入文件');
      return importImages(e.ctx, body, { trashImpl: e.ports.trashImpl });
    },
  }),
  defineCommand({
    name: 'library.replace',
    summary: '用下载好的高清版替换一张图：保留 id、角色、画师、来源、收藏，更新尺寸和缩略图；原版本有备份，可撤销',
    input: ReplaceImageInput,
    scope: 'import',
    undoable: true,
    idempotent: true,
    mcp: { destructive: true },
    images: byId,
    http: [{ method: 'POST', path: '/api/images/:id/replace' }],
    run(e, { id, ...body }) {
      e.requireLibraryFiles('替换图库里的文件');
      return replaceImage(e.ctx, id, body);
    },
  }),
  defineCommand({
    name: 'library.trash',
    summary: '移到回收站（最近 5 次可撤销，更早的放进系统回收站）',
    input: ImagesInput,
    scope: 'organize-files',
    undoable: true,
    idempotent: true,
    mcp: { destructive: true },
    images: byIds,
    run: (e, input) => trashImages(e, e.requireVisibleImages([...new Set(input.ids)])),
  }),
  defineCommand({
    name: 'library.move',
    summary: '把图移到图库里的某个文件夹（磁盘上真的移动），识别和整理结果都保留，可撤销；合集里的页不动',
    input: MoveImagesInput,
    scope: 'organize-files',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/images/move' }],
    run: (e, body) => moveImages(e, body),
  }),
  defineCommand({
    name: 'library.reveal',
    summary: '在资源管理器中显示这张图',
    input: IdInput,
    scope: 'desktop',
    undoable: false,
    barrier: false,
    idempotent: false,
    http: [{ method: 'POST', path: '/api/images/:id/reveal' }],
    async run(e, input) {
      await revealImage(e, input.id);
      return { ok: true as const };
    },
  }),
  defineCommand({
    name: 'library.addRoot',
    summary: '添加图库文件夹（包含已有文件夹时先问再合并；移除过的找回整理结果）',
    input: AddRootInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/library-roots' }],
    run: (e, body) => addLibraryRoot(e, body),
  }),
  defineCommand({
    name: 'library.updateRoot',
    summary: '启用 / 停用图库文件夹，改导入方式、漫画分级，设置里面的漫画子文件夹',
    input: UpdateRootInput,
    scope: 'settings',
    undoable: true,
    idempotent: true,
    http: [{ method: 'PATCH', path: '/api/library-roots/:id' }],
    run: (e, { id, ...body }) => updateLibraryRoot(e, id, body),
  }),
  defineCommand({
    name: 'library.removeRoot',
    summary: '移除图库文件夹（磁盘上的文件不动，30 天内重新添加能找回整理结果）',
    input: IdInput,
    scope: 'settings',
    undoable: true,
    idempotent: true,
    http: [{ method: 'DELETE', path: '/api/library-roots/:id' }],
    run: (e, input) => removeLibraryRoot(e, input.id),
  }),
];

export const libraryQueries = [
  defineQuery({
    name: 'images.movePreview',
    summary: '移动前先数：会移哪些图、几张已经在那里、几张在合集里、几张同时属于别的角色',
    input: MovePreviewInput,
    scope: 'read',
    http: [
      { method: 'GET', path: '/api/images/move/preview' },
      // 选中的图很多时 id 放不进地址栏，POST 一直留着
      { method: 'POST', path: '/api/images/move/preview' },
    ],
    run: (e, body) => previewMove(e, body),
  }),
];
