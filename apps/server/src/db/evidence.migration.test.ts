/**
 * 迁移 035（证据和决定分开，P3b）：造一个停在 v34 的库，覆盖各种旧的建议、作品、原创情况，迁移之后逐条核对。
 * 不变量：建议一条不丢（派生出来的建议、分数、未识别汇总里的 suggested 和迁移前一样）；识别器写的作品全部转成作品证据；
 * 原创的张数和时间不变，每张都有来历（能从 change_log、Pixiv 检查记录认出来的记成 Pixiv 的自动决定，其余手动）。
 * 也跑一遍给协调方核对真实库用的 SQL（scripts/verify-migration-035.sql）：在迁移后的库上 ATTACH 迁移前的自动备份。
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTmpDir } from '../../test/helpers/tmp.ts';
import { openDatabase, type Db } from './connection.ts';
import { loadMigrations, migrate } from './migrate.ts';

let db: Db;
let dir: string;

beforeEach(() => {
  dir = makeTmpDir('migrate-035');
  db = openDatabase(path.join(dir, 'emaki.sqlite'));
  // 迁移目录只放到 v34，库停在迁移 035 之前
  const old = path.join(dir, 'old-migrations');
  mkdirSync(path.join(old, 'migrations'), { recursive: true });
  copyFileSync(path.join(import.meta.dirname, 'schema.sql'), path.join(old, 'schema.sql'));
  for (const m of loadMigrations().slice(1, 34)) writeFileSync(path.join(old, 'migrations', m.name), m.sql);
  expect(migrate(db, { dir: old })).toEqual({ from: 0, to: 34 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = '2026-01-01T00:00:00.000Z';
const P = '2026-02-01T00:00:00.000Z';

/**
 * 旧库。角色 1 = alice（Danbooru），2 = bob，3 = 自建；作品 1 = game（Danbooru），2 = 原创（标签 original），3 = 手动挂过的别的作品。
 * 图 1–14，每张一种情况（见注释）
 */
function seedOld(): void {
  db.exec(`
    INSERT INTO library_roots (id, path) VALUES (1, '//old/lib');
    INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES
      (1, '爱丽丝', 'alice_(game)', 'danbooru', '${T}'), (2, '鲍勃', 'bob_(game)', 'danbooru', '${T}'), (3, '自建', NULL, 'custom', '${T}');
    INSERT INTO works (id, name, danbooru_tag, created_at) VALUES (1, '游戏', 'game', '${T}'), (2, '原创', 'original', '${T}'), (3, '别的', 'other', '${T}');
    INSERT INTO character_works (character_id, work_id, position) VALUES (1, 1, 0), (2, 1, 0);
  `);
  const img = db.prepare(
    `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, content_kind, tagged_at)
     VALUES (?, 1, ?, ?, 1, 1, 1, 'png', ?, 'x', 'x', 'illustration', ?)`,
  );
  for (let id = 1; id <= 14; id++) img.run(id, `${id}.png`, `${id}.png`, `s${id}`, id <= 12 ? T : null);
  const sug = db.prepare('INSERT INTO character_suggestions (image_id, danbooru_tag, score, source, character_id) VALUES (?, ?, ?, ?, ?)');
  const icr = db.prepare('INSERT INTO image_copyrights (image_id, work_id, score) VALUES (?, ?, ?)');
  const link = db.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, rule, added_at) VALUES (?, ?, 'manual', 'user', NULL, ?)");
  const check = db.prepare("INSERT INTO pixiv_character_checks (image_id, post_id, modified_at, checked_at, result) VALUES (?, ?, 'x', ?, ?)");
  // 1 未识别、两条模型建议（一条的角色还没建档），建议角色的主作品挂过 image_copyrights（识别器写的，有分数）
  sug.run(1, 'alice_(game)', 0.7, 'tagger', null);
  sug.run(1, 'carol_(game)', 0.4, 'tagger', null);
  icr.run(1, 1, 0.7);
  // 2 未识别、一条 Pixiv 建议（占位分 0）、一条 Pixiv 给自建角色的建议
  sug.run(2, 'bob_(game)', 0, 'pixiv', null);
  sug.run(2, 'emaki:character:3', 0, 'pixiv', 3);
  check.run(2, '200', T, 'suggested');
  // 3 已识别（手动归了 alice）、还留着一条 bob 的建议：派生建议照样有（看图器里显示），不算进未识别
  link.run(3, 1, T);
  sug.run(3, 'bob_(game)', 0.5, 'tagger', null);
  // 4 手动归为原创（score 为空的原创作品行）
  db.prepare('UPDATE images SET original_at = ? WHERE id = 4').run(T);
  icr.run(4, 2, null);
  // 5 Pixiv 补充标的原创：change_log 的 pixiv-sync 里有这张图和这个时间
  db.prepare('UPDATE images SET original_at = ? WHERE id = 5').run(P);
  icr.run(5, 2, null);
  db.prepare("INSERT INTO change_log (kind, created_at, summary, payload) VALUES ('pixiv-sync', ?, 'x', ?)").run(P, JSON.stringify({ links: [], originals: [[5, 2, P, 1]] }));
  // 6 Pixiv 补充标的原创：只有检查记录（结果 original，时间相同）
  db.prepare('UPDATE images SET original_at = ? WHERE id = 6').run(P);
  icr.run(6, 2, null);
  check.run(6, '600', P, 'original');
  // 7 检查记录是 original，但时间对不上（用户后来手动重标过）：按手动处理
  db.prepare('UPDATE images SET original_at = ? WHERE id = 7').run(T);
  check.run(7, '700', P, 'original');
  // 8 Pixiv 判过原创、用户后来移出了原创：记成用户取消
  check.run(8, '800', P, 'original');
  // 9 Pixiv 补充标的原创被用户在设置里撤回了：记成用户取消
  db.prepare("INSERT INTO change_log (kind, created_at, summary, payload, reverted_at) VALUES ('pixiv-sync', ?, 'x', ?, ?)").run(
    P,
    JSON.stringify({ links: [], originals: [[9, 2, P, 1]] }),
    P,
  );
  // 10 手动挂过别的作品（score 为空、不是原创）：留着当手动指定的作品
  icr.run(10, 3, null);
  // 11 分数为空的原创行，但图没标原创（遗留的不一致）：去掉
  icr.run(11, 2, null);
  // 12 被否决的角色还留着建议（按理不该有）：派生建议里没有它
  db.prepare("INSERT INTO character_vetoes (image_id, character_id, created_at) VALUES (12, 2, ?)").run(T);
  sug.run(12, 'bob_(game)', 0.6, 'tagger', null);
  // 13 没识别过、没任何东西；14 标了原创但「原创」作品行没挂（作品当时还没有）：原创作品照样算它
  db.prepare('UPDATE images SET original_at = ? WHERE id = 14').run(T);
}

/** 未识别汇总里的 suggested（插画、没放下、没角色、没原创、有建议）；table 是建议表或视图 */
const suggested = (table: string) =>
  db
    .prepare(
      `SELECT i.id FROM v_counted_images i WHERE i.content_kind = 'illustration' AND i.shelved_at IS NULL AND i.original_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id) AND EXISTS (SELECT 1 FROM ${table} s WHERE s.image_id = i.id) ORDER BY i.id`,
    )
    .pluck()
    .all() as number[];

it('035：建议转成证据，派生出来的建议和迁移前一样；作品证据、原创来历逐条核对', () => {
  seedOld();
  const oldSuggestions = db.prepare('SELECT image_id, danbooru_tag, score, source, character_id FROM character_suggestions ORDER BY image_id, danbooru_tag').all();
  const oldSuggested = suggested('character_suggestions');
  const oldWorks = db.prepare('SELECT image_id, work_id FROM v_image_works ORDER BY 1, 2').all();
  const originals = db.prepare('SELECT id, original_at FROM images WHERE original_at IS NOT NULL ORDER BY id').all();
  expect(oldSuggested).toEqual([1, 2, 12]);

  migrate(db, { backupDir: dir });

  // 建议：每一行都转成了证据；派生的建议除了被否决的那条都在，分数、来源原样
  expect(db.prepare('SELECT image_id, tag AS danbooru_tag, score, provider AS source, character_id FROM character_evidence ORDER BY image_id, tag').all()).toEqual(
    oldSuggestions,
  );
  expect(db.prepare('SELECT image_id, danbooru_tag, score, source, character_id FROM v_character_suggestions ORDER BY image_id, danbooru_tag').all()).toEqual(
    oldSuggestions.filter((s) => !((s as { image_id: number }).image_id === 12)),
  );
  // 未识别汇总里的 suggested：被否决的那条建议本来就不该显示，其余一样
  expect(suggested('v_character_suggestions')).toEqual([1, 2]);

  // 作品：识别器写的转成作品证据，不再算图的作品；原创作品由 original_at 派生；手动挂的别的作品留着
  expect(db.prepare('SELECT image_id, provider, tag, score FROM work_evidence').all()).toEqual([{ image_id: 1, provider: 'tagger', tag: 'game', score: 0.7 }]);
  expect(db.prepare('SELECT image_id, work_id FROM image_copyrights').all()).toEqual([{ image_id: 10, work_id: 3 }]);
  const newWorks = db.prepare('SELECT image_id, work_id FROM v_image_works ORDER BY 1, 2').all();
  const key = (r: unknown) => JSON.stringify(r);
  expect(oldWorks.filter((r) => !newWorks.map(key).includes(key(r)))).toEqual([
    { image_id: 1, work_id: 1 }, // 只靠识别器的作品证据
    { image_id: 11, work_id: 2 }, // 没标原创的遗留原创行
  ]);
  // 标了原创、当时没挂「原创」作品行的：现在照样算原创作品
  expect(newWorks.filter((r) => !oldWorks.map(key).includes(key(r)))).toEqual([
    { image_id: 7, work_id: 2 },
    { image_id: 14, work_id: 2 },
  ]);

  // 原创：张数、时间不变；来历按能认出来的分
  expect(db.prepare('SELECT id, original_at FROM images WHERE original_at IS NOT NULL ORDER BY id').all()).toEqual(originals);
  expect(
    db.prepare('SELECT id, original_at IS NOT NULL AS marked, original_decision, original_actor, original_rule, original_evidence_provider FROM images WHERE original_decision IS NOT NULL ORDER BY id').all(),
  ).toEqual([
    { id: 4, marked: 1, original_decision: 'manual', original_actor: 'user', original_rule: null, original_evidence_provider: null },
    { id: 5, marked: 1, original_decision: 'auto', original_actor: 'system:migration', original_rule: 'legacy:pixiv', original_evidence_provider: 'pixiv' },
    { id: 6, marked: 1, original_decision: 'auto', original_actor: 'system:migration', original_rule: 'legacy:pixiv', original_evidence_provider: 'pixiv' },
    { id: 7, marked: 1, original_decision: 'manual', original_actor: 'user', original_rule: null, original_evidence_provider: null },
    { id: 8, marked: 0, original_decision: 'manual', original_actor: 'user', original_rule: null, original_evidence_provider: null },
    { id: 9, marked: 0, original_decision: 'manual', original_actor: 'user', original_rule: null, original_evidence_provider: null },
    { id: 14, marked: 1, original_decision: 'manual', original_actor: 'user', original_rule: null, original_evidence_provider: null },
  ]);

  // 证据头：识别过的图一条 tagger；Pixiv 检查有结果的一条 pixiv，结果是 original 的带原创信号
  expect(db.prepare("SELECT COUNT(*) FROM image_evidence WHERE provider = 'tagger'").pluck().get()).toBe(12);
  expect(db.prepare("SELECT image_id, original FROM image_evidence WHERE provider = 'pixiv' ORDER BY image_id").all()).toEqual([
    { image_id: 2, original: 0 },
    { image_id: 6, original: 1 },
    { image_id: 7, original: 1 },
    { image_id: 8, original: 1 },
  ]);
  // change_log 认得新的 auto-retract；建议表没了
  expect(() => db.prepare("INSERT INTO change_log (kind, created_at, summary, payload) VALUES ('auto-retract', 'x', 'x', '{}')").run()).not.toThrow();
  expect(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'character_suggestions'").pluck().get()).toBe(0);

  // 给协调方的核对 SQL：在迁移后的库上 ATTACH 迁移前的自动备份就能跑
  db.exec(`ATTACH DATABASE '${path.join(dir, 'emaki.v34.bak.sqlite').replace(/'/g, "''")}' AS old`);
  const sql = readFileSync(path.join(import.meta.dirname, '../../scripts/verify-migration-035.sql'), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
  const out = Object.fromEntries(
    sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const row = db.prepare(s).raw().get() as unknown[];
        return [String(row[0]).split(' ')[0], row.slice(1)];
      }),
  );
  expect(out).toEqual({
    '1a': [6, 5, 1, 0],
    '1b': [0, 1, 0],
    '1c': [0],
    '1d': [3, 2],
    '1e': [6, 4, 2],
    '2a': [5, 5],
    '2b': [3, 2, 0],
    '2c': [2],
    '2d': [0],
    '3a': [1, 4, 1, 1, 1],
    '3b': [2, 1, 1],
    '3c': [1, 1],
    '3d': [2],
    '3e': [3, 3],
  });
});

it('035：空库照常迁移', () => {
  migrate(db);
  expect(db.prepare('SELECT COUNT(*) FROM character_evidence').pluck().get()).toBe(0);
  expect(db.pragma('user_version', { simple: true })).toBe(loadMigrations().at(-1)!.version);
});
