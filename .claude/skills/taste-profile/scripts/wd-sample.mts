// 不是 WD 打的标签的图（换成 PixAI 之后的），每个时期抽一部分用 WD 重打，让整条时间线同一个口径。
// 只写 out/wd-sample.json，不改图库。用法：node --import tsx wd-sample.mts [--per 600] [--out 目录]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { args, loadIllustrations, openSnapshot, readJson, REPO } from './lib.mjs';

const { out, get } = args();
const PER = Number(get('--per') ?? 600);
const undated = (get('--undated-roots') ?? '').split(',').filter(Boolean).map(Number);
const db = openSnapshot(out);
const roots = new Map((db.prepare('SELECT id, path FROM library_roots').all() as { id: number; path: string }[]).map((r) => [r.id, r.path]));
const relOf = new Map((db.prepare('SELECT id, root_id, rel_path FROM images').all() as { id: number; root_id: number; rel_path: string }[]).map((r) => [r.id, r]));
const rows = (loadIllustrations(db, { undatedRoots: undated }) as { id: number; per: string; wd: boolean; tagged_at: string | null }[]).filter((r) => !r.wd && r.tagged_at);
if (!rows.length) {
  console.log('全部是 WD 打的标签，不需要抽样');
  process.exit(0);
}
// 固定种子洗牌，结果可复现
let seed = 20260928;
const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
// 增量：上次抽过、现在仍然不是 WD 标签的保留，每个时期只补差的部分
type Entry = { per: string; rating: string; tags: string[] };
const prev = (readJson(path.join(out, 'wd-sample.json'), {}) ?? {}) as Record<string, Entry>;
const perOf = new Map(rows.map((r) => [r.id, r.per]));
const kept: Record<string, Entry> = Object.fromEntries(Object.entries(prev).filter(([id]) => perOf.has(+id)));
const have: Record<string, number> = {};
for (const id of Object.keys(kept)) have[perOf.get(+id)!] = (have[perOf.get(+id)!] ?? 0) + 1;
const byPer = new Map<string, typeof rows>();
for (const r of rows) if (!kept[r.id]) (byPer.get(r.per) ?? byPer.set(r.per, []).get(r.per)!).push(r);
const sample: { id: number; path: string; per: string }[] = [];
for (const [per, list] of byPer) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  for (const x of a.slice(0, Math.max(0, PER - (have[per] ?? 0)))) {
    const f = relOf.get(x.id)!;
    sample.push({ id: x.id, per, path: path.join(roots.get(f.root_id)!, f.rel_path) });
  }
}
const srv = (p: string) => pathToFileURL(path.join(REPO, 'apps/server/src', p)).href;
const { config } = await import(srv('config.ts'));
const { startTagger } = await import(srv('services/tagger/client.ts'));
const { ensureModelFiles } = await import(srv('services/tagger/download.ts'));
const { clampBatch, findModel } = await import(srv('services/tagger/models.ts'));
const { pickRating } = await import(srv('services/tagger/postprocess.ts'));
const spec = findModel('SmilingWolf/wd-eva02-large-tagger-v3')!;
const { modelPath, labelsPath } = await ensureModelFiles(spec, config.modelsDir, { log: console.log });
const client = await startTagger({ repo: spec.repo, modelPath, labelsPath, device: 'dml', batchSize: clampBatch(spec, 'dml', 8), modelsDir: config.modelsDir });
console.log(`要重打 ${sample.length} 张（保留上次的 ${Object.keys(kept).length} 张）`);
if (!sample.length) process.exit(0);
const res: Record<string, Entry> = { ...kept };
const t0 = Date.now();
for (let i = 0; i < sample.length; i += client.batchSize) {
  const batch = sample.slice(i, i + client.batchSize);
  for (const r of await client.tag(batch.map((b) => ({ id: b.id, path: b.path })), { general: 0.5, character: 0.99 })) {
    if (!r.ok) continue;
    res[r.id] = { per: batch.find((b) => b.id === r.id)!.per, rating: r.rating ? pickRating(r.rating) : 'general', tags: r.general.map(([n]: [string, number]) => n) };
  }
  if ((i / client.batchSize) % 50 === 0) console.log(`${i + batch.length}/${sample.length} · ${((i + batch.length) / ((Date.now() - t0) / 1000)).toFixed(1)} 张/秒`);
}
writeFileSync(path.join(out, 'wd-sample.json'), JSON.stringify(res));
console.log('完成', Object.keys(res).length);
await client.shutdown?.();
process.exit(0);
