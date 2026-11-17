/**
 * 附录 #13–#22 已关闭（P2 变更传播，docs/core-architecture.md 第 5 节）：每条一组用例。
 * 写法和 crossEntry.test.ts 一样：同一个变化从不同入口进来，反应的结果相同；撤销之后派生数据正确。
 * 用真实的 SqliteDataSource（内存库）；要动文件的（移动、扫描）在临时目录里放真的小图。
 */
import type { MutationResult, ServerEvent } from '@emaki/shared';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { EventBus } from '../../src/core/events.ts';
import type { JobContext } from '../../src/core/jobs.ts';
import { SqliteDataSource, type SqliteOpenOptions } from '../../src/datasource/sqlite/SqliteDataSource.ts';
import { ACTOR_HEADER, ASSISTANT_HEADER_VALUE, runAs } from '../../src/propagation/actor.ts';
import { hasWork } from '../../src/propagation/work.ts';
import { sharp } from '../../src/services/image/sharpConfig.ts';
import { makeTmpDir } from '../helpers/tmp.ts';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const OLD = new Date('2025-01-01T00:00:00.000Z');

const opened: { ds: SqliteDataSource; dir: string }[] = [];
afterEach(async () => {
  for (const { ds, dir } of opened.splice(0)) {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Env {
  ds: SqliteDataSource;
  bus: EventBus;
  /** 图库文件夹在磁盘上的位置（id 1） */
  root: string;
}

/** 一个全新的引擎：图库文件夹是临时目录；一个角色「爱丽丝」(id 1)，一个自建角色「临时」(id 2) */
async function engine(opts: SqliteOpenOptions = {}): Promise<Env> {
  const dir = makeTmpDir('p2-closure');
  const root = path.join(dir, 'lib');
  mkdirSync(root);
  const bus = new EventBus();
  const ds = await SqliteDataSource.open(bus, path.join(dir, 'data'), {
    memory: true,
    clock: () => NOW,
    autoJobs: false,
    importDict: false,
    checkRecyclable: async () => {},
    trashImpl: async () => {},
    ...opts,
  });
  opened.push({ ds, dir });
  const db = ds.ctx.db;
  db.prepare('INSERT INTO library_roots (id, path, last_scan_at) VALUES (1, ?, ?)').run(root.replace(/\\/g, '/'), new Date(NOW).toISOString());
  db.exec(`INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (1, '爱丽丝', 'alice_(game_a)', 'danbooru', '2000-01-01'),
    (2, '临时', NULL, 'custom', '2000-01-01')`);
  return { ds, bus, root };
}

interface Spec {
  id: number;
  rel: string;
  kind?: string;
  tagged?: boolean;
  /** 在磁盘上放一个真的文件（移动、扫描要用） */
  file?: boolean;
}

/** 一张真的小 PNG（每张颜色不同，sha 不同） */
const png = (id: number) => sharp({ create: { width: 8, height: 8 + id, channels: 3, background: { r: (id * 40) % 256, g: 90, b: 150 } } }).png().toBuffer();

async function addImage(env: Env, s: Spec): Promise<number> {
  const fileName = s.rel.slice(s.rel.lastIndexOf('/') + 1);
  const m = /^(\d+)_p\d+\./.exec(fileName);
  const bytes = s.file ? await png(s.id) : null;
  env.ds.ctx.db
    .prepare(
      `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
         content_kind, content_kind_source, tagged_at, source_site, source_post_id, source_url)
       VALUES (@id, 1, @rel, @fileName, 1200, 1700, @bytes, 'png', @sha, @at, @at, @kind, 'default', @tagged, @site, @post, @url)`,
    )
    .run({
      id: s.id,
      rel: s.rel,
      fileName,
      bytes: bytes?.length ?? 10 + s.id,
      sha: bytes ? createHash('sha256').update(bytes).digest('hex') : `sha-${s.id}`,
      at: OLD.toISOString(),
      kind: s.kind ?? 'illustration',
      tagged: s.tagged === false ? null : OLD.toISOString(),
      site: m ? 'pixiv' : null,
      post: m ? m[1]! : null,
      url: m ? `https://www.pixiv.net/artworks/${m[1]}` : null,
    });
  if (bytes) {
    const abs = path.join(env.root, s.rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    utimesSync(abs, OLD, OLD);
  }
  return s.id;
}

const one = (env: Env, sql: string, ...args: unknown[]) => env.ds.ctx.db.prepare(sql).pluck().get(...args);
const excludedBy = (env: Env, id: number) => one(env, 'SELECT excluded_by FROM images WHERE id = ?', id) as number | null;
const ctxOf = (): JobContext => ({
  signal: new AbortController().signal,
  setTotal() {},
  advance() {},
  setMessage() {},
  shouldYield: () => false,
  requeue() {},
  yielded: false,
});

describe('附录 #13：所有改来源的路径走同一个 image.sourceChanged', () => {
  /** 图 1 原来是 Pixiv 98785437，查过、有 Pixiv 建议；各个入口把它的来源改成 98785438 */
  async function setup(): Promise<Env> {
    const env = await engine();
    await addImage(env, { id: 1, rel: 'pics/98785437_p0.png', file: true });
    const db = env.ds.ctx.db;
    db.prepare("INSERT INTO pixiv_character_checks (image_id, post_id, modified_at, checked_at, result) VALUES (1, '98785437', ?, ?, 'suggested')").run(OLD.toISOString(), OLD.toISOString());
    db.prepare("INSERT INTO character_evidence (image_id, tag, score, provider) VALUES (1, 'alice_(game_a)', 0, 'pixiv')").run();
    return env;
  }
  const outcome = (env: Env) => ({
    post: one(env, 'SELECT source_post_id FROM images WHERE id = 1'),
    pixivSuggestions: env.ds.ctx.db.prepare("SELECT danbooru_tag FROM v_character_suggestions WHERE image_id = 1 AND source = 'pixiv'").pluck().all(),
    check: env.ds.ctx.db.prepare('SELECT post_id, checked_at FROM pixiv_character_checks WHERE image_id = 1').get(),
  });
  const entries: [string, (env: Env) => Promise<unknown>][] = [
    ['手动改来源', (env) => env.ds.updateImage('1', { source: { url: 'https://www.pixiv.net/artworks/98785438' } })],
    [
      '扫描发现改名',
      async (env) => {
        renameSync(path.join(env.root, 'pics/98785437_p0.png'), path.join(env.root, 'pics/98785438_p0.png'));
        env.ds.requests.requestFull();
        await env.ds.scanner.scan(ctxOf());
      },
    ],
    [
      '查重合并来源',
      async (env) => {
        await addImage(env, { id: 2, rel: 'pics/copy.png' });
        const db = env.ds.ctx.db;
        db.prepare("UPDATE images SET source_site = 'pixiv', source_post_id = '98785438', source_url = 'https://www.pixiv.net/artworks/98785438', source_manual = 1 WHERE id = 2").run();
        db.prepare("INSERT INTO duplicate_groups (id, kind, similarity, created_at) VALUES (1, 'exact', 1, 'x')").run();
        db.prepare('INSERT INTO duplicate_members (group_id, image_id) VALUES (1, 1), (1, 2)').run();
        await env.ds.resolveDuplicate('1', ['1']);
      },
    ],
  ];

  it('手动改来源、扫描发现改名、查重合并来源：都清掉旧投稿的 Pixiv 建议、按新投稿号重新登记补充', async () => {
    const results: Record<string, unknown> = {};
    for (const [name, change] of entries) {
      const env = await setup();
      await change(env);
      results[name] = outcome(env);
    }
    const expected = { post: '98785438', pixivSuggestions: [], check: { post_id: '98785438', checked_at: null } };
    expect(results).toEqual(Object.fromEntries(entries.map(([n]) => [n, expected])));
  });

  it('撤销手动改来源：来源、Pixiv 建议、检查记录都回去', async () => {
    const env = await setup();
    const before = outcome(env);
    const r = await env.ds.updateImage('1', { source: { url: 'https://www.pixiv.net/artworks/98785438' } });
    await env.ds.undo(r.undoToken!);
    expect(outcome(env)).toEqual(before);
  });
});

describe('附录 #14、#15：排除结果是派生的，双向重算', () => {
  async function withRule(): Promise<Env> {
    const env = await engine();
    for (const id of [1, 2, 3]) await addImage(env, { id, rel: `pics/${id}.png` });
    await env.ds.createExclusion({ kind: 'character', target: '1' });
    return env;
  }

  it('角色合并带进来的关联也套排除规则', async () => {
    const env = await withRule();
    await env.ds.bulkImages({ ids: ['1'], action: { type: 'assign', characterId: '2' } });
    expect(excludedBy(env, 1)).toBeNull();
    await env.ds.mergeCharacter('2', '1');
    expect(excludedBy(env, 1)).not.toBeNull();
  });

  it('去掉角色后放出来（整组替换、批量移除都一样），撤销后又排除', async () => {
    const env = await withRule();
    await env.ds.bulkImages({ ids: ['1', '2'], action: { type: 'assign', characterId: '1' } });
    expect([excludedBy(env, 1), excludedBy(env, 2)].every((x) => x !== null)).toBe(true);
    const a = await env.ds.updateImage('1', { characterIds: [] });
    const b = await env.ds.bulkImages({ ids: ['2'], action: { type: 'unassign', characterId: '1' } });
    expect([excludedBy(env, 1), excludedBy(env, 2)]).toEqual([null, null]);
    await env.ds.undo(b.undoToken!);
    await env.ds.undo(a.undoToken!);
    expect([excludedBy(env, 1), excludedBy(env, 2)].every((x) => x !== null)).toBe(true);
  });

  it('删掉一条规则：还被别的规则命中的图换成那条，没有的放出来', async () => {
    const env = await withRule();
    await env.ds.bulkImages({ ids: ['1', '2'], action: { type: 'assign', characterId: '1' } });
    const single = await env.ds.createExclusion({ kind: 'image', target: '2' });
    expect(single.message).toContain('0 张'); // 已经被角色规则排除
    const charRule = (await env.ds.listExclusions()).find((e) => e.kind === 'character')!;
    await env.ds.deleteExclusion(charRule.id);
    expect(excludedBy(env, 1)).toBeNull();
    expect(excludedBy(env, 2)).toBe(Number((await env.ds.listExclusions())[0]!.id));
  });

  it('「恢复」是决定：之后规则重新判定也不再排除；明确「排除这张」会取消这个例外', async () => {
    const env = await withRule();
    await env.ds.bulkImages({ ids: ['1'], action: { type: 'assign', characterId: '1' } });
    await env.ds.bulkImages({ ids: ['1'], action: { type: 'restore' } });
    expect(excludedBy(env, 1)).toBeNull();
    await env.ds.updateImage('1', { characterIds: ['1', '2'] }); // 角色又变了，规则重新判定
    expect(excludedBy(env, 1)).toBeNull();
    await env.ds.bulkImages({ ids: ['1'], action: { type: 'exclude' } });
    expect(excludedBy(env, 1)).not.toBeNull();
  });

  it('移出被排除的文件夹：放出来；移回去：又排除（应用内移动、撤回移动一样）', async () => {
    const env = await engine();
    await addImage(env, { id: 1, rel: 'hide/1.png', file: true });
    await env.ds.createExclusion({ kind: 'folder', target: path.join(env.root, 'hide') });
    expect(excludedBy(env, 1)).not.toBeNull();
    // 被排除的图不在 v_counted_images 里，但仍能移动（requireVisibleImages 看 v_images）
    const moved = await env.ds.moveImages({ ids: ['1'], rootId: '1', dir: 'show' });
    expect(excludedBy(env, 1)).toBeNull();
    await env.ds.undo(moved.undoToken!);
    expect(one(env, 'SELECT rel_path FROM images WHERE id = 1')).toBe('hide/1.png');
    expect(excludedBy(env, 1)).not.toBeNull();
  });
});

describe('附录 #16：恢复排除后重新排队识别', () => {
  it('没识别过的图被放出来时排识别；识别过的不排（批量恢复、删规则一样）', async () => {
    for (const via of ['restore', 'deleteRule'] as const) {
      const env = await engine();
      await addImage(env, { id: 1, rel: 'pics/1.png', tagged: false });
      await addImage(env, { id: 2, rel: 'pics/2.png' });
      const requestTag = vi.spyOn(env.ds as unknown as { requestTag(): void }, 'requestTag');
      await env.ds.createExclusion({ kind: 'image', target: '2' });
      await env.ds.bulkImages({ ids: ['2'], action: { type: 'restore' } });
      expect(requestTag, `${via}：识别过的图`).not.toHaveBeenCalled();
      const rule = await env.ds.createExclusion({ kind: 'image', target: '1' });
      expect(requestTag).not.toHaveBeenCalled();
      if (via === 'restore') await env.ds.bulkImages({ ids: ['1'], action: { type: 'restore' } });
      else await env.ds.undo(rule.undoToken!);
      expect(requestTag, via).toHaveBeenCalledTimes(1);
    }
  });
});

describe('附录 #17：合集在各种变化之后都刷新', () => {
  /** 「书」文件夹手动成册（3 页），另一张图在别处 */
  async function withBook(): Promise<Env> {
    const env = await engine();
    for (const id of [1, 2, 3]) await addImage(env, { id, rel: `book/00${id}.png`, file: true });
    await addImage(env, { id: 4, rel: 'loose/004.png', file: true });
    await env.ds.createCollection({ fromImageId: '1', kind: 'doujin' });
    return env;
  }
  const pages = (env: Env) => env.ds.ctx.db.prepare('SELECT id FROM images WHERE collection_id IS NOT NULL ORDER BY page_no').pluck().all();

  it('应用内移动进书的文件夹：成为新的一页；撤回移动：离开', async () => {
    const env = await withBook();
    expect(pages(env)).toEqual([1, 2, 3]);
    const moved = await env.ds.moveImages({ ids: ['4'], rootId: '1', dir: 'book' });
    expect(pages(env)).toEqual([1, 2, 3, 4]);
    await env.ds.undo(moved.undoToken!);
    expect(pages(env)).toEqual([1, 2, 3]);
  });

  it('后台任务改了类型（帧数、相机）：任务结束时重算，让出或中止的任务也一样', async () => {
    const env = await withBook();
    // 识别、缩略图任务的写入：job actor 下声明 image.kindChanged，合集延后到任务结束
    runAs('job:thumbnail', () =>
      env.ds.ctx.apply(() => {
        env.ds.ctx.db.prepare("UPDATE images SET content_kind = 'screenshot', content_kind_manual = 1 WHERE id = 2").run();
        env.ds.ctx.changed({ type: 'image.kindChanged', ids: [2] });
      }),
    );
    expect(pages(env)).toEqual([1, 2, 3]); // 还没到任务结束
    env.ds.ctx.propagation.jobFinished('thumbnail'); // core/jobs.ts 在任务结束（不论完成、让出、取消）时调用
    const now = pages(env);
    // 和用户手动改类型的结果一样
    const user = await withBook();
    await user.ds.updateImage('2', { kind: 'screenshot' });
    expect(now).toEqual(pages(user));
  });

  it('排除和恢复：页离开再回来，页码不变', async () => {
    const env = await withBook();
    const ex = await env.ds.createExclusion({ kind: 'image', target: '2' });
    expect(pages(env)).toEqual([1, 3]);
    await env.ds.undo(ex.undoToken!);
    expect(pages(env)).toEqual([1, 2, 3]);
  });
});

describe('附录 #18：查重标记持久化，可见性和文件内容变化都标记', () => {
  const entries: [string, (env: Env) => Promise<MutationResult>][] = [
    ['排除', (env) => env.ds.bulkImages({ ids: ['1'], action: { type: 'exclude' } })],
    ['移到回收站', (env) => env.ds.bulkImages({ ids: ['1'], action: { type: 'trash' } })],
    ['停用文件夹', (env) => env.ds.updateLibraryRoot('1', { enabled: false })],
  ];
  it.each(entries)('%s、撤销：都标「要查重」，记在库里', async (_name, change) => {
    const env = await engine();
    await addImage(env, { id: 1, rel: 'pics/1.png', file: true });
    const db = env.ds.ctx.db;
    expect(hasWork(db, 'dedupe')).toBe(false);
    const r = await change(env);
    expect(hasWork(db, 'dedupe')).toBe(true);
    db.prepare('DELETE FROM pending_work').run();
    await env.ds.undo(r.undoToken!);
    expect(hasWork(db, 'dedupe')).toBe(true);
  });
});

describe('附录 #19：Pixiv 资格变了重新登记', () => {
  /** Pixiv 的图，开始时不符合资格的各种原因；改掉那个原因之后都应该排进 Pixiv 补充 */
  const entries: [string, (env: Env) => Promise<unknown>, (env: Env) => Promise<unknown>][] = [
    ['放下 → 放回', (env) => env.ds.bulkImages({ ids: ['1'], action: { type: 'shelve', value: true } }), (env) => env.ds.bulkImages({ ids: ['1'], action: { type: 'shelve', value: false } })],
    ['截图 → 插画', (env) => env.ds.updateImage('1', { kind: 'screenshot' }), (env) => env.ds.updateImage('1', { kind: 'illustration' })],
    ['原创 → 取消原创', (env) => env.ds.bulkImages({ ids: ['1'], action: { type: 'original', value: true } }), (env) => env.ds.bulkImages({ ids: ['1'], action: { type: 'original', value: false } })],
    ['归到角色 → 移除', (env) => env.ds.bulkImages({ ids: ['1'], action: { type: 'assign', characterId: '2' } }), (env) => env.ds.bulkImages({ ids: ['1'], action: { type: 'unassign', characterId: '2' } })],
  ];
  it.each(entries)('%s', async (_name, block, unblock) => {
    const env = await engine();
    await addImage(env, { id: 1, rel: 'pics/98785555_p0.png' });
    await block(env);
    env.ds.ctx.db.prepare('DELETE FROM pixiv_character_checks').run();
    await unblock(env);
    const check = env.ds.ctx.db.prepare('SELECT post_id, checked_at, result FROM pixiv_character_checks WHERE image_id = 1').get() as
      | { post_id: string; checked_at: string | null; result: string | null }
      | undefined;
    // 移除角色会把这张记成「用户处理过」（dismissed），不再自动补；其余都排进待查
    if (_name.includes('移除')) expect(check?.result).toBe('dismissed');
    else expect(check).toEqual({ post_id: '98785555', checked_at: null, result: null });
  });
});

describe('附录 #20、#21：缓存和事件按 actor', () => {
  async function watch(env: Env) {
    const events: string[] = [];
    const soft: boolean[] = [];
    env.bus.subscribe((e: ServerEvent) => {
      if (e.type === 'library-changed') events.push(e.reason);
    });
    env.ds.ctx.onInvalidate((_s, o) => void soft.push(!!o.soft));
    return { events, soft };
  }

  it('用户、助手的操作强刷新，推 mutation，各一次；伪造的助手头按用户算', async () => {
    const env = await engine();
    await addImage(env, { id: 1, rel: 'pics/1.png' });
    const app = await buildApp(env.ds, env.bus);
    const seen = await watch(env);
    const actors: string[] = [];
    env.ds.ctx.propagation.register({ name: 't.actor', on: ['curation.favoriteChanged'], phase: 'after', run: ({ actor }) => void actors.push(actor) });
    const patch = (headers: Record<string, string>) =>
      app.inject({ method: 'PATCH', url: '/api/images/1', headers: { 'content-type': 'application/json', ...headers }, payload: { favorite: true } });
    expect((await patch({})).statusCode).toBe(200);
    expect((await patch({ [ACTOR_HEADER]: ASSISTANT_HEADER_VALUE })).statusCode).toBe(200);
    expect((await patch({ [ACTOR_HEADER]: 'assistant' })).statusCode).toBe(200);
    expect(actors).toEqual(['user', 'assistant', 'user']);
    expect(seen.events).toEqual(['mutation', 'mutation', 'mutation']);
    expect(seen.soft).toEqual([false, false, false]);
    await app.close();
  });

  it('后台任务写库弱刷新、事件节流；任务结束按任务种类推（不再一律是 scan）', async () => {
    const env = await engine();
    await addImage(env, { id: 1, rel: 'pics/1.png' });
    const seen = await watch(env);
    for (let i = 0; i < 3; i++) {
      runAs('job:pixiv-tags', () => env.ds.ctx.apply(() => env.ds.ctx.changed({ type: 'curation.favoriteChanged', ids: [1] })));
    }
    expect(seen.soft).toEqual([true, true, true]);
    expect(seen.events).toEqual(['pixiv-tags']); // 第一次马上推，后面的在节流窗口里
    env.ds.ctx.propagation.jobFinished('pixiv-tags');
    expect(seen.events).toEqual(['pixiv-tags', 'pixiv-tags']);
  });

  it('真的跑一个任务：执行体在 job:<种类> 下，结束时推这个种类', async () => {
    const actors: string[] = [];
    const env = await engine({
      jobRunner: (kind) => async () => {
        runAs(`job:${kind}`, () => void 0);
        actors.push(String((await import('../../src/propagation/actor.ts')).currentActor()));
      },
    });
    const seen = await watch(env);
    await env.ds.startJob('dedupe');
    await vi.waitFor(() => expect(seen.events).toContain('dedupe'));
    expect(actors).toEqual(['job:dedupe']);
  });
});

describe('附录 #22：撤销 = 还原 + 重跑反应，不再手工接线', () => {
  it('撤销手动改画师：改回自动的图重新排「识别画师」', async () => {
    const env = await engine();
    await addImage(env, { id: 1, rel: 'pics/1.png' });
    const requestArtists = vi.spyOn(env.ds.pipeline, 'requestArtists');
    const r = await env.ds.bulkImages({ ids: ['1'], action: { type: 'artist', mode: 'set', artists: ['someone'] } });
    expect(requestArtists).not.toHaveBeenCalled();
    await env.ds.undo(r.undoToken!);
    expect(requestArtists).toHaveBeenCalledTimes(1);
    // artist-auto 本身也一样
    await env.ds.bulkImages({ ids: ['1'], action: { type: 'artist', mode: 'set', artists: ['someone'] } });
    await env.ds.bulkImages({ ids: ['1'], action: { type: 'artist-auto' } });
    expect(requestArtists).toHaveBeenCalledTimes(2);
  });

  it('撤销切换识别方式：来源变回去，同样重跑「清过期证据、重新登记、本地重新匹配」', async () => {
    const env = await engine();
    await addImage(env, { id: 1, rel: 'pics/144506494_キス魔な山賊.jpg' });
    env.ds.ctx.db.prepare("UPDATE images SET source_site = NULL, source_post_id = NULL, source_url = NULL WHERE id = 1").run();
    const rematch = vi.spyOn(env.ds as unknown as { rematchCachedPixiv(ids: number[]): Promise<number> }, 'rematchCachedPixiv');
    const r = await env.ds.setSourceMode('broad');
    expect(one(env, 'SELECT source_post_id FROM images WHERE id = 1')).toBe('144506494');
    expect(rematch).toHaveBeenLastCalledWith([1]);
    await env.ds.undo(r.undoToken!);
    expect(one(env, 'SELECT source_post_id FROM images WHERE id = 1')).toBeNull();
    expect(rematch).toHaveBeenCalledTimes(2);
    expect((await env.ds.getSettings()).tagger.pixivFilenameMode).toBe('strict');
  });

  it('后台自动绑定不占用户的撤销栈，只记在 change_log（照样能撤回）', async () => {
    const env = await engine();
    const before = (env.ds.ctx.undo as unknown as { entries: Map<string, unknown> }).entries.size;
    env.ds.ctx.db.prepare(
      "INSERT INTO custom_character_matches (character_id, danbooru_tag, score, reason, existing_character_id, dismissed, computed_at) VALUES (2, 'temp_(game_a)', 1, 'exact', NULL, 0, 'x')",
    ).run();
    (env.ds as unknown as { characters: { associateAutomatic(): void } }).characters.associateAutomatic();
    expect((env.ds.ctx.undo as unknown as { entries: Map<string, unknown> }).entries.size).toBe(before);
  });
});
