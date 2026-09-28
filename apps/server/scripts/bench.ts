/**
 * T22 测速：在一个库目录上（真实库的快照，见 docs/PERF.md）用 app.inject 请求各个接口，
 * 每个场景预热 5 次、测 50 次，打印 p50 / p95 / max / 预算；任一 p95 超预算时退出码 1。
 *
 *   npx tsx apps/server/scripts/bench.ts F:/Claude/emaki/data/perf [--runs 50] [--only images]
 *
 * 不走网络、不开后台任务（autoJobs: false），库目录里的数据库会被迁移到最新版本。
 */
import { performance } from 'node:perf_hooks';
import { buildApp } from '../src/app.ts';
import { EventBus } from '../src/core/events.ts';
import { SqliteDataSource } from '../src/datasource/sqlite/SqliteDataSource.ts';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) throw new Error('用法：bench.ts <数据目录> [--runs 50] [--only 关键字]');
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const RUNS = Number(flag('--runs') ?? 50);
const ONLY = flag('--only');
const WARM = 5;

process.env.EMAKI_LOG_LEVEL ??= 'warn';
const bus = new EventBus();
const tOpen = performance.now();
const ds = await SqliteDataSource.open(bus, dir, { autoJobs: false });
const openMs = performance.now() - tOpen;
const app = await buildApp(ds, bus);
const db = ds.ctx.db;

/** 计时只算服务端：响应体不在这里解析（重复组一次 6 MB，解析比服务端还慢） */
const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  if (res.statusCode !== 200) throw new Error(`${url} → ${res.statusCode} ${res.body.slice(0, 200)}`);
  return res;
};

// ---------------------------------------------------------------- 场景用到的 id：从库里挑最大的
const one = (sql: string) => String(db.prepare(sql).pluck().get());
const topChar = one(`SELECT character_id FROM image_characters GROUP BY character_id ORDER BY count(*) DESC LIMIT 1`);
const topWork = one(
  `SELECT cw.work_id FROM character_works cw JOIN image_characters ic ON ic.character_id = cw.character_id GROUP BY cw.work_id ORDER BY count(*) DESC LIMIT 1`,
);
const someImage = one(`SELECT id FROM images WHERE trashed_at IS NULL AND missing = 0 ORDER BY id DESC LIMIT 1`);

/** 沿 nextCursor 翻 n 页，返回第 n+1 页的 url */
async function deepUrl(base: string, pages: number) {
  let cursor: string | null | undefined;
  for (let i = 0; i < pages; i++) {
    const r = (await get(`${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json() as { nextCursor: string | null };
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return `${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
}

const L = 'limit=120';
type Scenario = { name: string; budget: number; url: string | (() => Promise<string>) };
const scenarios: Scenario[] = [
  { name: 'images 首页', budget: 60, url: `/api/images?${L}` },
  { name: 'images 深翻页（30 页后）', budget: 60, url: () => deepUrl(`/api/images?${L}`, 30) },
  { name: 'images 最大角色', budget: 60, url: `/api/images?${L}&characterId=${topChar}` },
  { name: 'images 最大作品', budget: 80, url: `/api/images?${L}&workId=${topWork}` },
  { name: 'images rating=explicit', budget: 60, url: `/api/images?${L}&rating=explicit` },
  { name: 'images 横图', budget: 60, url: `/api/images?${L}&orientation=landscape` },
  { name: 'images 收藏', budget: 60, url: `/api/images?${L}&favorite=true` },
  { name: 'images q=girl', budget: 100, url: `/api/images?${L}&q=girl` },
  { name: 'images 画面=腿·足', budget: 100, url: `/api/images?${L}&theme=legs` },
  { name: 'images 未识别', budget: 60, url: `/api/images?${L}&status=unrecognized` },
  { name: 'images 全部类型', budget: 60, url: `/api/images?${L}&kind=all` },
  { name: 'images 截图', budget: 60, url: `/api/images?${L}&kind=screenshot` },
  { name: 'images sort=fileName', budget: 60, url: `/api/images?${L}&sort=fileName` },
  { name: 'images sort=bytes asc', budget: 60, url: `/api/images?${L}&sort=bytes&order=asc` },
  { name: 'images random', budget: 60, url: `/api/images?${L}&sort=random&seed=7` },
  { name: 'image 详情', budget: 30, url: `/api/images/${someImage}` },
  { name: 'characters 首页', budget: 50, url: '/api/characters?limit=60' },
  { name: 'characters q=mi', budget: 50, url: '/api/characters?limit=60&q=mi' },
  { name: 'characters 最近在收', budget: 50, url: '/api/characters?limit=60&workId=recent' },
  { name: 'characters top', budget: 50, url: '/api/characters/top?limit=9' },
  { name: 'character 详情', budget: 50, url: `/api/characters/${topChar}` },
  { name: 'works', budget: 30, url: '/api/works' },
  { name: 'works sort=recent', budget: 30, url: '/api/works?sort=recent' },
  { name: 'work 详情', budget: 30, url: `/api/works/${topWork}` },
  { name: 'stats', budget: 50, url: '/api/stats' },
  { name: 'content-kinds', budget: 50, url: '/api/content-kinds' },
  { name: 'unrecognized 首页', budget: 80, url: '/api/unrecognized?limit=60' },
  { name: 'unrecognized 汇总', budget: 80, url: '/api/unrecognized/summary' },
  { name: 'unrecognized 没认出', budget: 80, url: '/api/unrecognized?limit=60&bucket=untagged' },
  { name: 'unrecognized 别册', budget: 80, url: '/api/unrecognized?limit=60&area=annex' },
  { name: 'duplicates', budget: 80, url: '/api/duplicates?limit=20' },
  { name: 'exclusions', budget: 50, url: '/api/exclusions' },
  { name: 'collections', budget: 50, url: '/api/collections' },
  { name: 'search q=mi', budget: 30, url: '/api/search?q=mi' },
  { name: 'search q=明日方舟', budget: 30, url: '/api/search?q=%E6%98%8E%E6%97%A5%E6%96%B9%E8%88%9F' },
];

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]!;
const rows: { name: string; p50: number; p95: number; max: number; budget: number; first: number }[] = [];

for (const s of scenarios) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  const url = typeof s.url === 'string' ? s.url : await s.url();
  const t0 = performance.now();
  await get(url);
  const first = performance.now() - t0;
  for (let i = 0; i < WARM - 1; i++) await get(url);
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await get(url);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  rows.push({ name: s.name, p50: pct(times, 0.5), p95: pct(times, 0.95), max: times.at(-1)!, budget: s.budget, first });
}

// ---------------------------------------------------------------- 修改后的第一个请求（派生缓存重建）
const after: { name: string; ms: number; budget: number }[] = [];
if (!ONLY || 'PATCH'.includes(ONLY)) {
  for (const [name, url] of [
    ['PATCH 后 characters', '/api/characters?limit=60'],
    ['PATCH 后 stats', '/api/stats'],
    ['PATCH 后 images', `/api/images?${L}`],
    ['PATCH 后 works', '/api/works'],
  ] as const) {
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'PATCH', url: `/api/images/${someImage}`, payload: { favorite: i % 2 === 0 } });
      if (r.statusCode !== 200) throw new Error(`PATCH → ${r.statusCode}`);
      const t = performance.now();
      await get(url);
      ms.push(performance.now() - t);
    }
    ms.sort((a, b) => a - b);
    after.push({ name, ms: ms[Math.floor(ms.length / 2)]!, budget: 500 });
  }
  // 还原收藏状态：上面最后一次是 favorite=true（i=4），原值在第一次之前
}

const f = (n: number) => n.toFixed(1).padStart(7);
console.log(`\n库：${dir}（打开 ${openMs.toFixed(0)} ms）`);
console.log(`${'场景'.padEnd(26)}   首次     p50     p95     max   预算`);
let bad = 0;
for (const r of rows) {
  const over = r.p95 > r.budget;
  if (over) bad++;
  console.log(`${r.name.padEnd(26)} ${f(r.first)} ${f(r.p50)} ${f(r.p95)} ${f(r.max)} ${String(r.budget).padStart(6)}${over ? '  ✗ 超预算' : ''}`);
}
for (const r of after) {
  const over = r.ms > r.budget;
  if (over) bad++;
  console.log(`${r.name.padEnd(26)} ${f(r.ms)}  （中位数，5 次）             ${String(r.budget).padStart(6)}${over ? '  ✗ 超预算' : ''}`);
}
// 用 node --expose-gc 跑时先回收一次，内存数才接近常驻水平
(globalThis as { gc?: () => void }).gc?.();
const mem = process.memoryUsage();
console.log(`\n内存：rss ${(mem.rss / 1048576).toFixed(0)} MB · heap ${(mem.heapUsed / 1048576).toFixed(0)} MB`);
console.log(bad ? `\n${bad} 项超预算` : '\n全部在预算内');
process.exitCode = bad ? 1 : 0;
await app.close();
await ds.close?.();
