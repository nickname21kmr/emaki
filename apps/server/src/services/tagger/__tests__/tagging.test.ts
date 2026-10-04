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
import { resetIoBackoff } from '../readBackoff.ts';
import { createTagJobRunner, createTagStage } from '../tagJob.ts';
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

  it('顺便解码画师时，识别失败的图也标画师跑过（画师补跑不再单独跑它）；没解码画师时不标', () => {
    const copyrights = new CopyrightResolver(db, OFFLINE);
    const catalog = new CharacterCatalog(db, { copyrights, localizer: new HumanizeLocalizer() });
    new TagResultWriter(db, catalog, copyrights, { repo: REPO, ...TH }).writeBatch([{ id: 1, ok: false, code: 'DECODE', message: 'x' }]);
    new TagResultWriter(db, catalog, copyrights, { repo: REPO, ...TH, artists: true }).writeBatch([
      { id: 2, ok: false, code: 'DECODE', message: '识别时子进程崩溃，已跳过' },
      { id: 3, ok: false, code: 'ENOENT', message: 'x' },
    ]);
    expect(db.prepare('SELECT id FROM images WHERE artist_checked_at IS NOT NULL').pluck().all()).toEqual([2]);
    expect(db.prepare('SELECT COUNT(*) FROM image_artists').pluck().get()).toBe(0);
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

  const fakeClient = (device: 'dml' | 'webgpu' | 'cpu', crashFirst: boolean | Error = false): TaggerLike => {
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

  const runner = (factory: (o: TaggerStartOptions) => Promise<TaggerLike>, bus = new EventBus(), model = REPO) =>
    createTagJobRunner({
      db,
      bus,
      modelsDir: 'X:/models',
      getTaggerSettings: () => ({ model, device: 'dml', batchSize: 2, ...TH, legacyModel: null, legacyBefore: null, skipCameraPhotos: true, retryOld: false, keepAwake: true, artists: false }),
      makeCatalog: () => {
        const copyrights = new CopyrightResolver(db, OFFLINE);
        return { catalog: new CharacterCatalog(db, { copyrights }), copyrights };
      },
      clientFactory: factory,
      ensureFiles: async () => ({ dir: 'X:', modelPath: 'X:/m.onnx', labelsPath: 'X:/l.csv' }),
    });
  const pending = () => count('SELECT count(*) FROM images WHERE tagged_at IS NULL');

  beforeEach(() => {
    freshDb(5);
    resetIoBackoff();
  });

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

  const hung = () => new Error('DML GPU readback failed with HRESULT 0x887A0006: N:\ort\dml_provider.cc');

  it('显卡卡死（推理报 0x887A0006）→ 先在显卡上改成一张一批', async () => {
    const factory = vi.fn(async (o: TaggerStartOptions) => (o.batchSize > 1 ? fakeClient('dml', hung()) : { ...fakeClient('dml'), batchSize: 1 }));
    await runner(factory)(ctxOf());
    expect(factory.mock.calls.map((c) => [c[0].device, c[0].batchSize])).toEqual([['dml', 2], ['dml', 1]]);
    expect(pending()).toBe(0);
  });

  it('一张一批还卡死 → 换 CPU 继续', async () => {
    const factory = vi.fn(async (o: TaggerStartOptions) =>
      o.device === 'cpu' ? fakeClient('cpu') : { ...fakeClient('dml', hung()), batchSize: o.batchSize },
    );
    await runner(factory)(ctxOf());
    expect(factory.mock.calls.map((c) => c[0].device)).toEqual(['dml', 'dml', 'cpu']);
    expect(pending()).toBe(0);
  });

  it('PixAI：DirectML 上卡死 → 换 WebGPU；WebGPU 也卡死 → 换 CPU', async () => {
    const PIXAI = 'A1yCE/pixai-tagger-v1.0-onnx-fp16';
    // PixAI 只能一张一批，没有「缩小批」这一步
    const one = (c: TaggerLike): TaggerLike => ({ ...c, batchSize: 1 });
    const toWebgpu = vi.fn(async (o: TaggerStartOptions) => one(o.noDml ? fakeClient('webgpu') : fakeClient('dml', hung())));
    await runner(toWebgpu, new EventBus(), PIXAI)(ctxOf());
    expect(toWebgpu.mock.calls.map((c) => [c[0].device, !!c[0].noDml])).toEqual([['dml', false], ['dml', true]]);
    expect(pending()).toBe(0);

    freshDb(5);
    const toCpu = vi.fn(async (o: TaggerStartOptions) =>
      one(o.device === 'cpu' ? fakeClient('cpu') : o.noDml ? fakeClient('webgpu', hung()) : fakeClient('dml', hung())),
    );
    await runner(toCpu, new EventBus(), PIXAI)(ctxOf());
    expect(toCpu.mock.calls.map((c) => [c[0].device, !!c[0].noDml])).toEqual([['dml', false], ['dml', true], ['cpu', false]]);
    expect(pending()).toBe(0);
  });

  it('普通推理错误不换 CPU，照常报错', async () => {
    const factory = vi.fn(async () => fakeClient('dml', new Error('Invalid input shape')));
    await expect(runner(factory)(ctxOf())).rejects.toThrow('Invalid input shape');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  /**
   * 每次调用由 behave(items, 第几次调用) 决定：返回 Error 就抛出，否则正常出结果；delay 模拟推理耗时，让多个请求同时在途。
   * 和真的 TaggerClient 一样：子进程崩了（TaggerCrashedError）之后这个客户端就死了，在途和之后的请求都立刻失败。
   */
  const scripted = (
    device: 'dml' | 'webgpu' | 'cpu',
    behave: (items: { id: number }[], call: number) => Error | null,
    delay = 5,
    batchSize = 2,
  ): TaggerLike => {
    let call = 0;
    let dead = false;
    const waiting = new Set<(e: Error) => void>();
    return {
      ...fakeClient(device),
      batchSize,
      tag: async (items) => {
        if (dead) throw new TaggerCrashedError('识别子进程已退出');
        const n = call++;
        await new Promise<void>((resolve, reject) => {
          const fail = (e: Error) => {
            clearTimeout(t);
            reject(e);
          };
          const t = setTimeout(() => {
            waiting.delete(fail);
            resolve();
          }, delay);
          waiting.add(fail);
        });
        if (dead) throw new TaggerCrashedError('识别子进程已退出');
        const e = behave(items, n);
        if (e instanceof TaggerCrashedError) {
          dead = true;
          for (const w of waiting) w(e); // 子进程退出：在途的一起失败
          waiting.clear();
        }
        if (e) throw e;
        return items.map((i) => ok(i.id, [['mika_(blue_archive)', 0.95]]));
      },
    };
  };
  const crash = () => new TaggerCrashedError('识别子进程退出（3221225477）');
  const linked = () => count('SELECT count(DISTINCT image_id) FROM image_characters');
  const failed = () => count('SELECT count(*) FROM images WHERE tagged_at IS NOT NULL AND id NOT IN (SELECT image_id FROM image_characters)');

  it('子进程崩溃一次（不是显卡报错）→ 按原设置重开，接着跑完，不降级', async () => {
    let first = true;
    const factory = vi.fn(async (_o: TaggerStartOptions) => {
      const crashOnce = first;
      first = false;
      return scripted('dml', (_, n) => (crashOnce && n === 0 ? crash() : null));
    });
    await runner(factory)(ctxOf());
    expect(factory.mock.calls.map((c) => [c[0].device, c[0].batchSize, !!c[0].noDml])).toEqual([['dml', 2, false], ['dml', 2, false]]);
    expect(pending()).toBe(0);
    expect(linked()).toBe(5);
  });

  it('几个在途请求一起失败：只重开一次，任务照常完成', async () => {
    freshDb(20);
    let first = true;
    const factory = vi.fn(async () => {
      const dead = first;
      first = false;
      // 第一个客户端：所有请求都失败（子进程退出时在途的请求会一起被拒）
      return scripted('dml', () => (dead ? crash() : null), 20);
    });
    await runner(factory)(ctxOf());
    expect(factory).toHaveBeenCalledTimes(2);
    expect(pending()).toBe(0);
    expect(linked()).toBe(20);
  });

  it('DirectML 每次都崩（显卡 / 驱动坏了）：重开几次后降级到 CPU，不会把好图当坏图跳过', async () => {
    const factory = vi.fn(async (o: TaggerStartOptions) => (o.device === 'cpu' ? scripted('cpu', () => null) : scripted('dml', () => crash())));
    await runner(factory)(ctxOf());
    const devices = factory.mock.calls.map((c) => c[0].device);
    expect(devices.at(-1)).toBe('cpu');
    // 计数的重开 3 次之外，还有排查坏图时的几次重开；总数有上限，不会无限重开
    expect(devices.filter((d) => d === 'dml').length).toBeGreaterThanOrEqual(4);
    expect(devices.filter((d) => d === 'dml').length).toBeLessThanOrEqual(8);
    expect(pending()).toBe(0);
    expect(linked()).toBe(5);
    expect(failed()).toBe(0);
  });

  it('一张坏图每次都让子进程崩溃：找出来单独跳过，别的图照常识别，不降级', async () => {
    freshDb(9);
    const BAD = 4;
    // 不管哪种设备，带着这张图就崩
    const factory = vi.fn(async (o: TaggerStartOptions) => scripted(o.device, (items) => (items.some((i) => i.id === BAD) ? crash() : null)));
    const log: string[] = [];
    const run = createTagJobRunner({
      db,
      bus: new EventBus(),
      modelsDir: 'X:/models',
      getTaggerSettings: () => ({ model: REPO, device: 'dml', batchSize: 2, ...TH, legacyModel: null, legacyBefore: null, skipCameraPhotos: true, retryOld: false, keepAwake: true, artists: false }),
      makeCatalog: () => {
        const copyrights = new CopyrightResolver(db, OFFLINE);
        return { catalog: new CharacterCatalog(db, { copyrights }), copyrights };
      },
      clientFactory: factory,
      ensureFiles: async () => ({ dir: 'X:', modelPath: 'X:/m.onnx', labelsPath: 'X:/l.csv' }),
      log: (m) => log.push(m),
    });
    await run(ctxOf());
    expect(factory.mock.calls.every((c) => c[0].device === 'dml' && c[0].batchSize === 2)).toBe(true);
    expect(pending()).toBe(0);
    expect(linked()).toBe(8);
    expect(count(`SELECT count(*) FROM image_characters WHERE image_id = ${BAD}`)).toBe(0);
    expect(log.some((m) => m.includes(`id ${BAD}`))).toBe(true);
  });

  it('显存不够（0x8007000E）按显卡问题处理：先改成一张一批', async () => {
    const oom = () => new Error('Non-zero status code returned while running Conv node. Status Message: D3D12 failed with 8007000E (E_OUTOFMEMORY)');
    const factory = vi.fn(async (o: TaggerStartOptions) => (o.batchSize > 1 ? scripted('dml', (_, n) => (n === 0 ? oom() : null)) : { ...scripted('dml', () => null), batchSize: 1 }));
    await runner(factory)(ctxOf());
    expect(factory.mock.calls.map((c) => [c[0].device, c[0].batchSize])).toEqual([['dml', 2], ['dml', 1]]);
    expect(pending()).toBe(0);
  });

  it('PixAI（一张一批、4 个在途）：坏图后面排着的好图不会被连累成失败', async () => {
    freshDb(16);
    for (const BAD of [16, 12, 9, 1]) {
      freshDb(16);
      const factory = vi.fn(async (o: TaggerStartOptions) =>
        scripted(o.device, (items) => (items.some((i) => i.id === BAD) ? crash() : null), 5, 1),
      );
      await runner(factory, new EventBus(), 'A1yCE/pixai-tagger-v1.0-onnx-fp16')(ctxOf());
      expect(pending()).toBe(0);
      expect(linked()).toBe(15); // 只有坏图没认出来
      expect(count(`SELECT count(*) FROM image_characters WHERE image_id = ${BAD}`)).toBe(0);
      expect(factory.mock.calls.every((c) => c[0].device === 'dml')).toBe(true); // 没有因为一张坏图降级
    }
  });

  it('取消后不再重开子进程，任务按取消结束', async () => {
    freshDb(20);
    const ac = new AbortController();
    let made = 0;
    const factory = vi.fn(async () => {
      made++;
      if (made === 2) ac.abort(); // 第一次重开的同时用户点了取消
      return scripted('dml', () => crash());
    });
    await runner(factory)(ctxOf({ signal: ac.signal })); // 不抛错（取消不算失败）
    const callsAtEnd = factory.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(factory.mock.calls.length).toBe(callsAtEnd); // 结束后没有再起新的
    expect(callsAtEnd).toBeLessThanOrEqual(2);
  });

  it('一开始就回退到 CPU 的：之后崩溃按 CPU 重开，不再去试起不来的 DirectML', async () => {
    let first = true;
    const factory = vi.fn(async (o: TaggerStartOptions) => {
      const crashOnce = first;
      first = false;
      const c = scripted('cpu', (_, n) => (crashOnce && n === 0 ? crash() : null));
      return o.device === 'dml' ? { ...c, info: { ...c.info, fallbackReason: 'DirectML 不可用' } } : c;
    });
    await runner(factory)(ctxOf());
    expect(factory.mock.calls.map((c) => c[0].device)).toEqual(['dml', 'cpu']);
    expect(pending()).toBe(0);
  });

  it('唯一剩下的一张图每次都让子进程崩溃（没有别的图能证明显卡是好的）：最后记成失败跳过，任务不失败', async () => {
    freshDb(1);
    const factory = vi.fn(async (o: TaggerStartOptions) => scripted(o.device, () => crash()));
    await runner(factory)(ctxOf());
    expect(pending()).toBe(0);
    expect(failed()).toBe(1);
    expect(factory.mock.calls.at(-1)![0].device).toBe('cpu'); // 先降到 CPU，CPU 上也崩才认定是图的问题
  });

  it('读取暂时失败（IO）的图：这次不记，30 分钟内不再挑它，也不会因为它触发识别', async () => {
    const io = (id: number): HostItemResult => ({ id, ok: false, code: 'IO', message: '读取失败（EBUSY），下次再试' });
    const factory = vi.fn(async () => ({
      ...scripted('dml', () => null),
      tag: async (items: { id: number }[]) => items.map((i) => (i.id === 2 ? io(i.id) : ok(i.id, [['mika_(blue_archive)', 0.95]]))),
    }));
    await runner(factory)(ctxOf());
    expect(pending()).toBe(1); // id 2 没有写
    const stage = createTagStage({
      db,
      bus: new EventBus(),
      modelsDir: 'X:/models',
      getTaggerSettings: () => ({ model: REPO, device: 'dml', batchSize: 2, ...TH, legacyModel: null, legacyBefore: null, skipCameraPhotos: true, retryOld: false, keepAwake: true, artists: false }),
      clientFactory: factory,
    });
    expect(stage.pendingCount()).toBe(0); // 退避中，扫描后不会为它重新加载模型
    expect(await runner(factory)(ctxOf())).toBe('没有需要识别的图片');
    resetIoBackoff();
    expect(stage.pendingCount()).toBe(1); // 退避过了照常重试
  });

  it('PixAI 唯一一张图每次都崩：要真的在 CPU 上试过也崩，才记成失败（不能刚切到 CPU 就下结论）', async () => {
    freshDb(1);
    const tried: string[] = [];
    const factory = vi.fn(async (o: TaggerStartOptions) => {
      const dev = o.device === 'cpu' ? 'cpu' : o.noDml ? 'webgpu' : 'dml';
      return scripted(dev, () => (tried.push(dev), crash()), 5, 1);
    });
    await runner(factory, new EventBus(), 'A1yCE/pixai-tagger-v1.0-onnx-fp16')(ctxOf());
    expect(pending()).toBe(0);
    expect(failed()).toBe(1);
    expect(tried).toContain('cpu'); // 记失败之前确实在 CPU 上跑过
  });

  it('文件不在（移动硬盘拔掉）也退避；同一张图连续 3 次读不了就记失败', async () => {
    const enoent = (id: number): HostItemResult => ({ id, ok: false, code: 'ENOENT', message: '文件不存在' });
    const io = (id: number): HostItemResult => ({ id, ok: false, code: 'IO', message: '读取失败（EIO），下次再试' });
    const factory = vi.fn(async () => ({
      ...scripted('dml', () => null),
      tag: async (items: { id: number }[]) => items.map((i) => (i.id === 2 ? enoent(i.id) : i.id === 3 ? io(i.id) : ok(i.id, [['mika_(blue_archive)', 0.95]]))),
    }));
    await runner(factory)(ctxOf());
    expect(pending()).toBe(2); // 2、3 都没写
    expect(await runner(factory)(ctxOf())).toBe('没有需要识别的图片'); // 都在退避
    // 第 2、3 次（退避过了再试）：id 3 还是 IO，第 3 次记成失败；id 2 一直是 ENOENT，留给扫描器
    resetIoBackoff();
    await runner(factory)(ctxOf());
    resetIoBackoff();
    await runner(factory)(ctxOf());
    expect(count('SELECT tagged_at IS NOT NULL FROM images WHERE id = 3')).toBe(1);
    expect(count('SELECT tagged_at IS NULL FROM images WHERE id = 2')).toBe(1);
  });

  it('显卡卡死先改成一张一批，再降到 CPU 时批大小按最初的设置算', async () => {
    const factory = vi.fn(async (o: TaggerStartOptions) =>
      o.device === 'cpu' ? scripted('cpu', () => null, 5, o.batchSize) : scripted('dml', () => hung(), 5, o.batchSize),
    );
    await runner(factory)(ctxOf());
    expect(factory.mock.calls.map((c) => [c[0].device, c[0].batchSize])).toEqual([['dml', 2], ['dml', 1], ['cpu', 2]]);
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
    artists: false,
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

  it('retag：主模型自己认过的也再认一遍（不管文件新旧），写完清掉标记；再跑不重复', async () => {
    const tagged = db.prepare("UPDATE images SET tagged_at = '2025-06-01', tagger_model = ?, retag = ? WHERE id = ?");
    for (const id of [1, 2, 3, 4]) tagged.run(PIXAI, 0, id);
    tagged.run(PIXAI, 1, 3); // 新文件，主模型认过
    tagged.run(PIXAI, 1, 1); // 旧文件，主模型认过（不走旧模型那一轮）
    const { seen, go } = run();
    await go();
    expect(seen[REPO]).toBeUndefined();
    expect(seen[PIXAI]!.sort()).toEqual([1, 3]);
    expect(count('SELECT count(*) FROM images WHERE retag = 1')).toBe(0);
    const again = run();
    expect(await again.go()).toBe('没有需要识别的图片');
  });
});
