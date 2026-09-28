/**
 * T10：humanize、catalog、writer、tagJob（不需要模型和 GPU）。
 */
import type { ServerEvent } from '@emaki/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '../../../core/jobs.ts';
import { EventBus } from '../../../core/events.ts';
import { openDatabase, type Db } from '../../../db/connection.ts';
import { migrate } from '../../../db/migrate.ts';
import { CharacterCatalog } from '../../catalog/characterCatalog.ts';
import { CopyrightResolver } from '../../catalog/copyrights.ts';
import { humanizeCharacterTag, humanizeCopyrightTag } from '../../i18n/humanize.ts';
import { HumanizeLocalizer, type AutoAlias } from '../../i18n/localizer.ts';
import { TaggerCrashedError, type TaggerLike, type TaggerStartOptions } from '../client.ts';
import type { HostItemResult } from '../protocol.ts';
import { createTagJobRunner } from '../tagJob.ts';
import { TagResultWriter } from '../writer.ts';

const REPO = 'SmilingWolf/wd-eva02-large-tagger-v3';
const OFFLINE = { 'mika_(blue_archive)': ['blue_archive'], 'hina_(blue_archive)': ['blue_archive'] };
const TH = { generalThreshold: 0.35, characterThreshold: 0.35, autoAcceptThreshold: 0.85 };

describe('humanize', () => {
  it.each([
    ['mika_(blue_archive)', 'Mika'],
    ['hatsune_miku', 'Hatsune Miku'],
    ['mika_(swimsuit)_(blue_archive)', 'Mika (Swimsuit)'],
  ])('角色 %s → %s', (tag, want) => expect(humanizeCharacterTag(tag)).toBe(want));
  it.each([
    ['fate_(series)', 'Fate'],
    ['fate/grand_order', 'Fate/Grand Order'],
    ['honkai:_star_rail', 'Honkai: Star Rail'],
    ['pokemon_(anime)', 'Pokemon (Anime)'],
  ])('作品 %s → %s', (tag, want) => expect(humanizeCopyrightTag(tag)).toBe(want));
});

let db: Db;
const count = (sql: string, ...args: unknown[]) => db.prepare(sql).pluck().get(...args) as number;

function freshDb(nImages = 3) {
  db = openDatabase(':memory:');
  migrate(db);
  db.prepare("INSERT INTO library_roots (id, path) VALUES (1, 'D:/lib')").run();
  const ins = db.prepare(
    "INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at) VALUES (?, 1, ?, ?, 10, 10, 1, 'png', ?, 'x', 'x')",
  );
  for (let i = 1; i <= nImages; i++) ins.run(i, `${i}.png`, `${i}.png`, `s${i}`);
}

const ok = (id: number, character: [string, number][], rating?: 'sensitive'): HostItemResult => ({
  id,
  ok: true,
  rating: rating ? { general: 0.1, sensitive: 0.8, questionable: 0.05, explicit: 0.05 } : null,
  general: [['1girl', 0.99]],
  character,
});

describe('CharacterCatalog', () => {
  beforeEach(() => freshDb(1));

  it('重定向命中时不新建', () => {
    db.prepare("INSERT INTO characters (id, name, source, created_at) VALUES (9, '目标', 'custom', 'x')").run();
    db.prepare("INSERT INTO danbooru_tag_redirects (tag, character_id) VALUES ('mika_(blue_archive)', 9)").run();
    const cat = new CharacterCatalog(db, { copyrights: new CopyrightResolver(db, OFFLINE) });
    expect(cat.resolveCharacterId('mika_(blue_archive)')).toBe(9);
    expect(cat.ensureCharacter('mika_(blue_archive)', 'now').created).toBe(false);
  });

  it('createdWorkIds：新建作品时有，作品已存在时为空', () => {
    const cat = new CharacterCatalog(db, { copyrights: new CopyrightResolver(db, OFFLINE) });
    const a = cat.ensureCharacter('mika_(blue_archive)', 'now');
    expect(a.createdWorkIds.length).toBe(1);
    const b = cat.ensureCharacter('hina_(blue_archive)', 'now');
    expect(b.createdWorkIds).toEqual([]);
  });
});

describe('TagResultWriter', () => {
  beforeEach(() => freshDb(3));
  const writer = (localizer = new HumanizeLocalizer()) => {
    const copyrights = new CopyrightResolver(db, OFFLINE);
    return new TagResultWriter(db, new CharacterCatalog(db, { copyrights, localizer }), copyrights, { repo: REPO, ...TH });
  };

  it('按规则写：自动采纳、建议、作品、分级', () => {
    writer().writeBatch([ok(1, [['mika_(blue_archive)', 0.95], ['hina_(blue_archive)', 0.5]], 'sensitive')]);
    expect(db.prepare("SELECT name, source FROM characters WHERE danbooru_tag = 'mika_(blue_archive)'").get()).toEqual({ name: 'Mika', source: 'danbooru' });
    const work = db.prepare("SELECT id, name FROM works WHERE danbooru_tag = 'blue_archive'").get() as { id: number; name: string };
    expect(work.name).toBe('Blue Archive');
    expect(count('SELECT position FROM character_works')).toBe(0);
    expect(db.prepare('SELECT image_id, origin, score FROM image_characters').all()).toEqual([{ image_id: 1, origin: 'tagger', score: 0.95 }]);
    expect(db.prepare('SELECT image_id, danbooru_tag, score FROM character_suggestions').all()).toEqual([
      { image_id: 1, danbooru_tag: 'hina_(blue_archive)', score: 0.5 },
    ]);
    expect(db.prepare('SELECT image_id, work_id, score FROM image_copyrights').all()).toEqual([{ image_id: 1, work_id: work.id, score: 0.5 }]);
    expect(db.prepare('SELECT rating, tagger_model, tagged_at IS NOT NULL AS t FROM images WHERE id = 1').get()).toEqual({ rating: 'sensitive', tagger_model: REPO, t: 1 });
    // HumanizeLocalizer 下 mika_(blue_archive) 和 Mika 的 key 相同 → 只剩标签原文（不可见）被去重掉
    expect(count("SELECT count(*) FROM aliases WHERE owner_type = 'character' AND visible = 1")).toBe(0);
  });

  it('自定义 Localizer 的别名：origin=dict、visible=1、position=100', () => {
    const loc = new HumanizeLocalizer();
    loc.aliasesFor = (): AutoAlias[] => [{ alias: '未花', origin: 'dict', visible: true }];
    writer(loc).writeBatch([ok(1, [['mika_(blue_archive)', 0.95]])]);
    expect(db.prepare("SELECT alias, origin, visible, position FROM aliases WHERE owner_type = 'character'").all()).toEqual([
      { alias: '未花', origin: 'dict', visible: 1, position: 100 },
    ]);
  });

  it('手动分级不覆盖；已手动关联的角色不再建议', () => {
    db.prepare("UPDATE images SET rating = 'explicit', rating_manual = 1 WHERE id = 2").run();
    db.prepare("INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (5, '日奈', 'hina_(blue_archive)', 'danbooru', 'x')").run();
    db.prepare("INSERT INTO image_characters (image_id, character_id, origin, added_at) VALUES (3, 5, 'manual', 'x')").run();
    writer().writeBatch([ok(2, [], 'sensitive'), ok(3, [['hina_(blue_archive)', 0.5]])]);
    expect(count('SELECT rating = \'explicit\' FROM images WHERE id = 2')).toBe(1);
    expect(count('SELECT count(*) FROM character_suggestions WHERE image_id = 3')).toBe(0);
  });

  it('DECODE 标记已处理，ENOENT 不写', () => {
    writer().writeBatch([
      { id: 1, ok: false, code: 'DECODE', message: 'x' },
      { id: 2, ok: false, code: 'ENOENT', message: 'x' },
    ]);
    expect(db.prepare('SELECT id FROM images WHERE tagged_at IS NOT NULL').pluck().all()).toEqual([1]);
  });

  it('幂等', () => {
    const batch = [ok(1, [['mika_(blue_archive)', 0.95], ['hina_(blue_archive)', 0.5]], 'sensitive')];
    writer().writeBatch(batch);
    const tables = ['characters', 'works', 'image_characters', 'character_suggestions', 'image_copyrights', 'image_tags', 'tags', 'aliases'];
    const before = tables.map((t) => count(`SELECT count(*) FROM ${t}`));
    writer().writeBatch(batch);
    expect(tables.map((t) => count(`SELECT count(*) FROM ${t}`))).toEqual(before);
  });

  it('阈值调低后提升建议', () => {
    db.prepare("INSERT INTO character_suggestions (image_id, danbooru_tag, score) VALUES (1, 'mika_(blue_archive)', 0.88)").run();
    expect(writer().promoteSuggestions()).toBe(1);
    expect(count('SELECT count(*) FROM character_suggestions')).toBe(0);
    expect(count('SELECT count(*) FROM image_characters')).toBe(1);
  });
});

describe('tagJob', () => {
  const ctxOf = (over: Partial<JobContext> = {}): JobContext & { advance: ReturnType<typeof vi.fn>; requeue: ReturnType<typeof vi.fn> } =>
    ({
      signal: new AbortController().signal,
      setTotal: vi.fn(),
      advance: vi.fn(),
      setMessage: vi.fn(),
      shouldYield: () => false,
      requeue: vi.fn(),
      yielded: false,
      ...over,
    }) as never;

  const fakeClient = (device: 'dml' | 'cpu', crashFirst = false): TaggerLike => {
    let crashed = !crashFirst;
    return {
      device,
      batchSize: 2,
      info: { type: 'ready', device, dmlDeviceId: device === 'dml' ? 0 : null, fallbackReason: null, batchSize: 2, fixedBatch: false, inputName: 'input', inputShape: [], outputName: 'output', numLabels: 0, loadMs: 0, pid: 1 },
      tag: async (items) => {
        if (!crashed) {
          crashed = true;
          throw crashFirst instanceof Error ? crashFirst : new TaggerCrashedError('boom');
        }
        return items.map((i) => ok(i.id, [['mika_(blue_archive)', 0.95]]));
      },
    };
  };

  const runner = (factory: (o: TaggerStartOptions) => Promise<TaggerLike>, bus = new EventBus()) =>
    createTagJobRunner({
      db,
      bus,
      modelsDir: 'X:/models',
      getTaggerSettings: () => ({ model: REPO, device: 'dml', batchSize: 2, ...TH, legacyModel: null, legacyBefore: null, skipCameraPhotos: true, retryOld: false, keepAwake: true }),
      makeCatalog: () => {
        const copyrights = new CopyrightResolver(db, OFFLINE);
        return { catalog: new CharacterCatalog(db, { copyrights }), copyrights };
      },
      clientFactory: factory,
      ensureFiles: async () => ({ dir: 'X:', modelPath: 'X:/m.onnx', labelsPath: 'X:/l.csv' }),
    });
  const pending = () => count('SELECT count(*) FROM images WHERE tagged_at IS NULL');

  beforeEach(() => freshDb(5));

  it('全部跑完；再跑一次不启动引擎', async () => {
    const factory = vi.fn(async () => fakeClient('dml'));
    const ctx = ctxOf();
    await runner(factory)(ctx);
    expect(pending()).toBe(0);
    expect(ctx.advance.mock.calls.reduce((s, c) => s + (c[0] as number), 0)).toBe(5);
    expect(await runner(factory)(ctxOf())).toBe('没有需要识别的图片');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('识别胶卷：有 jobId 时每批推一条 job-item，带角色名；没有 jobId 不推', async () => {
    const bus = new EventBus();
    const items: ServerEvent[] = [];
    bus.subscribe((e) => e.type === 'job-item' && items.push(e));
    await runner(async () => fakeClient('dml'), bus)(ctxOf({ jobId: 'j1' }));
    // 5 张分 3 批；限流 250ms，假模型很快，至少推了第一批
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]).toMatchObject({ type: 'job-item', jobId: 'j1', characterNames: [expect.any(String)], score: 0.95 });
    freshDb(5);
    items.length = 0;
    await runner(async () => fakeClient('dml'), bus)(ctxOf());
    expect(items).toEqual([]);
  });

  it('取消：已写的保留，剩下的还是未处理', async () => {
    freshDb(20); // 5 张只有 3 批，开头就全部在途了
    const ac = new AbortController();
    const ctx = ctxOf({ signal: ac.signal });
    ctx.advance.mockImplementation(() => ac.abort());
    await runner(async () => fakeClient('dml'))(ctx);
    expect(pending()).toBeGreaterThan(0);
    expect(pending()).toBeLessThan(20);
  });

  it('让出给扫描', async () => {
    let y = false;
    const ctx = ctxOf({ shouldYield: () => y });
    ctx.advance.mockImplementation(() => (y = true));
    const msg = await runner(async () => fakeClient('dml'))(ctx);
    expect(ctx.requeue).toHaveBeenCalled();
    expect(msg).toContain('已让出');
  });

  it('显卡卡死（子进程没崩，推理报 0x887A0006）→ 换 CPU 继续', async () => {
    const hung = new Error('DML GPU readback failed with HRESULT 0x887A0006: N:\ort\dml_provider.cc');
    const factory = vi.fn(async (o: TaggerStartOptions) => (o.device === 'dml' ? fakeClient('dml', hung) : fakeClient('cpu')));
    await runner(factory)(ctxOf());
    expect(factory.mock.calls.map((c) => c[0].device)).toEqual(['dml', 'cpu']);
    expect(pending()).toBe(0);
  });

  it('普通推理错误不换 CPU，照常报错', async () => {
    const factory = vi.fn(async () => fakeClient('dml', new Error('Invalid input shape')));
    await expect(runner(factory)(ctxOf())).rejects.toThrow('Invalid input shape');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('DML 崩溃 → 换 CPU 继续', async () => {
    const factory = vi.fn(async (o: TaggerStartOptions) => (o.device === 'dml' ? fakeClient('dml', true) : fakeClient('cpu')));
    await runner(factory)(ctxOf());
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1]![0].device).toBe('cpu');
    expect(pending()).toBe(0);
  });
});

describe('tagJob 分流（旧文件用旧模型、新文件用新模型、相机照片跳过）', () => {
  const PIXAI = 'noaione/pixai-tagger-v1.0-onnx';
  const ctxOf = (): JobContext =>
    ({
      signal: new AbortController().signal,
      setTotal: vi.fn(),
      advance: vi.fn(),
      setMessage: vi.fn(),
      shouldYield: () => false,
      requeue: vi.fn(),
      yielded: false,
    }) as never;
  const client = (repo: string, seen: Record<string, number[]>): TaggerLike => ({
    device: 'dml',
    batchSize: 2,
    info: { type: 'ready', device: 'dml', dmlDeviceId: 0, fallbackReason: null, batchSize: 2, fixedBatch: false, inputName: 'input', inputShape: [], outputName: 'output', numLabels: 0, loadMs: 0, pid: 1 },
    tag: async (items) => {
      (seen[repo] ??= []).push(...items.map((i) => i.id));
      return items.map((i) => ok(i.id, []));
    },
  });
  const run = (over: Partial<ReturnType<typeof settings>> = {}) => {
    const seen: Record<string, number[]> = {};
    const r = createTagJobRunner({
      db,
      bus: new EventBus(),
      modelsDir: 'X:/models',
      getTaggerSettings: () => ({ ...settings(), ...over }),
      makeCatalog: () => {
        const copyrights = new CopyrightResolver(db, OFFLINE);
        return { catalog: new CharacterCatalog(db, { copyrights }), copyrights };
      },
      clientFactory: async (o) => client(o.repo, seen),
      ensureFiles: async () => ({ dir: 'X:', modelPath: 'X:/m.onnx', labelsPath: 'X:/l.csv' }),
    });
    return { seen, go: () => r(ctxOf()) };
  };
  const settings = () => ({
    model: PIXAI,
    device: 'dml' as const,
    batchSize: 2,
    ...TH,
    legacyModel: REPO as string | null,
    legacyBefore: '2024-03-01' as string | null,
    skipCameraPhotos: true,
    retryOld: false,
    keepAwake: true,
  });

  beforeEach(() => {
    freshDb(6);
    const mt = db.prepare('UPDATE images SET modified_at = ? WHERE id = ?');
    mt.run('2023-05-01T00:00:00Z', 1);
    mt.run('2024-02-28T00:00:00Z', 2);
    mt.run('2024-03-01T00:00:00Z', 3);
    mt.run('2026-04-09T00:00:00Z', 4);
    mt.run('2025-01-01T00:00:00Z', 5);
    mt.run('2020-01-01T00:00:00Z', 6);
    db.prepare("UPDATE images SET content_kind = 'photo', camera = 'Apple iPhone 13' WHERE id = 5").run();
    // 6：旧文件，旧模型早就识别过、没认出角色
    db.prepare("UPDATE images SET tagged_at = '2025-01-01', tagger_model = ? WHERE id = 6").run(REPO);
  });

  it('早于分界用旧模型，之后用新模型；相机照片不识别；旧模型认过的旧文件默认不重跑', async () => {
    const { seen, go } = run();
    await go();
    expect(seen[REPO]!.sort()).toEqual([1, 2]);
    expect(seen[PIXAI]!.sort()).toEqual([3, 4]);
    expect(count('SELECT tagged_at IS NULL FROM images WHERE id = 5')).toBe(1);
    expect(count('SELECT count(*) FROM images WHERE tagger_model = ?', PIXAI)).toBe(2);
  });

  it('retryOld：旧文件里没认出角色的也用新模型再认', async () => {
    const { seen, go } = run({ retryOld: true });
    await go();
    // 1、2 先被旧模型识别（没认出角色），随后和 6 一起进新模型那一轮
    expect(seen[PIXAI]!.sort()).toEqual([1, 2, 3, 4, 6]);
  });

  it('不分流（legacyBefore = null）：全部用新模型，相机照片仍跳过', async () => {
    const { seen, go } = run({ legacyBefore: null });
    await go();
    expect(seen[REPO]).toBeUndefined();
    expect(seen[PIXAI]!.sort()).toEqual([1, 2, 3, 4, 6]);
  });
});
