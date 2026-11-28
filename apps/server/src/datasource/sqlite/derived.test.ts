/**
 * 派生缓存（角色 / 作品的张数和封面）：多久重建一次，以及归类、原创之后的定向重算。
 * 定向重算只重数涉及的角色和作品，这里拿它和「重新整份 build()」逐字段对拍：计数必须完全相等，封面只在整份重建的那几步比。
 */
import type { MutationResult } from '@emaki/shared';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/events.ts';
import type { Db } from '../../db/connection.ts';
import { runAs } from '../../propagation/actor.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { Derived, type DerivedData } from './derived.ts';

const DAY = 86_400_000;
/** 本地上午 10 点：往后拨一个多小时不会跨过零点 */
const MORNING = new Date(2026, 10, 27, 10, 0, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const opened: { ds: SqliteDataSource; dir: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { ds, dir } of opened.splice(0)) {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const CHARACTERS = 24;
const WORKS = 12;

/**
 * 合成的库：12 部作品（一批图涉及的作品可以超过 8 部：那时全部作品一遍数完）、24 个角色（21–24 是自建的，一开始没有图）、images 张图。
 * 有漫画、截图、排除、回收站、丢失、停用文件夹里的图，同框的图，手动指定作品的图，还没建档的建议标签。
 */
function seed(db: Db, now: number, images: number): void {
  db.exec("INSERT INTO library_roots (id, path) VALUES (1, 'D:/derived'), (2, 'D:/off'); UPDATE library_roots SET enabled = 0 WHERE id = 2;");
  const work = db.prepare("INSERT INTO works (id, name, danbooru_tag, created_at) VALUES (?, ?, ?, '2026-01-01')");
  for (let w = 1; w <= WORKS; w++) work.run(w, `作品${w}`, `work_${w}`);
  const ch = db.prepare('INSERT INTO characters (id, name, danbooru_tag, source, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const cw = db.prepare('INSERT INTO character_works (character_id, work_id, position) VALUES (?, ?, ?)');
  for (let c = 1; c <= CHARACTERS; c++) {
    const custom = c > 20;
    ch.run(c, `角色${c}`, custom ? null : `char_${c}_(work_${(c % WORKS) + 1})`, custom ? 'custom' : 'danbooru', c % 2 ? null : iso(now - 10 * DAY), '2026-01-01');
    if (c <= 22) cw.run(c, (c % WORKS) + 1, 0);
    if (c % 5 === 0) cw.run(c, ((c + 2) % WORKS) + 1, 1);
  }
  const img = db.prepare(
    `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
       content_kind, content_kind_source, content_kind_manual, tagged_at, rating, favorite, missing, trashed_at)
     VALUES (@id, @root, @rel, @name, 1200, 1700, 1000, 'png', @sha, @at, @at, @kind, 'default', 1, @at, @rating, @fav, @missing, @trashed)`,
  );
  const link = db.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (?, ?, 'manual', 'user', ?)");
  const manualWork = db.prepare('INSERT INTO image_copyrights (image_id, work_id) VALUES (?, ?)');
  const evidence = db.prepare("INSERT INTO character_evidence (image_id, provider, tag, score) VALUES (?, 'tagger', ?, 0.5)");
  const rule = db.prepare("INSERT INTO exclusions (kind, target, label, created_at) VALUES ('image', ?, ?, 'x')");
  const exclude = db.prepare('UPDATE images SET excluded_by = ? WHERE id = ?');
  db.transaction(() => {
    for (let id = 1; id <= images; id++) {
      const at = iso(now - (id % 90) * DAY - id * 60_000);
      img.run({
        id,
        root: id % 37 === 0 ? 2 : 1,
        rel: `d${id % 20}/${id}.png`,
        name: `${id}.png`,
        sha: `sha${id}`,
        at,
        kind: id % 11 === 0 ? 'comic' : id % 17 === 0 ? 'screenshot' : 'illustration',
        rating: id % 7 === 0 ? 'explicit' : id % 5 === 0 ? 'questionable' : 'general',
        fav: id % 13 === 0 ? 1 : 0,
        missing: id % 53 === 0 ? 1 : 0,
        trashed: id % 41 === 0 ? at : null,
      });
      if (id % 4) {
        const a = (id % 20) + 1;
        link.run(id, a, at);
        const b = ((id * 7) % 20) + 1;
        if (id % 6 === 0 && b !== a) link.run(id, b, at);
      } else {
        if (id % 8 === 0) manualWork.run(id, (id % WORKS) + 1);
        // 没认出的图带一条对不上任何角色的建议（按标签建档用）
        evidence.run(id, `fresh_${id % 5}_(work_1)`);
      }
      if (id % 29 === 0) exclude.run(Number(rule.run(String(id), `图 ${id}`).lastInsertRowid), id);
    }
  })();
}

async function engine(opts: { images?: number; clock?: () => number } = {}): Promise<SqliteDataSource> {
  const dir = makeTmpDir('derived');
  const clock = opts.clock ?? (() => MORNING);
  const ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false, clock });
  opened.push({ ds, dir });
  seed(ds.ctx.db, clock(), opts.images ?? 700);
  ds.ctx.invalidate();
  return ds;
}

type Internals = { build(now: number): unknown; track: { coverIds: Set<number>; charsOfImage: Map<number, number[]> } | null };
const internals = (d: Derived) => d as unknown as Internals;
const builds = (ds: SqliteDataSource) => vi.spyOn(internals(ds.derived), 'build');

/** 和计数有关的字段（定向重算负责的那部分），外加编目字段（定向重算不该碰） */
function counts(d: DerivedData) {
  return {
    characters: [...d.characters.values()].map((c) => ({
      id: c.id,
      name: c.name,
      workIds: c.workIds,
      imageCount: c.imageCount,
      otherCount: c.otherCount,
      newCount: c.newCount,
      recentCount: c.recentCount,
      lastAddedAt: c.lastAddedAt,
      lastSeenAt: c.lastSeenAt,
    })),
    works: [...d.works.values()].map((w) => ({
      id: w.id,
      name: w.name,
      imageCount: w.imageCount,
      otherCount: w.otherCount,
      recentImageCount: w.recentImageCount,
      characterCount: w.characterCount,
    })),
  };
}
const everything = (d: DerivedData) => ({ characters: [...d.characters.values()], works: [...d.works.values()] });
const sortedLinks = (m: Map<number, number[]>) => [...m].sort((a, b) => a[0] - b[0]);

/** 现在的缓存和重新 build() 的比：计数逐字段相等，图 → 角色的反查表也相等；whole = 连封面在内整份相等 */
function expectFresh(ds: SqliteDataSource, whole: boolean, label: string): void {
  const got = ds.derived.get();
  const fresh = new Derived(ds.ctx);
  const want = fresh.get();
  expect(counts(got), label).toEqual(counts(want));
  expect(sortedLinks(internals(ds.derived).track!.charsOfImage), label).toEqual(sortedLinks(internals(fresh).track!.charsOfImage));
  if (whole) expect(everything(got), label).toEqual(everything(want));
}

/** 确定的伪随机数（mulberry32） */
function rng(seedValue: number) {
  let a = seedValue >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return {
    next,
    int,
    pick: <T,>(xs: readonly T[]): T => xs[int(xs.length)]!,
    sample: <T,>(xs: readonly T[], n: number): T[] => {
      const pool = [...xs];
      const out: T[] = [];
      while (out.length < n && pool.length) out.push(pool.splice(int(pool.length), 1)[0]!);
      return out;
    },
  };
}

describe('多久重建一次', () => {
  it('没有变化时最多用 1 小时；本地日期变了也重建；用户的操作让它失效后马上重建', async () => {
    let now = MORNING;
    const ds = await engine({ images: 60, clock: () => now });
    const first = ds.derived.get();
    now += 59 * 60_000;
    expect(ds.derived.get()).toBe(first);
    now += 2 * 60_000;
    const second = ds.derived.get();
    expect(second).not.toBe(first);
    expect(second.builtAt).toBe(now);
    // 23:30 建的，过了零点（才 40 分钟）也重建：「最近 30 天」按天挪了一格
    now = new Date(2026, 10, 27, 23, 30, 0).getTime();
    ds.derived.invalidate();
    const night = ds.derived.get();
    now += 20 * 60_000;
    expect(ds.derived.get()).toBe(night);
    now += 20 * 60_000;
    expect(ds.derived.get()).not.toBe(night);
    // 硬失效：下一次读就是新的
    const before = ds.derived.get();
    ds.derived.invalidate();
    expect(ds.derived.get()).not.toBe(before);
  });

  it('统计这类结果同样：同一天里是缓存的那一份，过了零点重算', async () => {
    let now = new Date(2026, 10, 27, 23, 30, 0).getTime();
    const ds = await engine({ images: 60, clock: () => now });
    const summary = await ds.getSummary();
    const kinds = await ds.listContentKinds();
    now += 20 * 60_000;
    expect(await ds.getSummary()).toBe(summary);
    now += 20 * 60_000;
    const next = await ds.getSummary();
    expect(next).not.toBe(summary);
    expect(await ds.listContentKinds()).not.toBe(kinds);
    // 「本周新收」的 7 格往后挪了一天
    expect(next.added.last7Days.slice(0, 6)).toEqual(summary.added.last7Days.slice(1));
  });
});

describe('归类、原创之后只重算涉及的角色和作品', () => {
  it('随机 200 步（归类、移出、整组替换、标原创、取消原创、各自的撤销，单张和批量混着）：计数和重新 build() 的逐字段相等', async () => {
    const ds = await engine();
    const db = ds.ctx.db;
    const r = rng(20261128);
    const build = builds(ds);
    ds.derived.get();
    const visible = () => (db.prepare('SELECT id FROM v_images ORDER BY id').pluck().all() as number[]).map(String);
    const ofCharacter = (c: number) => (db.prepare('SELECT ic.image_id FROM image_characters ic JOIN v_images i ON i.id = ic.image_id WHERE ic.character_id = ? ORDER BY 1').pluck().all(c) as number[]).map(String);
    // 多数时候挑本来就有图的角色；偶尔挑到没图的（1、5、9、13、17 和 21–24 一开始都没有图），那一步会从没图变成有图
    const WITH_IMAGES = [2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20];
    const anyCharacter = () => String(r.next() < 0.88 ? r.pick(WITH_IMAGES) : 1 + r.int(CHARACTERS));
    const some = (pool: string[]) => r.sample(pool, r.next() < 0.6 ? 1 : 2 + r.int(40));
    const undoable: string[] = [];
    const done = (res: MutationResult) => void (res.undoToken && undoable.push(res.undoToken));

    const steps: [number, string, () => Promise<void>][] = [
      [26, '归类', async () => done(await ds.bulkImages({ ids: some(visible()), action: { type: 'assign', characterId: anyCharacter() } }))],
      [
        20,
        '移出',
        async () => {
          const c = anyCharacter();
          const pool = ofCharacter(Number(c));
          if (pool.length) done(await ds.bulkImages({ ids: some(pool), action: { type: 'unassign', characterId: c } }));
        },
      ],
      [12, '整组替换', async () => done(await ds.updateImage(r.pick(visible()), { characterIds: r.sample(['2', '3', '4', '7', '8', '10', '21', '22'], r.int(4)) }))],
      [8, '标原创', async () => done(await ds.bulkImages({ ids: some(visible()), action: { type: 'original', value: true } }))],
      [6, '取消原创', async () => done(await ds.bulkImages({ ids: some(visible()), action: { type: 'original', value: false } }))],
      [
        20,
        '撤销',
        async () => {
          // 最近几次里随便撤一次（不一定是最后一次）
          if (!undoable.length) return;
          const [token] = undoable.splice(Math.max(0, undoable.length - 1 - r.int(4)), 1);
          await ds.undo(token!).catch(() => undefined);
        },
      ],
      [3, '看过了', () => ds.markCharacterSeen(anyCharacter())],
      [2, '收藏', async () => done(await ds.bulkImages({ ids: some(visible()), action: { type: 'favorite', value: r.next() < 0.5 } }))],
      [2, '改分级', async () => done(await ds.bulkImages({ ids: some(visible()), action: { type: 'rating', value: r.pick(['general', 'explicit'] as const) } }))],
      [
        2,
        '按标签建档',
        async () => {
          const row = db
            .prepare("SELECT s.image_id AS id, s.danbooru_tag AS tag FROM v_character_suggestions s JOIN v_counted_images i ON i.id = s.image_id WHERE s.danbooru_tag LIKE 'fresh_%' ORDER BY s.image_id LIMIT 1 OFFSET ?")
            .get(r.int(20)) as { id: number; tag: string } | undefined;
          if (row) done(await ds.bulkImages({ ids: [String(row.id)], action: { type: 'assignTag', danbooruTag: row.tag } }));
        },
      ],
      [1, '排除', async () => done(await ds.bulkImages({ ids: [r.pick(visible())], action: { type: 'exclude' } }))],
    ];
    const weight = steps.reduce((sum, s) => sum + s[0], 0);
    const pickStep = () => {
      let at = r.int(weight);
      return steps.find((s) => (at -= s[0]) < 0)!;
    };

    const ran = new Map<string, number>();
    let targeted = 0;
    let rebuilt = 0;
    for (let step = 1; step <= 200; ) {
      // 有时连着做两三步再读：攒着的定向重算要一起做对
      const batch: string[] = [];
      const before = build.mock.calls.length;
      for (let k = r.next() < 0.75 ? 1 : 2 + r.int(2); k > 0 && step <= 200; k--, step++) {
        const [, name, run] = pickStep();
        await run();
        batch.push(name);
        ran.set(name, (ran.get(name) ?? 0) + 1);
      }
      ds.derived.get();
      const whole = build.mock.calls.length > before;
      if (whole) rebuilt++;
      else targeted++;
      expectFresh(ds, whole, `第 ${step - 1} 步（${batch.join(' + ')}）${whole ? '整份重建' : '定向重算'}`);
    }
    // 大多数时候走的是定向重算，每种操作都轮到过
    expect(targeted, `定向 ${targeted} 轮，整份重建 ${rebuilt} 轮`).toBeGreaterThan(rebuilt);
    expect([...ran.keys()].sort()).toEqual(steps.map((s) => s[1]).sort());
  });

  it('退回整份重建：改到现在的封面图', async () => {
    const ds = await engine();
    const build = builds(ds);
    ds.derived.get();
    // 角色 2 的封面图，再归给本来就有图的角色 3（没有谁从没图变成有图）
    const cover = ds.derived.get().characters.get(2)!.effectiveCoverId!;
    expect(internals(ds.derived).track!.coverIds.has(cover)).toBe(true);
    const n = build.mock.calls.length;
    await ds.bulkImages({ ids: [String(cover)], action: { type: 'assign', characterId: '3' } });
    ds.derived.get();
    expect(build.mock.calls.length).toBe(n + 1);
    expectFresh(ds, true, '封面图');
  });

  it('退回整份重建：有角色从没图变成有图、从有图变成没图', async () => {
    const ds = await engine();
    const build = builds(ds);
    ds.derived.get();
    const covers = internals(ds.derived).track!.coverIds;
    const plain = (ds.ctx.db.prepare('SELECT id FROM v_illust_images ORDER BY id').pluck().all() as number[]).filter((id) => !covers.has(id)).map(String);
    // 角色 23 一开始没有图：0 → 1，要挑封面
    let n = build.mock.calls.length;
    await ds.bulkImages({ ids: [plain[0]!], action: { type: 'assign', characterId: '23' } });
    expect(ds.derived.get().characters.get(23)).toMatchObject({ imageCount: 1, effectiveCoverId: Number(plain[0]) });
    expect(build.mock.calls.length).toBe(n + 1);
    // 再加一张：1 → 2，定向重算
    n = build.mock.calls.length;
    await ds.bulkImages({ ids: [plain[1]!], action: { type: 'assign', characterId: '23' } });
    expect(ds.derived.get().characters.get(23)).toMatchObject({ imageCount: 2 });
    expect(build.mock.calls.length).toBe(n);
    expectFresh(ds, false, '1 → 2');
    // 角色 24 也没有图：归一张漫画页给它，非插画张数 0 → 1（没有插画时漫画页兜底当封面）
    const comic = String(ds.ctx.db.prepare("SELECT id FROM v_counted_images WHERE content_kind = 'comic' AND id % 4 = 0 ORDER BY id LIMIT 1").pluck().get());
    await ds.bulkImages({ ids: [comic], action: { type: 'assign', characterId: '24' } });
    expect(ds.derived.get().characters.get(24)).toMatchObject({ imageCount: 0, otherCount: 1, effectiveCoverId: Number(comic) });
    expect(build.mock.calls.length).toBe(n + 1);
    // 两张都移出：2 → 0，封面没了
    n = build.mock.calls.length;
    await ds.bulkImages({ ids: [plain[0]!, plain[1]!], action: { type: 'unassign', characterId: '23' } });
    expect(ds.derived.get().characters.get(23)).toMatchObject({ imageCount: 0, effectiveCoverId: null });
    expect(build.mock.calls.length).toBe(n + 1);
    expectFresh(ds, true, '2 → 0');
  });

  it('退回整份重建：一次超过 500 张，或者攒着没读的加起来超过 500 张', async () => {
    const ds = await engine({ images: 1300 });
    const build = builds(ds);
    ds.derived.get();
    const db = ds.ctx.db;
    /** 不是封面、也还没归给这些角色的图（归过的不算变化） */
    const free = (...characters: number[]) => {
      ds.derived.get();
      const covers = internals(ds.derived).track!.coverIds;
      const linked = new Set(
        db.prepare('SELECT image_id FROM image_characters WHERE character_id IN (SELECT value FROM json_each(?))').pluck().all(JSON.stringify(characters)) as number[],
      );
      return (db.prepare('SELECT id FROM v_images ORDER BY id').pluck().all() as number[]).filter((id) => !covers.has(id) && !linked.has(id)).map(String);
    };
    let n = build.mock.calls.length;
    await ds.bulkImages({ ids: free(2).slice(0, 500), action: { type: 'assign', characterId: '2' } });
    ds.derived.get();
    expect(build.mock.calls.length, '500 张：定向重算').toBe(n);
    expectFresh(ds, false, '500 张');
    await ds.bulkImages({ ids: free(3).slice(0, 501), action: { type: 'assign', characterId: '3' } });
    ds.derived.get();
    expect(build.mock.calls.length, '501 张：整份重建').toBe(n + 1);
    // 两次各 300 张，中间没读
    const pool = free(4, 6);
    n = build.mock.calls.length;
    await ds.bulkImages({ ids: pool.slice(0, 300), action: { type: 'assign', characterId: '4' } });
    await ds.bulkImages({ ids: pool.slice(300, 600), action: { type: 'assign', characterId: '6' } });
    ds.derived.get();
    expect(build.mock.calls.length, '300 + 300 张：整份重建').toBe(n + 1);
    expectFresh(ds, true, '300 + 300 张');
  });

  it('退回整份重建：归类时按标签新建了角色（编目变了），撤销把它删掉也是', async () => {
    const ds = await engine();
    const build = builds(ds);
    ds.derived.get();
    const row = ds.ctx.db
      .prepare("SELECT s.image_id AS id, s.danbooru_tag AS tag FROM v_character_suggestions s JOIN v_counted_images i ON i.id = s.image_id WHERE s.danbooru_tag LIKE 'fresh_%' ORDER BY s.image_id LIMIT 1")
      .get() as { id: number; tag: string };
    let n = build.mock.calls.length;
    const made = await ds.bulkImages({ ids: [String(row.id)], action: { type: 'assignTag', danbooruTag: row.tag } });
    const d = ds.derived.get();
    expect(build.mock.calls.length).toBe(n + 1);
    expect([...d.characters.values()].find((c) => c.danbooruTag === row.tag)).toMatchObject({ imageCount: 1 });
    expectFresh(ds, true, '新建角色');
    n = build.mock.calls.length;
    await ds.undo(made.undoToken!);
    expect([...ds.derived.get().characters.values()].some((c) => c.danbooruTag === row.tag)).toBe(false);
    expect(build.mock.calls.length).toBe(n + 1);
    expectFresh(ds, true, '撤销新建角色');
  });

  it('退回整份重建：标原创时新建了「原创」作品，撤销把它删掉也是', async () => {
    const ds = await engine();
    const build = builds(ds);
    ds.derived.get();
    const covers = internals(ds.derived).track!.coverIds;
    const id = (ds.ctx.db.prepare('SELECT id FROM v_illust_images WHERE id % 4 = 0 ORDER BY id').pluck().all() as number[]).find((x) => !covers.has(x))!;
    const original = (d: DerivedData) => [...d.works.values()].find((w) => w.danbooruTag === 'original');
    expect(original(ds.derived.get())).toBeUndefined();
    let n = build.mock.calls.length;
    const marked = await ds.bulkImages({ ids: [String(id)], action: { type: 'original', value: true } });
    expect(original(ds.derived.get())).toMatchObject({ imageCount: 1 });
    expect(build.mock.calls.length).toBe(n + 1);
    expectFresh(ds, true, '新建「原创」作品');
    n = build.mock.calls.length;
    await ds.undo(marked.undoToken!);
    expect(original(ds.derived.get())).toBeUndefined();
    expect(build.mock.calls.length).toBe(n + 1);
    expectFresh(ds, true, '撤销');
  });

  it('同一个编号删了又建成别的角色（建档 → 撤销 → 再按另一个标签建档，中间没读）：不会把旧角色的名字留下', async () => {
    const ds = await engine();
    // 挑截图：截图不当封面，撤销时不会因为「改到封面图」顺带整份重建，只能靠编目的规模看出来
    const fresh = ds.ctx.db
      .prepare(
        `SELECT MIN(s.image_id) AS id, s.danbooru_tag AS tag FROM v_character_suggestions s JOIN v_counted_images i ON i.id = s.image_id
         WHERE s.danbooru_tag LIKE 'fresh_%' AND i.content_kind = 'screenshot' GROUP BY s.danbooru_tag ORDER BY tag LIMIT 2`,
      )
      .all() as { id: number; tag: string }[];
    const [a, b] = fresh as [(typeof fresh)[number], (typeof fresh)[number]];
    const made = await ds.bulkImages({ ids: [String(a.id)], action: { type: 'assignTag', danbooruTag: a.tag } });
    const first = [...ds.derived.get().characters.values()].find((c) => c.danbooruTag === a.tag)!;
    expect(first).toMatchObject({ imageCount: 0, otherCount: 1, effectiveCoverId: null });
    await ds.undo(made.undoToken!);
    await ds.bulkImages({ ids: [String(b.id)], action: { type: 'assignTag', danbooruTag: b.tag } });
    const second = ds.derived.get().characters.get(first.id)!;
    // 编号被新角色拿走了
    expect(second).toMatchObject({ danbooruTag: b.tag, otherCount: 1 });
    expectFresh(ds, true, '编号复用');
  });

  it('这份缓存已经被后台任务写旧了（软失效，还在窗口里）：用户再归类时整份重建，后台的改动一起看到', async () => {
    const ds = await engine();
    const db = ds.ctx.db;
    // 内存库的软窗口是 0，这里单独建一份带 60 秒软窗口的
    const d = new Derived(ds.ctx, () => 60_000);
    const first = d.get();
    const covers = internals(d).track!.coverIds;
    const [a, b] = (db.prepare('SELECT id FROM v_illust_images WHERE id % 4 = 0 ORDER BY id').pluck().all() as number[]).filter((id) => !covers.has(id)) as [number, number];
    const link = db.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (?, ?, 'manual', 'user', 'x')");
    const none = { all: false, covers: [], links: [], original: [], seen: [] };
    // 后台任务归了一张：软失效，窗口里继续用旧的
    link.run(a, 6);
    d.narrow({ ...none, links: [a] }, true);
    expect(d.get()).toBe(first);
    // 用户归了另一张：不能只重算这一张涉及的角色（反查表里没有后台那一笔）
    link.run(b, 7);
    d.narrow({ ...none, links: [b] }, false);
    const after = d.get();
    expect(after).not.toBe(first);
    const want = new Derived(ds.ctx).get();
    expect(counts(after)).toEqual(counts(want));
    expect(after.characters.get(6)!.imageCount).toBe(first.characters.get(6)!.imageCount + 1);
    expect(after.characters.get(7)!.imageCount).toBe(first.characters.get(7)!.imageCount + 1);
  });

  it('后台任务的归类（软失效）不做定向重算：照旧等软窗口到了整份重建', async () => {
    const ds = await engine();
    const db = ds.ctx.db;
    const build = builds(ds);
    const covers = (ds.derived.get(), internals(ds.derived).track!.coverIds);
    const a = (db.prepare('SELECT id FROM v_illust_images WHERE id % 4 = 0 ORDER BY id').pluck().all() as number[]).find((id) => !covers.has(id))!;
    const n = build.mock.calls.length;
    runAs('job:tag', () =>
      ds.ctx.apply(() => {
        db.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (?, 6, 'manual', 'job:tag', 'x')").run(a);
        ds.ctx.changed({ type: 'curation.charactersChanged', ids: [a] });
      }),
    );
    // 内存库的软窗口是 0：下一次读就整份重建
    ds.derived.get();
    expect(build.mock.calls.length).toBe(n + 1);
    expectFresh(ds, true, '后台归类');
  });

  it('定向重算换的是新对象：之前拿到的那份不会被悄悄改掉', async () => {
    const ds = await engine();
    const before = ds.derived.get();
    const c2 = before.characters.get(2)!;
    const covers = internals(ds.derived).track!.coverIds;
    const id = (ds.ctx.db.prepare('SELECT id FROM v_illust_images WHERE id % 4 = 0 ORDER BY id').pluck().all() as number[]).find((x) => !covers.has(x))!;
    const c3 = before.characters.get(3)!;
    await ds.bulkImages({ ids: [String(id)], action: { type: 'assign', characterId: '2' } });
    const after = ds.derived.get();
    expect(after).not.toBe(before);
    expect(after.characters.get(2)).not.toBe(c2);
    expect(after.characters.get(2)!.imageCount).toBe(c2.imageCount + 1);
    // 没涉及的角色还是原来的对象
    expect(after.characters.get(3)).toBe(c3);
  });
});
