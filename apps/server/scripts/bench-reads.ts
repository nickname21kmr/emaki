/**
 * 读的测速（P5 读模型前后对比用）：在合成的图库上用 app.inject 请求统计、汇总、列表、未识别，打印「缓存冷」和「缓存热」的 p50 / p95。
 * 不需要真实库：每次运行都在临时目录里新建一个库，灌入合成数据（默认 10 万张图），跑完删掉。
 *
 *   npx tsx apps/server/scripts/bench-reads.ts [--images 100000] [--runs 9]
 *
 * 冷：每次请求前把结果缓存全部清掉（等于刚做完一次用户操作）；热：连着请求。
 * 合成数据：四分之一的图没有角色（一半还没识别）；三分之一的文件夹像本子（成册）；一成漫画、一成截图等；一个漫画子文件夹。
 * 旧版本没有的接口（/api/summary）跳过，同一份脚本能在改前的代码上跑。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildApp } from '../src/app.ts';
import { EventBus } from '../src/core/events.ts';
import { SqliteDataSource } from '../src/datasource/sqlite/SqliteDataSource.ts';
import type { Db } from '../src/db/connection.ts';

const args = process.argv.slice(2);
const flag = (name: string, d: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const IMAGES = flag('--images', 100_000);
const RUNS = flag('--runs', 9);
const PER_DIR = 25;
const CHARACTERS = 500;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

process.env.EMAKI_LOG_LEVEL ??= 'warn';

function seed(db: Db): void {
  db.prepare("INSERT INTO library_roots (id, path, last_scan_at, imported_at) VALUES (1, '//emaki-bench/lib', ?, ?)").run(
    new Date(T0).toISOString(),
    new Date(T0).toISOString(),
  );
  db.prepare("INSERT INTO comic_folders (root_id, rel_dir, created_at) VALUES (1, 'manga', '2026-01-01')").run();
  db.transaction(() => {
    const work = db.prepare("INSERT INTO works (id, name, danbooru_tag, created_at) VALUES (?, ?, ?, '2026-01-01')");
    for (let w = 1; w <= 30; w++) work.run(w, `作品${w}`, `work_${w}`);
    const ch = db.prepare("INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (?, ?, ?, 'danbooru', '2026-01-01')");
    const cw = db.prepare('INSERT INTO character_works (character_id, work_id, position) VALUES (?, ?, 0)');
    for (let c = 1; c <= CHARACTERS; c++) {
      ch.run(c, `角色${c}`, `char_${c}`);
      cw.run(c, (c % 30) + 1);
    }
    const img = db.prepare(
      `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
         content_kind, content_kind_source, tagged_at, rating)
       VALUES (@id, 1, @rel, @name, 1200, 1700, 100000, 'png', @sha, @at, @at, @kind, 'default', @tagged, @rating)`,
    );
    const ic = db.prepare(
      `INSERT INTO image_characters (image_id, character_id, decision, actor, rule, evidence_provider, evidence_score, added_at)
       VALUES (?, ?, 'auto', 'job:tag', 'auto-accept@2', 'tagger', 0.9, ?)`,
    );
    // 七成插画，漫画、截图、表情各一成
    const KINDS = [...Array<string>(7).fill('illustration'), 'comic', 'screenshot', 'meme'];
    for (let id = 1; id <= IMAGES; id++) {
      const dir = Math.floor((id - 1) / PER_DIR);
      const folder = dir % 3 === 0 ? `books/本子${dir}` : dir % 41 === 0 ? `manga/卷${dir}` : `pics/folder${dir}`;
      const at = new Date(T0 - id * 60_000).toISOString();
      const unrecognized = id % 4 === 0;
      img.run({
        id,
        rel: `${folder}/${String(id).padStart(6, '0')}.png`,
        name: `${String(id).padStart(6, '0')}.png`,
        sha: `sha${id}`,
        at,
        kind: KINDS[id % KINDS.length],
        tagged: unrecognized && id % 8 === 0 ? null : at,
        rating: id % 13 === 0 ? 'questionable' : 'general',
      });
      if (!unrecognized) ic.run(id, (id % CHARACTERS) + 1, at);
    }
  })();
}

const dir = mkdtempSync(path.join(tmpdir(), 'emaki-bench-reads-'));
const bus = new EventBus();
const ds = await SqliteDataSource.open(bus, dir, { autoJobs: false, importDict: false, seed });
const app = await buildApp(ds, bus);

/** 清掉全部结果缓存（统计、汇总、未识别、派生的角色 / 作品），和用户操作之后一样 */
const coldAll = () => {
  const x = ds as unknown as Record<string, { invalidate?: (soft?: boolean) => void }>;
  for (const k of ['results', 'unrecognized', 'derived']) x[k]?.invalidate?.(false);
};

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  if (res.statusCode !== 200) throw new Error(`${url} → ${res.statusCode} ${res.body.slice(0, 200)}`);
};
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]!;
const fmt = (n: number) => (n < 10 ? n.toFixed(1) : n.toFixed(0));

const scenarios: [string, string][] = [
  ['统计 /api/stats', '/api/stats'],
  ['汇总 /api/summary', '/api/summary'],
  ['图库首页（只看插画）', '/api/images?limit=120&kind=illustration'],
  ['全部类型首页', '/api/images?limit=120'],
  ['未识别的图（status）', '/api/images?limit=120&status=unrecognized'],
  ['未识别汇总', '/api/unrecognized/summary'],
  ['未识别「有建议」首页', '/api/unrecognized?area=art&bucket=suggested&limit=60'],
  ['未识别「没认出」首页', '/api/unrecognized?area=art&bucket=unsure&limit=120'],
  ['作品列表', '/api/works'],
];

console.log(`合成图库 ${IMAGES} 张；每个场景 ${RUNS} 次（毫秒，p50 / p95）`);
console.log('| 场景 | 冷 p50 | 冷 p95 | 热 p50 |');
console.log('| --- | ---: | ---: | ---: |');
for (const [name, url] of scenarios) {
  if (!app.hasRoute({ method: 'GET', url: url.split('?')[0]! })) {
    console.log(`| ${name} | — | — | — |`);
    continue;
  }
  await get(url);
  const cold: number[] = [];
  const warm: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    coldAll();
    let t = performance.now();
    await get(url);
    cold.push(performance.now() - t);
    t = performance.now();
    await get(url);
    warm.push(performance.now() - t);
  }
  console.log(`| ${name} | ${fmt(pct(cold, 0.5))} | ${fmt(pct(cold, 0.95))} | ${fmt(pct(warm, 0.5))} |`);
}

await app.close();
await ds.close();
rmSync(dir, { recursive: true, force: true });
