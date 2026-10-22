import type { ImportImagesBody, ImportImagesResult } from '@emaki/shared';
import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { BadRequestError, ConflictError, NotFoundError } from '../../http/errors.ts';
import { sha256Buffer } from '../../services/fs/hash.ts';
import { isImageFile, toAbs } from '../../services/fs/paths.ts';
import { probeImage } from '../../services/image/probe.ts';
import { htmlAnimationCache } from '../../services/image/htmlAnimation.ts';
import { ComicAreas } from '../../services/classify/comicAreas.ts';
import { parseSource } from '../../services/source/parseSource.ts';
import { INSERT_IMAGE_SQL, imageClassification } from '../../services/scan/imageRow.ts';
import { assertRecyclable } from '../../services/trash/driveType.ts';
import { moveToRecycleBin, type TrashImpl } from '../../services/trash/recycleBin.ts';
import type { SqliteContext } from './context.ts';
import { applyExclusionRules } from './exclusions.ts';
import { normalizeSubdir } from './move.ts';
import { readSettings } from './settings.ts';
import { parseId } from './sql.ts';

const MAX_BYTES = 128 * 1024 * 1024;
const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
};
type Root = { id: number; path: string; enabled: number };
type Imported = { id: number; rootId: number; rel: string; abs: string; sha: string; bytes: number };

function destination(ctx: SqliteContext, rootId: string, dir: string) {
  const id = parseId(rootId);
  const root = id === null ? undefined : ctx.db.prepare('SELECT id,path,enabled FROM library_roots WHERE id=? AND removed_at IS NULL').get(id) as Root | undefined;
  if (!root) throw new NotFoundError('图库文件夹');
  if (!root.enabled) throw new BadRequestError('请先启用目标图库文件夹');
  // Never recreate an offline root, or follow a child junction outside it.
  if (!statSync(root.path).isDirectory()) throw new BadRequestError('目标图库文件夹无法访问');
  const rootReal = realpathSync(root.path);
  let abs = root.path;
  for (const part of dir.split('/').filter(Boolean)) {
    abs = path.join(abs, part);
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new BadRequestError('目标子目录不能是链接或联接点');
  }
  abs = toAbs(root.path, dir);
  if (inside(abs, path.resolve(ctx.dataDir))) throw new BadRequestError('图片不能导入 Emaki 数据目录');
  for (const nested of ctx.db.prepare('SELECT id,path FROM library_roots WHERE removed_at IS NULL AND enabled=1 AND id<>?').all(root.id) as Root[]) {
    if (inside(abs, path.resolve(nested.path))) throw new BadRequestError('目标属于另一个图库文件夹，请使用该文件夹的 rootId');
  }
  mkdirSync(abs, { recursive: true });
  if (!inside(realpathSync(abs), rootReal)) throw new BadRequestError('目标目录必须位于选定图库内');
  return { root, abs };
}

/** Bounded reads of regular files only: not a URL downloader or a directory importer. */
async function imageBytes(file: string) {
  if (!path.isAbsolute(file)) throw new BadRequestError('请提供下载图片在服务器上的绝对路径');
  if (!(await stat(file)).isFile()) throw new BadRequestError('请选择普通图片文件');
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_BYTES) throw new BadRequestError('每个文件需为 1 字节至 128 MiB 的普通图片文件');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new ConflictError('下载文件仍在变化，请下载完成后重试');
    return bytes;
  } finally { await handle.close(); }
}

/** File publication and INSERT run without yielding, like the existing move API. */
export async function importImages(ctx: SqliteContext, body: ImportImagesBody, options: {
  afterImport(ids: number[]): void;
  trashImpl?: TrashImpl;
}): Promise<ImportImagesResult> {
  if (!body.files.length || body.files.length > 20) throw new BadRequestError('每次可导入 1–20 张图片');
  const dir = normalizeSubdir(body.dir);
  destination(ctx, body.rootId, dir);
  const created: Imported[] = [];
  const items: ImportImagesResult['items'] = [];
  for (const file of body.files) {
    try {
      const bytes = await imageBytes(file.path);
      const probe = await probeImage(bytes);
      const sha = sha256Buffer(bytes);
      if (probe.format === 'html') await htmlAnimationCache(bytes, ctx.dataDir, sha);
      let name = file.fileName ?? path.basename(file.path);
      if (!name || /[\\/]/.test(name) || normalizeSubdir(name) !== name) throw new BadRequestError('fileName 必须是一个有效文件名');
      if (!isImageFile(name)) name += `.${probe.format === 'jpeg' ? 'jpg' : probe.format}`;
      // Recheck state after all asynchronous preparation. No writes to existing images.
      const { root, abs: folder } = destination(ctx, body.rootId, dir);
      const duplicates = ctx.db.prepare(`SELECT i.id,i.rel_path,r.path FROM images i JOIN library_roots r ON r.id=i.root_id
        WHERE i.sha256=? AND i.missing=0 AND i.trashed_at IS NULL AND r.enabled=1 AND r.removed_at IS NULL ORDER BY i.id`).all(sha) as { id: number; rel_path: string; path: string }[];
      const existing = duplicates.find(r => {
        try { const f=toAbs(r.path,r.rel_path); return statSync(f).size === bytes.length && sha256Buffer(readFileSync(f)) === sha; }
        catch { return false; }
      });
      if (existing) {
        items.push({ path: file.path, status: 'existing', imageId: String(existing.id), absPath: toAbs(existing.path, existing.rel_path) });
        continue;
      }
      const ext = path.extname(name), stem = name.slice(0, name.length-ext.length);
      const occupied = ctx.db.prepare('SELECT 1 FROM images WHERE root_id=? AND rel_path=? COLLATE NOCASE');
      let n=0, target='', rel='';
      const tmp = path.join(folder, `.emaki-import-${randomUUID()}.tmp`);
      let published = false;
      try {
        writeFileSync(tmp, bytes, {flag:'wx'});
        for (;;) {
          const next = n ? `${stem} (${n})${ext}` : name;
          n++;
          rel = dir ? `${dir}/${next}` : next;
          target = path.join(folder,next);
          if (occupied.get(root.id,rel) || existsSync(target)) continue;
          try {
            // Atomic publication with no overwrite; FAT/network drives use exclusive copy.
            try { linkSync(tmp,target); }
            catch (error) {
              if (!['EPERM','ENOSYS','ENOTSUP','EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
              copyFileSync(tmp,target,constants.COPYFILE_EXCL);
            }
            published = true; break;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        }
        const now = new Date(ctx.clock()).toISOString();
        const source = parseSource(rel, readSettings(ctx.db).tagger.pixivFilenameMode);
        const comic = ComicAreas.load(ctx.db).of(root.id,rel);
        const id = ctx.db.transaction(() => {
          const result = ctx.db.prepare(INSERT_IMAGE_SQL).run({ rootId:root.id,relPath:rel,fileName:path.basename(target),
            width:probe.width,height:probe.height,frameCount:probe.pages,format:probe.format,bytes:bytes.length,sha256:sha,
            modifiedAt:statSync(target).mtime.toISOString(),addedAt:now,rating:comic?.rating ?? 'general',
            ...imageClassification(probe,rel,!!comic),site:source?.site ?? null,postId:source?.postId ?? null,artist:source?.artist ?? null,url:source?.url ?? null });
          const id=Number(result.lastInsertRowid);
          applyExclusionRules(ctx,{imageIds:[id]});
          return id;
        })();
        created.push({id,rootId:root.id,rel,abs:target,sha,bytes:bytes.length});
        items.push({path:file.path,status:'imported',imageId:String(id),absPath:target});
      } catch (error) {
        if (published) unlinkSync(target); // Only our newly published, uncommitted copy.
        throw error;
      } finally { if (existsSync(tmp)) unlinkSync(tmp); }
    } catch (error) { items.push({path:file.path,status:'failed',error:(error as Error).message}); }
  }
  const imported=created.length, existing=items.filter(i=>i.status==='existing').length, failed=items.filter(i=>i.status==='failed').length;
  const message=`已入库 ${imported} 张${existing ? `，${existing} 张已在图库` : ''}${failed ? `，${failed} 张失败` : ''}`;
  if (!created.length) return {ok:true,message,undoToken:null,items};
  ctx.touch();
  options.afterImport(created.map(r=>r.id));
  return {...ctx.undo.result(message,async()=>{
    for (const root of new Set(created.map(r=>path.parse(r.abs).root))) await assertRecyclable(root);
    if (ctx.jobs.list().some(j=>j.kind==='scan' && j.status==='running')) throw new ConflictError('正在扫描图库，请扫描结束后再撤销导入');
    // Refuse to remove anything that was moved, replaced or given a new identity.
    for (const r of created) {
      const current=ctx.db.prepare('SELECT root_id,rel_path,sha256 FROM images WHERE id=?').get(r.id) as {root_id:number;rel_path:string;sha256:string}|undefined;
      if (!current || current.root_id!==r.rootId || current.rel_path!==r.rel || current.sha256!==r.sha ||
        (existsSync(r.abs) && (statSync(r.abs).size!==r.bytes || sha256Buffer(readFileSync(r.abs))!==r.sha)))
        throw new ConflictError('导入后的图片位置或内容已变化，请在图库中选择对应图片处理');
    }
    const result=await moveToRecycleBin(created.map(r=>r.abs),options.trashImpl);
    const done=new Set([...result.trashed,...result.alreadyGone]);
    ctx.db.transaction(()=>{for(const r of created) if(done.has(r.abs)) ctx.db.prepare('UPDATE images SET trashed_at=? WHERE id=?').run(new Date(ctx.clock()).toISOString(),r.id);})();
    ctx.touch(); options.afterImport([]);
    if(result.failed.length) throw new ConflictError(`${result.failed.length} 张图片未能移到系统回收站`);
  }),items};
}
