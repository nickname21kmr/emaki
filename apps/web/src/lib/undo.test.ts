import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './api';
import { announce, beginPending, forgetFailedUndo, settlePending, undo } from './queries';
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
    // sonner 关 toast 时要用
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
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

  it('第 6 次移到回收站把最早那次挤出去：它原地变成占位，Ctrl+Z 不越过它', async () => {
    const client = { invalidateQueries: vi.fn() } as never;
    useUndoStore.getState().push({ token: 'older', label: '收藏 1 张' });
    useUndoStore.getState().push({ token: 't1', label: '已把 1 张图移到回收站' });
    useUndoStore.getState().push({ token: 'fav', label: '收藏 2 张' });
    announce({ ok: true, message: '已把 2 张图移到回收站', undoToken: 't6', expiredUndoTokens: ['t1'] }, client);
    const entries = useUndoStore.getState().entries;
    expect(entries.map((e) => [e.token, !!e.barrier])).toEqual([
      ['t6', false],
      ['fav', false],
      ['t1', true],
      ['older', false],
    ]);
    expect(await undo('t1', client)).toBe('gone');
    expect(tokens(useUndoStore)).toEqual(['t6', 'fav', 'older']);
  });

  it('没给占位说法的、没有撤销的结果不占位置（只读、外观偏好）', () => {
    announce({ ok: true, message: '已保存', undoToken: null }, { invalidateQueries: vi.fn() } as never);
    expect(useUndoStore.getState().entries).toEqual([]);
  });

  it('改设置 / 开始任务这种没有撤销的写操作也占一格，Ctrl+Z 只提示，不越过去', async () => {
    const client = { invalidateQueries: vi.fn() } as never;
    const spy = vi.spyOn(api, 'undo');
    useUndoStore.getState().push({ token: 'older', label: '收藏 1 张' });
    announce({ ok: true, message: '已保存', undoToken: null }, client, { barrier: '改了设置' });
    const top = useUndoStore.getState().entries[0]!;
    expect(top).toMatchObject({ label: '改了设置', barrier: true });
    expect(top.note).toContain('不能撤销');
    expect(await undo(top.token, client)).toBe('gone');
    expect(spy).not.toHaveBeenCalled();
    expect(tokens(useUndoStore)).toEqual(['older']);
    spy.mockRestore();
  });
});

describe('连着改设置', () => {
  beforeEach(() => {
    saved.clear();
    useUndoStore.setState({ entries: [], boot: null });
  });

  it('挨着的同一种占位只留一条，不把能撤销的挤出栈', () => {
    const client = { invalidateQueries: vi.fn() } as never;
    useUndoStore.getState().push({ token: 'fav', label: '收藏 1 张' });
    for (let i = 0; i < 30; i++) {
      const id = beginPending('改了设置');
      announce({ ok: true, message: '已保存', undoToken: null }, client, { pending: id, silent: true, barrier: '改了设置' });
    }
    expect(useUndoStore.getState().entries.map((e) => e.label)).toEqual(['改了设置', '收藏 1 张']);
  });
});

describe('还在进行的操作', () => {
  const client = { invalidateQueries: vi.fn() } as never;
  beforeEach(() => {
    saved.clear();
    useUndoStore.setState({ entries: [], boot: null });
  });

  it('一开始就占住栈顶，落定后原地换成 token，位置不变', () => {
    useUndoStore.getState().push({ token: 'older', label: 'a' });
    const id = beginPending('排除这张');
    useUndoStore.getState().push({ token: 'later', label: 'b' });
    expect(useUndoStore.getState().entries[1]).toMatchObject({ token: id, pending: true });
    announce({ ok: true, message: '已排除 1 张', undoToken: 't1' }, client, { pending: id, silent: true });
    expect(tokens(useUndoStore)).toEqual(['later', 't1', 'older']);
    expect(useUndoStore.getState().entries[1]!.pending).toBeUndefined();
  });

  it('不存进 sessionStorage', () => {
    beginPending('收藏');
    useUndoStore.getState().push({ token: 't1', label: 'a' });
    expect(JSON.parse(saved.get('emaki.undo')!).state.entries.map((e: { token: string }) => e.token)).toEqual(['t1']);
  });

  it('Ctrl+Z 按到进行中的：等它做完再撤它，不撤上一步；连按两次只撤一次', async () => {
    const spy = vi.spyOn(api, 'undo').mockResolvedValue({ ok: true, message: '已撤销', undoToken: null });
    useUndoStore.getState().push({ token: 'older', label: 'a' });
    const id = beginPending('归为原创');
    const first = undo(id, client);
    const second = undo(id, client);
    expect(second).toBe(first);
    expect(spy).not.toHaveBeenCalled();
    announce({ ok: true, message: '已归为原创', undoToken: 't1' }, client, { pending: id });
    // 落定后马上又按一次：拿到的还是同一次撤销
    await Promise.resolve();
    const third = undo('t1', client);
    expect(await first).toBe('ok');
    expect(await second).toBe('ok');
    expect(await third).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('t1');
    expect(tokens(useUndoStore)).toEqual(['older']);
    spy.mockRestore();
  });

  it('进行中的失败了：拿掉占位，这次 Ctrl+Z 不去撤更早的', async () => {
    const spy = vi.spyOn(api, 'undo');
    useUndoStore.getState().push({ token: 'older', label: 'a' });
    const id = beginPending('收藏');
    const p = undo(id, client);
    settlePending(id, null, true);
    expect(await p).toBe('gone');
    expect(spy).not.toHaveBeenCalled();
    expect(tokens(useUndoStore)).toEqual(['older']);
    spy.mockRestore();
  });

  it('进行中的落定成撤销不了的一步：只提示、拿掉', async () => {
    const id = beginPending('移到回收站');
    const p = undo(id, client);
    announce({ ok: true, message: '已把 1 张图移到回收站', undoToken: null, irreversible: true }, client, { pending: id });
    expect(await p).toBe('gone');
    expect(useUndoStore.getState().entries).toEqual([]);
  });
});

describe('合成一条的多个 token', () => {
  const client = { invalidateQueries: vi.fn() } as never;
  beforeEach(() => {
    saved.clear();
    useUndoStore.setState({ entries: [], boot: null });
  });

  it('一次 Ctrl+Z 倒序撤回全部', async () => {
    const calls: string[] = [];
    const spy = vi.spyOn(api, 'undo').mockImplementation(async (t) => {
      calls.push(t);
      return { ok: true, message: '', undoToken: null };
    });
    useUndoStore.getState().push({ token: 'group:1', label: '已处理 3 组', tokens: ['a', 'b', 'c'] });
    expect(await undo('group:1', client)).toBe('ok');
    expect(calls).toEqual(['c', 'b', 'a']);
    expect(useUndoStore.getState().entries).toEqual([]);
    spy.mockRestore();
  });

  it('其中的 token 被挤出可撤销范围：整条变成撤销不了的占位', () => {
    useUndoStore.getState().push({ token: 'group:1', label: '已处理 3 组', tokens: ['a', 'b'] });
    useUndoStore.getState().markBarrier(['b']);
    expect(useUndoStore.getState().entries[0]!.barrier).toBe(true);
  });
});
