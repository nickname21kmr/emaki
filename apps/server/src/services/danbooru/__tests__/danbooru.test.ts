/**
 * T11：全部离线（注入假 fetch），夹具用 TASKS.md 里的实测数据。
 */
import { searchKey } from '@emaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '../../../core/jobs.ts';
import { openDatabase, type Db } from '../../../db/connection.ts';
import { migrate } from '../../../db/migrate.ts';
import type { FetchLike, HttpResponse } from '../../../net/http.ts';
import { CharacterCatalog } from '../../catalog/characterCatalog.ts';
import { CopyrightResolver } from '../../catalog/copyrights.ts';
import { HumanizeLocalizer } from '../../i18n/localizer.ts';
import { DanbooruCatalog } from '../catalog.ts';
import { DanbooruClient } from '../client.ts';
import { guessCopyrightFromQualifier, pickCopyrights, type CopyrightCandidate } from '../copyright.ts';
import { decideMatch, findDanbooruMatches, recomputeCustomMatches } from '../matcher.ts';
import { RateLimiter } from '../rateLimiter.ts';
import { createDanbooruSyncRunner } from '../sync.ts';

const cand = (name: string, frequency: number, postCount = 1000, implies: string[] = []): CopyrightCandidate => ({ name, frequency, postCount, implies });

describe('pickCopyrights（实测数据）', () => {
  it.each<[string, CopyrightCandidate[], string[]]>([
    ['mika_(blue_archive)', [cand('blue_archive', 0.9998, 458840), cand('blue_archive_the_animation', 0.0048), cand('comiket_106', 0.0026)], ['blue_archive']],
    [
      'artoria_pendragon_(fate)',
      [cand('fate_(series)', 0.9992), cand('fate/grand_order', 0.5658, 1, ['fate_(series)']), cand('fate/stay_night', 0.3664, 1, ['fate_(series)'])],
      ['fate_(series)'],
    ],
    ["jeanne_d'arc_alter_(fate)", [cand('fate_(series)', 1), cand('fate/grand_order', 0.992, 1, ['fate_(series)'])], ['fate/grand_order', 'fate_(series)']],
    [
      'kafka_(honkai:_star_rail)',
      [cand('honkai_(series)', 1, 191132), cand('honkai:_star_rail', 1, 135426, ['honkai_(series)'])],
      ['honkai:_star_rail', 'honkai_(series)'],
    ],
    ['gawr_gura', [cand('hololive', 1), cand('hololive_english', 1, 1, ['hololive'])], ['hololive_english', 'hololive']],
    [
      'kaname_madoka',
      [cand('mahou_shoujo_madoka_magica', 1), cand('mahou_shoujo_madoka_magica_(anime)', 0.823, 1, ['mahou_shoujo_madoka_magica'])],
      ['mahou_shoujo_madoka_magica'],
    ],
    ['2b_(nier:automata)', [cand('nier_(series)', 0.9966), cand('nier:automata', 0.9952, 1, ['nier_(series)'])], ['nier:automata', 'nier_(series)']],
    ['pikachu', [cand('pokemon', 1), cand('pokemon_(anime)', 0.218)], ['pokemon']],
    ['空', [], []],
  ])('%s', (_name, cands, want) => expect(pickCopyrights(cands)).toEqual(want));
});

let db: Db;
const offline = { 'mika_(blue_archive)': ['blue_archive'] };
beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
});
afterEach(() => db.close());
const catalog = () => new DanbooruCatalog(db, new CopyrightResolver(db, offline));

describe('限定词猜作品', () => {
  it('saber_(fate) → fate_(series)；kafka → honkai:_star_rail；hakurei_reimu → null', () => {
    db.exec(`INSERT INTO tag_i18n (tag, category, post_count) VALUES ('fate_(series)', 3, 900000), ('honkai:_star_rail', 3, 135426);
      INSERT INTO tag_name_keys (search_key, tag, kind, source) VALUES ('${searchKey('fate')}', 'fate_(series)', 'alias', 'dict');`);
    const d = catalog();
    expect(d.copyrights('saber_(fate)')).toEqual(['fate_(series)']);
    expect(d.copyrights('kafka_(honkai:_star_rail)')).toEqual(['honkai:_star_rail']);
    expect(d.copyrights('hakurei_reimu')).toEqual([]);
    expect(guessCopyrightFromQualifier('hakurei_reimu', () => 'x')).toBeNull();
  });

  it('回退链：只有离线表时用离线表；有在线结果后用在线结果', () => {
    const d = catalog();
    expect(d.copyrights('mika_(blue_archive)')).toEqual(['blue_archive']);
    db.prepare("INSERT INTO danbooru_tags (name, category, post_count, fetched_at) VALUES ('mika_(blue_archive)', 4, 1, 'x')").run();
    d.setCopyrights('mika_(blue_archive)', ['blue_archive', 'blue_archive_the_animation'], 'now');
    expect(d.copyrights('mika_(blue_archive)')).toEqual(['blue_archive', 'blue_archive_the_animation']);
  });
});

/** 假 fetch：按路径返回 JSON；记录每次请求 */
function fakeFetch(routes: (url: URL) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const fn: FetchLike = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, headers: init.headers });
    const r = routes(u);
    const res: HttpResponse = {
      status: r.status ?? 200,
      headers: { get: (n) => r.headers?.[n.toLowerCase()] ?? null },
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
    return res;
  };
  return { fn, calls };
}
const noWait = { wait: async () => {} } as unknown as RateLimiter;
const signal = () => new AbortController().signal;

describe('DanbooruClient', () => {
  it('UA 以 Emaki/ 开头；key 走 Authorization，不进 URL', async () => {
    const f = fakeFetch(() => ({ body: [] }));
    await new DanbooruClient({ fetchImpl: f.fn, limiter: noWait, login: 'me', apiKey: 'secret' }).tagsByNames(['a'], signal());
    expect(f.calls[0]!.headers['User-Agent']).toMatch(/^Emaki\//);
    expect(f.calls[0]!.headers.Authorization).toMatch(/^Basic /);
    expect(f.calls[0]!.url.href).not.toContain('secret');
  });

  it('Cloudflare 挑战 → blocked，不重试', async () => {
    const f = fakeFetch(() => ({ status: 403, body: '<html>Just a moment...</html>', headers: { 'cf-mitigated': 'challenge' } }));
    await expect(new DanbooruClient({ fetchImpl: f.fn, limiter: noWait }).tagsByNames(['a'], signal())).rejects.toMatchObject({ kind: 'blocked' });
    expect(f.calls.length).toBe(1);
  });

  it('500、500、200 → 成功，调用 3 次', async () => {
    vi.useFakeTimers();
    let n = 0;
    const f = fakeFetch(() => (++n < 3 ? { status: 500, body: 'err' } : { body: [] }));
    const p = new DanbooruClient({ fetchImpl: f.fn, limiter: noWait }).tagsByNames(['a'], signal());
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual([]);
    expect(f.calls.length).toBe(3);
    vi.useRealTimers();
  });

  it('150 个名字 → 两批，limit 分别为 100、50', async () => {
    const f = fakeFetch(() => ({ body: [] }));
    await new DanbooruClient({ fetchImpl: f.fn, limiter: noWait }).tagsByNames(Array.from({ length: 150 }, (_, i) => `t${i}`), signal());
    expect(f.calls.map((c) => c.url.searchParams.get('limit'))).toEqual(['100', '50']);
  });
});

describe('RateLimiter', () => {
  // 假时钟接管不了 node:timers/promises，用真实的短间隔测（生产里是 1000 ms）
  it('相邻开始时间间隔 ≥ 设定值', async () => {
    const lim = new RateLimiter(50);
    const starts: number[] = [];
    for (let i = 0; i < 5; i++) {
      await lim.wait();
      starts.push(performance.now());
    }
    // setTimeout 按整毫秒计时，performance.now() 是亚毫秒，CI 上偶尔差出 49.97ms 这种；留 2ms 余量
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(48);
  });
});

describe('sync', () => {
  const ctx = (): JobContext => ({
    signal: new AbortController().signal,
    setTotal() {},
    advance() {},
    setMessage() {},
    shouldYield: () => false,
    requeue() {},
    yielded: false,
  });
  const runner = (enabled: boolean, f: FetchLike) => {
    const d = catalog();
    return createDanbooruSyncRunner({
      db,
      danbooru: d,
      getCatalog: () => new CharacterCatalog(db, { copyrights: d }),
      localizer: new HumanizeLocalizer(),
      getDanbooru: () => ({ enabled, username: '', apiKey: null }),
      setLastSyncAt: () => {},
      fetchImpl: f,
      limiter: noWait,
    });
  };

  it('关闭联网：零请求，仍然落库', async () => {
    const f = fakeFetch(() => ({ body: [] }));
    const msg = await runner(false, f.fn)(ctx());
    expect(f.calls.length).toBe(0);
    expect(msg).toContain('已关闭');
  });

  it('旧名改名 / 兜底 alias / 查不到 / 缓存命中', async () => {
    db.exec(`INSERT INTO characters (name, danbooru_tag, source, created_at) VALUES
      ('A', 'gojou_satoru', 'danbooru', 'x'), ('B', 'old_name', 'danbooru', 'x'), ('C', 'nobody_here', 'danbooru', 'x')`);
    const f = fakeFetch((u) => {
      const p = u.pathname;
      if (p === '/tags.json') {
        const names = (u.searchParams.get('search[name_comma]') ?? '').split(',');
        const out: unknown[] = [];
        if (names.includes('gojou_satoru'))
          out.push({ name: 'gojou_satoru', category: 4, post_count: 0, antecedent_alias: { consequent_name: 'gojo_satoru', status: 'active' } });
        for (const n of ['gojo_satoru', 'new_name']) if (names.includes(n)) out.push({ name: n, category: 4, post_count: 10 });
        return { body: out };
      }
      if (p === '/tag_aliases.json') {
        const names = (u.searchParams.get('search[antecedent_name_comma]') ?? '').split(',');
        return { body: names.includes('old_name') ? [{ antecedent_name: 'old_name', consequent_name: 'new_name' }] : [] };
      }
      if (p === '/related_tag.json') return { body: { query: u.searchParams.get('query'), post_count: 1, tag: null, related_tags: [] } };
      return { body: [] };
    });
    await runner(true, f.fn)(ctx());
    expect(db.prepare("SELECT new_name, source FROM tag_renames WHERE old_name = 'gojou_satoru'").get()).toEqual({ new_name: 'gojo_satoru', source: 'danbooru' });
    expect(db.prepare("SELECT alias_of FROM danbooru_tags WHERE name = 'gojou_satoru'").pluck().get()).toBe('gojo_satoru');
    const aliasCalls = f.calls.filter((c) => c.url.pathname === '/tag_aliases.json');
    expect(aliasCalls.every((c) => !(c.url.searchParams.get('search[antecedent_name_comma]') ?? '').includes('gojou_satoru'))).toBe(true);
    expect(db.prepare("SELECT new_name FROM tag_renames WHERE old_name = 'old_name'").pluck().get()).toBe('new_name');
    expect(db.prepare("SELECT not_found FROM danbooru_tags WHERE name = 'nobody_here'").pluck().get()).toBe(1);
    // 落库：角色标签改成新名
    expect(db.prepare("SELECT danbooru_tag FROM characters WHERE name = 'A'").pluck().get()).toBe('gojo_satoru');

    const before = f.calls.length;
    await runner(true, f.fn)(ctx());
    expect(f.calls.length).toBe(before); // 缓存未过期
  });
});

describe('matcher', () => {
  beforeEach(() => {
    db.exec(`INSERT INTO tag_i18n (tag, category, zh, copyright_guess, post_count) VALUES
        ('mika_(blue_archive)', 4, '圣园未花', 'blue_archive', 16024),
        ('mika_(swimsuit)_(blue_archive)', 4, '圣园未花', 'blue_archive', 1642);
      INSERT INTO tag_name_keys (search_key, tag, kind, source) VALUES
        ('${searchKey('圣园未花')}', 'mika_(blue_archive)', 'zh', 'dict'),
        ('${searchKey('圣园未花')}', 'mika_(swimsuit)_(blue_archive)', 'zh', 'dict'),
        ('${searchKey('未花')}', 'mika_(blue_archive)', 'alias', 'dict');
      INSERT INTO works (id, name, danbooru_tag, created_at) VALUES (1, '蔚蓝档案', 'blue_archive', 'x');`);
  });
  const custom = (name: string, withWork: boolean) => {
    const id = Number(db.prepare("INSERT INTO characters (name, source, created_at) VALUES (?, 'custom', 'x')").run(name).lastInsertRowid);
    if (withWork) db.prepare('INSERT INTO character_works (character_id, work_id) VALUES (?, 1)').run(id);
    return id;
  };
  const match = (id: number) => decideMatch(findDanbooruMatches(db, catalog(), id))?.danbooruTag ?? null;

  it('圣园未花 + 蔚蓝档案 → mika_(blue_archive)（靠 post_count 压过泳装变体）', () => expect(match(custom('圣园未花', true))).toBe('mika_(blue_archive)'));
  it('未花（无作品）→ 不匹配', () => expect(match(custom('未花', false))).toBeNull());
  it('未花 + 蔚蓝档案 → 匹配', () => expect(match(custom('未花', true))).toBe('mika_(blue_archive)'));
  it('我的原创角色 → 不匹配', () => expect(match(custom('我的原创角色', true))).toBeNull());

  it('recomputeCustomMatches 写表 / 删表', () => {
    const id = custom('圣园未花', true);
    recomputeCustomMatches(db, catalog());
    expect(db.prepare('SELECT danbooru_tag FROM custom_character_matches WHERE character_id = ?').pluck().get(id)).toBe('mika_(blue_archive)');
    db.prepare("UPDATE characters SET name = '我的原创角色' WHERE id = ?").run(id);
    recomputeCustomMatches(db, catalog(), [id]);
    expect(db.prepare('SELECT count(*) FROM custom_character_matches').pluck().get()).toBe(0);
  });
});
