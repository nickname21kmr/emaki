/**
 * 移动只有一条路径（docs/core-architecture.md 第 2.4 节，P4a，附录 #11）。
 *
 * 应用内「移动…」、整理到子文件夹、撤回移动（toast 里的撤销、「最近的移动」里移回）共用这一个实现：
 * 改文件 → 改路径（recordMoved）→ 声明 image.moved → 记 change_log（重启后也能移回）。
 * 扫描发现的移动是「观察到的」，不动文件，但路径同样经 recordMoved 写、声明同样的 image.moved（reason 是 scan），
 * 来源重新解析、路径相关的分类、漫画区、排除规则、合集都由反应按新位置重算，和应用内移动完全一样。
 * 动文件之前都过 assertFilesIdle（guard.ts）。
 *
 * 文件操作全用同步 API：移动过程中事件循环不让出，扫描任务插不进来，
 * 不会出现「扫描读到了旧的记录、又发现文件不在了」把刚移走的图标成丢失。
 */
import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { BadRequestError, ConflictError } from '../../http/errors.ts';
import { isSkippedDirName, parentRel, toAbs } from '../../services/fs/paths.ts';
import type { Db } from '../../db/connection.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { recordChange, settleMoveLog, type MovePayload } from '../../datasource/sqlite/changeLog.ts';
import type { MoveReason } from '../../propagation/changes.ts';
import { linkEach } from '../curation/links.ts';
import { fromLegacySnapshot, fromRow } from '../curation/provenance.ts';
import { setRetag } from '../evidence/retag.ts';
import { stmt, type DomainTx } from '../tx.ts';
import { assertFilesIdle } from './guard.ts';

const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** 图库文件夹下的子目录：'角色\\未花\\' → '角色/未花'，'' = 图库文件夹本身 */
export function normalizeSubdir(input: string): string {
  const parts = input
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // '. .' 这种点和空格夹杂的也算：去掉结尾的点和空格后会变成空段，拼出 '/x'、'a//b'
      if (/^[. ]+$/.test(s)) throw new BadRequestError('文件夹名不能只有点');
      // Windows 会悄悄去掉结尾的点和空格，先去掉，免得记录和磁盘对不上
      return s.replace(/[. ]+$/, '');
    });
  for (const s of parts) {
    if (BAD_CHARS.test(s)) throw new BadRequestError(`文件夹名不能包含 < > : " | ? *：${s}`);
    if (RESERVED.test(s)) throw new BadRequestError(`「${s}」是 Windows 保留的名字，换一个`);
    // 扫描器不进这些目录，移进去的图下次扫描会被当成丢失
    if (isSkippedDirName(s)) throw new BadRequestError(`「${s}」开头是 . 或 $，或者是系统目录，Emaki 不会扫描这种文件夹，换一个名字`);
  }
  const dir = parts.join('/');
  if (dir.length > 200) throw new BadRequestError('文件夹路径太长');
  return dir;
}

/** 同盘直接改名；跨盘复制后删除原文件，并保留修改时间（识别模型的新旧分流、统计都用它） */
function moveFile(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    const st = statSync(src);
    copyFileSync(src, dst, constants.COPYFILE_EXCL);
    try {
      utimesSync(dst, st.atime, st.mtime);
      unlinkSync(src);
    } catch (e) {
      // 原文件删不掉（比如被占用）：删掉刚复制的那份，算这张移动失败，记录仍指向原文件
      rmSync(dst, { force: true });
      throw e;
    }
  }
}

export interface MoveRow {
  id: number;
  root_id: number;
  rel_path: string;
  file_name: string;
  root_path: string;
  collection_id: number | null;
}

export interface Moved {
  id: number;
  from: { rootId: number; rel: string; name: string; rootPath: string };
  to: { rootId: number; rel: string; name: string; rootPath: string };
}

export interface MoveOutcome {
  moved: Moved[];
  /** 合集（本子、画集）里的页：移走会拆散合集，不动 */
  inCollection: number;
  /** 已经在目标文件夹里 */
  alreadyThere: number;
  failed: string[];
}

/** 改路径（图库与文件模块的观测列）；扫描发现的移动另外带上文件的修改时间，并清掉丢失、回收站（文件就在新位置） */
export interface PathUpdate {
  id: number;
  rootId: number;
  relPath: string;
  fileName: string;
  modifiedAt?: string;
}

function writePath(db: Db, p: PathUpdate): void {
  if (p.modifiedAt === undefined) stmt(db, 'UPDATE images SET root_id = @rootId, rel_path = @relPath, file_name = @fileName WHERE id = @id').run(p);
  else
    stmt(db, 'UPDATE images SET root_id = @rootId, rel_path = @relPath, file_name = @fileName, modified_at = @modifiedAt, missing = 0, trashed_at = NULL WHERE id = @id').run(p);
}

/**
 * 扫描观察到的移动：只改路径，声明 image.moved（reason scan）。应用内的移动在移完每个文件时已经写了路径（见 moveImageFiles），
 * 只用 declareMoved 声明
 */
export function recordMoved(tx: DomainTx, moves: readonly PathUpdate[], reason: MoveReason): void {
  for (const m of moves) writePath(tx.db, m);
  declareMoved(tx, moves.map((m) => m.id), reason);
}

/** 路径变了：来源、路径相关的分类、漫画区、排除规则、合集由反应按新位置重算（附录 #11、#17） */
export function declareMoved(tx: DomainTx, ids: readonly number[], reason: MoveReason): void {
  tx.changed({ type: 'image.moved', ids: [...ids], reason });
}

/** 改文件 + 改路径：每张移完立刻写库（中途出错时，已经移走的图记录也是对的）。不声明变化，调用方（moveImages）统一声明 */
export function moveImageFiles(db: Db, rows: MoveRow[], dest: { rootId: number; rootPath: string; dir: string }, allowCollection = false): MoveOutcome {
  const out: MoveOutcome = { moved: [], inCollection: 0, alreadyThere: 0, failed: [] };
  const destAbs = toAbs(dest.rootPath, dest.dir);
  const occupiedInDb = db.prepare('SELECT 1 FROM images WHERE root_id = ? AND rel_path = ?');
  const update = { run: (rootId: number, relPath: string, fileName: string, id: number) => writePath(db, { id, rootId, relPath, fileName }) };
  const taken = new Set<string>();
  const free = (rel: string) => !taken.has(rel.toLowerCase()) && !occupiedInDb.get(dest.rootId, rel) && !existsSync(toAbs(dest.rootPath, rel));

  let made = false;
  for (const r of rows) {
    if (r.collection_id !== null && !allowCollection) {
      out.inCollection++;
      continue;
    }
    if (r.root_id === dest.rootId && parentRel(r.rel_path).toLowerCase() === dest.dir.toLowerCase()) {
      out.alreadyThere++;
      continue;
    }
    if (!made) {
      mkdirSync(destAbs, { recursive: true });
      made = true;
    }
    // 重名：a.jpg → a (1).jpg
    const ext = path.extname(r.file_name);
    const stem = r.file_name.slice(0, r.file_name.length - ext.length);
    let name = r.file_name;
    let rel = dest.dir ? `${dest.dir}/${name}` : name;
    for (let n = 1; !free(rel); n++) {
      name = `${stem} (${n})${ext}`;
      rel = dest.dir ? `${dest.dir}/${name}` : name;
    }
    try {
      moveFile(toAbs(r.root_path, r.rel_path), toAbs(dest.rootPath, rel));
    } catch (err) {
      out.failed.push(`${r.file_name}（${(err as NodeJS.ErrnoException).code ?? (err as Error).message}）`);
      continue;
    }
    // 每张移完立刻写库：中途出错时，已经移走的图记录也是对的
    update.run(dest.rootId, rel, name, r.id);
    taken.add(rel.toLowerCase());
    out.moved.push({
      id: r.id,
      from: { rootId: r.root_id, rel: r.rel_path, name: r.file_name, rootPath: r.root_path },
      to: { rootId: dest.rootId, rel, name, rootPath: dest.rootPath },
    });
  }
  return out;
}

export interface MoveBackFailure {
  id: number;
  name: string;
  reason: string;
}

/** 撤销：按原路移回。记录或文件已经变了、原位置被占了的跳过，每张记下原因 */
export function moveBack(db: Db, moved: Moved[]): { restored: number; restoredIds: number[]; failed: MoveBackFailure[] } {
  const current = db.prepare('SELECT root_id, rel_path FROM images WHERE id = ?');
  const rootAlive = db.prepare('SELECT path FROM library_roots WHERE id = ? AND removed_at IS NULL').pluck();
  const update = { run: (rootId: number, relPath: string, fileName: string, id: number) => writePath(db, { id, rootId, relPath, fileName }) };
  const restoredIds: number[] = [];
  const failed: MoveBackFailure[] = [];
  for (const m of [...moved].reverse()) {
    const row = current.get(m.id) as { root_id: number; rel_path: string } | undefined;
    const src = toAbs(m.to.rootPath, m.to.rel);
    const dst = toAbs(m.from.rootPath, m.from.rel);
    const fail = (reason: string) => failed.push({ id: m.id, name: m.to.name, reason });
    if (!row) { fail('图已经不在库里了'); continue; }
    if (row.root_id !== m.to.rootId || row.rel_path !== m.to.rel) { fail('之后又移动或改过名'); continue; }
    if (rootAlive.get(m.from.rootId) === undefined) { fail('原来的图库文件夹已经移除'); continue; }
    if (!existsSync(src)) { fail('文件不在了'); continue; }
    if (existsSync(dst)) { fail('原位置已经有同名文件'); continue; }
    try {
      mkdirSync(path.dirname(dst), { recursive: true });
      moveFile(src, dst);
    } catch (err) {
      fail(`移动失败：${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
      continue;
    }
    update.run(m.from.rootId, m.from.rel, m.from.name, m.id);
    restoredIds.push(m.id);
  }
  return { restored: restoredIds.length, restoredIds, failed };
}

// ---------------------------------------------------------------- 应用内移动、整理到子文件夹、撤回移动

export interface MoveGroup {
  rows: MoveRow[];
  dest: { rootId: number; rootPath: string; dir: string };
}

export interface MoveResult extends MoveOutcome {
  /** change_log 里这批的编号；一张都没移时是 null */
  logId: number | null;
}

/**
 * 应用内移动（「移动…」reason move、整理到子文件夹 reason organize）唯一的实现：先过 assertFilesIdle，
 * 改文件、改路径，声明 image.moved，记 change_log（where：显示用的位置，summary：「最近的移动」里的一行）。
 * 移动前记下这些图的自动关联和重新识别标记：漫画区同步会去掉自动关联、标重新识别，移回时按原来的来历放回
 */
export function moveImages(
  ctx: SqliteContext,
  groups: readonly MoveGroup[],
  opts: { reason: Extract<MoveReason, 'move' | 'organize'>; where: string; summary: (n: number) => string; allowCollection?: boolean },
): MoveResult {
  assertFilesIdle(ctx, groups.flatMap((g) => g.rows.map((r) => r.id)), opts.reason === 'organize' ? '整理文件夹' : '移动');
  const out: MoveResult = { moved: [], inCollection: 0, alreadyThere: 0, failed: [], logId: null };
  for (const g of groups) {
    const o = moveImageFiles(ctx.db, g.rows, g.dest, opts.allowCollection);
    out.moved.push(...o.moved);
    out.inCollection += o.inCollection;
    out.alreadyThere += o.alreadyThere;
    out.failed.push(...o.failed);
  }
  if (!out.moved.length) return out;
  const ids = out.moved.map((m) => m.id);
  const json = JSON.stringify(ids);
  // 漫画区同步只去掉自动关联（附录 #6）：快照也只记自动的，移回时按原来的来历放回
  const charSnap = ctx.db.prepare("SELECT * FROM image_characters WHERE decision = 'auto' AND image_id IN (SELECT value FROM json_each(?))").all(json);
  const retagSnap = ctx.db.prepare('SELECT id, retag FROM images WHERE id IN (SELECT value FROM json_each(?))').all(json);
  const payload: MovePayload = { where: opts.where, items: out.moved, charSnap: charSnap as MovePayload['charSnap'], retagSnap: retagSnap as MovePayload['retagSnap'] };
  out.logId = ctx.apply(() => {
    declareMoved(ctx, ids, opts.reason);
    return recordChange(ctx, 'move', opts.summary(out.moved.length), payload);
  });
  return out;
}

export interface MoveBackOutcome {
  restored: number;
  failed: MoveBackFailure[];
  /** 给用户的提示 */
  message: string;
  /** 要报冲突时的话（strict 时有没移回的、或者一张都没移回）；已经移回的照样记下了 */
  conflict: string | null;
}

const fileList = (failed: MoveBackFailure[]) =>
  `${failed.slice(0, 5).map((f) => `${f.name}（${f.reason}）`).join('、')}${failed.length > 5 ? ` 等 ${failed.length} 张` : ''}`;

/**
 * 撤回一批移动（toast 里的撤销 strict：有没移回的就算冲突；「最近的移动」里移回：只在一张都没移回时算冲突，其余列在提示里）。
 * 移回原位也是一次移动：声明 image.moved（revertMove），来源、分类、排除规则、合集由反应按原位置重算；
 * 按移动前的快照放回自动关联（归类模块；用户这期间否决过的不放回）和重新识别标记。移回的从记录里去掉，全部移回才算撤回完。
 * 扫描、识别正在动这些文件时直接报错（什么都没做）
 */
export function revertMoveLog(ctx: SqliteContext, logId: number, strict: boolean): MoveBackOutcome {
  const row = ctx.db.prepare("SELECT payload, reverted_at FROM change_log WHERE id = ? AND kind = 'move'").get(logId) as
    | { payload: string; reverted_at: string | null }
    | undefined;
  if (!row) throw new ConflictError('这批移动的记录已经不在了');
  if (row.reverted_at) throw new ConflictError('这批已经移回去了');
  const payload = JSON.parse(row.payload) as MovePayload;
  assertFilesIdle(ctx, payload.items.map((it) => it.id), '移回');
  const back = moveBack(ctx.db, payload.items);
  const restored = new Set(back.restoredIds);
  const now = new Date(ctx.clock()).toISOString();
  ctx.apply(() => {
    if (restored.size) {
      declareMoved(ctx, [...restored], 'revertMove');
      // 角色这期间被删掉、合并掉的放不回，这几页留着重新识别
      const res = linkEach(
        ctx,
        null,
        payload.charSnap
          .filter((c) => restored.has(c.image_id))
          .map((c) => ({ imageId: c.image_id, characterId: c.character_id, provenance: 'decision' in c ? fromRow(c) : fromLegacySnapshot(c) })),
        { vetoes: 'respect' },
      );
      const lost = new Set([...res.missing, ...res.vetoed].map((x) => x.imageId));
      // 重新识别的标记按移动前写回（移回原位后漫画文件夹的同步不会再标：它只标漫画文件夹里还挂着识别器角色的页）
      setRetag(ctx.db, payload.retagSnap.filter((s) => restored.has(s.id)).map((s) => ({ id: s.id, retag: lost.has(s.id) ? 1 : s.retag })));
    }
    const left = payload.items.filter((it) => !restored.has(it.id));
    settleMoveLog(ctx.db, logId, { ...payload, items: left }, back.failed.length ? `没能移回：${fileList(back.failed)}` : null, left.length ? null : now);
  });
  const failed = back.failed.length ? `${back.failed.length} 张没能移回：${fileList(back.failed)}` : '';
  return {
    restored: back.restored,
    failed: back.failed,
    message: failed ? `移回了 ${back.restored} 张；${failed}` : `已把 ${back.restored} 张移回原处`,
    conflict: back.failed.length && (strict || !restored.size) ? `移回了 ${back.restored} 张，${failed}` : null,
  };
}
