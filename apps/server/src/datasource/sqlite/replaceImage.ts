import type { ID, ReplaceImageBody, ReplaceImageResult } from '@emaki/shared';
import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BadRequestError, ConflictError, NotFoundError } from '../../http/errors.ts';
import { sha256Buffer } from '../../services/fs/hash.ts';
import { toAbs } from '../../services/fs/paths.ts';
import { probeImage } from '../../services/image/probe.ts';
import { htmlAnimationCache } from '../../services/image/htmlAnimation.ts';
import type { SqliteContext } from './context.ts';
import { destination, imageBytes } from './importImages.ts';
import { parseId } from './sql.ts';

// Only physical media columns change: associations, tags, source, rating, favorites,
// added_at and all manual edits remain attached to the same image identity.
const COLUMNS = ['rel_path','file_name','width','height','bytes','format','sha256','modified_at',
  'camera','frame_count','dhash','dominant_color','thumb_at','decode_error'] as const;
type Media = Record<typeof COLUMNS[number], string | number | null>;
type Row = Media & { id:number; root_id:number; missing:number; trashed_at:string|null };
const MAX_BYTES = 128 * 1024 * 1024;

function target(ctx:SqliteContext,id:ID) {
  const n=parseId(id);
  const row=n===null ? undefined : ctx.db.prepare(`SELECT id,root_id,missing,trashed_at,${COLUMNS.join(',')} FROM images WHERE id=?`).get(n) as Row|undefined;
  if (!row || row.missing || row.trashed_at) throw new NotFoundError('可替换的图片');
  const rel=String(row.rel_path), dir=path.posix.dirname(rel);
  const {root,abs:folder}=destination(ctx,String(row.root_id),dir==='.'?'':dir);
  const abs=toAbs(root.path,rel);
  if (lstatSync(abs).isSymbolicLink() || !statSync(abs).isFile()) throw new BadRequestError('请选择图库中的普通图片文件');
  return {row,abs,root,folder};
}

function unchangedFile(file:string,bytes:number,sha:string) {
  try {
    return statSync(file).size===bytes && bytes<=MAX_BYTES && sha256Buffer(readFileSync(file))===sha;
  } catch {return false;}
}

function idleScanner(ctx:SqliteContext) {
  if(ctx.jobs.list().some(j=>j.kind==='scan' && j.status==='running')) throw new ConflictError('图库正在扫描，请扫描完成后重试替换');
}

/** Publish bytes and update their row without yielding to the watcher/scan loop.
 * On a database/rename failure, restore the previous file before surfacing the error.
 * A format change gets the matching extension, retaining the same database ID.
 */
function swap(ctx:SqliteContext,id:number,from:string,to:string,bytes:Buffer,previous:Buffer,previousMtime:Date,media:Media,mtime?:Date) {
  const tmp=path.join(path.dirname(to),`.emaki-replace-${randomUUID()}.tmp`);
  let published=false, removed=false;
  try {
    writeFileSync(tmp,bytes,{flag:'wx'});
    if(mtime) utimesSync(tmp,mtime,mtime);
    if(from===to) {renameSync(tmp,to);published=true;}
    else {
      try {linkSync(tmp,to);}
      catch(error) {
        if(!['EPERM','ENOSYS','ENOTSUP','EXDEV'].includes((error as NodeJS.ErrnoException).code??'')) throw error;
        copyFileSync(tmp,to,constants.COPYFILE_EXCL);
        if(mtime) utimesSync(to,mtime,mtime);
      }
      published=true;
    }
    ctx.db.transaction(()=>{
      ctx.db.prepare(`UPDATE images SET ${COLUMNS.map(c=>`${c}=@${c}`).join(',')} WHERE id=@id`)
        .run({...media,modified_at:statSync(to).mtime.toISOString(),id});
      if(from!==to) {unlinkSync(from);removed=true;}
    })();
  } catch(error) {
    if(published) {
      if(from===to || removed) {
        // Same-directory rename makes compensation atomic as well.
        const rollback=path.join(path.dirname(from),`.emaki-restore-${randomUUID()}.tmp`);
        try {
          writeFileSync(rollback,previous,{flag:'wx'});
          utimesSync(rollback,previousMtime,previousMtime);
          renameSync(rollback,from);
        } finally {if(existsSync(rollback)) unlinkSync(rollback);}
      }
      if(from!==to) unlinkSync(to);
    }
    throw error;
  } finally {if(existsSync(tmp)) unlinkSync(tmp);}
}

export async function replaceImage(ctx:SqliteContext,id:ID,body:ReplaceImageBody,afterChange:(ids:number[])=>void):Promise<ReplaceImageResult> {
  const bytes=await imageBytes(body.path), probe=await probeImage(bytes), sha=sha256Buffer(bytes);
  if(probe.format==='html') await htmlAnimationCache(bytes,ctx.dataDir,sha);
  let old=target(ctx,id);
  const previous=await imageBytes(old.abs);
  // All asynchronous work is complete. Check current identity and bytes again.
  old=target(ctx,id);
  idleScanner(ctx);
  if(sha256Buffer(previous)!==old.row.sha256 || !unchangedFile(old.abs,Number(old.row.bytes),String(old.row.sha256)))
    throw new ConflictError('原图片正在变化，请更新图库后重试');
  if(sha===old.row.sha256) return {ok:true,message:'这张图片已是该版本',undoToken:null,imageId:id,absPath:old.abs};
  const before=Object.fromEntries(COLUMNS.map(c=>[c,old.row[c]])) as Media;
  const oldMtime=statSync(old.abs).mtime;
  const ext=probe.format==='jpeg'?'jpg':probe.format;
  const oldRel=String(old.row.rel_path),oldExt=path.extname(oldRel);
  const rel=probe.format===old.row.format ? oldRel : (oldExt ? oldRel.slice(0,-oldExt.length) : oldRel)+`.${ext}`;
  const abs=toAbs(old.root.path,rel);
  if(abs!==old.abs && (existsSync(abs) || ctx.db.prepare('SELECT 1 FROM images WHERE root_id=? AND rel_path=? COLLATE NOCASE AND id<>?').get(old.row.root_id,rel,old.row.id)))
    throw new ConflictError('新格式的同名文件已存在，请先选择要替换的图片');
  // A recoverable copy lives outside watched roots, including across a process restart.
  const backupDir=path.join(ctx.dataDir,'image-replacements',randomUUID());
  mkdirSync(backupDir,{recursive:true});
  const backup=path.join(backupDir,'original.bin');
  writeFileSync(backup,previous,{flag:'wx'});
  writeFileSync(path.join(backupDir,'record.json'),JSON.stringify({imageId:id,originalPath:old.abs,replacementPath:abs,sourcePath:body.path,at:new Date(ctx.clock()).toISOString(),media:before},null,2),{flag:'wx'});
  const media:Media={...before,rel_path:rel,file_name:path.basename(abs),width:probe.width,height:probe.height,
    bytes:bytes.length,format:probe.format,sha256:sha,camera:probe.camera,frame_count:probe.pages,
    dhash:null,dominant_color:null,thumb_at:null,decode_error:null};
  swap(ctx,old.row.id,old.abs,abs,bytes,previous,oldMtime,media);
  const previousSize=previous.length,replacementSize=bytes.length;
  ctx.touch();afterChange([old.row.id]);
  return {...ctx.undo.result('已替换图片',()=>{
    idleScanner(ctx);
    const current=target(ctx,id);
    if(current.row.root_id!==old.row.root_id || current.row.rel_path!==rel || current.row.sha256!==sha || current.abs!==abs || !unchangedFile(abs,replacementSize,sha))
      throw new ConflictError('图片位置或内容已变化，请查看当前图片后再处理');
    if(abs!==old.abs && existsSync(old.abs)) throw new ConflictError('原文件位置已有其他文件，请先处理重名文件');
    if(!unchangedFile(backup,previousSize,String(before.sha256))) throw new ConflictError('原版本备份无法读取');
    swap(ctx,old.row.id,abs,old.abs,readFileSync(backup),readFileSync(abs),statSync(abs).mtime,before,oldMtime);
    ctx.touch();afterChange([old.row.id]);
  }),imageId:id,absPath:abs};
}
