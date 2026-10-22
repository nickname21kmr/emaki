import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/events.ts';
import type { JobContext } from '../../core/jobs.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from './SqliteDataSource.ts';

// 不联网：把 Pixiv 补充换成一直跑到被取消的假任务，待查数量由测试控制
const fake = vi.hoisted(() => ({ pending: 0, runs: 0, clears: 0 }));
vi.mock('../../services/pixiv/sync.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/pixiv/sync.ts')>()),
  pendingPixivCount: () => fake.pending,
  queuePixivImages: () => {},
  clearPendingPixivCache: () => { fake.clears++; },
  syncPixivCharacters: (_ctx: unknown, job: JobContext) => {
    fake.runs++;
    return new Promise<string>((resolve) => job.signal.addEventListener('abort', () => resolve('已取消')));
  },
}));

describe('设置：识别后自动查 Pixiv 标签', () => {
  let dir: string;
  let ds: SqliteDataSource;
  const pixivJobs = async () => (await ds.listJobs()).filter((j) => j.kind === 'pixiv-tags').map((j) => j.status);

  beforeEach(async () => {
    fake.pending = 0;
    fake.runs = 0;
    fake.clears = 0;
    dir = makeTmpDir('pixiv-settings');
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
  });
  afterEach(async () => {
    for (const j of await ds.listJobs()) if (j.status === 'queued' || j.status === 'running') await ds.cancelJob(j.id);
    await vi.waitFor(async () => expect((await ds.listJobs()).some((j) => j.status === 'running')).toBe(false));
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('默认关；打开时有积压就排一轮，关掉时停掉自动排上的', async () => {
    expect((await ds.getSettings()).tagger.pixiv).toBe(false);
    // 没有积压：打开不排
    await ds.updateSettings({ tagger: { pixiv: true } });
    expect(await pixivJobs()).toEqual([]);
    await ds.updateSettings({ tagger: { pixiv: false } });

    fake.pending = 3;
    await ds.updateSettings({ tagger: { pixiv: true } });
    expect(await pixivJobs()).toEqual(['running']);
    expect(fake.runs).toBe(1);
    await ds.updateSettings({ tagger: { pixiv: false } });
    await vi.waitFor(async () => expect(await pixivJobs()).toEqual(['cancelled']));
    expect((await ds.getSettings()).tagger.pixiv).toBe(false);
  });

  it('默认严格；切换模式立即重算已有来源，保留人工来源和模型建议，恢复自动来源也使用当前模式', async () => {
    const db = ds.ctx.db;
    const rootId = db.prepare("INSERT INTO library_roots(path) VALUES('D:/Pics')").run().lastInsertRowid;
    const name = '104714967_３人で奉仕.jpg';
    const insert = db.prepare(`INSERT INTO images(root_id,rel_path,file_name,width,height,bytes,format,sha256,added_at,modified_at)
      VALUES(?,?,?,10,10,10,'jpg',?,'2026-01-01','2026-01-01')`);
    const id = String(insert.run(rootId,name,name,'auto').lastInsertRowid);
    const manualId = String(insert.run(rootId,`copy/${name}`,name,'manual').lastInsertRowid);
    await ds.updateImage(manualId, {source:{url:'https://example.com/manual'}});
    expect((await ds.getSettings()).tagger.pixivFilenameMode).toBe('strict');
    expect((await ds.getImage(id))?.source).toBeNull();
    await ds.updateSettings({tagger:{pixivFilenameMode:'broad'}});
    expect((await ds.getImage(id))?.source).toMatchObject({site:'pixiv',postId:'104714967'});
    db.prepare("INSERT INTO character_suggestions(image_id,danbooru_tag,score,source) VALUES (?,'pixiv_role',0,'pixiv'),(?,'model_role',0.7,'tagger')").run(id,id);
    await ds.updateSettings({tagger:{pixivFilenameMode:'strict'}});
    expect((await ds.getImage(id))?.source).toBeNull();
    expect(db.prepare('SELECT danbooru_tag FROM character_suggestions WHERE image_id=?').pluck().all(id)).toEqual(['model_role']);
    expect((await ds.getImage(manualId))?.source?.url).toBe('https://example.com/manual');
    await ds.updateImage(manualId,{source:'auto'});
    expect(await ds.getImage(manualId)).toMatchObject({source:null,sourceManual:false});
    await ds.updateSettings({tagger:{pixivFilenameMode:'broad'}});
    expect((await ds.getImage(manualId))?.source?.postId).toBe('104714967');
    expect(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='tagger'").pluck().get() as string).pixivFilenameMode).toBe('broad');
    expect(await ds.listJobs()).toEqual([]);
  });

  it('关着时手动点按钮照常跑；跑的时候关掉设置也不取消它', async () => {
    fake.pending = 3;
    await ds.startJob('pixiv-tags');
    expect(await pixivJobs()).toEqual(['running']);
    // 跑着时打开设置不追加一轮；再关掉也不取消手动点的这一轮
    await ds.updateSettings({ tagger: { pixiv: true } });
    expect(await pixivJobs()).toEqual(['running']);
    await ds.updateSettings({ tagger: { pixiv: false } });
    expect(await pixivJobs()).toEqual(['running']);
    expect(fake.runs).toBe(1);
  });

  it('普通补跑保留缓存，显式刷新才清缓存；运行中重复启动不干扰当前任务', async () => {
    fake.pending=3;
    const first=await ds.startJob('pixiv-tags');
    expect(fake.clears).toBe(0);
    expect((await ds.startJob('pixiv-tags',{refreshPixiv:true})).id).toBe(first.id);
    expect(fake.clears).toBe(0);
    expect(fake.runs).toBe(1);
    await ds.cancelJob(first.id);
    await vi.waitFor(async()=>expect((await ds.listJobs()).some(j=>j.status==='running')).toBe(false));
    await ds.startJob('pixiv-tags',{refreshPixiv:true});
    expect(fake.clears).toBe(1);
    expect(fake.runs).toBe(2);
  });
});
