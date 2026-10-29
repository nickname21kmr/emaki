/** Read-only evaluation: originals are read; generated fixtures and metrics stay in the output directory. */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { sharp } from '../src/services/image/sharpConfig.ts';
import { compareImages, COMPARISON_LIMITS, COMPARISON_VERSION } from '../src/services/dedupe/compareImages.ts';

const [dbFile, output, examples = '', sampleOffset = '0.5'] = process.argv.slice(2);
if (!dbFile || !output) throw new Error('Usage: tsx verify-duplicate-comparison.ts <database> <output-directory> [id:id,id:id] [sample-offset]');
if (examples && !/^\d+:\d+(,\d+:\d+)*$/.test(examples)) throw new Error('Example pairs must be id:id,id:id');
const offset = Number(sampleOffset);
if (!(offset > 0 && offset < 1)) throw new Error('Sample offset must be between 0 and 1');
await mkdir(output, { recursive: true });
const db = new Database(dbFile, { readonly: true, fileMustExist: true });
const file = (id: number) => {
  const r = db.prepare('SELECT r.path AS root, i.rel_path FROM images i JOIN library_roots r ON r.id=i.root_id WHERE i.id=?').get(id) as {root:string;rel_path:string};
  return path.join(r.root,r.rel_path);
};
const results: object[] = [];
for (const ids of examples ? examples.split(',').map(p => p.split(':').map(Number)) : []) {
  results.push({ kind:'reported-example', ids, ...await compareImages(file(ids[0]!),file(ids[1]!)) });
}
// Spread samples throughout each category instead of selecting only the first imports.
for (const kind of ['illustration','photo','screenshot','comic']) {
  const rows = db.prepare("SELECT id FROM v_counted_images WHERE content_kind=? AND rating='general' AND format IN ('jpeg','png','webp') AND COALESCE(frame_count,1)=1 AND width>=300 AND height>=300 ORDER BY id").all(kind) as {id:number}[];
  for (let n=0;n<6;n++) {
    const chosen=rows[Math.floor((n+offset)*rows.length/6)];
    if (!chosen) continue;
    const {id}=chosen;
    const prefix=path.join(output,`${kind}-${id}`), original=file(id);
    const reference=prefix+'-reference.png';
    await sharp(original).autoOrient().resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).png().toFile(reference);
    const meta=await sharp(reference).metadata();
    for (const quality of [80,95]) {
      const reduced=prefix+`-q${quality}.jpg`;
      await sharp(reference).resize({width:Math.round(meta.width!/2),height:Math.round(meta.height!/2),fit:'fill'}).jpeg({quality}).toFile(reduced);
      results.push({kind:'known-copy',category:kind,id,quality,...await compareImages(reference,reduced)});
    }
    const edit=prefix+'-local-edit.png';
    const patch=await sharp({create:{width:16,height:16,channels:4,background:'#ff00ff'}}).png().toBuffer();
    await sharp(reference).composite([{input:patch,left:Math.floor(meta.width!/2),top:Math.floor(meta.height!/3)}]).png().toFile(edit);
    results.push({kind:'known-edit',category:kind,id,...await compareImages(reference,edit)});
  }
}
// Distribution only: these existing candidates do not have human-labelled ground truth.
const groups=db.prepare("SELECT id FROM duplicate_groups WHERE kind='similar' AND resolved_at IS NULL AND ignored=0 ORDER BY id").all() as {id:number}[];
for(let n=0;n<120;n++) {
  const g=groups[Math.floor((n+0.5)*groups.length/120)];
  if(!g) continue;
  const ids=db.prepare('SELECT image_id FROM duplicate_members WHERE group_id=? ORDER BY image_id LIMIT 2').pluck().all(g.id) as number[];
  try { results.push({kind:'existing-candidate',group:g.id,ids,...await compareImages(file(ids[0]!),file(ids[1]!))}); }
  catch(e) { results.push({kind:'existing-candidate',group:g.id,ids,error:String(e)}); }
}
db.close();
const summary=Object.fromEntries(['reported-example','known-copy','known-edit','existing-candidate'].map(kind=>{
 const values=results.filter((r:any)=>r.kind===kind) as any[];
 return [kind,{total:values.length,pixels:values.filter(r=>r.match==='pixels').length,visual:values.filter(r=>r.match==='visual').length,rejected:values.filter(r=>r.match===null).length,errors:values.filter(r=>r.error).length}];
}));
await writeFile(path.join(output,'results.json'),JSON.stringify({version:COMPARISON_VERSION,limits:COMPARISON_LIMITS,summary,results},null,2));
console.log(JSON.stringify(summary,null,2));
