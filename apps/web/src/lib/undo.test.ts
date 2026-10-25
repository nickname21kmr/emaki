import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './api';
import { announce, forgetFailedUndo, undo } from './queries';
import { useUndoStore } from './stores';

// 撤销栈存在 sessionStorage：node 里没有，换成一个 Map（要赶在 import stores 之前）
const saved = vi.hoisted(() => {
  const saved = new Map<string, string>();
  Object.assign(globalThis, {
    sessionStorage: {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k),
    },
  });
  return saved;
});

/** 「刷新页面」：清掉模块缓存，重新建一个 store，从 sessionStorage 读回来 */
const reload = async () => {
  vi.resetModules();
  return (await import('./stores')).useUndoStore;
};
const tokens = (s: { getState: () => { entries: { token: string }[] } }) => s.getState().entries.map((e) => e.token);

describe('撤销栈', () => {
  beforeEach(() => {
    saved.clear();
    useUndoStore.setState({ entries: [], boot: null });
  });

  it('刷新页面后还在', async () => {
    useUndoStore.getState().push({ token: 't1', label: '收藏 1 张' });
    useUndoStore.getState().push({ token: 't2', label: '归为原创' });
    const after = await reload();
    expect(after).not.toBe(useUndoStore);
    expect(after.getState().entries).toEqual([
      { token: 't2', label: '归为原创' },
      { token: 't1', label: '收藏 1 张' },
    ]);
  });

  it('连上的后端换了启动 id：丢掉旧启动的记录，没连上时记下的归到这次', () => {
    const s = useUndoStore.getState();
    s.setBoot('b1');
    s.push({ token: 'old', label: 'a' });
    s.setBoot(null); // SSE 断开
    s.push({ token: 'gap', label: 'b' });
    s.setBoot('b2'); // 后端重启后重新连上
    expect(tokens(useUndoStore)).toEqual(['gap']);
    expect(useUndoStore.getState().entries[0]?.boot).toBe('b2');

    // 同一个后端断开又连上：都留着
    s.push({ token: 'new', label: 'c' });
    s.setBoot(null);
    s.setBoot('b2');
    expect(tokens(useUndoStore)).toEqual(['new', 'gap']);
  });

  it('刷新后连上的是重启过的后端：旧记录全部丢掉', async () => {
    useUndoStore.getState().setBoot('b1');
    useUndoStore.getState().push({ token: 't1', label: 'a' });
    const after = await reload();
    expect(tokens(after)).toEqual(['t1']);
    after.getState().setBoot('b1');
    expect(tokens(after)).toEqual(['t1']);
    after.getState().setBoot('b2');
    expect(tokens(after)).toEqual([]);
  });

  it('撤销失败：后端回了错误就移除这条，下次 Ctrl+Z 轮到更早的；连不上时留着', () => {
    useUndoStore.getState().push({ token: 't1', label: 'a' });
    useUndoStore.getState().push({ token: 't2', label: 'b' });

    forgetFailedUndo('t2', new ApiRequestError(0, 'network', '连不上'));
    forgetFailedUndo('t2', new ApiRequestError(502, 'network', '后端暂时连不上'));
    expect(tokens(useUndoStore)).toEqual(['t2', 't1']);

    forgetFailedUndo('t2', new ApiRequestError(404, 'not_found', '找不到可撤销的操作（可能已过期）'));
    expect(tokens(useUndoStore)).toEqual(['t1']);
    // revert 抛错时后端也已经把 token 删了
    forgetFailedUndo('t1', new ApiRequestError(409, 'conflict', '冲突'));
    expect(tokens(useUndoStore)).toEqual([]);
  });
});

describe('撤销不了的一步', () => {
  beforeEach(() => {
    saved.clear();
    useUndoStore.setState({ entries: [], boot: null });
  });

  it('移到回收站占住撤销栈，Ctrl+Z 只提示并拿掉它，不越过去撤更早的', async () => {
    const client = { invalidateQueries: vi.fn() } as never;
    useUndoStore.getState().push({ token: 'older', label: '全部保留' });
    announce({ ok: true, message: '已保留 1 张，2 张移到回收站', undoToken: null, irreversible: true }, client);
    const top = useUndoStore.getState().entries[0]!;
    expect(top.barrier).toBe(true);
    expect(await undo(top.token, client)).toBe('gone');
    expect(tokens(useUndoStore)).toEqual(['older']);
  });

  it('普通的没有撤销的结果不占位置', () => {
    announce({ ok: true, message: '已保存', undoToken: null }, { invalidateQueries: vi.fn() } as never);
    expect(useUndoStore.getState().entries).toEqual([]);
  });
});
