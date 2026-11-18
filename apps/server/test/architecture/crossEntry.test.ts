/**
 * 跨入口一致性（P0 护栏，docs/core-architecture.md 第 4.2、8、12 节）。
 *
 * 同一份证据从不同入口进来（首次识别写入、补采纳、手动改类型、自动改类型、Pixiv 补充、单张采纳、批量归类、整组替换），
 * 结果必须相同：同样的角色关联、同样可辨认的来历、同样的资格判断、同样会套排除规则。
 * 用的是真实的 SqliteDataSource（内存库），图片行直接插进库里，不碰文件。
 *
 * 不一致的用例曾用 it.fails 标出来，注释里写明附录编号（docs/core-architecture-inventory.md）和修好它的阶段；
 * P3b 之后已经全部改回 it（附录 #1、#2、#3 由唯一的自动决定规则 decideAuto / reevaluateAuto 关闭）。
 *
 * 来历从 image_characters 的统一来历字段读（P3a，迁移 034）：decision 手动 / 自动，evidence_provider 是依据的证据来源。
 */
import type { JobContext } from '../../src/core/jobs.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { searchKey } from '@emaki/shared';
import { EventBus } from '../../src/core/events.ts';
import { declareTagged } from '../../src/domain/evidence/reactions.ts';
import { SqliteDataSource } from '../../src/datasource/sqlite/SqliteDataSource.ts';
import { patchSettingsInternal, readSettings } from '../../src/datasource/sqlite/settings.ts';
import { CharacterCatalog } from '../../src/domain/catalog/characterCatalog.ts';
import { CopyrightResolver } from '../../src/services/catalog/copyrights.ts';
import type { PixivArtwork } from '../../src/services/pixiv/client.ts';
import { pendingPixivCount, queuePixivImages, resetPixivBackoff, syncPixivCharacters } from '../../src/services/pixiv/sync.ts';
import { TagResultWriter } from '../../src/domain/evidence/tagger.ts';
import { makeTmpDir } from '../helpers/tmp.ts';
import { animationHtml } from '../helpers/htmlAnimation.ts';
import { scanTree } from './sqlWrites.ts';
import { runAs } from '../../src/propagation/actor.ts';
import type { ChangeOf } from '../../src/propagation/changes.ts';
import { hasWork } from '../../src/propagation/work.ts';
import { htmlAnimationCache } from '../../src/services/image/htmlAnimation.ts';
import { sharp } from '../../src/services/image/sharpConfig.ts';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
/** 图库里已有的角色（有作品） */
const KNOWN = 'alice_(game_a)';
/** 图库里还没有的角色标签 */
const NEW_TAG = 'newcomer_(game_b)';
/** 让分类器判成截图的识别标签（UI_TAGS） */
const UI_TAG = 'user_interface';

const opened: { ds: SqliteDataSource; dir: string }[] = [];
afterEach(async () => {
  for (const { ds, dir } of opened.splice(0)) {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 一个全新的引擎：内存库、固定时钟、不跑后台任务；一个图库文件夹（路径不存在，这里不碰文件） */
async function engine(): Promise<SqliteDataSource> {
  const dir = makeTmpDir('cross-entry');
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
  db.prepare("INSERT INTO library_roots (id, path, last_scan_at) VALUES (1, '//emaki-test/cross-entry', ?)").run(new Date(NOW).toISOString());
  // 名字索引：Pixiv 靠这些把投稿标签认成角色和作品
  names(ds, KNOWN, 'アリス', 4);
  names(ds, 'game_a', 'ゲームA', 3);
  // 已有的角色和作品
  const w = db.prepare("INSERT INTO works (name, danbooru_tag, created_at) VALUES ('游戏A', 'game_a', '2000-01-01')").run().lastInsertRowid;
  const c = db.prepare("INSERT INTO characters (name, danbooru_tag, source, created_at) VALUES ('爱丽丝', ?, 'danbooru', '2000-01-01')").run(KNOWN).lastInsertRowid;
  db.prepare('INSERT INTO character_works (character_id, work_id, position) VALUES (?, ?, 0)').run(c, w);
  return ds;
}

function names(ds: SqliteDataSource, tag: string, value: string, category: number): void {
  const db = ds.ctx.db;
  db.prepare("INSERT OR IGNORE INTO tag_i18n (tag, category, aliases) VALUES (?, ?, '[]')").run(tag, category);
  db.prepare("UPDATE tag_i18n SET aliases = json_insert(aliases, '$[#]', ?) WHERE tag = ?").run(value, tag);
  db.prepare("INSERT OR IGNORE INTO tag_name_keys (search_key, tag, kind, source) VALUES (?, ?, 'alias', 'dict')").run(searchKey(value), tag);
}

interface ImageSpec {
  id: number;
  fileName?: string;
  format?: string;
  /** Pixiv 投稿号：文件名用 <投稿号>_p0 */
  post?: string;
}

function addImage(ds: SqliteDataSource, spec: ImageSpec): number {
  const fileName = spec.fileName ?? (spec.post ? `${spec.post}_p0.png` : `image_${spec.id}.png`);
  ds.ctx.db
    .prepare(
      `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
         content_kind, content_kind_source, source_site, source_post_id)
       VALUES (@id, 1, @rel, @fileName, 1200, 1700, 1000, @format, @sha, @at, @at, 'illustration', 'default', @site, @post)`,
    )
    .run({
      id: spec.id,
      rel: `pics/${fileName}`,
      fileName,
      format: spec.format ?? 'png',
      sha: `sha-${spec.id}`,
      at: new Date(NOW - spec.id * 60_000).toISOString(),
      site: spec.post ? 'pixiv' : null,
      post: spec.post ?? null,
    });
  return spec.id;
}

type Scores = [string, number][];

/**
 * 首次识别写入：和识别任务一样用 TagResultWriter 写一批（同一个事务），批后声明证据、类型变了（declareTagged），
 * 自动关联（reevaluateAuto）、套排除规则、登记 Pixiv 由反应做（SqliteDataSource.open 里给识别任务接的 afterBatchInTx 就是这一步）。
 * P3b 起自动阈值只来自设置：autoAcceptThreshold 是识别那一刻设置里的阈值，写完放回原来的（模拟「识别时阈值是多少，之后又改了」）
 */
function recognize(ds: SqliteDataSource, batch: { id: number; general?: Scores; character: Scores }[], autoAcceptThreshold = 0.85): void {
  const before = readSettings(ds.ctx.db).tagger.autoAcceptThreshold;
  patchSettingsInternal(ds.ctx.db, 'tagger', { autoAcceptThreshold });
  const { catalog, copyrights } = ds.makeCatalog();
  const writer = new TagResultWriter(ds.ctx.db, catalog, copyrights, {
    repo: 'test/model',
    generalThreshold: 0.35,
    now: () => NOW,
    afterBatchInTx: (ids, changes) => declareTagged(ds.ctx, ids, changes),
  });
  writer.writeBatch(batch.map((b) => ({ id: b.id, ok: true as const, rating: null, general: [['1girl', 0.9], ...(b.general ?? [])], character: b.character })));
  patchSettingsInternal(ds.ctx.db, 'tagger', { autoAcceptThreshold: before });
}

/** 一张图的角色关联：[角色标签, 手动 / 自动, 有没有依据的证据]，按标签排序 */
function provenance(ds: SqliteDataSource, imageId: number): [string, 'manual' | 'auto', boolean][] {
  const rows = ds.ctx.db
    .prepare(
      `SELECT COALESCE(c.danbooru_tag, c.name) AS tag, ic.decision, ic.evidence_provider FROM image_characters ic JOIN characters c ON c.id = ic.character_id
       WHERE ic.image_id = ? ORDER BY tag`,
    )
    .all(imageId) as { tag: string; decision: 'manual' | 'auto'; evidence_provider: string | null }[];
  return rows.map((r) => [r.tag, r.decision, r.evidence_provider !== null]);
}

const linkedTags = (ds: SqliteDataSource, imageId: number) => provenance(ds, imageId).map(([tag]) => tag);

/** Pixiv 补充：这张图（投稿号 post）的投稿标签是「アリス」「ゲームA」，补充任务认成爱丽丝并自动关联 */
async function pixivSync(ds: SqliteDataSource, imageId: number, post: string): Promise<void> {
  queuePixivImages(ds.ctx, [imageId]);
  resetPixivBackoff();
  const artwork: PixivArtwork = { id: post, pageCount: 1, tags: { tags: [{ tag: 'アリス' }, { tag: 'ゲームA' }] } };
  const copyrights = new CopyrightResolver(ds.ctx.db, { [KNOWN]: ['game_a'] });
  const job: JobContext = {
    signal: new AbortController().signal,
    setTotal: vi.fn(),
    advance: vi.fn(),
    setMessage: vi.fn(),
    shouldYield: () => false,
    requeue: vi.fn(),
    yielded: false,
  };
  await syncPixivCharacters(ds.ctx, job, () => ({ catalog: new CharacterCatalog(ds.ctx.db, { copyrights }), copyrights }), { artwork: async () => artwork }, 0);
}
const characterId = (ds: SqliteDataSource, tag: string) =>
  String(ds.ctx.db.prepare('SELECT id FROM characters WHERE danbooru_tag = ?').pluck().get(tag) as number);
const kindOf = (ds: SqliteDataSource, id: number) => ds.ctx.db.prepare('SELECT content_kind FROM images WHERE id = ?').pluck().get(id) as string;
const excluded = (ds: SqliteDataSource, id: number) => ds.ctx.db.prepare('SELECT excluded_by IS NOT NULL FROM images WHERE id = ?').pluck().get(id) === 1;

describe('自动关联：同一份模型证据，从哪个入口进来结果都一样', () => {
  // 附录 #1（P3b 已关闭）：以前识别写入时新角色能不能建档取决于它在批次里的先后（逐张建档），补采纳按整批收集新标签。
  // 同一批里一张截图、一张插画都认出同一个新角色：截图排在前面时不关联，排在后面时关联。
  // 现在都经 reevaluateAuto：一轮里先收集要建档的标签，再让同一轮里不能建档的图复用，结果和先后无关
  it('首次识别写入不取决于批次里的先后，和补采纳一致（附录 #1，P3b 已关闭）', async () => {
    const batch = (shotFirst: boolean) => {
      const shot = { id: 1, general: [[UI_TAG, 0.9]] as Scores, character: [[NEW_TAG, 0.9]] as Scores };
      const illust = { id: 2, character: [[NEW_TAG, 0.9]] as Scores };
      return shotFirst ? [shot, illust] : [illust, shot];
    };
    const results: string[][] = [];
    for (const shotFirst of [true, false]) {
      const ds = await engine();
      addImage(ds, { id: 1 });
      addImage(ds, { id: 2 });
      recognize(ds, batch(shotFirst));
      expect(kindOf(ds, 1)).toBe('screenshot');
      results.push(linkedTags(ds, 1));
    }
    // 补采纳：识别时阈值更高（只留建议），调低后点「按当前阈值补采纳」
    const ds = await engine();
    addImage(ds, { id: 1 });
    addImage(ds, { id: 2 });
    recognize(ds, batch(true), 0.95);
    await ds.updateSettings({ tagger: { autoAcceptThreshold: 0.85 } });
    await ds.promoteSuggestions();
    results.push(linkedTags(ds, 1));
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('已有角色：首次识别写入和补采纳得到同样的关联和来历', async () => {
    const first = await engine();
    addImage(first, { id: 1 });
    recognize(first, [{ id: 1, character: [[KNOWN, 0.9]] }]);

    const promoted = await engine();
    addImage(promoted, { id: 1 });
    recognize(promoted, [{ id: 1, character: [[KNOWN, 0.9]] }], 0.95);
    await promoted.updateSettings({ tagger: { autoAcceptThreshold: 0.85 } });
    await promoted.promoteSuggestions();

    expect(provenance(first, 1)).toEqual([[KNOWN, 'auto', true]]);
    expect(provenance(promoted, 1)).toEqual(provenance(first, 1));
  });

  it('新角色：截图上认出的新角色，手动改成插画后的结果和一开始就是插画时一样', async () => {
    const direct = await engine();
    addImage(direct, { id: 1 });
    recognize(direct, [{ id: 1, character: [[NEW_TAG, 0.9]] }]);

    const changed = await engine();
    addImage(changed, { id: 1 });
    recognize(changed, [{ id: 1, general: [[UI_TAG, 0.9]], character: [[NEW_TAG, 0.9]] }]);
    expect(kindOf(changed, 1)).toBe('screenshot');
    expect(linkedTags(changed, 1)).toEqual([]);
    await changed.updateImage('1', { kind: 'illustration' });

    expect(provenance(direct, 1)).toEqual([[NEW_TAG, 'auto', true]]);
    expect(provenance(changed, 1)).toEqual(provenance(direct, 1));
  });

  // 附录 #3（P3b 已关闭）：以前只有手动改类型会重新评估自动关联（kinds.ts）。帧数检测、相机识别、扫描重判这些自动改类型的路径不会。
  // 这里模拟扫描发现图挪进了「3话」文件夹：分析模块按新路径重判成漫画 → 类型真的变了就声明 image.kindChanged。
  // 现在两条路都由 reevaluateAuto 订阅 image.kindChanged（D5 之前用的是帧数检测判成动图；动图不再是类型，帧数不改类型）
  it('自动改类型和手动改类型一样会重新评估（附录 #3，P3b 已关闭）', async () => {
    const manual = await engine();
    const auto = await engine();
    for (const ds of [manual, auto]) {
      addImage(ds, { id: 1 });
      recognize(ds, [{ id: 1, general: [[UI_TAG, 0.9]], character: [[NEW_TAG, 0.9]] }]);
      expect(kindOf(ds, 1)).toBe('screenshot');
    }
    await manual.updateImage('1', { kind: 'comic' });
    auto.ctx.db.prepare("UPDATE images SET rel_path = '某漫画 3话/image_1.png' WHERE id = 1").run();
    auto.ctx.apply(() => auto.ctx.changed({ type: 'image.moved', ids: [1], reason: 'scan' }));

    expect(kindOf(auto, 1)).toBe('comic');
    expect(linkedTags(manual, 1)).toEqual([NEW_TAG]);
    expect(provenance(auto, 1)).toEqual(provenance(manual, 1));
  });
});

describe('Pixiv 和模型：同样的置信度，同样的资格判断', () => {
  // 附录 #2（P3b 已关闭）：以前 Pixiv 的资格判断写死了 cs.score >= 0.8（pixiv/sync.ts），而模型按设置里的自动采纳阈值（默认 0.85）。
  // 模型分数没到阈值（没自动关联）的图，应当和没有模型证据的图一样去查 Pixiv；反过来到了阈值的已经关联，不用再查
  it('模型没自动关联的图都会排进 Pixiv 补充，和分数落在哪一档无关（附录 #2，P3b 已关闭）', async () => {
    const mismatches: string[] = [];
    for (const threshold of [0.75, 0.85, 0.95]) {
      for (const score of [0.78, 0.82, 0.9]) {
        const ds = await engine();
        addImage(ds, { id: 1, post: '1001' });
        await ds.updateSettings({ tagger: { autoAcceptThreshold: threshold } });
        recognize(ds, [{ id: 1, character: [[KNOWN, score]] }], threshold);
        const modelLinked = linkedTags(ds, 1).length > 0;
        const pixivEligible = pendingPixivCount(ds.ctx) > 0;
        if (pixivEligible === modelLinked) mismatches.push(`阈值 ${threshold} 分数 ${score}：模型${modelLinked ? '已' : '没'}关联，Pixiv ${pixivEligible ? '会' : '不'}查`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  // 附录 #1（P3b 已关闭）：以前 Pixiv 能不能处理漫画页看设置（comicInUnrecognized，QUEUE_KINDS_SQL），模型的识别写入和补采纳总是允许漫画。
  // 现在 Pixiv 的资格和模型一致：插画、漫画、动图都查
  it('漫画页：模型能自动关联的，Pixiv 也会去查（附录 #1，P3b 已关闭）', async () => {
    const ds = await engine();
    await ds.updateSettings({ tagger: { comicInUnrecognized: false } });
    addImage(ds, { id: 1 });
    addImage(ds, { id: 2, post: '1002' });
    for (const id of [1, 2]) await ds.updateImage(String(id), { kind: 'comic' });
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.9]] }]);
    queuePixivImages(ds.ctx, [2]);
    const modelLinks = linkedTags(ds, 1).length > 0;
    const pixivChecks = pendingPixivCount(ds.ctx) > 0;
    expect(modelLinks).toBe(true);
    expect(pixivChecks).toBe(modelLinks);
  });

  // 附录 #5（P3a 已关闭）：以前 Pixiv 的自动关联存成 origin = 'tagger' 且分数为空，和「手动」的记法撞在一起；
  // 现在两种来源的自动关联都记成「自动 + 依据的证据」（统一来历，迁移 034）
  it('Pixiv 的自动关联和模型的自动关联来历一样可辨认（附录 #5）', async () => {
    const ds = await engine();
    addImage(ds, { id: 1, post: '1003' });
    addImage(ds, { id: 2 });
    recognize(ds, [{ id: 2, character: [[KNOWN, 0.9]] }]);
    await pixivSync(ds, 1, '1003');
    expect(linkedTags(ds, 1)).toEqual([KNOWN]);
    expect(provenance(ds, 1)).toEqual(provenance(ds, 2));
  });
});

describe('新增关联之后都会套排除规则', () => {
  /** 排除「爱丽丝」的规则建好之后，再用各个入口把她关联到一张新图 */
  const entries: [string, (ds: SqliteDataSource, id: number) => Promise<unknown>][] = [
    ['首次识别写入', async (ds, id) => recognize(ds, [{ id, character: [[KNOWN, 0.9]] }])],
    [
      '补采纳',
      async (ds, id) => {
        recognize(ds, [{ id, character: [[KNOWN, 0.9]] }], 0.95);
        await ds.updateSettings({ tagger: { autoAcceptThreshold: 0.85 } });
        await ds.promoteSuggestions();
      },
    ],
    [
      '单张采纳建议',
      async (ds, id) => {
        recognize(ds, [{ id, character: [[KNOWN, 0.6]] }]);
        await ds.acceptSuggestion(String(id), KNOWN);
      },
    ],
    ['批量归类（按标签）', (ds, id) => ds.bulkImages({ ids: [String(id)], action: { type: 'assignTag', danbooruTag: KNOWN } })],
    ['批量归类（按角色）', (ds, id) => ds.bulkImages({ ids: [String(id)], action: { type: 'assign', characterId: characterId(ds, KNOWN) } })],
    ['看图器里整组替换角色', (ds, id) => ds.updateImage(String(id), { characterIds: [characterId(ds, KNOWN)] })],
  ];

  async function run(names: string[]): Promise<string[]> {
    const ds = await engine();
    await ds.createExclusion({ kind: 'character', target: characterId(ds, KNOWN) });
    const notExcluded: string[] = [];
    let id = 10;
    for (const [name, link] of entries.filter(([n]) => names.includes(n))) {
      addImage(ds, { id: ++id });
      await link(ds, id);
      expect(linkedTags(ds, id), name).toEqual([KNOWN]);
      if (!excluded(ds, id)) notExcluded.push(name);
    }
    return notExcluded;
  }

  it('识别写入、补采纳、单张采纳、按标签批量归类会套排除规则', async () => {
    expect(await run(['首次识别写入', '补采纳', '单张采纳建议', '批量归类（按标签）'])).toEqual([]);
  });

  // 附录 #14（P2 已关闭）：以前批量 assign、updateImage 整组替换（还有角色合并、查重合并）新增关联后不套排除规则。
  // 现在所有入口都声明 curation.charactersChanged，由反应 reevaluateExclusions 重新判定
  it('所有入口新增关联后都会套排除规则（附录 #14）', async () => {
    expect(await run(entries.map(([n]) => n))).toEqual([]);
  });
});

// ---------------------------------------------------------------- P3a：归类收口（附录 #4、#6、#12、#39）

/** 一张图的关联和完整来历：[角色标签, 手动 / 自动, 规则, 证据来源]，按标签排序 */
function fullProvenance(ds: SqliteDataSource, imageId: number): [string, string, string | null, string | null][] {
  return (
    ds.ctx.db
      .prepare(
        `SELECT COALESCE(c.danbooru_tag, c.name) AS tag, ic.decision, ic.rule, ic.evidence_provider AS provider
         FROM image_characters ic JOIN characters c ON c.id = ic.character_id WHERE ic.image_id = ? ORDER BY tag`,
      )
      .all(imageId) as { tag: string; decision: string; rule: string | null; provider: string | null }[]
  ).map((r) => [r.tag, r.decision, r.rule, r.provider]);
}
/** 这张图上被用户否决过的角色（标签） */
const vetoedTags = (ds: SqliteDataSource, imageId: number) =>
  ds.ctx.db
    .prepare('SELECT COALESCE(c.danbooru_tag, c.name) FROM character_vetoes v JOIN characters c ON c.id = v.character_id WHERE v.image_id = ? ORDER BY 1')
    .pluck()
    .all(imageId) as string[];
/** 再建一个图库里已有的角色（属于作品 game_a） */
function addCharacter(ds: SqliteDataSource, tag: string, name: string): string {
  const db = ds.ctx.db;
  const id = db.prepare("INSERT INTO characters (name, danbooru_tag, source, created_at) VALUES (?, ?, 'danbooru', '2000-01-01')").run(name, tag).lastInsertRowid;
  db.prepare("INSERT INTO character_works (character_id, work_id, position) SELECT ?, id, 0 FROM works WHERE danbooru_tag = 'game_a'").run(id);
  return String(id);
}
/** 一个重复组：keep 和 gone 两张，处理时保留 keep */
function duplicateGroup(ds: SqliteDataSource, keep: number, gone: number): string {
  const db = ds.ctx.db;
  const gid = db.prepare("INSERT INTO duplicate_groups (kind, similarity, suggested_keep_id, created_at) VALUES ('exact', 1, ?, '2026-01-01')").run(keep).lastInsertRowid;
  db.prepare('INSERT INTO duplicate_members (group_id, image_id) VALUES (?, ?), (?, ?)').run(gid, keep, gid, gone);
  return String(gid);
}

describe('图 ↔ 角色只有归类模块写，每个入口记下同一种来历（附录 #4，P3a 已关闭）', () => {
  it('源码里写 image_characters、character_vetoes 的只有 domain/curation/（演示数据灌入除外）', () => {
    const tables = new Set(['image_characters', 'character_vetoes']);
    const writes = scanTree(path.resolve(import.meta.dirname, '../../src'), tables).filter((w) => tables.has(w.table));
    expect(writes.filter((w) => !w.file.startsWith('domain/curation/') && !w.file.startsWith('demo/')).map((w) => `${w.file}:${w.line} ${w.snippet}`)).toEqual([]);
    // 扫描器确实看到了归类模块里的写入（不是什么都没扫到）
    expect([...new Set(writes.filter((w) => w.file.startsWith('domain/curation/')).map((w) => w.table))].sort()).toEqual(['character_vetoes', 'image_characters']);
  });

  it('13 个入口：识别写入、补采纳、单张采纳、批量归类（角色 / 标签）、整组替换、Pixiv、角色合并、查重合并……都记下来历', async () => {
    const ds = await engine();
    const bob = addCharacter(ds, 'bob_(game_a)', '鲍勃');
    for (let id = 1; id <= 11; id++) addImage(ds, { id, post: id === 6 ? '1006' : undefined });
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.9]] }]);
    recognize(ds, [{ id: 2, character: [[KNOWN, 0.9]] }], 0.95);
    await ds.promoteSuggestions();
    recognize(ds, [{ id: 3, character: [[KNOWN, 0.6]] }]);
    await ds.acceptSuggestion('3', KNOWN);
    await ds.bulkImages({ ids: ['4'], action: { type: 'assign', characterId: characterId(ds, KNOWN) } });
    await ds.bulkImages({ ids: ['5'], action: { type: 'assignTag', danbooruTag: KNOWN } });
    await pixivSync(ds, 6, '1006');
    await ds.updateImage('7', { characterIds: [characterId(ds, KNOWN)] });
    // P3b：识别写入、补采纳、Pixiv 补充都是同一条规则（decideAuto，auto-accept@2），依据哪个来源看证据
    expect([1, 2, 3, 4, 5, 6, 7].map((id) => fullProvenance(ds, id))).toEqual([
      [[KNOWN, 'auto', 'auto-accept@2', 'tagger']],
      [[KNOWN, 'auto', 'auto-accept@2', 'tagger']],
      [[KNOWN, 'manual', null, 'tagger']],
      [[KNOWN, 'manual', null, null]],
      [[KNOWN, 'manual', null, null]],
      [[KNOWN, 'auto', 'auto-accept@2', 'pixiv']],
      [[KNOWN, 'manual', null, null]],
    ]);
    // 采纳、归类之后，这些图上指向爱丽丝的建议都没了（建议是派生的：关联上了就不是建议）
    expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM v_character_suggestions WHERE image_id IN (2, 3)').pluck().get()).toBe(0);

    // 角色合并：被合并角色的关联按原来的来历搬给目标
    const dup = addCharacter(ds, 'alice_alt_(game_a)', '爱丽丝（重复）');
    await ds.bulkImages({ ids: ['8'], action: { type: 'assign', characterId: dup } });
    recognize(ds, [{ id: 9, character: [['alice_alt_(game_a)', 0.9]] }]);
    await ds.mergeCharacter(dup, characterId(ds, KNOWN));
    expect([fullProvenance(ds, 8), fullProvenance(ds, 9)]).toEqual([[[KNOWN, 'manual', null, null]], [[KNOWN, 'auto', 'auto-accept@2', 'tagger']]]);

    // 查重合并：手动的还是手动，自动的记成 dedupe-merge（证据照搬）
    recognize(ds, [{ id: 11, character: [[KNOWN, 0.9]] }]);
    await ds.bulkImages({ ids: ['11'], action: { type: 'assign', characterId: bob } });
    await ds.resolveDuplicate(duplicateGroup(ds, 10, 11), ['10']);
    expect(fullProvenance(ds, 10)).toEqual([
      [KNOWN, 'auto', 'dedupe-merge@1', 'tagger'],
      ['bob_(game_a)', 'manual', null, null],
    ]);
  });
});

describe('撤回一批自动关联只按来历精确删除（附录 #6，P3a 已关闭）', () => {
  it('漫画区同步只去掉自动的：识别写入、补采纳、Pixiv 的去掉，单张采纳和手动归的留着；撤销放回', async () => {
    const ds = await engine();
    for (let id = 1; id <= 5; id++) addImage(ds, { id, post: id === 4 ? '1004' : undefined });
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.9]] }]);
    recognize(ds, [{ id: 2, character: [[KNOWN, 0.9]] }], 0.95);
    await ds.promoteSuggestions();
    recognize(ds, [{ id: 3, character: [[KNOWN, 0.6]] }]);
    await ds.acceptSuggestion('3', KNOWN);
    await pixivSync(ds, 4, '1004');
    await ds.bulkImages({ ids: ['5'], action: { type: 'assign', characterId: characterId(ds, KNOWN) } });
    const before = [1, 2, 3, 4, 5].map((id) => fullProvenance(ds, id));
    expect(before.every((l) => l.length === 1)).toBe(true);

    const r = await ds.updateLibraryRoot('1', { comicFolder: { relDir: 'pics' } });
    expect([1, 2, 3, 4, 5].map((id) => linkedTags(ds, id).length)).toEqual([0, 0, 1, 0, 1]);
    expect(fullProvenance(ds, 3)).toEqual([[KNOWN, 'manual', null, 'tagger']]);
    // 规则去掉的不记否决
    expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM character_vetoes').pluck().get()).toBe(0);
    await ds.undo(r.undoToken!);
    expect([1, 2, 3, 4, 5].map((id) => fullProvenance(ds, id))).toEqual(before);
  });

  it('撤回 Pixiv 补充只去掉这轮 Pixiv 加的；之后用户手动确认过的（改成手动）留着', async () => {
    const ds = await engine();
    addImage(ds, { id: 1, post: '1001' });
    addImage(ds, { id: 2, post: '1001', fileName: '1001_p1.png' });
    queuePixivImages(ds.ctx, [2]);
    await pixivSync(ds, 1, '1001');
    expect([linkedTags(ds, 1), linkedTags(ds, 2)]).toEqual([[KNOWN], [KNOWN]]);
    // 用户之后在 2 上去掉又手动加回：现在是手动的
    await ds.updateImage('2', { characterIds: [] });
    await ds.updateImage('2', { characterIds: [characterId(ds, KNOWN)] });
    const [entry] = await ds.listChanges('auto');
    await ds.revertChange(entry!.id);
    expect(fullProvenance(ds, 1)).toEqual([]);
    expect(vetoedTags(ds, 1)).toEqual([KNOWN]);
    expect(fullProvenance(ds, 2)).toEqual([[KNOWN, 'manual', null, null]]);
  });
});

describe('查重合并经归类命令（附录 #12，P3a 已关闭）', () => {
  it('按来历搬关联、放下也搬、保留的图上否决过的不搬、搬来的角色套排除规则；撤销全部还原', async () => {
    const ds = await engine();
    const bob = addCharacter(ds, 'bob_(game_a)', '鲍勃');
    const carol = addCharacter(ds, 'carol_(game_a)', '卡罗尔');
    addImage(ds, { id: 1 });
    addImage(ds, { id: 2 });
    // 副本：模型认的爱丽丝，手动归的鲍勃、卡罗尔，放下了
    recognize(ds, [{ id: 2, character: [[KNOWN, 0.9]] }]);
    await ds.bulkImages({ ids: ['2'], action: { type: 'assign', characterId: bob } });
    await ds.bulkImages({ ids: ['2'], action: { type: 'assign', characterId: carol } });
    await ds.bulkImages({ ids: ['2'], action: { type: 'shelve', value: true } });
    // 保留的图：用户去掉过卡罗尔
    await ds.bulkImages({ ids: ['1'], action: { type: 'assign', characterId: carol } });
    await ds.bulkImages({ ids: ['1'], action: { type: 'unassign', characterId: carol } });
    await ds.createExclusion({ kind: 'character', target: bob });
    expect(excluded(ds, 2)).toBe(true);
    const snap = () => ({
      links: fullProvenance(ds, 1),
      vetoes: vetoedTags(ds, 1),
      shelved: ds.ctx.db.prepare('SELECT shelved_at FROM images WHERE id = 1').pluck().get(),
      excluded: excluded(ds, 1),
    });
    const before = snap();
    expect(before).toEqual({ links: [], vetoes: ['carol_(game_a)'], shelved: null, excluded: false });

    // 被排除的副本也照样处理（重复组里可见的成员才会被移到回收站，这里先恢复副本）
    await ds.bulkImages({ ids: ['2'], action: { type: 'restore' } });
    const r = await ds.resolveDuplicate(duplicateGroup(ds, 1, 2), ['1']);
    expect(snap()).toEqual({
      links: [
        [KNOWN, 'auto', 'dedupe-merge@1', 'tagger'],
        ['bob_(game_a)', 'manual', null, null],
      ],
      vetoes: ['carol_(game_a)'],
      shelved: expect.any(String),
      excluded: true,
    });
    await ds.undo(r.undoToken!);
    expect(snap()).toEqual(before);
  });

  it('副本上手动确认的来源搬过来时声明 image.sourceChanged：保留的图重新登记 Pixiv 补充', async () => {
    const ds = await engine();
    addImage(ds, { id: 1 });
    addImage(ds, { id: 2 });
    await ds.updateImage('2', { source: { url: 'https://www.pixiv.net/artworks/98785437' } });
    await ds.resolveDuplicate(duplicateGroup(ds, 1, 2), ['1']);
    expect(ds.ctx.db.prepare('SELECT source_post_id, source_manual FROM images WHERE id = 1').get()).toEqual({ source_post_id: '98785437', source_manual: 1 });
    expect(ds.ctx.db.prepare('SELECT post_id FROM pixiv_character_checks WHERE image_id = 1').pluck().get()).toBe('98785437');
  });
});

describe('否决（附录 #39，D3，P3a 已关闭）', () => {
  /** 各个「用户手动加回」的入口 */
  const addBack: [string, (ds: SqliteDataSource) => Promise<{ undoToken: string | null }>][] = [
    ['批量归类', (ds) => ds.bulkImages({ ids: ['1'], action: { type: 'assign', characterId: characterId(ds, KNOWN) } })],
    ['按标签批量归类', (ds) => ds.bulkImages({ ids: ['1'], action: { type: 'assignTag', danbooruTag: KNOWN } })],
    ['整组替换', (ds) => ds.updateImage('1', { characterIds: [characterId(ds, KNOWN)] })],
  ];

  it.each(addBack)('用户手动加回去掉过的角色（%s）：清掉否决，之后识别也照常认；撤销加回时否决回来', async (_name, add) => {
    const ds = await engine();
    addImage(ds, { id: 1 });
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.9]] }]);
    await ds.updateImage('1', { characterIds: [] });
    expect(vetoedTags(ds, 1)).toEqual([KNOWN]);
    // 否决挡住重新识别
    recognize(ds, [{ id: 1, character: [[KNOWN, 0.9]] }]);
    expect(linkedTags(ds, 1)).toEqual([]);

    const r = await add(ds);
    expect(fullProvenance(ds, 1)).toEqual([[KNOWN, 'manual', null, null]]);
    expect(vetoedTags(ds, 1)).toEqual([]);
    await ds.undo(r.undoToken!);
    expect(linkedTags(ds, 1)).toEqual([]);
    expect(vetoedTags(ds, 1)).toEqual([KNOWN]);
  });

  it('单张采纳被否决过的角色的建议：同样清掉否决', async () => {
    const ds = await engine();
    addImage(ds, { id: 1 });
    await ds.bulkImages({ ids: ['1'], action: { type: 'assign', characterId: characterId(ds, KNOWN) } });
    await ds.bulkImages({ ids: ['1'], action: { type: 'unassign', characterId: characterId(ds, KNOWN) } });
    // 建议不会再出现（派生视图滤掉被否决的），这里直接放一条模型证据（例如否决之前留下的），用户照样能按它采纳
    ds.ctx.db.prepare("INSERT INTO character_evidence (image_id, provider, tag, score) VALUES (1, 'tagger', ?, 0.6)").run(KNOWN);
    await ds.acceptSuggestion('1', KNOWN);
    expect(fullProvenance(ds, 1)).toEqual([[KNOWN, 'manual', null, 'tagger']]);
    expect(vetoedTags(ds, 1)).toEqual([]);
  });

  it('角色合并：目标在这张图上被否决过，被合并角色的关联（手动的、自动的）都不搬过去；否决留着', async () => {
    const ds = await engine();
    addImage(ds, { id: 1 });
    addImage(ds, { id: 2 });
    const dup = addCharacter(ds, 'alice_alt_(game_a)', '爱丽丝（重复）');
    for (const id of ['1', '2']) {
      await ds.bulkImages({ ids: [id], action: { type: 'assign', characterId: characterId(ds, KNOWN) } });
      await ds.bulkImages({ ids: [id], action: { type: 'unassign', characterId: characterId(ds, KNOWN) } });
    }
    await ds.bulkImages({ ids: ['1'], action: { type: 'assign', characterId: dup } });
    recognize(ds, [{ id: 2, character: [['alice_alt_(game_a)', 0.9]] }]);
    expect([linkedTags(ds, 1), linkedTags(ds, 2)]).toEqual([['alice_alt_(game_a)'], ['alice_alt_(game_a)']]);
    const r = await ds.mergeCharacter(dup, characterId(ds, KNOWN));
    expect([linkedTags(ds, 1), linkedTags(ds, 2)]).toEqual([[], []]);
    expect([vetoedTags(ds, 1), vetoedTags(ds, 2)]).toEqual([[KNOWN], [KNOWN]]);
    await ds.undo(r.undoToken!);
    expect([linkedTags(ds, 1), linkedTags(ds, 2)]).toEqual([['alice_alt_(game_a)'], ['alice_alt_(game_a)']]);
  });
});

describe('文件内容变了：用户替换和扫描发现外部修改走同一条路（D1，附录 #10，P4a）', () => {
  // 以前扫描发现内容变了会清掉识别结果、主题、画质分并重判类型，用户替换文件则这些都保留，尺寸、格式、帧数变了也不重新分类、不重新识别；
  // 两条路都不重置画师识别。现在两条路都只改观测、声明 image.fileChanged（reason 只记录在案），后续全由反应做，结果一样
  it('派生数据重算、识别过期并重新排队、画师重认、查重标记；手动的决定保留；自动关联等新证据到了按 D2 处理', async () => {
    const ds = await engine();
    const dir = opened.at(-1)!.dir;
    const lib = path.join(dir, 'lib');
    mkdirSync(lib);
    ds.ctx.db.prepare('UPDATE library_roots SET path = ?, last_scan_at = NULL WHERE id = 1').run(lib.replace(/\\/g, '/'));
    const put = (name: string, bytes: Buffer, at: Date) => {
      const file = path.join(name.startsWith('/') ? '' : lib, name);
      writeFileSync(file, bytes);
      utimesSync(file, at, at);
      return file;
    };
    const png = (seed: number) => sharp({ create: { width: 40, height: 60, channels: 3, background: { r: seed * 60, g: 90, b: 150 } } }).png().toBuffer();
    put('a.png', await png(1), new Date('2025-01-01'));
    put('b.png', await png(2), new Date('2025-01-01'));
    const job: JobContext = { signal: new AbortController().signal, setTotal() {}, advance() {}, setMessage() {}, shouldYield: () => false, requeue() {}, yielded: false };
    const scan = async () => {
      ds.requests.requestFull();
      await runAs('job:scan', () => ds.scanner.scan(job));
      ds.ctx.propagation.jobFinished('scan');
    };
    await scan();
    const id = (name: string) => ds.ctx.db.prepare('SELECT id FROM images WHERE file_name = ?').pluck().get(name) as number;
    const [a, b] = [id('a.png'), id('b.png')];
    // 两张图一样的处境：识别过（爱丽丝 0.9 自动关联，新角色 0.8 只是建议），手动归了 Bob、收藏、手动分级，画师认过，缩略图算过
    recognize(ds, [a, b].map((x) => ({ id: x, character: [[KNOWN, 0.9], [NEW_TAG, 0.8]] as Scores })));
    const bob = ds.ctx.db.prepare("INSERT INTO characters (name, source, created_at) VALUES ('Bob', 'custom', '2000-01-01')").run().lastInsertRowid;
    await ds.bulkImages({ ids: [String(a), String(b)], action: { type: 'assign', characterId: String(bob) } });
    for (const x of [a, b]) await ds.updateImage(String(x), { favorite: true, rating: 'sensitive' });
    ds.ctx.db.exec("UPDATE images SET artist_checked_at = '2026-01-01', dhash = '0123456789abcdef', dominant_color = '#112233', thumb_at = '2026-01-01'");
    ds.ctx.db.prepare("DELETE FROM pending_work WHERE kind = 'dedupe'").run();
    // 后台任务不跑（缩略图任务会按新文件把像素派生补回来，这里看的是变化那一刻）
    vi.spyOn(ds.pipeline, 'afterImport').mockImplementation(() => {});
    const seen: ChangeOf<'image.fileChanged'>[] = [];
    ds.ctx.propagation.register({ name: 'spyFileChanged', on: ['image.fileChanged'], phase: 'after', run: ({ changes }) => void seen.push(...changes.of('image.fileChanged')) });

    // 新版本：一张两帧的动图 WebP（格式、尺寸、帧数、类型都变）
    const animated = readFileSync(await htmlAnimationCache(await animationHtml(), path.join(dir, 'data')));
    const download = path.join(dir, 'download.webp');
    writeFileSync(download, animated);
    // 一条路：用户替换（格式变了扩展名跟着变）；另一条路：外部程序把 b.png 改成同样的内容，扫描发现
    await ds.replaceImage(String(a), { path: download });
    put('b.png', animated, new Date('2025-06-01'));
    await scan();

    expect(seen.map((c) => [c.reason, c.ids])).toEqual([
      ['replace', [a]],
      ['scan', [b]],
    ]);
    expect(seen.every((c) => c.files.every((f) => f.before !== f.after && f.after === seen[0]!.files[0]!.after))).toBe(true);
    const facts = (x: number) =>
      ds.ctx.db
        .prepare(
          `SELECT width, height, format, sha256, frame_count, animated, content_kind, theme, art_score, tagged_at, tagger_model, artist_checked_at,
             dhash, dominant_color, thumb_at, decode_error, favorite, rating, rating_manual, missing, trashed_at FROM images WHERE id = ?`,
        )
        .get(x);
    expect(facts(a)).toEqual(facts(b));
    expect(facts(a)).toMatchObject({
      format: 'webp',
      frame_count: 2,
      // D5：两帧的 WebP 是动图；类型照其余规则判（还没识别，默认插画）
      animated: 1,
      content_kind: 'illustration',
      // 这份文件版本还没有识别结果：识别时间、主题、画质分为空，排队重新识别；画师也重认
      tagged_at: null,
      theme: null,
      art_score: null,
      artist_checked_at: null,
      // 旧文件算出来的像素派生清掉，缩略图任务按新文件（新 sha）重新生成
      dhash: null,
      dominant_color: null,
      thumb_at: null,
      favorite: 1,
      rating: 'sensitive',
      rating_manual: 1,
    });
    expect(hasWork(ds.ctx.db, 'dedupe')).toBe(true);
    // 手动的决定、依据旧证据的自动关联都还在（旧证据留着，标成过期）
    expect(provenance(ds, a)).toEqual(provenance(ds, b));
    expect(provenance(ds, a)).toEqual([
      ['Bob', 'manual', false],
      [KNOWN, 'auto', true],
    ]);

    // 过期的模型证据不拿来新加关联：调低阈值再补采纳，新角色（0.8）也不会关联上
    await ds.updateSettings({ tagger: { autoAcceptThreshold: 0.75 } });
    await ds.promoteSuggestions();
    expect(linkedTags(ds, a)).toEqual(['Bob', KNOWN]);
    expect(linkedTags(ds, b)).toEqual(['Bob', KNOWN]);

    // 新证据到了（按新文件重新识别：只认出新角色）：依据旧证据的自动关联按 D2 撤回，手动的不动
    recognize(ds, [a, b].map((x) => ({ id: x, character: [[NEW_TAG, 0.9]] as Scores })));
    expect(provenance(ds, a)).toEqual(provenance(ds, b));
    expect(provenance(ds, a)).toEqual([
      ['Bob', 'manual', false],
      [NEW_TAG, 'auto', true],
    ]);
  });
});

describe('动图（D5，P4b）：是否动图和类型是两个维度', () => {
  /** 一个真的图库文件夹（临时目录）：放文件、扫描 */
  async function libraryEngine() {
    const ds = await engine();
    const lib = path.join(opened.at(-1)!.dir, 'lib');
    mkdirSync(lib);
    ds.ctx.db.prepare('UPDATE library_roots SET path = ?, last_scan_at = NULL WHERE id = 1').run(lib.replace(/\\/g, '/'));
    const job: JobContext = { signal: new AbortController().signal, setTotal() {}, advance() {}, setMessage() {}, shouldYield: () => false, requeue() {}, yielded: false };
    const scan = async () => {
      ds.requests.requestFull();
      await runAs('job:scan', () => ds.scanner.scan(job));
      ds.ctx.propagation.jobFinished('scan');
    };
    const id = (name: string) => ds.ctx.db.prepare('SELECT id FROM images WHERE file_name = ?').pluck().get(name) as number;
    // 修改时间放在过去：刚写的文件扫描会当成还在写入、下次再看
    const put = (name: string, bytes: Buffer) => {
      const file = path.join(lib, name);
      writeFileSync(file, bytes);
      utimesSync(file, new Date('2025-01-01'), new Date('2025-01-01'));
    };
    return { ds, put, scan, id };
  }
  /** 两帧的动画 WebP（delays 不同内容就不同）；转换用的缓存放在图库文件夹外面 */
  const animatedWebp = async (delays: number[]) =>
    readFileSync(await htmlAnimationCache(await animationHtml(delays), path.join(opened.at(-1)!.dir, 'data')));

  // 一条路：扫描入库，识别出是插画（动的插画就是插画）；另一条路：识别标签让它判成了截图，用户改成插画。
  // 两条路的类型、是否动图、角色关联和来历、未识别队列、Pixiv 资格、动图筛选都一样
  it('同一张动图，从扫描入库和从改类型两条路进来，结果一致', async () => {
    const results = [];
    for (const route of ['scan', 'kind'] as const) {
      const { ds, put, scan, id } = await libraryEngine();
      // a：认出图库里还没有的角色（插画上可以建档）；b：Pixiv 投稿，模型只给了建议（留在未识别里，能去查 Pixiv）
      put('a.webp', await animatedWebp([30, 60]));
      put('12345678_p0.webp', await animatedWebp([40, 80]));
      await scan();
      const [a, b] = [id('a.webp'), id('12345678_p0.webp')];
      expect(ds.ctx.db.prepare('SELECT frame_count, animated, content_kind FROM images WHERE id IN (?, ?)').all(a, b)).toEqual([
        { frame_count: 2, animated: 1, content_kind: 'illustration' },
        { frame_count: 2, animated: 1, content_kind: 'illustration' },
      ]);
      const ui = route === 'kind' ? ([[UI_TAG, 0.9]] as Scores) : [];
      recognize(ds, [
        { id: a, general: ui, character: [[NEW_TAG, 0.9]] },
        { id: b, general: ui, character: [[KNOWN, 0.6]] },
      ]);
      if (route === 'kind') {
        // 判成了截图：新角色不建档，两张都在未识别的「照片 · 文字等」里，不去查 Pixiv；是动图不受影响
        expect([kindOf(ds, a), kindOf(ds, b)]).toEqual(['screenshot', 'screenshot']);
        expect(linkedTags(ds, a)).toEqual([]);
        expect((await ds.unrecognizedSummary({})).annex.kinds.screenshot).toBe(2);
        expect(pendingPixivCount(ds.ctx)).toBe(0);
        await ds.bulkImages({ ids: [String(a), String(b)], action: { type: 'kind', value: 'illustration' } });
      }
      const summary = await ds.unrecognizedSummary({});
      const animatedIllust = await ds.listImages({ kind: ['illustration'], animated: true });
      results.push({
        facts: [a, b].map((x) => ds.ctx.db.prepare('SELECT content_kind, animated, frame_count FROM images WHERE id = ?').get(x)),
        links: [provenance(ds, a), provenance(ds, b)],
        art: summary.art.kinds.illustration,
        annex: summary.annex.total,
        pixiv: pendingPixivCount(ds.ctx),
        filtered: animatedIllust.items.map((i) => i.fileName).sort(),
        stats: { illustration: (await ds.getStats()).kindCounts.illustration, animated: (await ds.getStats()).animatedCount },
      });
    }
    expect(results[0]).toMatchObject({
      facts: [
        { content_kind: 'illustration', animated: 1, frame_count: 2 },
        { content_kind: 'illustration', animated: 1, frame_count: 2 },
      ],
      links: [[[NEW_TAG, 'auto', true]], []],
      // 动的插画和静态插画一样进「插画 · 漫画」的未识别队列（有建议的那一段），不在「照片 · 文字等」里
      art: { total: 1, suggested: 1 },
      annex: 0,
      pixiv: 1,
      filtered: ['12345678_p0.webp', 'a.webp'],
      stats: { illustration: 2, animated: 2 },
    });
    expect(results[1]).toEqual(results[0]);
  });

  it('改类型不动「是否动图」；动图不能当类型选', async () => {
    const { ds, put, scan, id } = await libraryEngine();
    put('a.webp', await animatedWebp([30, 60]));
    await scan();
    const a = String(id('a.webp'));
    for (const kind of ['meme', 'photo', 'illustration', 'auto'] as const) {
      await ds.updateImage(a, { kind });
      expect((await ds.getImage(a))).toMatchObject({ kind: kind === 'auto' ? 'illustration' : kind, animated: true, animatedReason: 'WEBP · 2 帧' });
    }
    await expect(ds.updateImage(a, { kind: 'animated' as never })).rejects.toThrow('「动图」不是类型了');
  });
});
