/**
 * 迁移 034（统一来历，P3a）：造一个停在 v33 的库，覆盖各种旧的 origin / score 情况，迁移之后逐条核对。
 * 不变量：条数不变、每一对都在、关联时间不变；manual ⇔ 手动、tagger ⇔ 自动；原来的分数原样保留。
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTmpDir } from '../../test/helpers/tmp.ts';
import { openDatabase, type Db } from './connection.ts';
import { loadMigrations, migrate } from './migrate.ts';

let db: Db;
let dir: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  dir = makeTmpDir('migrate-034');
  // 迁移目录只放到 v33，库停在迁移 034 之前
  copyFileSync(path.join(import.meta.dirname, 'schema.sql'), path.join(dir, 'schema.sql'));
  mkdirSync(path.join(dir, 'migrations'));
  for (const m of loadMigrations().slice(1, 33)) writeFileSync(path.join(dir, 'migrations', m.name), m.sql);
  expect(migrate(db, { dir })).toEqual({ from: 0, to: 33 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = '2026-01-01T00:00:00.000Z';
const LATER = '2026-03-01T00:00:00.000Z';

/** 旧库：每张图一种情况。角色 1 = alice（Danbooru 标签），角色 2 = bob（有一条合并重定向 bobby），角色 3 = 自建 */
function seedOld(): void {
  db.exec(`
    INSERT INTO library_roots (id, path) VALUES (1, '//old/lib');
    INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES
      (1, '爱丽丝', 'alice_(game)', 'danbooru', '${T}'), (2, '鲍勃', 'bob_(game)', 'danbooru', '${T}'), (3, '自建', NULL, 'custom', '${T}');
    INSERT INTO danbooru_tag_redirects (tag, character_id) VALUES ('bobby_(game)', 2);
    INSERT INTO tags (id, name, category) VALUES (1, 'alice_(game)', 'character'), (2, 'bob_(game)', 'character'), (3, 'bobby_(game)', 'character'),
      (4, '1girl', 'general');
  `);
  const img = db.prepare(
    "INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at) VALUES (?, 1, ?, ?, 1, 1, 1, 'png', ?, 'x', 'x')",
  );
  for (let id = 1; id <= 12; id++) img.run(id, `${id}.png`, `${id}.png`, `s${id}`);
  const link = db.prepare('INSERT INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, ?, ?, ?)');
  const tag = db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, ?, ?)');
  // 1 手动归的
  link.run(1, 1, 'manual', null, T);
  // 2 单张采纳模型建议：手动 + 模型分数
  link.run(2, 1, 'manual', 0.72, T);
  tag.run(2, 1, 0.72);
  // 3 单张采纳 Pixiv 建议：手动 + 占位分 0
  link.run(3, 2, 'manual', 0, T);
  // 4 识别写入：tagger + 分数（模型标签里有两个解析到 bob 的，分数相同的那个是当时依据的）
  link.run(4, 2, 'tagger', 0.91, LATER);
  tag.run(4, 2, 0.88);
  tag.run(4, 3, 0.91);
  // 5 Pixiv 补充：分数为空，检查记录结果是 linked
  link.run(5, 1, 'tagger', null, T);
  db.prepare("INSERT INTO pixiv_character_checks (image_id, post_id, modified_at, checked_at, result) VALUES (5, '100', 'x', ?, 'linked')").run(T);
  // 6 Pixiv 补充：分数为空，change_log 的 pixiv-sync 记录里有（检查记录后来被改成别的）
  link.run(6, 3, 'tagger', null, T);
  db.prepare("INSERT INTO pixiv_character_checks (image_id, post_id, modified_at, checked_at, result) VALUES (6, '101', 'x', ?, 'dismissed')").run(T);
  db.prepare("INSERT INTO change_log (kind, created_at, summary, payload) VALUES ('pixiv-sync', ?, 'x', ?)").run(
    T,
    JSON.stringify({ links: [[6, 3, T]], originals: [] }),
  );
  // 7 分数为空、模型证据是角色本身的标签（补采纳）
  link.run(7, 1, 'tagger', null, T);
  tag.run(7, 1, 0.66);
  tag.run(7, 4, 0.99);
  // 8 分数为空、模型证据是合并重定向的标签
  link.run(8, 2, 'tagger', null, T);
  tag.run(8, 3, 0.7);
  // 9 分数为空、什么都对不上
  link.run(9, 1, 'tagger', null, T);
  // 10 分数为空、Pixiv 和模型证据都有：Pixiv 优先
  link.run(10, 1, 'tagger', null, T);
  tag.run(10, 1, 0.5);
  db.prepare("INSERT INTO pixiv_character_checks (image_id, post_id, modified_at, checked_at, result) VALUES (10, '102', 'x', ?, 'linked')").run(T);
  // 11 同一张图两个角色，一个手动一个模型
  link.run(11, 1, 'manual', null, T);
  link.run(11, 2, 'tagger', 0.95, LATER);
  tag.run(11, 2, 0.95);
  // 12 没有关联（检查记录是 linked 也不会凭空多出关联）
  db.prepare("INSERT INTO pixiv_character_checks (image_id, post_id, modified_at, checked_at, result) VALUES (12, '103', 'x', ?, 'linked')").run(T);
}

type Row = {
  image_id: number;
  character_id: number;
  decision: string;
  actor: string;
  rule: string | null;
  evidence_provider: string | null;
  evidence_tag: string | null;
  evidence_score: number | null;
  added_at: string;
};
const row = (image_id: number, character_id: number, r: Omit<Row, 'image_id' | 'character_id' | 'added_at'>, added_at = T): Row => ({ image_id, character_id, ...r, added_at });
const MANUAL = { decision: 'manual', actor: 'user', rule: null };
const AUTO = { decision: 'auto', actor: 'system:migration' };

it('034：旧的 origin / score 逐条转成统一来历，条数和每一对都不变', () => {
  seedOld();
  const before = db.prepare('SELECT image_id, character_id, origin, score, added_at FROM image_characters ORDER BY image_id, character_id').all() as {
    image_id: number;
    character_id: number;
    origin: string;
    score: number | null;
    added_at: string;
  }[];
  expect(before).toHaveLength(12);

  migrate(db);

  const after = db.prepare('SELECT * FROM image_characters ORDER BY image_id, character_id').all() as Row[];
  expect(after).toEqual([
    row(1, 1, { ...MANUAL, evidence_provider: null, evidence_tag: null, evidence_score: null }),
    row(2, 1, { ...MANUAL, evidence_provider: 'tagger', evidence_tag: 'alice_(game)', evidence_score: 0.72 }),
    row(3, 2, { ...MANUAL, evidence_provider: 'pixiv', evidence_tag: null, evidence_score: 0 }),
    row(4, 2, { ...AUTO, rule: 'legacy:tagger', evidence_provider: 'tagger', evidence_tag: 'bobby_(game)', evidence_score: 0.91 }, LATER),
    row(5, 1, { ...AUTO, rule: 'legacy:pixiv', evidence_provider: 'pixiv', evidence_tag: null, evidence_score: null }),
    row(6, 3, { ...AUTO, rule: 'legacy:pixiv', evidence_provider: 'pixiv', evidence_tag: null, evidence_score: null }),
    row(7, 1, { ...AUTO, rule: 'legacy:tagger-evidence', evidence_provider: 'tagger', evidence_tag: 'alice_(game)', evidence_score: 0.66 }),
    row(8, 2, { ...AUTO, rule: 'legacy:tagger-evidence', evidence_provider: 'tagger', evidence_tag: 'bobby_(game)', evidence_score: 0.7 }),
    row(9, 1, { ...AUTO, rule: 'legacy', evidence_provider: null, evidence_tag: null, evidence_score: null }),
    row(10, 1, { ...AUTO, rule: 'legacy:pixiv', evidence_provider: 'pixiv', evidence_tag: null, evidence_score: null }),
    row(11, 1, { ...MANUAL, evidence_provider: null, evidence_tag: null, evidence_score: null }),
    row(11, 2, { ...AUTO, rule: 'legacy:tagger', evidence_provider: 'tagger', evidence_tag: 'bob_(game)', evidence_score: 0.95 }, LATER),
  ]);

  // 不变量逐条核对：同样的对、同样的时间；manual ⇔ 手动；原来的分数原样保留
  expect(after.map((r) => [r.image_id, r.character_id, r.added_at])).toEqual(before.map((r) => [r.image_id, r.character_id, r.added_at]));
  for (const [k, b] of before.entries()) {
    const a = after[k]!;
    expect(a.decision).toBe(b.origin === 'manual' ? 'manual' : 'auto');
    if (b.score !== null) expect(a.evidence_score).toBe(b.score);
    // 自动的都有规则，手动的没有
    expect(a.rule === null).toBe(a.decision === 'manual');
  }

  // 报告用的分布查询（docs 里给协调方的 SQL）
  const dist = db
    .prepare('SELECT decision, evidence_provider AS provider, rule, COUNT(*) AS n FROM image_characters GROUP BY 1, 2, 3 ORDER BY 1, 2, 3')
    .all();
  expect(dist).toEqual([
    { decision: 'auto', provider: null, rule: 'legacy', n: 1 },
    { decision: 'auto', provider: 'pixiv', rule: 'legacy:pixiv', n: 3 },
    { decision: 'auto', provider: 'tagger', rule: 'legacy:tagger', n: 2 },
    { decision: 'auto', provider: 'tagger', rule: 'legacy:tagger-evidence', n: 2 },
    { decision: 'manual', provider: null, rule: null, n: 2 },
    { decision: 'manual', provider: 'pixiv', rule: null, n: 1 },
    { decision: 'manual', provider: 'tagger', rule: null, n: 1 },
  ]);

  // 视图、索引都在，约束生效（自动的必须有规则）
  expect(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('v_image_works', 'idx_image_characters_character', 'idx_ic_character_image')").pluck().get()).toBe(3);
  expect(() =>
    db.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (12, 1, 'auto', 'user', 'x')").run(),
  ).toThrow(/CHECK/);
  expect(() => db.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (12, 1, 'tagger', 'user', 'x')").run()).toThrow(
    /CHECK/,
  );
});

it('034：空库照常迁移', () => {
  migrate(db);
  expect(db.prepare('SELECT COUNT(*) FROM image_characters').pluck().get()).toBe(0);
  expect(db.pragma('user_version', { simple: true })).toBe(loadMigrations().at(-1)!.version);
});
