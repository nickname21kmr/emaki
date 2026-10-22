import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EventBus } from '../../core/events.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { sharp } from '../../services/image/sharpConfig.ts';
import { animationHtml } from '../../../test/helpers/htmlAnimation.ts';
import { SqliteDataSource } from './SqliteDataSource.ts';
import Fastify from 'fastify';
import { imageRoutes } from '../../routes/images.ts';

let dir:string, lib:string, downloads:string, rootId:string, ds:SqliteDataSource;
let image:Buffer;
beforeEach(async()=>{
  dir=makeTmpDir('image-import');lib=path.join(dir,'library');downloads=path.join(dir,'downloads');
  await mkdir(lib);await mkdir(downloads);
  image=await sharp({create:{width:12,height:14,channels:3,background:'#d72'}}).png().toBuffer();
  ds=await SqliteDataSource.open(new EventBus(),path.join(dir,'data'),{memory:true,autoJobs:false,importDict:false,
    trashImpl:async(files)=>{for(const f of files) await rename(f,path.join(downloads,`trashed-${path.basename(f)}`));}});
  rootId=String(ds.ctx.db.prepare('INSERT INTO library_roots(path) VALUES(?)').run(lib).lastInsertRowid);
  vi.spyOn(ds.pipeline,'afterImport').mockImplementation(()=>{});
});
afterEach(async()=>{await ds.close();await rm(dir,{recursive:true,force:true,maxRetries:3});});
const source=async(name='image.png',bytes=image)=>{const file=path.join(downloads,name);await writeFile(file,bytes);return file;};
const run=(files:{path:string;fileName?:string}[],dest='插画')=>ds.importImages({rootId,dir:dest,files});
const item=(result:Awaited<ReturnType<typeof run>>)=>{
  const first=result.items[0]!;if(first.status==='failed') throw Error(first.error);return first;
};

it('copies validated bytes, immediately returns real image IDs, preserves source and continues the pipeline',async()=>{
  const file=await source('12345678_p0.png'),before=await stat(file);
  const result=await run([{path:file}]), row=item(result);
  expect(row.status).toBe('imported');expect(result.undoToken).toBeTruthy();
  expect(await readFile(row.absPath)).toEqual(image);
  expect(await readFile(file)).toEqual(image);expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  expect(await ds.getImage(row.imageId)).toMatchObject({fileName:'12345678_p0.png',width:12,height:14,source:{site:'pixiv',postId:'12345678'}});
  expect(await readdir(path.join(lib,'插画'))).toEqual(['12345678_p0.png']);
  expect(ds.pipeline.afterImport).toHaveBeenCalledWith();expect(await ds.listJobs()).toEqual([]);
  // Ordinary scans see the same row and do not import it again.
  ds.requests.requestFull();
  const summary=await ds.scanner.scan({signal:new AbortController().signal,setTotal(){},advance(){},setMessage(){},shouldYield:()=>false,requeue(){},yielded:false});
  expect(summary).toMatchObject({added:0,updated:0,missing:0});
});

it('exact duplicates reuse existing IDs, including duplicate paths within a batch, and never overwrite names',async()=>{
  const file=await source(),one=item(await run([{path:file}],'')).imageId;
  const again=await run([{path:file},{path:file,fileName:'different.png'}]);
  expect(again.undoToken).toBeNull();expect(again.items.map(i=>i.status)).toEqual(['existing','existing']);
  expect(again.items.every(i=>i.status!=='failed' && i.imageId===one)).toBe(true);
  const other=await sharp({create:{width:12,height:14,channels:3,background:'#2c9'}}).png().toBuffer();
  await writeFile(file,other);
  const next=item(await run([{path:file}],'') );
  expect(next.imageId).not.toBe(one);expect(path.basename(next.absPath)).toBe('image (1).png');
  expect(await readFile(path.join(lib,'image.png'))).toEqual(image);
});

it('never overwrites an unindexed disk file, and reports per-file validation failures',async()=>{
  await writeFile(path.join(lib,'image.png'),'keep-me');
  const good=await source(),bad=await source('page.jpg',Buffer.from('<html>not an image</html>'));
  const result=await run([{path:good},{path:bad},{path:good,fileName:'../escape.png'},{path:'relative.png'}],'');
  expect(result.items.map(i=>i.status)).toEqual(['imported','failed','failed','failed']);
  expect(await readFile(path.join(lib,'image.png'),'utf8')).toBe('keep-me');
  expect(await readdir(lib)).toEqual(['image (1).png','image.png']);
  expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM images').pluck().get()).toBe(1);
});

it('respects comic import mode and supports the same HTML animation adapter',async()=>{
  ds.ctx.db.prepare("UPDATE library_roots SET content_mode='comic',comic_rating='explicit' WHERE id=?").run(rootId);
  const file=await source(), row=item(await run([{path:file}],'comic'));
  expect(await ds.getImage(row.imageId)).toMatchObject({kind:'comic',rating:'explicit'});
  ds.ctx.db.prepare("UPDATE library_roots SET content_mode='auto' WHERE id=?").run(rootId);
  const html=await source('124815237_动画.html',await animationHtml());
  const animated=item(await run([{path:html}],'动画'));
  expect(await ds.getImage(animated.imageId)).toMatchObject({format:'html',kind:'animated'});
  expect((await ds.getOriginal(animated.imageId))?.contentType).toBe('image/webp');
});

it('blocks traversal, disabled or missing roots, nested library roots and child junctions',async()=>{
  const file=await source();
  await expect(run([{path:file}],'../outside')).rejects.toThrow();
  ds.ctx.db.prepare('UPDATE library_roots SET enabled=0 WHERE id=?').run(rootId);
  await expect(run([{path:file}])).rejects.toThrow('启用');
  ds.ctx.db.prepare('UPDATE library_roots SET enabled=1 WHERE id=?').run(rootId);
  await mkdir(path.join(lib,'nested'));
  ds.ctx.db.prepare('INSERT INTO library_roots(path) VALUES(?)').run(path.join(lib,'nested'));
  await expect(run([{path:file}],'nested')).rejects.toThrow('另一个图库');
  await symlink(downloads,path.join(lib,'link'),process.platform==='win32'?'junction':'dir');
  await expect(run([{path:file}],'link')).rejects.toThrow('链接');
  await rm(lib,{recursive:true,force:true});
  await expect(run([{path:file}])).rejects.toThrow();
  expect(await stat(lib).catch(()=>null)).toBeNull();
});

it('undo moves only new copies to the system recycle bin; source and existing images remain',async()=>{
  const file=await source(),result=await run([{path:file}]),row=item(result);
  await ds.undo(result.undoToken!);
  expect(await stat(row.absPath).catch(()=>null)).toBeNull();expect(await readFile(file)).toEqual(image);
  expect(await readFile(path.join(downloads,'trashed-image.png'))).toEqual(image);
  expect(ds.ctx.db.prepare('SELECT trashed_at FROM images WHERE id=?').pluck().get(row.imageId)).toBeTruthy();
});

it('undo does not remove a modified image',async()=>{
  const file=await source(),result=await run([{path:file}]),row=item(result);
  await writeFile(row.absPath,'user replacement');
  await expect(ds.undo(result.undoToken!)).rejects.toThrow('变化');
  expect(await readFile(row.absPath,'utf8')).toBe('user replacement');
});

it('database write failure removes only its new copy and leaves no temporary file or orphan row',async()=>{
  ds.ctx.db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  const file=await source(),result=await run([{path:file}],'');
  expect(result.items[0]).toMatchObject({status:'failed',error:'fixture failure'});
  expect(await readdir(lib)).toEqual([]);expect(await readFile(file)).toEqual(image);
  expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM images').pluck().get()).toBe(0);
});

it('HTTP validates requests and returns immediately readable imported records',async()=>{
  const app=Fastify();imageRoutes(app,ds);
  try {
    expect((await app.inject({method:'POST',url:'/api/images/import',payload:{rootId,files:[]}})).statusCode).toBe(400);
    const file=await source();
    const response=await app.inject({method:'POST',url:'/api/images/import',payload:{rootId,files:[{path:file}]}});
    expect(response.statusCode).toBe(200);
    const imageId=response.json().items[0].imageId;
    expect((await app.inject({url:`/api/images/${imageId}`})).json()).toMatchObject({id:imageId,width:12,height:14});
  } finally {await app.close();}
});
