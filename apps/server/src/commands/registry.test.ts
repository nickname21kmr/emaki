/**
 * 命令层（commands/registry.ts）：operationId 幂等、审计记录、事务和撤销、撤销屏障、命令事件。
 * operationId 以前只有 AI 助手有（assistant/service.ts 的 operations.json），P6 搬进命令层，所有入口都能用（网页的 Idempotency-Key）。
 */
import type { CommandEvent, ServerEvent } from '@emaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/events.ts';
import { buildContractDb } from '../../test/fixtures/contract-db.ts';
import { openDemoEngine, type DemoEngine } from '../../test/helpers/client.ts';
import { makeTmpDir } from '../../test/helpers/tmp.ts';
import type { CommandDef } from './registry.ts';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

let demo: DemoEngine;
let events: ServerEvent[];
const id = (fixture: string) => String(demo.map.images.get(fixture));

beforeEach(async () => {
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => void events.push(e));
  demo = await openDemoEngine(bus, { dir: makeTmpDir('registry'), memory: true, data: buildContractDb(NOW), now: NOW, clock: () => NOW });
});
afterEach(async () => {
  await demo.ds.close();
});

describe('operationId 幂等（所有入口）', () => {
  it('同一个键：只执行一次，并发和重试都拿到第一次的结果；换了参数 409', async () => {
    const r = demo.ds.registry;
    const input = { ids: [id('i3')], value: true };
    const opts = { actor: 'user' as const, operationId: 'op-1' };
    const [a, b] = await Promise.all([r.execute('curation.setFavorite', input, opts), r.execute('curation.setFavorite', input, opts)]);
    expect(a).toEqual(b);
    const again = await r.execute('curation.setFavorite', input, opts);
    expect(again).toEqual(a);
    expect(r.meta(again)?.replayed).toBe(true);
    // 只执行了一次：审计里只有一行，撤销栈里只有一个令牌
    expect(r.audit.list({ command: 'curation.setFavorite' })).toHaveLength(1);
    await expect(r.execute('curation.setFavorite', { ...input, value: false }, opts)).rejects.toMatchObject({ statusCode: 409, message: 'operationId 已用于不同操作' });
    // 不同调用方（命名空间）同一个 operationId 互不影响
    expect(await r.execute('curation.setFavorite', { ...input, value: false }, { ...opts, namespace: 'assistant:s1' })).toMatchObject({ ok: true });
  });

  it('执行失败什么都没改：让出这个键，可以重试', async () => {
    const r = demo.ds.registry;
    const opts = { operationId: 'op-fail' };
    await expect(r.execute('curation.setFavorite', { ids: ['999999'], value: true }, opts)).rejects.toMatchObject({ statusCode: 404 });
    expect(r.audit.list({ command: 'curation.setFavorite' })[0]).toMatchObject({ status: 'failed', operation_key: null });
    // 参数换成对的、同一个键：照常执行
    await expect(r.execute('curation.setFavorite', { ids: [id('i3')], value: true }, opts)).resolves.toMatchObject({ undoToken: expect.any(String) });
  });

  it('上次进程中途退出、结果不确定的（还在 running）：要求先核对，不自动重放', async () => {
    const r = demo.ds.registry;
    const def = r.get('curation.setFavorite') as CommandDef;
    const spy = vi.spyOn(def, 'tx');
    // 模拟：占了键、还没做完进程就没了（启动时标成 interrupted）
    r.audit.begin({ command: 'curation.setFavorite', actor: 'assistant', key: 'assistant:s1:op-x', signature: 'sig' });
    r.audit.open();
    await expect(r.execute('curation.setFavorite', { ids: [id('i3')], value: true }, { namespace: 'assistant:s1', operationId: 'op-x' })).rejects.toMatchObject({ statusCode: 409 });
    expect(spy).not.toHaveBeenCalled();
    const row = r.audit.byKey('assistant:s1:op-x')!;
    expect(row.status).toBe('interrupted');
  });

  it('不支持幂等的命令（标记看过、撤销）收到 operationId 照常执行（网页每个写请求都带 Idempotency-Key）', async () => {
    const r = demo.ds.registry;
    const fav = await r.execute<{ undoToken: string }>('curation.setFavorite', { ids: [id('i3')], value: true });
    await expect(r.execute('history.undo', { token: fav.undoToken }, { operationId: 'k1' })).resolves.toMatchObject({ ok: true });
  });
});

describe('审计记录：谁改的', () => {
  it('每次执行记一行：命令、actor、结果、撤销令牌、变了哪些事实；失败的记错误', async () => {
    const r = demo.ds.registry;
    const res = await r.execute<{ undoToken: string }>('curation.setRating', { ids: [id('i3')], value: 'sensitive' }, { actor: 'assistant' });
    const [row] = r.audit.list({ limit: 1 });
    expect(row).toMatchObject({ command: 'curation.setRating', actor: 'assistant', status: 'done', undo_token: res.undoToken });
    expect(JSON.parse(row!.changes!)).toContain('curation.ratingChanged');
    await expect(r.execute('curation.setRating', { ids: [id('i3')], value: 'nsfw' })).rejects.toMatchObject({ statusCode: 400 });
    // 校验不过的不算执行过，不记
    expect(r.audit.list({ limit: 1 })[0]!.id).toBe(row!.id);
  });
});

describe('事务、撤销、撤销屏障、事件', () => {
  it('同步命令：命令层开事务和撤销记录，一个命令一个令牌；几个命令合成一次操作（batch）一个令牌撤销全部', async () => {
    const r = demo.ds.registry;
    const before = (await demo.ds.getImage(id('i3')))!;
    const res = await r.batch<{ undoToken: string; message: string }>([
      { name: 'curation.setKind', input: { ids: [id('i3')], value: 'photo' } },
      { name: 'curation.setRating', input: { ids: [id('i3')], value: 'explicit' } },
      { name: 'curation.setFavorite', input: { ids: [id('i3')], value: true } },
    ]);
    expect(res.message).toBe('已收藏');
    expect(r.meta(res)).toMatchObject({ command: 'curation.setKind+curation.setRating+curation.setFavorite', undo: 'token' });
    expect((await demo.ds.getImage(id('i3')))!).toMatchObject({ kind: 'photo', rating: 'explicit', favorite: true });
    await demo.ds.undo(res.undoToken);
    expect((await demo.ds.getImage(id('i3')))!).toMatchObject({ kind: before.kind, rating: before.rating, favorite: before.favorite });
  });

  it('撤销屏障由注册表决定：改设置、启动任务是 barrier；可撤销的命令什么也没改时不占位置；界面小动作不占位置', async () => {
    const r = demo.ds.registry;
    expect(r.meta(await r.execute('settings.update', { ui: { theme: 'dark' } }))?.undo).toBe('barrier');
    expect(r.meta(await r.execute('jobs.start', { kind: 'dedupe' }))?.undo).toBe('barrier');
    const fav = await r.execute('curation.setFavorite', { ids: [id('i3')], value: true });
    expect(r.meta(fav)?.undo).toBe('token');
    // 可撤销的命令这次什么也没改（文件夹本来就启用着）：没有令牌，也不是屏障
    const same = await r.execute('library.updateRoot', { id: String(demo.map.roots.get('root1')), enabled: true });
    expect([(same as { message: string }).message, r.meta(same)]).toMatchObject(['没有变化', { undo: 'none', eventId: null }]);
    expect(r.meta(await r.execute('catalog.markSeen', { id: String(demo.map.characters.get('c1')) }))?.undo).toBe('none');
  });

  it('用户、助手的写命令：changed 事件带变化类型和命令名，命令事件带撤销令牌和这次启动的 id；结果说明里的 eventId 就是那条 changed', async () => {
    const r = demo.ds.registry;
    events.length = 0;
    const res = await r.execute<{ undoToken: string }>('curation.link', { ids: [id('i3')], characterId: String(demo.map.characters.get('c2')) }, { actor: 'assistant' });
    const changed = events.filter((e) => e.type === 'changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ actor: 'assistant', reason: 'mutation', command: 'curation.link', changes: expect.arrayContaining(['curation.charactersChanged']) });
    expect(r.meta(res)?.eventId).toBe((changed[0] as { id: number }).id);
    const command = events.find((e): e is CommandEvent => e.type === 'command')!;
    expect(command).toMatchObject({ name: 'curation.link', actor: 'assistant', undoToken: res.undoToken, undo: 'token', boot: demo.ds.ctx.bus.boot, imageIds: [id('i3')] });
    expect(command.id).toBeGreaterThan((changed[0] as { id: number }).id);
  });
});
