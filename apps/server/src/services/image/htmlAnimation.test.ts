import { rm, readFile, stat, readdir } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { animationHtml } from '../../../test/helpers/htmlAnimation.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { encodeAnimation, htmlAnimationCache, htmlAnimationFirstFrame, parseHtmlAnimation, probeHtmlAnimation } from './htmlAnimation.ts';
import { sharp } from './sharpConfig.ts';
import { probeImage } from './probe.ts';
import { preprocessWdV3 } from '../tagger/preprocess.ts';
import { processPixels } from './pixels.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';
import { EventBus } from '../../core/events.ts';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sha256Buffer } from '../fs/hash.ts';

const dirs: string[] = [];
const temporary = () => {const dir=makeTmpDir('html-animation');dirs.push(dir);return dir;};
afterEach(async()=>{for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true});});

it('extracts frames as data, preserves pixels, frame timing and loop, and caches concurrent requests', async()=>{
  const input=await animationHtml();
  const dir=temporary();
  expect(await probeImage(input)).toMatchObject({format:'html',width:4,height:3,pages:2});
  const [file,other]=await Promise.all([htmlAnimationCache(input,dir),htmlAnimationCache(input,dir)]);
  expect(file).toBe(other);
  const m=await sharp(file,{animated:true}).metadata();
  expect(m).toMatchObject({format:'webp',width:4,pageHeight:3,pages:2,delay:[30,60],loop:0});
  const decoded=await sharp(file,{animated:true}).ensureAlpha().raw().toBuffer();
  expect([...decoded.subarray(0,4)]).toEqual([255,0,0,255]);
  expect([...decoded.subarray(4*3*4,4*3*4+4)]).toEqual([0,255,0,255]);
  const before=(await stat(file)).mtimeMs;
  expect(await htmlAnimationCache(input,dir)).toBe(file);
  expect((await stat(file)).mtimeMs).toBe(before);
  expect(await htmlAnimationCache(await animationHtml([40,80]),dir)).not.toBe(file);
  expect(await readFile(file)).not.toEqual(input);
  expect((await readdir(dir)).sort()).toEqual(['animations']);
});

it('provides a first frame for thumbnails and model preprocessing', async()=>{
  const input=await animationHtml(), first=htmlAnimationFirstFrame(input);
  const dir=temporary();
  const a=await preprocessWdV3(input,8), b=await preprocessWdV3(first,8);
  expect(a).toEqual(b);
  expect(await processPixels(input,'html','ab'.repeat(32),dir)).toEqual(await processPixels(first,'png','cd'.repeat(32),dir));
});

it('serves WebP instead of HTML, recreates a missing cache, and reads changed source before the next scan',async()=>{
  const dir=temporary(),lib=path.join(dir,'library'),data=path.join(dir,'data');
  await mkdir(lib);
  const file=path.join(lib,'animation.html'), input=await animationHtml();
  await writeFile(file,input);
  const ds=await SqliteDataSource.open(new EventBus(),data,{memory:true,autoJobs:false,importDict:false});
  try {
    const db=ds.ctx.db;
    const root=db.prepare('INSERT INTO library_roots(path) VALUES(?)').run(lib).lastInsertRowid;
    const id=String(db.prepare(`INSERT INTO images(root_id,rel_path,file_name,width,height,bytes,format,sha256,added_at,modified_at,frame_count)
      VALUES(?,'animation.html','animation.html',4,3,?,'html',?,'x','x',2)`).run(root,input.length,sha256Buffer(input)).lastInsertRowid);
    const result=await ds.getOriginal(id);
    expect(result?.contentType).toBe('image/webp');
    if(result?.kind!=='path') throw Error('expected cached media path');
    expect(result.filePath).not.toBe(file);
    expect((await sharp(result.filePath,{animated:true}).metadata()).delay).toEqual([30,60]);
    await rm(result.filePath);
    expect((await ds.getOriginal(id))?.contentType).toBe('image/webp');
    await writeFile(file,await animationHtml([40,80]));
    const updated=await ds.getOriginal(id);
    expect(updated?.etag).not.toBe(result.etag);
    if(updated?.kind!=='path') throw Error('expected updated cache');
    expect((await sharp(updated.filePath,{animated:true}).metadata()).delay).toEqual([40,80]);
  } finally { await ds.close(); }
});

it('rejects ordinary pages, executable manifests, remote frames and invalid delays without executing code',async()=>{
  expect(()=>parseHtmlAnimation(Buffer.from('<html>ordinary page</html>'))).toThrow();
  expect(()=>parseHtmlAnimation(Buffer.from('<html><script>var frames_info=[process.exit()];</script></html>'))).toThrow();
  const input=await animationHtml();
  const frames=parseHtmlAnimation(input);
  expect(parseHtmlAnimation(Buffer.from(`<html><script>var frames_info=${JSON.stringify(frames)};throw new Error('must not run');</script></html>`))).toHaveLength(2);
  for(const file of ['https://example.com/a.png','file:///C:/a.png','data:image/svg+xml;base64,PHN2Zz4=']) {
    expect(()=>parseHtmlAnimation(Buffer.from(`<html><script>const frames_info=${JSON.stringify([{file,delay:30}])};</script></html>`))).toThrow();
  }
  for(const delay of [0,-1,1.2,60001]) {
    expect(()=>parseHtmlAnimation(Buffer.from(`<html><script>let frames_info=${JSON.stringify([{...frames[0],delay}])};</script></html>`))).toThrow();
  }
  await expect(probeHtmlAnimation(Buffer.from(`<html><script>var frames_info=${JSON.stringify([{file:'data:image/png;base64,PHN2Zz4=',delay:30}])};</script></html>`))).rejects.toThrow();
});

const solid = (width: number, height: number, background: string, alpha = 1) =>
  sharp({create:{width,height,channels:4,background:{...hexRgb(background),alpha}}}).png().toBuffer();
const hexRgb = (hex: string) => ({r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)});
const framesHtml = (frames: Buffer[], delay = 40) =>
  Buffer.from(`<!doctype html><html><script>var frames_info=${JSON.stringify(frames.map((f)=>({file:`data:image/png;base64,${f.toString('base64')}`,delay})))};</script></html>`);

it('encodes long animations in chunks and joins them into one WebP: frames, timing and loop stay the same', async()=>{
  const colors=['#ff0000','#00ff00','#0000ff','#ffff00','#00ffff'];
  const frames=await Promise.all(colors.map((c)=>solid(8,6,c)));
  const delays=[30,40,50,60,70];
  // 每段 2 帧：2 + 2 + 1（最后一段只有一帧，编出来是静态图，要包成一帧）
  const webp=await encodeAnimation(frames.map((f)=>()=>f),delays,8,6,{chunkPixels:8*6*2});
  expect(await sharp(webp,{animated:true}).metadata()).toMatchObject({format:'webp',width:8,pageHeight:6,pages:5,delay:delays,loop:0});
  const decoded=await sharp(webp,{animated:true}).ensureAlpha().raw().toBuffer();
  for(const [i,c] of colors.entries()) {
    const {r,g,b}=hexRgb(c);
    expect([i,...decoded.subarray(i*8*6*4,i*8*6*4+4)]).toEqual([i,r,g,b,255]);
  }
  // 和一次编码的结果一样
  const whole=await sharp(await encodeAnimation(frames.map((f)=>()=>f),delays,8,6),{animated:true}).ensureAlpha().raw().toBuffer();
  expect(decoded.equals(whole)).toBe(true);
});

it('large animations use lossy WebP for playback, also in chunks; transparency survives the join', async()=>{
  const frames=[await solid(8,6,'#ff0000'),await solid(8,6,'#00ff00',0.5),await solid(8,6,'#0000ff')];
  const webp=await encodeAnimation(frames.map((f)=>()=>f),[50,50,80],8,6,{chunkPixels:8*6,losslessPixels:0});
  const m=await sharp(webp,{animated:true}).metadata();
  expect(m).toMatchObject({pages:3,delay:[50,50,80],hasAlpha:true});
  const px=await sharp(webp,{animated:true}).ensureAlpha().raw().toBuffer();
  const at=(i: number)=>[...px.subarray(i*8*6*4,i*8*6*4+4)];
  const near=(a: number[],b: number[])=>a.every((v,i)=>Math.abs(v-b[i]!)<=12);
  expect(near(at(0),[255,0,0,255])).toBe(true);
  expect(near(at(1),[0,255,0,128])).toBe(true);
  expect(near(at(2),[0,0,255,255])).toBe(true);
});

it('accepts animations beyond the old 64M-pixel limit, still rejects absurd ones', async()=>{
  const big=await solid(3000,3000,'#808080');
  // 3000×3000×8 = 7200 万像素：以前报「HTML 动图解码尺寸过大」
  expect(await probeHtmlAnimation(framesHtml(Array(8).fill(big)))).toMatchObject({format:'html',width:3000,height:3000,pages:8});
  const huge=await solid(6000,6000,'#808080');
  await expect(probeHtmlAnimation(framesHtml(Array(30).fill(huge)))).rejects.toThrow('HTML 动图解码尺寸过大');
});
