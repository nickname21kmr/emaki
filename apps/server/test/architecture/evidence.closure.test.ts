/**
 * P3b 的关闭测试（docs/core-architecture.md 第 2.1、2.3、4.2 节，第 13 节 D2、D8；附录 #7、#8、#9）。
 * 真实的 SqliteDataSource（内存库），图片行直接插进库里，不碰文件；识别和 Pixiv 补充和 crossEntry.test.ts 一样走真正的写入路径。
 *
 * - #9 建议是派生视图：证据里还没关联、没被否决的候选；模型和 Pixiv 的证据各自一份，不再互相覆盖；
 * - #8 模型给的作品是证据，不算图的作品；图的作品只来自关联的角色、手动指定和原创；
 * - #7 / D8 原创是带来历的决定：Pixiv 的是自动的，手动标、手动取消优先；「原创」作品只有一种建法；
 * - D2 证据不再支持时撤回自动关联：只在证据变化时、只撤依据这个来源的自动关联；记进 change_log，能撤回、能撤销；
 * - 补采纳是一个可撤销的命令：对所选范围跑一遍 reevaluateAuto，只新增。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { searchKey } from '@emaki/shared';
import type { JobContext } from '../../src/core/jobs.ts';
import { EventBus } from '../../src/core/events.ts';
import { SqliteDataSource } from '../helpers/client.ts';
import { patchSettingsInternal, readSettings } from '../../src/datasource/sqlite/settings.ts';
import { loadSuggestions } from '../../src/datasource/sqlite/suggestions.ts';
import { declareTagged } from '../../src/domain/evidence/reactions.ts';
import { TagResultWriter } from '../../src/domain/evidence/tagger.ts';
import { CharacterCatalog } from '../../src/domain/catalog/characterCatalog.ts';
import { CopyrightResolver } from '../../src/services/catalog/copyrights.ts';
import type { PixivArtwork } from '../../src/services/pixiv/client.ts';
import { queuePixivImages, resetPixivBackoff, syncPixivCharacters } from '../../src/services/pixiv/sync.ts';
import { makeTmpDir } from '../helpers/tmp.ts';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const KNOWN = 'alice_(game_a)';
const OTHER = 'bob_(game_a)';

const opened: { ds: SqliteDataSource; dir: string }[] = [];
afterEach(async () => {
  for (const { ds, dir } of opened.splice(0)) {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function engine(): Promise<SqliteDataSource> {
  const dir = makeTmpDir('evidence-closure');
  const ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), {
    memory: true,
    clock: () => NOW,
    autoJobs: false,
    importDict: false,
    checkRecyclable: async () => {},
    trashImpl: async () => {},
  });
  opened.push({ ds, dir });
  const db = ds.ctx.db;
  db.prepare("INSERT INTO library_roots (id, path, last_scan_at) VALUES (1, '//emaki-test/evidence', ?)").run(new Date(NOW).toISOString());
  for (const [tag, value, category] of [[KNOWN, 'アリス', 4], [OTHER, 'ボブ', 4], ['game_a', 'ゲームA', 3]] as const) {
    db.prepare("INSERT OR IGNORE INTO tag_i18n (tag, category, aliases) VALUES (?, ?, '[]')").run(tag, category);
    db.prepare("UPDATE tag_i18n SET aliases = json_insert(aliases, '$[#]', ?) WHERE tag = ?").run(value, tag);
    db.prepare("INSERT OR IGNORE INTO tag_name_keys (search_key, tag, kind, source) VALUES (?, ?, 'alias', 'dict')").run(searchKey(value), tag);
  }
  const w = db.prepare("INSERT INTO works (name, danbooru_tag, created_at) VALUES ('游戏A', 'game_a', '2000-01-01')").run().lastInsertRowid;
  for (const [tag, name] of [[KNOWN, '爱丽丝'], [OTHER, '鲍勃']]) {
    const c = db.prepare("INSERT INTO characters (name, danbooru_tag, source, created_at) VALUES (?, ?, 'danbooru', '2000-01-01')").run(name, tag).lastInsertRowid;
    db.prepare('INSERT INTO character_works (character_id, work_id, position) VALUES (?, ?, 0)').run(c, w);
  }
  return ds;
}

function addImage(ds: SqliteDataSource, id: number, post?: string): void {
  const fileName = post ? `${post}_p0.png` : `image_${id}.png`;
  ds.ctx.db
    .prepare(
      `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
         content_kind, content_kind_source, source_site, source_post_id)
       VALUES (?, 1, ?, ?, 1200, 1700, 1000, 'png', ?, ?, ?, 'illustration', 'default', ?, ?)`,
    )
    .run(id, `pics/${fileName}`, fileName, `sha-${id}`, new Date(NOW - id * 60_000).toISOString(), new Date(NOW - id * 60_000).toISOString(), post ? 'pixiv' : null, post ?? null);
}

/** 识别写入（和识别任务一样：写证据、批后交给变更传播）；阈值是识别时设置里的，写完放回 */
function recognize(ds: SqliteDataSource, batch: { id: number; character: [string, number][] }[], autoAcceptThreshold = 0.85): void {
  const before = readSettings(ds.ctx.db).tagger.autoAcceptThreshold;
  patchSettingsInternal(ds.ctx.db, 'tagger', { autoAcceptThreshold });
  const { catalog, copyrights } = ds.makeCatalog();
  new TagResultWriter(ds.ctx.db, catalog, copyrights, {
    repo: 'test/model',
    generalThreshold: 0.35,
    now: () => NOW,
    afterBatchInTx: (ids, changes) => declareTagged(ds.ctx, ids, changes),
  }).writeBatch(batch.map((b) => ({ id: b.id, ok: true as const, rating: null, general: [['1girl', 0.9]], character: b.character })));
  patchSettingsInternal(ds.ctx.db, 'tagger', { autoAcceptThreshold: before });
}

/** Pixiv 补充：投稿标签 tags，可以带原创字段 */
async function pixivSync(ds: SqliteDataSource, ids: number[], artwork: PixivArtwork): Promise<void> {
  queuePixivImages(ds.ctx, ids);
  resetPixivBackoff();
  const copyrights = new CopyrightResolver(ds.ctx.db, { [KNOWN]: ['game_a'], [OTHER]: ['game_a'] });
  const job: JobContext = { signal: new AbortController().signal, setTotal: vi.fn(), advance: vi.fn(), setMessage: vi.fn(), shouldYield: () => false, requeue: vi.fn(), yielded: false };
  await syncPixivCharacters(ds.ctx, job, () => ({ catalog: new CharacterCatalog(ds.ctx.db, { copyrights }), copyrights }), { artwork: async () => artwork }, 0);
}
const art = (post: string, tags: string[], isOriginal?: boolean): PixivArtwork => ({ id: post, pageCount: 1, tags: { tags: tags.map((tag) => ({ tag })) }, ...(isOriginal ? { isOriginal } : {}) });

const links = (ds: SqliteDataSource, id: number) =>
  ds.ctx.db
    .prepare(
      `SELECT c.danbooru_tag AS tag, ic.decision, ic.rule, ic.evidence_provider AS provider FROM image_characters ic JOIN characters c ON c.id = ic.character_id
       WHERE ic.image_id = ? ORDER BY tag`,
    )
    .all(id) as { tag: string; decision: string; rule: string | null; provider: string | null }[];
const tags = (ds: SqliteDataSource, id: number) => links(ds, id).map((l) => l.tag);
const characterId = (ds: SqliteDataSource, tag: string) => String(ds.ctx.db.prepare('SELECT id FROM characters WHERE danbooru_tag = ?').pluck().get(tag));
const original = (ds: SqliteDataSource, id: number) =>
  ds.ctx.db.prepare('SELECT original_at IS NOT NULL AS marked, original_decision AS decision, original_evidence_provider AS provider FROM images WHERE id = ?').get(id);
const retractions = (ds: SqliteDataSource) => ds.ctx.db.prepare("SELECT id FROM change_log WHERE kind = 'auto-retract' ORDER BY id").pluck().all() as number[];

describe('建议是派生视图（附录 #9）', () => {
  it('没有单独写入的建议表；关联、否决之后自然不再是建议，撤销之后又回来', async () => {
    const ds = await engine();
    addImage(ds, 1);
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.6]] }]);
    const db = ds.ctx.db;
    expect(db.prepare("SELECT type FROM sqlite_master WHERE name IN ('character_suggestions', 'v_character_suggestions')").pluck().all()).toEqual(['view']);
    const sug = () => db.prepare('SELECT danbooru_tag, score, source FROM v_character_suggestions WHERE image_id = 1').all();
    expect(sug()).toEqual([{ danbooru_tag: KNOWN, score: 0.6, source: 'tagger' }]);
    const assigned = await ds.bulkImages({ ids: ['1'], action: { type: 'assign', characterId: characterId(ds, KNOWN) } });
    expect(sug()).toEqual([]);
    await ds.undo(assigned.undoToken!);
    expect(sug()).toHaveLength(1);
    await ds.bulkImages({ ids: ['1'], action: { type: 'assign', characterId: characterId(ds, KNOWN) } });
    await ds.bulkImages({ ids: ['1'], action: { type: 'unassign', characterId: characterId(ds, KNOWN) } });
    // 否决过的不是建议；证据本身还在
    expect(sug()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM character_evidence WHERE image_id = 1').pluck().get()).toBe(1);
  });

  it('模型和 Pixiv 的证据各自一份，不再互相覆盖；看的时候同一个角色只列分数高的那条', async () => {
    const ds = await engine();
    addImage(ds, 1, '2001');
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.6]] }]);
    // 投稿多页、两个角色：Pixiv 只给候选（置信度 0），不自动关联
    await pixivSync(ds, [1], { ...art('2001', ['アリス', 'ボブ', 'ゲームA']), pageCount: 3 });
    expect(ds.ctx.db.prepare('SELECT provider, tag, score FROM character_evidence WHERE image_id = 1 ORDER BY provider, tag').all()).toEqual([
      { provider: 'pixiv', tag: KNOWN, score: 0 },
      { provider: 'pixiv', tag: OTHER, score: 0 },
      { provider: 'tagger', tag: KNOWN, score: 0.6 },
    ]);
    // 再识别一次：模型的证据整体替换，Pixiv 的不动
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.7]] }]);
    expect(ds.ctx.db.prepare("SELECT COUNT(*) FROM character_evidence WHERE image_id = 1 AND provider = 'pixiv'").pluck().get()).toBe(2);
    const shown = loadSuggestions(ds.ctx, [1], ds.makeCatalog().catalog).get(1)!;
    expect(shown.map((s) => [s.danbooruTag, s.source, s.score])).toEqual([
      [KNOWN, 'tagger', 0.7],
      [OTHER, 'pixiv', 0],
    ]);
  });
});

describe('作品：模型给的是证据，图的作品只来自决定（附录 #8）', () => {
  it('建议角色的主作品只记成作品证据，不算图的作品；关联上角色之后才算', async () => {
    const ds = await engine();
    addImage(ds, 1);
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.6]] }]);
    const db = ds.ctx.db;
    expect(db.prepare('SELECT tag, score FROM work_evidence WHERE image_id = 1').all()).toEqual([{ tag: 'game_a', score: 0.6 }]);
    expect(db.prepare('SELECT COUNT(*) FROM v_image_works WHERE image_id = 1').pluck().get()).toBe(0);
    expect((await ds.getStats()).workCount).toBe(0);
    await ds.acceptSuggestion('1', KNOWN);
    expect(db.prepare('SELECT w.danbooru_tag FROM v_image_works x JOIN works w ON w.id = x.work_id WHERE x.image_id = 1').pluck().all()).toEqual(['game_a']);
    expect((await ds.getStats()).workCount).toBe(1);
  });
});

describe('原创是带来历的决定（附录 #7，D8）', () => {
  it('手动归为原创：手动的决定，「原创」作品只有编目的一种建法（带配色和别名），图算原创作品由 original_at 派生', async () => {
    const ds = await engine();
    addImage(ds, 1);
    await ds.bulkImages({ ids: ['1'], action: { type: 'original', value: true } });
    const db = ds.ctx.db;
    expect(original(ds, 1)).toEqual({ marked: 1, decision: 'manual', provider: null });
    expect(db.prepare("SELECT color IS NOT NULL FROM works WHERE danbooru_tag = 'original'").pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM image_copyrights').pluck().get()).toBe(0);
    expect(db.prepare("SELECT x.image_id FROM v_image_works x JOIN works w ON w.id = x.work_id WHERE w.danbooru_tag = 'original'").pluck().all()).toEqual([1]);
  });

  it('Pixiv 的原创信号由 decideAuto 标成自动的原创；Pixiv 和手动用的是同一部「原创」作品', async () => {
    const ds = await engine();
    addImage(ds, 1, '3001');
    addImage(ds, 2);
    await pixivSync(ds, [1], art('3001', ['オリジナル'], true));
    expect(original(ds, 1)).toEqual({ marked: 1, decision: 'auto', provider: 'pixiv' });
    expect(ds.ctx.db.prepare('SELECT original_rule FROM images WHERE id = 1').pluck().get()).toBe('auto-original@1');
    await ds.bulkImages({ ids: ['2'], action: { type: 'original', value: true } });
    expect(ds.ctx.db.prepare("SELECT COUNT(*) FROM works WHERE danbooru_tag = 'original'").pluck().get()).toBe(1);
  });

  it('D8：用户手动取消原创后，Pixiv 的原创信号不会再把它标回来（重新评估、重新查 Pixiv 都不会）', async () => {
    const ds = await engine();
    addImage(ds, 1, '3002');
    await pixivSync(ds, [1], art('3002', ['オリジナル'], true));
    expect(original(ds, 1)).toMatchObject({ marked: 1, decision: 'auto' });
    await ds.bulkImages({ ids: ['1'], action: { type: 'original', value: false } });
    expect(original(ds, 1)).toEqual({ marked: 0, decision: 'manual', provider: null });
    // 别的变化触发重新评估（证据还在、带着原创信号）
    await ds.updateImage('1', { kind: 'comic' });
    await ds.updateImage('1', { kind: 'illustration' });
    expect(original(ds, 1)).toMatchObject({ marked: 0, decision: 'manual' });
    // 文件变了重新查 Pixiv：新证据照样有原创信号，也不标回来
    ds.ctx.db.prepare("UPDATE images SET modified_at = 'changed' WHERE id = 1").run();
    await pixivSync(ds, [1], art('3002', ['オリジナル'], true));
    expect(ds.ctx.db.prepare("SELECT original FROM image_evidence WHERE image_id = 1 AND provider = 'pixiv'").pluck().get()).toBe(1);
    expect(original(ds, 1)).toMatchObject({ marked: 0, decision: 'manual' });
  });

  it('手动标的原创，Pixiv 新证据没有原创信号也不撤回；撤回 Pixiv 那一轮 = 用户取消原创', async () => {
    const ds = await engine();
    addImage(ds, 1, '3003');
    addImage(ds, 2, '3004');
    await ds.bulkImages({ ids: ['1'], action: { type: 'original', value: true } });
    await pixivSync(ds, [2], art('3004', ['オリジナル'], true));
    expect(original(ds, 2)).toMatchObject({ marked: 1, decision: 'auto' });
    const round = (await ds.listChanges('auto')).find((c) => c.kind === 'pixiv-sync')!;
    await ds.revertChange(round.id);
    expect(original(ds, 2)).toEqual({ marked: 0, decision: 'manual', provider: null });
    // 图 1：手动原创，证据换了也不动
    ds.ctx.db.prepare("UPDATE images SET original_at = NULL, original_decision = NULL WHERE id = 1").run();
    await ds.bulkImages({ ids: ['1'], action: { type: 'original', value: true } });
    ds.ctx.apply(() => ds.ctx.changed({ type: 'evidence.changed', provider: 'pixiv', ids: [1] }));
    expect(original(ds, 1)).toMatchObject({ marked: 1, decision: 'manual' });
  });
});

describe('D2：证据不再支持时撤回自动关联', () => {
  it('重新识别没再认出：撤回模型的自动关联，记进 change_log；在「最近的自动改动」里撤回（加回来记成手动），撤回本身也能撤销', async () => {
    const ds = await engine();
    addImage(ds, 1);
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.9]] }]);
    expect(tags(ds, 1)).toEqual([KNOWN]);
    recognize(ds, [{ id: 1, character: [[OTHER, 0.9]] }]);
    expect(tags(ds, 1)).toEqual([OTHER]);
    // 分数掉到阈值以下也撤回
    recognize(ds, [{ id: 1, character: [[OTHER, 0.6]] }]);
    expect(tags(ds, 1)).toEqual([]);
    const entries = (await ds.listChanges('auto')).filter((c) => c.kind === 'auto-retract');
    expect(entries.map((e) => [e.count, e.revertable])).toEqual([
      [1, true],
      [1, true],
    ]);
    expect(entries[1]!.summary).toContain('爱丽丝');
    const revert = await ds.revertChange(entries[1]!.id);
    expect(links(ds, 1)).toEqual([{ tag: KNOWN, decision: 'manual', rule: null, provider: 'tagger' }]);
    // 加回来的是手动的：之后证据再变也不撤回
    recognize(ds, [{ id: 1, character: [] }]);
    expect(tags(ds, 1)).toEqual([KNOWN]);
    await ds.undo(revert.undoToken!);
    expect(tags(ds, 1)).toEqual([]);
    expect((await ds.listChanges('auto')).find((c) => c.id === entries[1]!.id)!.revertable).toBe(true);
  });

  it('阈值调高不撤回；补采纳、改类型（没有新证据）也不撤回', async () => {
    const ds = await engine();
    addImage(ds, 1);
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.9]] }]);
    await ds.updateSettings({ tagger: { autoAcceptThreshold: 0.95 } });
    await ds.promoteSuggestions();
    await ds.updateImage('1', { kind: 'screenshot' });
    expect(tags(ds, 1)).toEqual([KNOWN]);
    expect(retractions(ds)).toEqual([]);
  });

  it('手动的、来历不明（legacy）的永远不撤回；来源已知的旧数据（legacy:tagger）照样按证据撤回', async () => {
    const ds = await engine();
    for (const id of [1, 2, 3]) addImage(ds, id);
    const db = ds.ctx.db;
    const insert = db.prepare(
      'INSERT INTO image_characters (image_id, character_id, decision, actor, rule, evidence_provider, evidence_score, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const alice = Number(characterId(ds, KNOWN));
    insert.run(1, alice, 'manual', 'user', null, 'tagger', 0.9, 'x');
    insert.run(2, alice, 'auto', 'system:migration', 'legacy', null, null, 'x');
    insert.run(3, alice, 'auto', 'system:migration', 'legacy:tagger', 'tagger', 0.9, 'x');
    recognize(ds, [1, 2, 3].map((id) => ({ id, character: [] })));
    expect([1, 2, 3].map((id) => tags(ds, id))).toEqual([[KNOWN], [KNOWN], []]);
  });

  it('来源失效（改来源，Pixiv 证据过期）：撤回 Pixiv 的自动关联；这次操作撤销时关联、证据、审计记录一起回来', async () => {
    const ds = await engine();
    addImage(ds, 1, '4001');
    await pixivSync(ds, [1], art('4001', ['アリス', 'ゲームA']));
    expect(links(ds, 1)).toEqual([{ tag: KNOWN, decision: 'auto', rule: 'auto-accept@2', provider: 'pixiv' }]);
    const edit = await ds.updateImage('1', { source: { url: 'https://x.com/someone/status/123' } });
    expect(tags(ds, 1)).toEqual([]);
    expect(retractions(ds)).toHaveLength(1);
    await ds.undo(edit.undoToken!);
    expect(links(ds, 1)).toEqual([{ tag: KNOWN, decision: 'auto', rule: 'auto-accept@2', provider: 'pixiv' }]);
    expect(ds.ctx.db.prepare("SELECT COUNT(*) FROM character_evidence WHERE image_id = 1 AND provider = 'pixiv'").pluck().get()).toBe(1);
    expect(retractions(ds)).toEqual([]);
  });

  it('另一个来源仍然支持：不撤回，只把来历换成那个来源', async () => {
    const ds = await engine();
    addImage(ds, 1, '4002');
    await pixivSync(ds, [1], art('4002', ['アリス', 'ゲームA']));
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.9]] }]);
    expect(links(ds, 1)).toEqual([{ tag: KNOWN, decision: 'auto', rule: 'auto-accept@2', provider: 'pixiv' }]);
    await ds.updateImage('1', { source: null });
    expect(links(ds, 1)).toEqual([{ tag: KNOWN, decision: 'auto', rule: 'auto-accept@2', provider: 'tagger' }]);
    expect(retractions(ds)).toEqual([]);
  });
});

describe('按当前阈值补采纳：一个可撤销的命令', () => {
  it('预览和执行同一轮评估；只新增；撤销后不会被重新评估加回来', async () => {
    const ds = await engine();
    for (const id of [1, 2]) addImage(ds, id);
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.8]] }, { id: 2, character: [['newcomer_(game_b)', 0.8]] }]);
    expect(tags(ds, 1)).toEqual([]);
    await ds.updateSettings({ tagger: { autoAcceptThreshold: 0.75 } });
    expect(await ds.promotableSuggestions()).toMatchObject({ images: 2, suggestions: 2 });
    const r = await ds.promoteSuggestions();
    expect(r.message).toContain('2 张');
    expect([tags(ds, 1), tags(ds, 2)]).toEqual([[KNOWN], ['newcomer_(game_b)']]);
    await ds.undo(r.undoToken!);
    expect([tags(ds, 1), tags(ds, 2)]).toEqual([[], []]);
    expect(ds.ctx.db.prepare("SELECT COUNT(*) FROM characters WHERE danbooru_tag = 'newcomer_(game_b)'").pluck().get()).toBe(0);
    expect(await ds.promotableSuggestions()).toMatchObject({ images: 2, suggestions: 2 });
  });
});
