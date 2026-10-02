// 用和图库同一个 WD 模型、同一个阈值给 Danbooru 对照样本打标签，写 out/baseline-wd.json；打完删掉下载的图
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, REPO } from './lib.mjs';

const { out } = args();
const DIR = path.join(out, 'baseline');
const meta = JSON.parse(readFileSync(path.join(DIR, 'meta.json'), 'utf8')) as Record<string, { per: string; file?: string }[]>;
const items: { id: number; path: string; group: string; per: string }[] = [];
for (const [group, list] of Object.entries(meta)) for (const p of list) if (p.file && existsSync(p.file)) items.push({ id: items.length + 1, path: p.file, group, per: p.per });
const srv = (p: string) => pathToFileURL(path.join(REPO, 'apps/server/src', p)).href;
const { config } = await import(srv('config.ts'));
const { startTagger } = await import(srv('services/tagger/client.ts'));
const { ensureModelFiles } = await import(srv('services/tagger/download.ts'));
const { clampBatch, findModel } = await import(srv('services/tagger/models.ts'));
const { pickRating } = await import(srv('services/tagger/postprocess.ts'));
const spec = findModel('SmilingWolf/wd-eva02-large-tagger-v3')!;
const { modelPath, labelsPath } = await ensureModelFiles(spec, config.modelsDir, { log: console.log });
const client = await startTagger({ repo: spec.repo, modelPath, labelsPath, device: 'dml', batchSize: clampBatch(spec, 'dml', 8), modelsDir: config.modelsDir });
const res: { group: string; per: string; rating: string; tags: string[] }[] = [];
for (let i = 0; i < items.length; i += client.batchSize) {
  const batch = items.slice(i, i + client.batchSize);
  for (const r of await client.tag(batch.map((b) => ({ id: b.id, path: b.path })), { general: 0.5, character: 0.99 })) {
    if (!r.ok) continue;
    const b = batch.find((x) => x.id === r.id)!;
    res.push({ group: b.group, per: b.per, rating: r.rating ? pickRating(r.rating) : 'general', tags: r.general.map(([n]: [string, number]) => n) });
  }
  if ((i / client.batchSize) % 50 === 0) console.log(`${i + batch.length}/${items.length}`);
}
writeFileSync(path.join(out, 'baseline-wd.json'), JSON.stringify(res));
for (const g of Object.keys(meta)) rmSync(path.join(DIR, g), { recursive: true, force: true });
console.log('完成', res.length, '（下载的图已删除）');
await client.shutdown?.();
process.exit(0);
