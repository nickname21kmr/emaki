/**
 * 附录 #24–#30、#32、#38 已关闭（P5 读模型，docs/core-architecture.md 第 6 节）：每条一组用例，跑在真实引擎（契约夹具，内存库）上。
 * 「口径只在一处定义」本身由 terms.test.ts（源码扫描）和 src/readmodel/terms.test.ts（SQL 和 JS 两个版本逐个组合比对）证明；
 * 这里证明各个入口拿到的数字、事实、文案确实一致。汇总接口和旧数字的逐项对账在 src/readmodel/summary.test.ts。
 */
import {
  CHAPTER_MARKS,
  COLLECTION_KIND_META,
  KIND_LABEL as SHARED_KIND_LABEL,
  JOB_LABEL,
  organizeFolderName,
  volumeUnit,
} from '@emaki/shared';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/events.ts';
import { JobQueue } from '../../src/core/jobs.ts';
import { openDatabase } from '../../src/db/connection.ts';
import { migrate } from '../../src/db/migrate.ts';
import { KIND_LABEL as SERVER_KIND_LABEL } from '../../src/datasource/sqlite/kinds.ts';
import type { SqliteDataSource } from '../helpers/client.ts';
import { readSettings } from '../../src/datasource/sqlite/settings.ts';
import { parseComicDir } from '../../src/domain/collections/parseName.ts';
import { sqliteFactory, type ContractEnv } from '../contract/harness.ts';

let env: ContractEnv;
let ds: SqliteDataSource;
beforeEach(async () => {
  env = await sqliteFactory();
  ds = env.ds as SqliteDataSource;
});
afterEach(() => env.close());

const sql = (s: string, ...args: unknown[]) => ds.ctx.db.prepare(s).run(...args);
const one = (s: string, ...args: unknown[]) => ds.ctx.db.prepare(s).pluck().get(...args);
/** 测试里直接改了表之后，做一次无关紧要的用户操作，让缓存按用户操作强刷新 */
const touch = async () => {
  const any = (await ds.listImages({ limit: 1 })).items[0]!;
  await ds.bulkImages({ ids: [any.id], action: { type: 'favorite', value: any.favorite } });
};
/** 未识别「插画 · 漫画」里的几张 */
const queued = async (n: number) => (await ds.listUnrecognized({ area: 'art', limit: n })).items.map((x) => x.image.id);
const image = async (id: string) => (await ds.getImage(id))!;

/** 同一个数从各个入口取：统计、汇总、未识别页、图片的队列事实 */
async function counts() {
  const [stats, summary, unrec, list] = await Promise.all([ds.getStats(), ds.getSummary(), ds.unrecognizedSummary(), ds.listImages({ limit: 200 })]);
  const kinds = await ds.listContentKinds();
  return { stats, summary, unrec, list, kinds };
}

describe('#24 「可见」只有一个定义：各入口按同一个口径数', () => {
  it('统计、汇总、图片列表、别册目次的张数一致；停用文件夹、移到回收站后一起变', async () => {
    const check = async () => {
      const c = await counts();
      const counted = one('SELECT COUNT(*) FROM v_counted_images') as number;
      expect(c.stats.imageCount).toBe(counted);
      expect(c.summary.images.total).toBe(counted);
      expect(c.list.total).toBe(counted);
      expect(c.kinds.reduce((n, k) => n + k.count, 0)).toBe(counted);
      return counted;
    };
    const before = await check();
    const [a] = await queued(1);
    await ds.bulkImages({ ids: [a!], action: { type: 'trash' } });
    expect(await check()).toBe(before - 1);
    const root = (await ds.getSettings()).libraryRoots.find((r) => r.enabled && r.imageCount > 0)!;
    await ds.updateLibraryRoot(root.id, { enabled: false });
    expect(await check()).toBeLessThan(before - 1);
  });
});

describe('#25 待处理队列只有一份：统计、未识别页、图片事实、汇总一致', () => {
  it('放下、成册、漫画区、关掉漫画设置时，几处的数都对得上', async () => {
    const consistent = async () => {
      const c = await counts();
      expect(c.stats.unrecognizedCount).toBe(c.unrec.art.total);
      expect(c.stats.shelvedCount).toBe(c.unrec.art.shelved);
      expect(c.stats.untaggedCount).toBe(c.unrec.art.untagged);
      return c;
    };
    await consistent();
    const [a, b, c] = await queued(3);
    await ds.bulkImages({ ids: [a!], action: { type: 'shelve', value: true } });
    expect((await image(a!)).queue).toBe('shelved');
    await consistent();
    // 漫画区：以前放下的张数不看漫画区，和未识别页的「放下的」差一截（library.ts 两份队列条件不同）
    const rel = one('SELECT rel_path FROM images WHERE id = ?', Number(a)) as string;
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : null;
    if (dir) {
      sql(`INSERT INTO comic_folders (root_id, rel_dir, created_at) SELECT root_id, ?, '2026-01-01' FROM images WHERE id = ?`, dir, Number(a));
      await touch();
      expect((await image(a!)).queue).toBeNull();
      await consistent();
      sql('DELETE FROM comic_folders');
      await touch();
    }
    // 成册：页不逐张进队列，事实是 book
    const rootId = one('SELECT root_id FROM images WHERE id = ?', Number(b)) as number;
    sql(`INSERT INTO collections (id, root_id, rel_dir, kind, kind_source, origin, state, created_at, updated_at)
      VALUES (900, ?, 'zz', 'doujin', 'manual', 'manual', 'active', '2026-01-01', '2026-01-01')`, rootId);
    sql('UPDATE images SET collection_id = 900, page_no = 1 WHERE id = ?', Number(b));
    await touch();
    expect((await image(b!)).queue).toBe('book');
    await consistent();
    // 关掉「未识别里也列出漫画页」：漫画不在队列里，图片事实也跟着变（以前前端假定漫画一定留在队列）
    await ds.bulkImages({ ids: [c!], action: { type: 'kind', value: 'comic' } });
    expect((await image(c!)).queue).toBe('art');
    await ds.updateSettings({ tagger: { comicInUnrecognized: false } });
    expect((await image(c!)).queue).toBeNull();
    await consistent();
  });
});

describe('#26 作品数和作品列表同一口径', () => {
  it('原创图手动指定了别的作品、模型给了作品证据：侧栏的作品数仍等于作品列表的长度', async () => {
    const [a] = await queued(1);
    const extra = Number(one(`INSERT INTO works (name, danbooru_tag, created_at) VALUES ('只在原创图上', 'only_on_original', '2026-01-01') RETURNING id`));
    const evidenceOnly = Number(one(`INSERT INTO works (name, danbooru_tag, created_at) VALUES ('只是证据', 'only_evidence', '2026-01-01') RETURNING id`));
    await ds.bulkImages({ ids: [a!], action: { type: 'original', value: true } });
    sql('INSERT INTO image_copyrights (image_id, work_id) VALUES (?, ?)', Number(a), extra);
    sql(`INSERT INTO work_evidence (image_id, provider, tag, score) VALUES (?, 'tagger', 'only_evidence', 0.99)`, Number(a));
    await touch();
    const works = await ds.listWorks({});
    expect(works.map((w) => Number(w.id))).not.toContain(extra);
    expect(works.map((w) => Number(w.id))).not.toContain(evidenceOnly);
    expect((await ds.getStats()).workCount).toBe(works.length);
    expect((await ds.getSummary()).works).toBe(works.length);
  });
});

describe('#27 状态拆成三个事实：识别过没有、角色数、所在队列', () => {
  it('图片接口不再有 status；三个事实各说各的', async () => {
    const [a, b] = await queued(2);
    const img = await image(a!);
    expect('status' in img).toBe(false);
    expect(img).toMatchObject({ characterCount: 0, queue: 'art', excluded: false });
    expect(typeof img.tagged).toBe('boolean');
    expect(img.tagged).toBe(one('SELECT tagged_at IS NOT NULL FROM images WHERE id = ?', Number(a)) === 1);
    // 归原创：不在队列；角色数仍是 0
    await ds.bulkImages({ ids: [a!], action: { type: 'original', value: true } });
    expect(await image(a!)).toMatchObject({ characterCount: 0, queue: null, original: true });
    // 改成截图：在「照片 · 文字等」
    await ds.bulkImages({ ids: [b!], action: { type: 'kind', value: 'screenshot' } });
    expect((await image(b!)).queue).toBe('annex');
    // 有角色：不在队列，角色数 1
    const character = (await ds.listCharacters({})).items[0]!;
    await ds.bulkImages({ ids: [b!], action: { type: 'assign', characterId: character.id } });
    expect(await image(b!)).toMatchObject({ characterCount: 1, queue: null });
    // 排除：excluded，事实里不在队列
    await ds.bulkImages({ ids: [b!], action: { type: 'exclude' } });
    expect(await image(b!)).toMatchObject({ excluded: true, queue: null });
  });

  it('列表、未识别、详情给的事实一样', async () => {
    const items = (await ds.listUnrecognized({ area: 'art', limit: 20 })).items;
    for (const it of items) {
      expect(['art', 'shelved']).toContain(it.image.queue);
      expect(it.image.tagged).toBe(it.tagged);
      expect((await image(it.image.id)).queue).toBe(it.image.queue);
    }
  });
});

describe('#28 汇总接口：一个接口给出侧栏、首页、命令面板要显示的计数', () => {
  it('待处理数只有一个定义：等你确认的张数 + 成册待整理', async () => {
    const s = await ds.getSummary();
    const u = await ds.unrecognizedSummary();
    expect(s.triage.total).toBe(u.art.suggested + u.art.unsure + s.triage.books);
    expect(s.triage.waiting).toBe(u.art.untagged);
  });
});

describe('#29 已认出比例：分子分母同一个范围', () => {
  it('成册的页不进分母，放下的进分母不进分子', async () => {
    const before = (await ds.getSummary()).recognition;
    const [a, b] = await queued(2);
    await ds.bulkImages({ ids: [a!], action: { type: 'shelve', value: true } });
    const shelved = (await ds.getSummary()).recognition;
    expect(shelved).toMatchObject({ scope: before.scope, recognized: before.recognized });
    const rootId = one('SELECT root_id FROM images WHERE id = ?', Number(b)) as number;
    sql(`INSERT INTO collections (id, root_id, rel_dir, kind, kind_source, origin, state, created_at, updated_at)
      VALUES (901, ?, 'zz', 'artbook', 'manual', 'manual', 'active', '2026-01-01', '2026-01-01')`, rootId);
    sql('UPDATE images SET collection_id = 901, page_no = 1 WHERE id = ?', Number(b));
    await touch();
    const booked = (await ds.getSummary()).recognition;
    expect(booked).toMatchObject({ scope: before.scope - 1, recognized: before.recognized });
    expect(booked.ratio).toBeCloseTo(booked.recognized / booked.scope);
  });
});

describe('#32 设置只有一份：图库设置和本机偏好分开', () => {
  it('模糊开关、网格密度不在图库设置里；接口传进来也不存', async () => {
    expect((await ds.getSettings()).ui).toEqual({ theme: 'system' });
    await ds.updateSettings({ ui: { theme: 'dark', blurSensitive: false, density: 'compact' } } as never);
    expect((await ds.getSettings()).ui).toEqual({ theme: 'dark' });
    expect(JSON.parse(one(`SELECT value FROM settings WHERE key = 'ui'`) as string)).toEqual({ theme: 'dark' });
  });

  it('迁移 039 清掉以前写进服务端的两项；读的时候也不返回', () => {
    const db = openDatabase(':memory:');
    migrate(db, {});
    db.prepare(`INSERT INTO settings (key, value) VALUES ('ui', ?)`).run(JSON.stringify({ theme: 'light', blurSensitive: true, density: 'compact' }));
    expect(readSettings(db).ui).toEqual({ theme: 'light' });
    db.exec(readFileSync(path.resolve(import.meta.dirname, '../../src/db/migrations/039_device_prefs.sql'), 'utf8'));
    expect(JSON.parse(db.prepare(`SELECT value FROM settings WHERE key = 'ui'`).pluck().get() as string)).toEqual({ theme: 'light' });
    db.close();
  });
});

describe('#38 前后端共用的规则只有一份', () => {
  it('类型、合集类型、任务的名称：服务端的提示文案用 packages/shared 的', async () => {
    expect(SERVER_KIND_LABEL).toBe(SHARED_KIND_LABEL);
    const [a] = await queued(1);
    const r = await ds.bulkImages({ ids: [a!], action: { type: 'kind', value: 'meme' } });
    expect(r.message).toContain(`「${SHARED_KIND_LABEL.meme}」`);
    expect(COLLECTION_KIND_META.doujin.label).toBe('本子');
    const queue = new JobQueue(new EventBus(), () => async () => undefined);
    expect(queue.enqueue('tag').message.startsWith(`${JOB_LABEL.tag}：`)).toBe(true);
  });

  it('排除规则的目标在服务端归一化：网页、HTTP、助手传进来的都一样', async () => {
    await ds.createExclusion({ kind: 'tag', target: '  Some Tag  ' });
    const rule = (await ds.listExclusions()).find((e) => e.kind === 'tag' && e.target.includes('some'));
    expect(rule?.target).toBe('some_tag');
  });

  it('「话 / 册」和服务端解析卷号 / 话数用同一组规则', () => {
    expect(CHAPTER_MARKS.length).toBeGreaterThan(0);
    for (const name of ['第3话', '第12話 出会い', 'Chapter 7', 'Ep.2', '第3回']) {
      expect(volumeUnit(name), name).toBe('话');
      expect(parseComicDir(`某漫画/${name}`, 'D:/漫画').volumeNo, name).not.toBeNull();
    }
    for (const name of ['Vol.03', '第3卷', '某漫画']) expect(volumeUnit(name), name).toBe('册');
  });

  it('剩余时间是任务的结构化字段，不从消息里抠', async () => {
    let seen: number | null | undefined;
    const bus = new EventBus();
    const queue = new JobQueue(bus, () => async (ctx) => {
      ctx.setEta?.(95.4);
      seen = queue.list()[0]!.etaSeconds;
    });
    const job = queue.enqueue('tag');
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toBe(95);
    expect(queue.list().find((j) => j.id === job.id)?.etaSeconds).toBeNull();
  });

  it('组图整理到子文件夹的文件夹名：服务端和确认弹窗同一个函数', () => {
    expect(organizeFolderName('a/b:c')).toBe('a_b_c');
    expect(organizeFolderName(null)).toBe('组图');
    expect(organizeFolderName('...')).toBe('组图');
  });
});
