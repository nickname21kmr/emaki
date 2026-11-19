/**
 * 扫描测速（P4a 前后对比用）：在临时目录里造一个图库（默认 3,000 张小 PNG，分在 30 个文件夹里），用真实引擎扫描，
 * 依次测四种扫描：首次入库、一成文件内容变了、一成文件挪了位置、什么都没变。打印每次的耗时（毫秒）。
 * 不需要真实库：每次运行都新建库和图片，跑完删掉。后台任务关着（autoJobs: false），只测扫描本身和它在事务里触发的反应。
 *
 *   npx tsx apps/server/scripts/bench-scan.ts [--images 3000] [--runs 3]
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { EventBus } from '../src/core/events.ts';
import type { JobContext } from '../src/core/jobs.ts';
import { SqliteDataSource } from '../src/datasource/sqlite/SqliteDataSource.ts';

const args = process.argv.slice(2);
const flag = (name: string, d: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const IMAGES = flag('--images', 3000);
const RUNS = flag('--runs', 3);
const DIRS = 30;

process.env.EMAKI_LOG_LEVEL ??= 'warn';
process.env.EMAKI_SCAN_CONCURRENCY ??= '2';

const job = (): JobContext => ({
  signal: new AbortController().signal,
  setTotal() {},
  advance() {},
  setMessage() {},
  shouldYield: () => false,
  requeue() {},
  yielded: false,
});

/** 第 i 张图的内容：颜色按 i 和版本变，每张都不一样 */
async function png(i: number, version: number): Promise<Buffer> {
  const c = (i * 2654435761 + version * 40503) >>> 0;
  return sharp({ create: { width: 48, height: 64, channels: 3, background: { r: c & 255, g: (c >> 8) & 255, b: (c >> 16) & 255 } } })
    .png()
    .toBuffer();
}

const relOf = (i: number) => `dir${String(i % DIRS).padStart(2, '0')}/img_${String(i).padStart(6, '0')}.png`;

const results: Record<string, number[]> = { 首次入库: [], 内容变了: [], 挪了位置: [], 没有变化: [] };

for (let run = 0; run < RUNS; run++) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'emaki-bench-scan-'));
  const lib = path.join(tmp, 'library');
  try {
    for (let d = 0; d < DIRS; d++) mkdirSync(path.join(lib, `dir${String(d).padStart(2, '0')}`), { recursive: true });
    mkdirSync(path.join(lib, 'moved'), { recursive: true });
    // 文件时间放到一小时前：扫描不会当成「刚写入、可能还在写」而延后
    const old = new Date(Date.now() - 3600_000);
    for (let i = 0; i < IMAGES; i++) {
      const file = path.join(lib, relOf(i));
      writeFileSync(file, await png(i, 0));
      utimesSync(file, old, old);
    }
    const ds = await SqliteDataSource.open(new EventBus(), path.join(tmp, 'data'), { autoJobs: false, importDict: false });
    ds.ctx.db.prepare('INSERT INTO library_roots (path) VALUES (?)').run(lib.replace(/\\/g, '/'));
    const scan = async (label: string) => {
      ds.requests.requestFull();
      const t0 = performance.now();
      await ds.scanner.scan(job());
      ds.ctx.propagation.jobFinished('scan');
      results[label]!.push(performance.now() - t0);
    };
    await scan('首次入库');
    // 一成文件内容变了（同名、新内容、更早的时间）
    const older = new Date(Date.now() - 1800_000);
    for (let i = 0; i < IMAGES; i += 10) {
      const file = path.join(lib, relOf(i));
      writeFileSync(file, await png(i, 1));
      utimesSync(file, older, older);
    }
    await scan('内容变了');
    // 一成文件挪了位置（不同的十分之一）
    for (let i = 5; i < IMAGES; i += 10) renameSync(path.join(lib, relOf(i)), path.join(lib, 'moved', path.basename(relOf(i))));
    await scan('挪了位置');
    await scan('没有变化');
    const n = ds.ctx.db.prepare('SELECT COUNT(*) FROM images WHERE missing = 0').pluck().get();
    if (n !== IMAGES) throw new Error(`图片数不对：${String(n)}`);
    await ds.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
console.log(`扫描 ${IMAGES} 张（${DIRS} 个文件夹），${RUNS} 轮，p50 / max 毫秒：`);
for (const [k, xs] of Object.entries(results)) console.log(`  ${k}：${p50(xs).toFixed(0)} / ${Math.max(...xs).toFixed(0)}`);
