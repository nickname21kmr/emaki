/**
 * 写操作测速（P2 变更传播前后对比用）：在合成的图库上用 app.inject 跑常见的修改和撤销，打印 p50 / p95 / max。
 * 不需要真实库：每次运行都在临时目录里新建一个库，灌入合成数据（默认 3 万张图），跑完删掉。
 *
 *   npx tsx apps/server/scripts/bench-mutations.ts [--images 30000] [--runs 7]
 *
 * 每个场景：执行一次修改、再撤销（两者分别计时），这样每轮开始时库的状态一样。
 * 不走网络、不开后台任务（autoJobs: false），不碰真实的图库文件。
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
const IMAGES = flag('--images', 30_000);
const RUNS = flag('--runs', 7);
const PER_DIR = 25;
const CHARACTERS = 300;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

process.env.EMAKI_LOG_LEVEL ??= 'warn';

/** 合成数据：一个图库文件夹，IMAGES 张图分在每个 25 张的文件夹里；三分之一的文件夹像本子（成册），其余是普通文件夹 */
function seed(db: Db): void {
  db.prepare("INSERT INTO library_roots (id, path, last_scan_at, imported_at) VALUES (1, '//emaki-bench/lib', ?, ?)").run(
    new Date(T0).toISOString(),
    new Date(T0).toISOString(),
  );
  const tx = db.transaction(() => {
    const work = db.prepare("INSERT INTO works (id, name, danbooru_tag, created_at) VALUES (?, ?, ?, '2026-01-01')");
    for (let w = 1; w <= 20; w++) work.run(w, `作品${w}`, `work_${w}`);
    const ch = db.prepare("INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (?, ?, ?, 'danbooru', '2026-01-01')");
    const cw = db.prepare('INSERT INTO character_works (character_id, work_id, position) VALUES (?, ?, 0)');
    for (let c = 1; c <= CHARACTERS; c++) {
      ch.run(c, `角色${c}`, `char_${c}_(work_${(c % 20) + 1})`);
      cw.run(c, (c % 20) + 1);
    }
    const tag = db.prepare("INSERT INTO tags (id, name, category) VALUES (?, ?, 'general')");
    for (let t = 1; t <= 50; t++) tag.run(t, `tag_${t}`);
    const img = db.prepare(
      `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
         content_kind, content_kind_source, tagged_at, rating, dhash)
       VALUES (@id, 1, @rel, @name, 1200, 1700, 100000, 'png', @sha, @at, @at, 'illustration', 'default', @at, 'general', @dhash)`,
    );
    const it = db.prepare('INSERT OR IGNORE INTO image_tags (image_id, tag_id, score) VALUES (?, ?, 0.8)');
    // 迁移 034 之前的库没有来历列：同一个脚本也能在旧版本上跑（前后对比）
    const provenance = (db.prepare("SELECT name FROM pragma_table_info('image_characters')").pluck().all() as string[]).includes('decision');
    const ic = provenance
      ? db.prepare(
          `INSERT INTO image_characters (image_id, character_id, decision, actor, rule, evidence_provider, evidence_score, added_at)
           VALUES (?, ?, 'auto', 'job:tag', 'auto-accept@1', 'tagger', 0.9, ?)`,
        )
      : db.prepare("INSERT INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, 'tagger', 0.9, ?)");
    for (let id = 1; id <= IMAGES; id++) {
      const dir = Math.floor((id - 1) / PER_DIR);
      const book = dir % 3 === 0;
      const folder = book ? `books/[サークル${dir}] 本子${dir}` : `pics/folder${dir}`;
      const name = book ? `${String(((id - 1) % PER_DIR) + 1).padStart(3, '0')}.png` : `img_${id}.png`;
      const at = new Date(T0 - id * 60_000).toISOString();
      img.run({ id, rel: `${folder}/${name}`, name, sha: `sha${id}`, at, dhash: (id * 2654435761 % 2 ** 32).toString(16).padStart(16, '0') });
      it.run(id, (id % 50) + 1);
      it.run(id, ((id * 7) % 50) + 1);
      if (id % 4 !== 0) ic.run(id, (id % CHARACTERS) + 1, at);
    }
    // 两条排除规则：一个标签、一个角色
    db.prepare("INSERT INTO exclusions (kind, target, label, created_at) VALUES ('tag', 'tag_50', '标签 · tag_50', '2026-01-01')").run();
    db.prepare("INSERT INTO exclusions (kind, target, label, created_at) VALUES ('character', '300', '角色 · 角色300', '2026-01-01')").run();
  });
  tx();
}

const dir = mkdtempSync(path.join(tmpdir(), 'emaki-bench-mut-'));
const bus = new EventBus();
const tOpen = performance.now();
const ds = await SqliteDataSource.open(bus, dir, { autoJobs: false, importDict: false, seed });
// 灌进来的规则还没套到图上：建一条再撤销，等于全量套一遍
{
  const db = ds.ctx.db;
  const rules = db.prepare('SELECT id, kind, target FROM exclusions').all() as { id: number; kind: string; target: string }[];
  for (const r of rules) {
    if (r.kind === 'tag')
      db.prepare(
        'UPDATE images SET excluded_by = ? WHERE excluded_by IS NULL AND EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = images.id AND t.name = ?)',
      ).run(r.id, r.target);
    else
      db.prepare(
        'UPDATE images SET excluded_by = ? WHERE excluded_by IS NULL AND EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = images.id AND ic.character_id = ?)',
      ).run(r.id, Number(r.target));
  }
}
const openMs = performance.now() - tOpen;
const app = await buildApp(ds, bus);
const db = ds.ctx.db;

type Res = { ok: boolean; undoToken: string | null };
async function call(method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<Res> {
  const r = await app.inject({ method, url, payload: payload as object });
  if (r.statusCode !== 200) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body.slice(0, 300)}`);
  return r.json() as Res;
}
async function undo(token: string | null): Promise<void> {
  if (!token) throw new Error('没有撤销令牌');
  await call('POST', `/api/undo/${token}`, {});
}

/** 可见、没被排除的图（在合集外的普通文件夹里），取 n 张 */
const pick = (n: number, offset = 0) =>
  (
    db
      .prepare(
        `SELECT i.id FROM v_images i WHERE i.excluded_by IS NULL AND i.rel_path LIKE 'pics/%' ORDER BY i.id LIMIT ? OFFSET ?`,
      )
      .pluck()
      .all(n, offset) as number[]
  ).map(String);
/** 本子里的页 */
const pickBook = (n: number) =>
  (db.prepare(`SELECT i.id FROM v_images i WHERE i.excluded_by IS NULL AND i.rel_path LIKE 'books/%' ORDER BY i.id LIMIT ?`).pluck().all(n) as number[]).map(String);

const ids1000 = pick(1000);
const ids1000b = pick(1000, 1000);
const book200 = pickBook(200);
const single = ids1000[0]!;

type Scenario = { name: string; run: () => Promise<Res> };
const scenarios: Scenario[] = [
  { name: '批量归类 1000 张（按角色）', run: () => call('POST', '/api/images/bulk', { ids: ids1000, action: { type: 'assign', characterId: '7' } }) },
  { name: '批量改类型 1000 张', run: () => call('POST', '/api/images/bulk', { ids: ids1000, action: { type: 'kind', value: 'comic' } }) },
  { name: '本子页改类型 200 张', run: () => call('POST', '/api/images/bulk', { ids: book200, action: { type: 'kind', value: 'screenshot' } }) },
  { name: '单张改类型', run: () => call('PATCH', `/api/images/${single}`, { kind: 'photo' }) },
  { name: '单张收藏', run: () => call('PATCH', `/api/images/${single}`, { favorite: true }) },
  { name: '单张整组替换角色', run: () => call('PATCH', `/api/images/${single}`, { characterIds: ['5', '6'] }) },
  { name: '批量排除 1000 张', run: () => call('POST', '/api/images/bulk', { ids: ids1000, action: { type: 'exclude' } }) },
  { name: '排除单张', run: () => call('POST', '/api/images/bulk', { ids: [single], action: { type: 'exclude' } }) },
  { name: '新建排除规则（标签）', run: () => call('POST', '/api/exclusions', { kind: 'tag', target: 'tag_3' }) },
  { name: '新建排除规则（角色）', run: () => call('POST', '/api/exclusions', { kind: 'character', target: '11' }) },
];

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]!;
const fmt = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toString());
console.log(`库：${IMAGES} 张图（${Math.ceil(IMAGES / PER_DIR)} 个文件夹）、${CHARACTERS} 个角色；打开 ${Math.round(openMs)} ms；每个场景 ${RUNS} 轮（另预热 1 轮）`);
console.log(['场景', '执行 p50', 'p95', 'max', '撤销 p50', 'p95', 'max'].join('\t'));
for (const s of scenarios) {
  const doMs: number[] = [];
  const undoMs: number[] = [];
  for (let i = 0; i <= RUNS; i++) {
    const t0 = performance.now();
    const r = await s.run();
    const t1 = performance.now();
    await undo(r.undoToken);
    const t2 = performance.now();
    if (i === 0) continue; // 预热
    doMs.push(t1 - t0);
    undoMs.push(t2 - t1);
  }
  console.log([s.name, fmt(pct(doMs, 0.5)), fmt(pct(doMs, 0.95)), fmt(Math.max(...doMs)), fmt(pct(undoMs, 0.5)), fmt(pct(undoMs, 0.95)), fmt(Math.max(...undoMs))].join('\t'));
}
// 先把 1000 张归到一个角色（不计时），测从这个角色移出和移出的撤销（以前这个场景移出的角色几乎不在这些图上，测的是空操作）
{
  const doMs: number[] = [];
  const undoMs: number[] = [];
  for (let i = 0; i <= RUNS; i++) {
    const as = await call('POST', '/api/images/bulk', { ids: ids1000b, action: { type: 'assign', characterId: '8' } });
    const t0 = performance.now();
    const r = await call('POST', '/api/images/bulk', { ids: ids1000b, action: { type: 'unassign', characterId: '8' } });
    const t1 = performance.now();
    await undo(r.undoToken);
    const t2 = performance.now();
    await undo(as.undoToken);
    if (i === 0) continue;
    doMs.push(t1 - t0);
    undoMs.push(t2 - t1);
  }
  console.log(['批量移出角色 1000 张', fmt(pct(doMs, 0.5)), fmt(pct(doMs, 0.95)), fmt(Math.max(...doMs)), fmt(pct(undoMs, 0.5)), fmt(pct(undoMs, 0.95)), fmt(Math.max(...undoMs))].join('\t'));
}
// 排除之后再恢复（restore）：先排除一次不计时，测恢复和恢复的撤销
{
  const doMs: number[] = [];
  const undoMs: number[] = [];
  for (let i = 0; i <= RUNS; i++) {
    const ex = await call('POST', '/api/images/bulk', { ids: ids1000b, action: { type: 'exclude' } });
    const t0 = performance.now();
    const r = await call('POST', '/api/images/bulk', { ids: ids1000b, action: { type: 'restore' } });
    const t1 = performance.now();
    await undo(r.undoToken);
    const t2 = performance.now();
    await undo(ex.undoToken);
    if (i === 0) continue;
    doMs.push(t1 - t0);
    undoMs.push(t2 - t1);
  }
  console.log(['恢复排除 1000 张', fmt(pct(doMs, 0.5)), fmt(pct(doMs, 0.95)), fmt(Math.max(...doMs)), fmt(pct(undoMs, 0.5)), fmt(pct(undoMs, 0.95)), fmt(Math.max(...undoMs))].join('\t'));
}

await app.close();
await ds.close();
rmSync(dir, { recursive: true, force: true });
