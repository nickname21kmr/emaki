/**
 * 识别写入测速（P3a、P3b 前后对比用）：在合成的图库上，把 1,000 张图的识别结果交给 TagResultWriter 写库，打印 p50 / p95 / max。
 * 和识别任务一样每批写完调 declareTagged（变更传播：自动决定 reevaluateAuto、排除规则、Pixiv 排队、合集等反应）。
 * 不需要真实库、不需要模型：每次运行都在临时目录里新建一个库，灌入合成数据（默认 3 万张图），跑完删掉。
 *
 *   npx tsx apps/server/scripts/bench-tagging.ts [--images 30000] [--runs 5] [--batch 8]
 *
 * 每轮先把这 1,000 张恢复成「没识别、没角色」（不计时），再按 --batch 张一批写完（识别任务默认一批 8 张），另测一次 1,000 张一批。
 * 每张图的结果：两个通用标签；一个已有角色 0.92（自动关联）、一个已有角色 0.5（建议）；每 10 张有一张本来就手动归了那个角色，
 * 每 25 张有一张用户去掉过（否决）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { EventBus } from '../src/core/events.ts';
import { SqliteDataSource } from '../src/datasource/sqlite/SqliteDataSource.ts';
import type { Db } from '../src/db/connection.ts';
import { declareTagged } from '../src/domain/evidence/reactions.ts';
import { TagResultWriter } from '../src/domain/evidence/tagger.ts';
import type { HostItemResult } from '../src/services/tagger/protocol.ts';

const args = process.argv.slice(2);
const flag = (name: string, d: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const IMAGES = flag('--images', 30_000);
const RUNS = flag('--runs', 5);
const BATCH = flag('--batch', 8);
const TARGET = 1000;
const CHARACTERS = 300;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

process.env.EMAKI_LOG_LEVEL ??= 'warn';

/** 迁移 035 之后有证据表 */
const hasEvidence = (db: Db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'character_evidence'").get();
/** 迁移 034 之前的库没有来历列：同一个脚本也能在旧版本上跑（前后对比） */
const hasProvenance = (db: Db) => (db.prepare("SELECT name FROM pragma_table_info('image_characters')").pluck().all() as string[]).includes('decision');

function seed(db: Db): void {
  db.prepare("INSERT INTO library_roots (id, path, last_scan_at, imported_at) VALUES (1, '//emaki-bench/lib', ?, ?)").run(
    new Date(T0).toISOString(),
    new Date(T0).toISOString(),
  );
  const ic = hasProvenance(db)
    ? db.prepare(
        `INSERT INTO image_characters (image_id, character_id, decision, actor, rule, evidence_provider, evidence_score, added_at)
         VALUES (?, ?, 'auto', 'job:tag', 'auto-accept@1', 'tagger', 0.9, ?)`,
      )
    : db.prepare("INSERT INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, 'tagger', 0.9, ?)");
  db.transaction(() => {
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
       VALUES (@id, 1, @rel, @name, 1200, 1700, 100000, 'png', @sha, @at, @at, 'illustration', 'default', @tagged, 'general', @dhash)`,
    );
    const it = db.prepare('INSERT OR IGNORE INTO image_tags (image_id, tag_id, score) VALUES (?, ?, 0.8)');
    for (let id = 1; id <= IMAGES; id++) {
      const at = new Date(T0 - id * 60_000).toISOString();
      const target = id <= TARGET;
      img.run({ id, rel: `pics/folder${Math.floor((id - 1) / 25)}/img_${id}.png`, name: `img_${id}.png`, sha: `sha${id}`, at, tagged: target ? null : at, dhash: (id * 2654435761 % 2 ** 32).toString(16).padStart(16, '0') });
      if (target) continue;
      it.run(id, (id % 50) + 1);
      if (id % 4 !== 0) ic.run(id, (id % CHARACTERS) + 1, at);
    }
    db.prepare("INSERT INTO exclusions (kind, target, label, created_at) VALUES ('tag', 'tag_50', '标签 · tag_50', '2026-01-01')").run();
    db.prepare("INSERT INTO exclusions (kind, target, label, created_at) VALUES ('character', '300', '角色 · 角色300', '2026-01-01')").run();
  })();
}

const dir = mkdtempSync(path.join(tmpdir(), 'emaki-bench-tag-'));
const ds = await SqliteDataSource.open(new EventBus(), dir, { autoJobs: false, importDict: false, seed });
const db = ds.ctx.db;
const provenance = hasProvenance(db);

const charTag = (c: number) => `char_${c}_(work_${(c % 20) + 1})`;
const autoChar = (id: number) => (id % (CHARACTERS - 1)) + 1;
const results: HostItemResult[] = [];
for (let id = 1; id <= TARGET; id++) {
  results.push({
    id,
    ok: true,
    rating: { general: 0.7, sensitive: 0.2, questionable: 0.05, explicit: 0.05 },
    general: [['1girl', 0.95], [`tag_${(id % 49) + 1}`, 0.7], [`tag_${((id * 7) % 49) + 1}`, 0.6]],
    character: [[charTag(autoChar(id)), 0.92], [charTag(((id + 37) % (CHARACTERS - 1)) + 1), 0.5]],
  });
}

/** 恢复成「没识别、没角色」，再放上手动关联和否决 */
function reset(): void {
  db.transaction(() => {
    const ids = `SELECT value FROM json_each('${JSON.stringify(results.map((r) => r.id))}')`;
    db.exec(`DELETE FROM image_characters WHERE image_id IN (${ids})`);
    // 迁移 035 之后建议是派生的，删的是证据
    db.exec(`DELETE FROM ${hasEvidence(db) ? 'character_evidence' : 'character_suggestions'} WHERE image_id IN (${ids})`);
    db.exec(`DELETE FROM character_vetoes WHERE image_id IN (${ids})`);
    db.exec(`DELETE FROM image_tags WHERE image_id IN (${ids})`);
    db.exec(`DELETE FROM pixiv_character_checks WHERE image_id IN (${ids})`);
    db.exec(`UPDATE images SET tagged_at = NULL, excluded_by = NULL WHERE id IN (${ids})`);
    const manual = provenance
      ? db.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (?, ?, 'manual', 'user', '2026-01-01')")
      : db.prepare("INSERT INTO image_characters (image_id, character_id, origin, added_at) VALUES (?, ?, 'manual', '2026-01-01')");
    const veto = db.prepare("INSERT INTO character_vetoes (image_id, character_id, created_at) VALUES (?, ?, '2026-01-01')");
    for (let id = 1; id <= TARGET; id++) {
      if (id % 10 === 0) manual.run(id, autoChar(id));
      else if (id % 25 === 1) veto.run(id, autoChar(id));
    }
  })();
}

function writeAll(batch: number): number {
  const { catalog, copyrights } = ds.makeCatalog();
  const writer = new TagResultWriter(db, catalog, copyrights, {
    repo: 'bench/model',
    generalThreshold: 0.35,
    // 和 SqliteDataSource 给识别任务接的一样（旧版本只收第一个参数）；P3b 起自动关联由反应 reevaluateAuto 按设置里的阈值做
    afterBatchInTx: (ids, changes) => declareTagged(ds.ctx, ids, changes),
  });
  const t0 = performance.now();
  for (let i = 0; i < results.length; i += batch) writer.writeBatch(results.slice(i, i + batch));
  const ms = performance.now() - t0;
  if (writer.stats.linked < TARGET * 0.8) throw new Error(`关联数不对：${writer.stats.linked}`);
  return ms;
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]!;
const fmt = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toString());
console.log(`库：${IMAGES} 张图、${CHARACTERS} 个角色；${provenance ? '有' : '没有'}来历列；写 ${TARGET} 张，每个场景 ${RUNS} 轮（另预热 1 轮）`);
console.log(['场景', 'p50', 'p95', 'max'].join('\t'));
for (const batch of [BATCH, TARGET]) {
  const ms: number[] = [];
  for (let i = 0; i <= RUNS; i++) {
    reset();
    const t = writeAll(batch);
    if (i > 0) ms.push(t);
  }
  console.log([`识别写入 ${TARGET} 张（每批 ${batch} 张）`, fmt(pct(ms, 0.5)), fmt(pct(ms, 0.95)), fmt(Math.max(...ms))].join('\t'));
}

await ds.close();
rmSync(dir, { recursive: true, force: true });
