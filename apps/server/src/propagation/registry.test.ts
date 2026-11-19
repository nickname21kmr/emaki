import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/events.ts';
import { SqliteDataSource } from '../../test/helpers/client.ts';
import { makeTmpDir } from '../../test/helpers/tmp.ts';
import type { ChangeType } from './changes.ts';
import { MAX_ROUNDS, type Reaction } from './registry.ts';

const opened: { ds: SqliteDataSource; dir: string }[] = [];
afterEach(async () => {
  for (const { ds, dir } of opened.splice(0)) {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function engine(): Promise<SqliteDataSource> {
  const dir = makeTmpDir('propagation');
  const ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
  opened.push({ ds, dir });
  ds.ctx.db.exec(`INSERT INTO library_roots (id, path) VALUES (1, '//emaki-test/p');
    INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
    VALUES (1, 1, 'a/1.png', '1.png', 1, 1, 1, 'png', 's1', 'x', 'x')`);
  return ds;
}

describe('反应注册表', () => {
  it('事务内反应按注册顺序执行，自己声明的变化在同一轮里交给后面的反应', async () => {
    const ds = await engine();
    const calls: string[] = [];
    ds.ctx.propagation.register(
      { name: 't.a', on: ['curation.favoriteChanged'], phase: 'tx', emits: ['curation.ratingChanged'], run: ({ changes, emit }) => (calls.push(`a:${changes.ids()}`), emit({ type: 'curation.ratingChanged', ids: [1] })) },
      { name: 't.b', on: ['curation.ratingChanged'], phase: 'tx', run: ({ changes }) => void calls.push(`b:${changes.ids()}`) },
      { name: 't.after', on: ['curation.ratingChanged'], phase: 'after', run: ({ all }) => void calls.push(`after:${all.size}`) },
    );
    ds.ctx.apply(() => ds.ctx.changed({ type: 'curation.favoriteChanged', ids: [1] }));
    expect(calls).toEqual(['a:1', 'b:1', 'after:2']);
  });

  it('反应之间有循环：超过固定轮数报错，整个事务回滚', async () => {
    const ds = await engine();
    ds.ctx.propagation.register(
      { name: 't.ping', on: ['curation.favoriteChanged'], phase: 'tx', run: ({ emit }) => emit({ type: 'curation.ratingChanged', ids: [1] }) },
      { name: 't.pong', on: ['curation.ratingChanged'], phase: 'tx', run: ({ emit }) => emit({ type: 'curation.favoriteChanged', ids: [1] }) },
    );
    expect(() =>
      ds.ctx.apply(() => {
        ds.ctx.db.prepare('UPDATE images SET favorite = 1 WHERE id = 1').run();
        ds.ctx.changed({ type: 'curation.favoriteChanged', ids: [1] });
      }),
    ).toThrow(`跑了 ${MAX_ROUNDS} 轮还没停下`);
    expect(ds.ctx.db.prepare('SELECT favorite FROM images WHERE id = 1').pluck().get()).toBe(0);
  });

  it('提交后的反应出错只记日志，数据已经提交', async () => {
    const ds = await engine();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ds.ctx.propagation.register({ name: 't.boom', on: ['curation.favoriteChanged'], phase: 'after', run: () => { throw new Error('boom'); } });
    ds.ctx.apply(() => {
      ds.ctx.db.prepare('UPDATE images SET favorite = 1 WHERE id = 1').run();
      ds.ctx.changed({ type: 'curation.favoriteChanged', ids: [1] });
    });
    expect(ds.ctx.db.prepare('SELECT favorite FROM images WHERE id = 1').pluck().get()).toBe(1);
    expect(warn.mock.calls.flat().join('')).toContain('t.boom');
    warn.mockRestore();
  });

  it('嵌套调用并进外层：外层结束时一起处理一次', async () => {
    const ds = await engine();
    const seen: number[][] = [];
    ds.ctx.propagation.register({ name: 't.count', on: ['curation.favoriteChanged'], phase: 'tx', run: ({ changes }) => void seen.push(changes.ids()) });
    ds.ctx.apply(() => {
      ds.ctx.changed({ type: 'curation.favoriteChanged', ids: [1] });
      ds.ctx.apply(() => ds.ctx.changed({ type: 'curation.favoriteChanged', ids: [2] }));
    });
    expect(seen).toEqual([[1, 2]]);
  });

  it('不在 mutate / apply 里声明变化直接报错；空的按图片变化被丢掉', async () => {
    const ds = await engine();
    expect(() => ds.ctx.changed({ type: 'curation.favoriteChanged', ids: [1] })).toThrow('只能在 ctx.mutate / ctx.apply 里声明');
    const seen: string[] = [];
    ds.ctx.propagation.register({ name: 't.any', on: ['curation.favoriteChanged'], phase: 'tx', run: () => void seen.push('ran') });
    ds.ctx.apply(() => ds.ctx.changed({ type: 'curation.favoriteChanged', ids: [] }));
    expect(seen).toEqual([]);
  });

  it('引擎注册的事务内反应之间没有循环（按「订阅 → 声明」连成的图）', async () => {
    const ds = await engine();
    const tx = ds.ctx.propagation.list().filter((r) => r.phase === 'tx');
    expect(tx.map((r) => r.name)).toEqual([
      'reparseSource',
      // P4a：文件内容变了（D1）先把识别标成过期，分析（唯一入口 analyze）再按新文件重算
      'staleFileEvidence',
      'analyze',
      'dropStalePixivEvidence',
      // P3b：唯一的自动决定规则（decideAuto）只由这个反应调用
      'reevaluateAuto',
      'reevaluateExclusions',
      'queuePixivCheck',
      'refreshPostGroups',
      'refreshFolderCollections',
      'renumberCollections',
    ]);
    // 反应 a 声明了反应 b 订阅的变化：a → b。不能有环
    const edges = new Map<Reaction, Reaction[]>(tx.map((a) => [a, tx.filter((b) => (a.emits ?? []).some((t: ChangeType) => b.on.includes(t)))]));
    const state = new Map<Reaction, 'visiting' | 'done'>();
    const cycle: string[] = [];
    const visit = (r: Reaction, trail: string[]): void => {
      if (state.get(r) === 'done') return;
      if (state.get(r) === 'visiting') return void cycle.push([...trail, r.name].join(' → '));
      state.set(r, 'visiting');
      for (const next of edges.get(r)!) visit(next, [...trail, r.name]);
      state.set(r, 'done');
    };
    for (const r of tx) visit(r, []);
    expect(cycle).toEqual([]);
    // 最长的链也在固定轮数之内（每轮按注册顺序过一遍，往后传的不额外占轮）
    expect(tx.length).toBeLessThan(MAX_ROUNDS * 2);
  });
});
