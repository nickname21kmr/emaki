/**
 * 附录 #35、#36 的前端部分：
 * - 写操作只刷新一遍：SSE 的 changed 事件按变化类型刷新相关的查询，写操作等那条事件的刷新做完，不再自己全部重新获取；
 * - SSE 断着时写操作自己按变化类型刷新（界面仍然及时）；
 * - 按事件类型只刷新相关的查询（改收藏不拉 6 MB 的重复组、不拉设置）；
 * - AI 助手做的、可撤销的修改（command 事件）进网页的撤销栈，按 boot 认领；
 * - 撤销屏障来自命令注册表（响应头的 undo），不是前端自己猜。
 */
import type { ServerEvent } from '@emaki/shared';
import type { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachMeta, type CommandMeta } from './api';
import { createInvalidator, handleServerEvent, resetEventPosition, settleRefresh } from './events';
import { entryOf } from './queries';
import { useUndoStore } from './stores';

/** 只记 invalidateQueries 的假 client；refetched(key) 数这个查询真的重拉了几次 */
function fakeClient() {
  const calls: { predicate?: (q: { queryKey: readonly unknown[] }) => boolean; refetchType?: string }[] = [];
  const client = {
    invalidateQueries: (f?: (typeof calls)[number]) => {
      calls.push(f ?? {});
      return Promise.resolve();
    },
  } as unknown as QueryClient;
  const refetched = (key: unknown[]) =>
    calls.filter((c) => c.refetchType !== 'none' && (!c.predicate || c.predicate({ queryKey: key }))).length;
  return { client, calls, refetched };
}

const meta = (m: Partial<CommandMeta>): CommandMeta => ({
  command: 'curation.setFavorite',
  undo: 'token',
  eventId: null,
  changes: [],
  ...m,
});

describe('写操作只刷新一遍（附录 #36）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEventPosition('boot-1', 0);
  });
  afterEach(() => vi.useRealTimers());

  it('SSE 先到：按事件刷新一次，写操作等它，不再自己刷新', async () => {
    const { client, refetched } = fakeClient();
    const { invalidate } = createInvalidator(client);
    const changed: ServerEvent = {
      type: 'changed',
      id: 7,
      changes: ['curation.favoriteChanged'],
      reason: 'mutation',
      actor: 'user',
      command: 'curation.setFavorite',
    };
    handleServerEvent(client, invalidate, changed);
    vi.advanceTimersByTime(0);
    const settled = settleRefresh(client, meta({ eventId: 7, changes: ['curation.favoriteChanged'] }));
    await vi.runAllTimersAsync();
    await settled;
    expect(refetched(['images', {}])).toBe(1);
    expect(refetched(['image', 'i1'])).toBe(1);
    expect(refetched(['summary'])).toBe(1);
    // 改收藏不碰重复组（一次 6 MB）、排除规则、设置
    expect(refetched(['duplicates', false])).toBe(0);
    expect(refetched(['exclusions'])).toBe(0);
    expect(refetched(['settings'])).toBe(0);
  });

  it('响应先到、SSE 后到：写操作等事件，仍然只刷新一遍', async () => {
    const { client, refetched } = fakeClient();
    const { invalidate } = createInvalidator(client);
    const settled = settleRefresh(client, meta({ eventId: 8, changes: ['curation.ratingChanged'] }));
    handleServerEvent(client, invalidate, {
      type: 'changed',
      id: 8,
      changes: ['curation.ratingChanged'],
      reason: 'mutation',
      actor: 'user',
      command: 'curation.setRating',
    });
    await vi.runAllTimersAsync();
    await settled;
    expect(refetched(['images', {}])).toBe(1);
  });

  it('SSE 断着（等不到事件）：写操作自己按变化类型刷新一遍', async () => {
    const { client, refetched } = fakeClient();
    const settled = settleRefresh(client, meta({ eventId: 9, changes: ['visibility.changed'] }));
    await vi.advanceTimersByTimeAsync(1600);
    await settled;
    expect(refetched(['images', {}])).toBe(1);
    expect(refetched(['exclusions'])).toBe(1);
    expect(refetched(['settings'])).toBe(0);
  });

  it('什么都没改的命令（没有事件）不刷新；不是命令的接口照旧全部刷新', async () => {
    const { client, calls } = fakeClient();
    await settleRefresh(client, meta({ eventId: null }));
    expect(calls).toHaveLength(0);
    await settleRefresh(client, undefined);
    expect(calls).toHaveLength(1);
  });

  it('补不上（resync）：全部刷新', async () => {
    const { client, refetched } = fakeClient();
    const { invalidate } = createInvalidator(client);
    handleServerEvent(client, invalidate, { type: 'resync', reason: 'gap' });
    await vi.runAllTimersAsync();
    expect(refetched(['settings'])).toBe(1);
    expect(refetched(['duplicates', false])).toBe(1);
  });
});

describe('AI 助手的修改进网页的撤销栈（附录 #35）', () => {
  beforeEach(() => useUndoStore.setState({ entries: [], boot: 'boot-1' }));

  const command = (o: Partial<Extract<ServerEvent, { type: 'command' }>> = {}): ServerEvent => ({
    type: 'command',
    id: 3,
    name: 'curation.link',
    actor: 'assistant',
    message: '已将 2 张图归到「圣园未花」',
    undoToken: 'assistant-tok',
    undo: 'token',
    boot: 'boot-1',
    imageIds: ['i1', 'i2'],
    ...o,
  });

  it('助手做的、可撤销的：放进撤销栈（标明是助手、撤销后指回那几张图），同一条不重复', () => {
    const { client } = fakeClient();
    const { invalidate } = createInvalidator(client);
    handleServerEvent(client, invalidate, command());
    handleServerEvent(client, invalidate, command());
    const entries = useUndoStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      token: 'assistant-tok',
      label: '助手：已将 2 张图归到「圣园未花」',
      by: 'assistant',
      boot: 'boot-1',
      focus: { images: ['i1', 'i2'] },
    });
  });

  it('按 boot 认领：别的启动（后端重启前）的不要；用户自己的、撤销不了的也不要', () => {
    const { client } = fakeClient();
    const { invalidate } = createInvalidator(client);
    handleServerEvent(client, invalidate, command({ boot: 'old-boot' }));
    handleServerEvent(client, invalidate, command({ actor: 'user', undoToken: 'user-tok' }));
    handleServerEvent(client, invalidate, command({ undo: 'barrier', undoToken: null }));
    expect(useUndoStore.getState().entries).toEqual([]);
  });
});

describe('撤销屏障来自命令注册表（附录 #33）', () => {
  it('不可撤销的命令（改设置、启动任务）占一格；可撤销但这次没改什么的不占', () => {
    const settings = attachMeta(
      { ok: true as const, message: '已保存', undoToken: null },
      meta({ command: 'settings.update', undo: 'barrier' }),
    );
    expect(entryOf(settings, '改了设置')).toMatchObject({ label: '改了设置', barrier: true });
    const noop = attachMeta(
      { ok: true as const, message: '没有变化', undoToken: null },
      meta({ command: 'curation.setFavorite', undo: 'none' }),
    );
    expect(entryOf(noop, '收藏')).toBeNull();
    // 有令牌就是令牌
    expect(entryOf({ ok: true, message: '已收藏', undoToken: 't' }, '收藏')).toEqual({ token: 't', label: '已收藏' });
  });
});
