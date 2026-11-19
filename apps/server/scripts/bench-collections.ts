/**
 * 合集接口的测速：在和真实图库同样规模的合成数据上测合集页、「收进组图」弹窗实际发的那组请求（总耗时、响应大小），
 * 以及合集列表、单个合集（直接调用和经 HTTP）、统计里的合集计数，打印 p50 / p95。
 * 规模照 2026-11 一份真实库：3.6 万张图（计入统计约 3.56 万），3509 个「同一投稿」组图（每组 2–10 张）和 1 本按文件夹成册的本子，
 * 有合集的图约 1.75 万；1580 个角色、450 部作品，图 ↔ 角色约 2.57 万条（关联到角色的图约 2.09 万张）；原创图约 2800 张，
 * 作品证据约 2700 行、角色证据约 4800 行。
 *
 *   npx tsx apps/server/scripts/bench-collections.ts [--runs 7] [--save-base 文件] [--base 文件] [--dump 文件]
 *
 * - 每次在临时目录里新建库：先用当前代码的迁移建表，再按表结构灌数据（迁移 034 / 035 之前的库也认得，同一份脚本能在改前的代码上跑），
 *   ANALYZE 之后才打开引擎——合集由启动时的全量重算按投稿号和文件夹建出来，和真实图库一样。
 * - --save-base：把灌好数据、还没打开过的库另存一份；--base：不灌数据，用这份库（会被当前代码迁移），
 *   这样「同一份数据」可以先在改前的代码上灌、再交给改后的代码迁移后测。
 * - --dump：把列表和几个合集详情的结果写成 JSON（封面的 modifiedAt、详情的作品不写：前者是改后才有的字段，
 *   后者改后不再把模型给的作品算进来，附录 #8），用来核对前后结果一致。
 * 不走网络、不开后台任务，不碰真实的图库文件。
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildApp } from '../src/app.ts';
import { EventBus } from '../src/core/events.ts';
import { SqliteDataSource } from '../src/datasource/sqlite/SqliteDataSource.ts';
import { openDatabase, type Db } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const RUNS = Number(opt('--runs') ?? 7);
const IMAGES = 36_000;
const POSTS = 3509;
const CHARACTERS = 1580;
const WORKS = 450;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

process.env.EMAKI_LOG_LEVEL ??= 'warn';

/** 确定的伪随机：同一个 (a, b) 总是同一个数，两份代码灌出来的数据完全一样 */
const rnd = (a: number, b = 0) => {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** 每组的张数：2–10，多是小组（平均约 5 张） */
const POST_PAGES = [2, 2, 3, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10];

function seed(db: Db): void {
  const cols = (t: string) => db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(t) as string[];
  // 迁移 034（来历列）、035（证据和决定分开）之前的库：image_characters 是 origin / score，模型给的作品和建议在 image_copyrights / character_suggestions
  const provenance = cols('image_characters').includes('decision');
  const evidence = cols('work_evidence').length > 0;
  const at = (k: number) => new Date(T0 - k * 60_000).toISOString();
  db.prepare("INSERT INTO library_roots (id, path, last_scan_at, imported_at) VALUES (1, '//emaki-bench/lib', ?, ?)").run(at(0), at(0));
  db.transaction(() => {
    const work = db.prepare("INSERT INTO works (id, name, danbooru_tag, created_at) VALUES (?, ?, ?, '2026-01-01')");
    for (let w = 1; w <= WORKS; w++) work.run(w, `作品${w}`, w === 1 ? 'original' : `work_${w}`);
    const ch = db.prepare("INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (?, ?, ?, 'danbooru', '2026-01-01')");
    const cw = db.prepare('INSERT INTO character_works (character_id, work_id, position) VALUES (?, ?, ?)');
    for (let c = 1; c <= CHARACTERS; c++) {
      ch.run(c, `角色${c}`, `char_${c}`);
      cw.run(c, (c % (WORKS - 1)) + 2, 0);
      if (c % 10 === 0) cw.run(c, ((c * 7) % (WORKS - 1)) + 2, 1);
    }

    const img = db.prepare(
      `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
         content_kind, content_kind_source, tagged_at, rating, dominant_color, source_site, source_post_id, missing)
       VALUES (@id, 1, @rel, @name, @w, @h, 100000, 'png', @sha, @at, @at, 'illustration', 'default', @tagged, @rating, @color,
         @site, @post, @missing)`,
    );
    const ic = provenance
      ? db.prepare(
          `INSERT INTO image_characters (image_id, character_id, decision, actor, rule, evidence_provider, evidence_score, added_at)
           VALUES (@image, @character, @decision, @actor, @rule, @provider, @score, @at)`,
        )
      : db.prepare(
          `INSERT INTO image_characters (image_id, character_id, origin, score, added_at)
           VALUES (@image, @character, @origin, @score, @at)`,
        );
    const link = (image: number, character: number, manual: boolean, when: string) =>
      provenance
        ? ic.run({
            image,
            character,
            decision: manual ? 'manual' : 'auto',
            actor: manual ? 'user' : 'system:migration',
            rule: manual ? null : 'legacy:tagger',
            provider: manual ? null : 'tagger',
            score: manual ? null : 0.9,
            at: when,
          })
        : ic.run({ image, character, origin: manual ? 'manual' : 'tagger', score: manual ? null : 0.9, at: when });
    const original = db.prepare(
      cols('images').includes('original_decision')
        ? "UPDATE images SET original_at = ?, original_decision = 'manual', original_actor = 'user' WHERE id = ?"
        : 'UPDATE images SET original_at = ? WHERE id = ?',
    );
    // 作品证据（模型给的作品）、角色证据（建议）、手动指定的作品
    const workEvidence = evidence
      ? db.prepare("INSERT OR IGNORE INTO work_evidence (image_id, provider, tag, score) VALUES (?, 'tagger', ?, ?)")
      : db.prepare('INSERT OR IGNORE INTO image_copyrights (image_id, work_id, score) VALUES (?, ?, ?)');
    const charEvidence = evidence
      ? db.prepare("INSERT OR IGNORE INTO character_evidence (image_id, provider, tag, score) VALUES (?, 'tagger', ?, ?)")
      : db.prepare("INSERT OR IGNORE INTO character_suggestions (image_id, danbooru_tag, score, source) VALUES (?, ?, ?, 'tagger')");
    const evidenceHead = evidence
      ? db.prepare("INSERT OR IGNORE INTO image_evidence (image_id, provider, at) VALUES (?, 'tagger', ?)")
      : null;
    const manualWork = db.prepare('INSERT OR IGNORE INTO image_copyrights (image_id, work_id) VALUES (?, ?)');

    let id = 0;
    const add = (rel: string, name: string, w: number, h: number, site: string | null, post: string | null, mainChar: number | null) => {
      id++;
      const when = at(id);
      const missing = rnd(id, 1) < 0.011 ? 1 : 0;
      const tagged = rnd(id, 2) < 0.92 ? when : null;
      img.run({
        id,
        rel: `${rel}/${name}`,
        name,
        w,
        h,
        sha: `sha${id}`,
        at: when,
        tagged,
        rating: rnd(id, 3) < 0.08 ? 'questionable' : rnd(id, 3) < 0.2 ? 'sensitive' : 'general',
        color: rnd(id, 4) < 0.95 ? '#8899aa' : null,
        site,
        post,
        missing,
      });
      // 约 58% 的图有角色，其中约 23% 有两个；组图里多是同一个角色
      if (rnd(id, 5) < 0.58) {
        const c1 = mainChar !== null && rnd(id, 6) < 0.8 ? mainChar : Math.floor(rnd(id, 7) * CHARACTERS) + 1;
        link(id, c1, rnd(id, 8) < 0.1, when);
        if (rnd(id, 9) < 0.23) {
          const c2 = Math.floor(rnd(id, 10) * CHARACTERS) + 1;
          if (c2 !== c1) link(id, c2, false, when);
        }
      } else if (rnd(id, 11) < 0.19) original.run(when, id);
      if (tagged && rnd(id, 12) < 0.075) {
        const w = Math.floor(rnd(id, 13) * (WORKS - 1)) + 2;
        workEvidence.run(id, evidence ? `work_${w}` : w, 0.6);
        evidenceHead?.run(id, when);
      }
      if (tagged && rnd(id, 14) < 0.13) {
        charEvidence.run(id, `char_${Math.floor(rnd(id, 15) * CHARACTERS) + 1}`, 0.4 + rnd(id, 16) * 0.2);
        evidenceHead?.run(id, when);
      }
      if (rnd(id, 17) < 0.006) manualWork.run(id, Math.floor(rnd(id, 18) * (WORKS - 1)) + 2);
    };
    const size = (k: number) => [800 + Math.floor(rnd(k, 20) * 1600), 800 + Math.floor(rnd(k, 21) * 1600)] as const;

    // 一本按文件夹成册的本子（文件名是页码）
    for (let p = 1; p <= 40; p++) add('books/(C99) [サークル (作者)] タイトル (原作)', `${String(p).padStart(3, '0')}.png`, 1280, 1810, null, null, 7);
    // 同一投稿的组图：Pixiv 的文件名「投稿号_p页号」，按画师分文件夹
    for (let k = 0; k < POSTS; k++) {
      const post = String(90_000_000 + k * 37);
      const pages = POST_PAGES[k % POST_PAGES.length]!;
      const mainChar = Math.floor(rnd(k, 30) * CHARACTERS) + 1;
      const [w, h] = size(k);
      for (let p = 0; p < pages; p++) add(`收藏/画师${k % 300}`, `${post}_p${p}.png`, w, h, 'pixiv', post, mainChar);
    }
    // 其余的图：单张的投稿和普通文件夹
    for (let k = 0; id < IMAGES; k++) {
      const [w, h] = size(100_000 + k);
      if (k % 3 === 0) add(`收藏/画师${k % 300}`, `${80_000_000 + k}_p0.png`, w, h, 'pixiv', String(80_000_000 + k), null);
      else add(`杂图/f${k % 400}`, `illust_${k}.png`, w, h, null, null, null);
    }
  })();
  db.exec('ANALYZE');
}

// ---------------------------------------------------------------- 建库、打开引擎

const dir = mkdtempSync(path.join(tmpdir(), 'emaki-bench-collections-'));
const file = path.join(dir, 'emaki.sqlite');
const base = opt('--base');
if (base) copyFileSync(base, file);
else {
  const db = openDatabase(file);
  migrate(db, { log: () => {} });
  seed(db);
  db.close();
  const save = opt('--save-base');
  if (save) copyFileSync(file, save);
}
const bus = new EventBus();
const t0 = performance.now();
const ds = await SqliteDataSource.open(bus, dir, { autoJobs: false, importDict: false });
console.log(`打开引擎（迁移、启动修补、合集重算）${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
const app = await buildApp(ds as never, bus);
// 改前的代码没有公开这两个字段（TypeScript 的 private），运行时一样能取到
const engine = ds as unknown as {
  ctx: { db: Db };
  collectionQueries: { list(q: object): unknown[]; get(id: string): unknown; stats(): unknown };
};
const db = engine.ctx.db;
const one = <T>(sql: string) => db.prepare(sql).pluck().get() as T;
console.log(
  `图 ${one<number>('SELECT COUNT(*) FROM images')}（计入统计 ${one<number>('SELECT COUNT(*) FROM v_counted_images')}）；` +
    `合集 ${one<number>("SELECT COUNT(*) FROM collections WHERE state = 'active'")}` +
    `（同一投稿 ${one<number>("SELECT COUNT(*) FROM collections WHERE state = 'active' AND membership = 'post'")}），` +
    `有合集的图 ${one<number>('SELECT COUNT(*) FROM v_counted_images WHERE collection_id IS NOT NULL')}；` +
    `角色 ${one<number>('SELECT COUNT(*) FROM characters')}，图 ↔ 角色 ${one<number>('SELECT COUNT(*) FROM image_characters')}` +
    `（${one<number>('SELECT COUNT(DISTINCT image_id) FROM image_characters')} 张），` +
    `原创 ${one<number>('SELECT COUNT(*) FROM images WHERE original_at IS NOT NULL')}`,
);

const book = one<number>("SELECT id FROM collections WHERE state = 'active' AND membership = 'folder'");
// 页数最多的一组同投稿；第一个在合集里出现的角色和它的作品
const post = one<number>(
  `SELECT collection_id FROM images WHERE collection_id IN (SELECT id FROM collections WHERE membership = 'post')
   GROUP BY 1 ORDER BY COUNT(*) DESC, 1 LIMIT 1`,
);
const firstCharacter = one<number>(
  'SELECT character_id FROM image_characters ic JOIN images i ON i.id = ic.image_id WHERE i.collection_id IS NOT NULL ORDER BY 1 LIMIT 1',
);
const firstWork = one<number>(`SELECT work_id FROM character_works WHERE character_id = ${firstCharacter} ORDER BY position LIMIT 1`);

// ---------------------------------------------------------------- 测速

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  if (res.statusCode !== 200) throw new Error(`${url} → ${res.statusCode} ${res.body.slice(0, 200)}`);
  return res.rawPayload.length;
};
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]!;
const fmt = (n: number) => (n < 10 ? n.toFixed(1) : n.toFixed(0));

/**
 * 合集页、「收进组图」弹窗实际发的那组请求：按顺序发，时间、响应大小加起来（浏览器里是并发的，但服务端一次只处理一个）。
 * 改前（没有 /api/collections/counts）每处都是一次 GET /api/collections 拉全部合集，弹窗的搜索在前端筛、不再请求；
 * 改后见 CollectionsPage 的 shelfQueries 和 CollectionControls 的 GroupPickerPanel。搜索用 9000（约 270 组同投稿的投稿号里有它）
 */
const lazy = (await app.inject({ method: 'GET', url: '/api/collections/counts' })).statusCode === 200;
const SEARCH = '9000';
const nonPost = 'kind=group&membership=folder,selection';
const picker = (q: string) => [
  `/api/collections?${nonPost}&sort=recent&limit=51${q ? `&q=${q}` : ''}`,
  `/api/collections?kind=group&membership=post&sort=recent&limit=51${q ? `&q=${q}` : ''}`,
];
const PAGE_REQUESTS: [string, string[]][] = lazy
  ? [
      ['合集页「全部」打开', ['/api/collections?kind=doujin,artbook', `/api/collections?${nonPost}`, '/api/collections/counts']],
      ['合集页「全部」点「显示」', ['/api/collections?kind=group&membership=post']],
      ['合集页切到「组图」（都没拉过）', [`/api/collections?${nonPost}`, '/api/collections?kind=group&membership=post']],
      [
        `合集页搜索 ${SEARCH}`,
        [
          `/api/collections?kind=doujin,artbook&q=${SEARCH}`,
          `/api/collections?${nonPost}&q=${SEARCH}`,
          `/api/collections/counts?q=${SEARCH}`,
        ],
      ],
      ['「收进组图」弹窗打开', picker('')],
      [`「收进组图」搜索 ${SEARCH}`, picker(SEARCH)],
    ]
  : [
      ['合集页「全部」打开', ['/api/collections']],
      ['合集页「全部」点「显示」', []],
      ['合集页切到「组图」（都没拉过）', ['/api/collections']],
      [`合集页搜索 ${SEARCH}`, [`/api/collections?q=${SEARCH}`]],
      ['「收进组图」弹窗打开', ['/api/collections']],
      [`「收进组图」搜索 ${SEARCH}`, []],
    ];
const getAll = async (urls: string[]) => {
  let bytes = 0;
  for (const url of urls) bytes += await get(url);
  return bytes;
};

const scenarios: [string, () => unknown][] = [
  ...PAGE_REQUESTS.map(([name, urls]): [string, () => unknown] => [`${name}（${urls.length} 个请求）`, () => getAll(urls)]),
  ['合集列表（直接调用）', () => engine.collectionQueries.list({})],
  ['GET /api/collections', () => get('/api/collections')],
  ['GET /api/collections?characterId=…', () => get(`/api/collections?characterId=${firstCharacter}`)],
  ['GET /api/collections?workId=…', () => get(`/api/collections?workId=${firstWork}`)],
  ['GET /api/collections?kind=doujin', () => get('/api/collections?kind=doujin')],
  ['单个合集：本子（直接调用）', () => engine.collectionQueries.get(String(book))],
  ['GET /api/collections/:id（本子）', () => get(`/api/collections/${book}`)],
  ['GET /api/collections/:id（组图）', () => get(`/api/collections/${post}`)],
  ['统计里的合集计数（直接调用）', () => engine.collectionQueries.stats()],
];

console.log(`\n每个场景预热 2 次、测 ${RUNS} 次（毫秒）`);
console.log('| 场景 | p50 | p95 | 响应 |');
console.log('| --- | ---: | ---: | ---: |');
for (const [name, run] of scenarios) {
  let bytes: unknown;
  for (let i = 0; i < 2; i++) bytes = await run();
  const ms: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await run();
    ms.push(performance.now() - t);
  }
  const size = typeof bytes === 'number' ? `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB` : '';
  console.log(`| ${name} | ${fmt(pct(ms, 0.5))} | ${fmt(pct(ms, 0.95))} | ${size} |`);
}

const dump = opt('--dump');
if (dump) {
  const strip = (x: unknown): unknown =>
    JSON.parse(JSON.stringify(x), (k, v) => (k === 'modifiedAt' && typeof v === 'string' && v.length > 0 ? undefined : v));
  const detail = (id: number) => {
    const r = engine.collectionQueries.get(String(id)) as Record<string, unknown>;
    // 作品：改后不把模型给的作品算进来（附录 #8），前后本来就不同；出场角色只比 id、页数（角色的计数字段不是合集接口的事）
    const cast = (r.cast as { character: { id: string }; pageCount: number; manual: boolean }[]).map((c) => [
      c.character.id,
      c.pageCount,
      c.manual,
    ]);
    const pages = (r.pages as object[]).map((p) => strip({ ...p, modifiedAt: undefined }));
    return strip({ ...r, works: undefined, cast, pages });
  };
  const sample = db.prepare("SELECT id FROM collections WHERE state = 'active' ORDER BY id LIMIT 20").pluck().all() as number[];
  writeFileSync(
    dump,
    JSON.stringify(
      {
        list: strip(engine.collectionQueries.list({})),
        byCharacter: strip(engine.collectionQueries.list({ characterId: String(firstCharacter) })),
        stats: engine.collectionQueries.stats(),
        details: [book, post, ...sample].map(detail),
      },
      null,
      1,
    ),
  );
  console.log(`结果写在 ${dump}`);
}

await app.close();
await ds.close();
rmSync(dir, { recursive: true, force: true });
