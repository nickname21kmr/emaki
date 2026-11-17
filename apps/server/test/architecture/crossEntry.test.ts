/**
 * 跨入口一致性（P0 护栏，docs/core-architecture.md 第 4.2、8、12 节）。
 *
 * 同一份证据从不同入口进来（首次识别写入、补采纳、手动改类型、自动改类型、Pixiv 补充、单张采纳、批量归类、整组替换），
 * 结果必须相同：同样的角色关联、同样可辨认的来历、同样的资格判断、同样会套排除规则。
 * 用的是真实的 SqliteDataSource（内存库），图片行直接插进库里，不碰文件。
 *
 * 现在不一致的用例用 it.fails 标出来，注释里写明附录编号（docs/core-architecture-inventory.md）和修好它的阶段。
 * 修好之后把 it.fails 改回 it——it.fails 的用例一旦通过，测试就会失败，提醒去改。
 *
 * 来历现在只能从 image_characters 的 origin、score 读出来（manual / tagger，分数为空表示「手动」）。
 * P3 换成统一的来历字段后，改 provenance() 这一处即可。
 */
import type { JobContext } from '../../src/core/jobs.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { searchKey } from '@emaki/shared';
import { EventBus } from '../../src/core/events.ts';
import { applyExclusionRules } from '../../src/datasource/sqlite/exclusions.ts';
import { SqliteDataSource } from '../../src/datasource/sqlite/SqliteDataSource.ts';
import { backfillClassification } from '../../src/services/classify/backfill.ts';
import { CharacterCatalog } from '../../src/services/catalog/characterCatalog.ts';
import { CopyrightResolver } from '../../src/services/catalog/copyrights.ts';
import type { PixivArtwork } from '../../src/services/pixiv/client.ts';
import { pendingPixivCount, queuePixivImages, resetPixivBackoff, syncPixivCharacters } from '../../src/services/pixiv/sync.ts';
import { TagResultWriter } from '../../src/services/tagger/writer.ts';
import { makeTmpDir } from '../helpers/tmp.ts';

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
  const ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, clock: () => NOW, autoJobs: false, importDict: false });
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
 * 首次识别写入：和识别任务一样用 TagResultWriter 写一批（同一个事务），批后同样套排除规则、登记 Pixiv。
 * （SqliteDataSource.open 里给识别任务接的 afterBatchInTx 就是这两步）
 */
function recognize(ds: SqliteDataSource, batch: { id: number; general?: Scores; character: Scores }[], autoAcceptThreshold = 0.85): void {
  const { catalog, copyrights } = ds.makeCatalog();
  const writer = new TagResultWriter(ds.ctx.db, catalog, copyrights, {
    repo: 'test/model',
    generalThreshold: 0.35,
    characterThreshold: 0.35,
    autoAcceptThreshold,
    now: () => NOW,
    afterBatchInTx: (ids) => {
      applyExclusionRules(ds.ctx, { imageIds: ids });
      queuePixivImages(ds.ctx, ids);
    },
  });
  writer.writeBatch(batch.map((b) => ({ id: b.id, ok: true as const, rating: null, general: [['1girl', 0.9], ...(b.general ?? [])], character: b.character })));
}

/** 一张图的角色关联：[角色标签, 手动 / 自动, 有没有依据的证据]，按标签排序 */
function provenance(ds: SqliteDataSource, imageId: number): [string, 'manual' | 'auto', boolean][] {
  const rows = ds.ctx.db
    .prepare(
      `SELECT COALESCE(c.danbooru_tag, c.name) AS tag, ic.origin, ic.score FROM image_characters ic JOIN characters c ON c.id = ic.character_id
       WHERE ic.image_id = ? ORDER BY tag`,
    )
    .all(imageId) as { tag: string; origin: string; score: number | null }[];
  // 现在的约定：origin = 'manual' 或分数为空都表示「手动」（附录 #5）
  return rows.map((r) => [r.tag, r.origin === 'manual' || r.score === null ? 'manual' : 'auto', r.score !== null]);
}

const linkedTags = (ds: SqliteDataSource, imageId: number) => provenance(ds, imageId).map(([tag]) => tag);
const characterId = (ds: SqliteDataSource, tag: string) =>
  String(ds.ctx.db.prepare('SELECT id FROM characters WHERE danbooru_tag = ?').pluck().get(tag) as number);
const kindOf = (ds: SqliteDataSource, id: number) => ds.ctx.db.prepare('SELECT content_kind FROM images WHERE id = ?').pluck().get(id) as string;
const excluded = (ds: SqliteDataSource, id: number) => ds.ctx.db.prepare('SELECT excluded_by IS NOT NULL FROM images WHERE id = ?').pluck().get(id) === 1;

describe('自动关联：同一份模型证据，从哪个入口进来结果都一样', () => {
  // 附录 #1：识别写入时新角色能不能建档取决于它在批次里的先后（writer.ts 逐张建档），补采纳按整批收集新标签。
  // 同一批里一张截图、一张插画都认出同一个新角色：截图排在前面时不关联，排在后面时关联。P3（decideAuto）修好
  it.fails('首次识别写入不取决于批次里的先后，和补采纳一致（附录 #1，P3）', async () => {
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

  // 附录 #3：只有手动改类型会重新评估自动关联（kinds.ts）。帧数检测、相机识别、扫描重判这些自动改类型的路径不会。
  // 这里模拟缩略图任务的帧数检测：PNG 读出 2 帧 → 自动重判成动图（ThumbnailService.frameMetadata 做的就是这两步）。P2/P3 修好
  it.fails('自动改类型和手动改类型一样会重新评估（附录 #3，P2/P3）', async () => {
    const manual = await engine();
    const auto = await engine();
    for (const ds of [manual, auto]) {
      addImage(ds, { id: 1 });
      recognize(ds, [{ id: 1, general: [[UI_TAG, 0.9]], character: [[NEW_TAG, 0.9]] }]);
      expect(kindOf(ds, 1)).toBe('screenshot');
    }
    await manual.updateImage('1', { kind: 'animated' });
    auto.ctx.db.prepare('UPDATE images SET frame_count = 2 WHERE id = 1').run();
    backfillClassification(auto.ctx.db, { ids: [1] });

    expect(kindOf(auto, 1)).toBe('animated');
    expect(linkedTags(manual, 1)).toEqual([NEW_TAG]);
    expect(provenance(auto, 1)).toEqual(provenance(manual, 1));
  });
});

describe('Pixiv 和模型：同样的置信度，同样的资格判断', () => {
  // 附录 #2：Pixiv 的资格判断写死了 cs.score >= 0.8（pixiv/sync.ts），而模型按设置里的自动采纳阈值（默认 0.85）。
  // 模型分数没到阈值（没自动关联）的图，应当和没有模型证据的图一样去查 Pixiv；反过来到了阈值的已经关联，不用再查。P3 修好
  it.fails('模型没自动关联的图都会排进 Pixiv 补充，和分数落在哪一档无关（附录 #2，P3）', async () => {
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

  // 附录 #1：Pixiv 能不能处理漫画页看设置（comicInUnrecognized，QUEUE_KINDS_SQL），模型的识别写入和补采纳总是允许漫画。P3 修好
  it.fails('漫画页：模型能自动关联的，Pixiv 也会去查（附录 #1，P3）', async () => {
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

  // 附录 #5、#7：Pixiv 的自动关联存成 origin = 'tagger' 且分数为空，和「手动」的记法撞在一起；
  // 模型的自动关联带分数。两种来源的自动关联都应当记成「自动 + 依据的证据」。P3（统一来历）修好
  it.fails('Pixiv 的自动关联和模型的自动关联来历一样可辨认（附录 #5，P3）', async () => {
    const ds = await engine();
    addImage(ds, { id: 1, post: '1003' });
    addImage(ds, { id: 2 });
    recognize(ds, [{ id: 2, character: [[KNOWN, 0.9]] }]);
    queuePixivImages(ds.ctx, [1]);
    resetPixivBackoff();
    const artwork: PixivArtwork = { id: '1003', pageCount: 1, tags: { tags: [{ tag: 'アリス' }, { tag: 'ゲームA' }] } };
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

  // 附录 #14：批量 assign、updateImage 整组替换（还有角色合并、查重合并）新增关联后不套排除规则。P2（reevaluateExclusions）修好
  it.fails('所有入口新增关联后都会套排除规则（附录 #14，P2）', async () => {
    expect(await run(entries.map(([n]) => n))).toEqual([]);
  });
});
