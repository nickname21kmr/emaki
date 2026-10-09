import { afterEach, describe, expect, it, vi } from 'vitest';
import { entryKey, isLightboxEntry, markLightboxEntry, popAction, skipDirection } from './history';

// react-router 存在 history.state 里的样子
const routerState = { usr: { from: 'x' }, key: 'k1', idx: 3 };

describe('看图器的历史记录', () => {
  it('标记时照抄路由的 key / idx / usr', () => {
    const marked = markLightboxEntry(routerState);
    expect(marked).toMatchObject(routerState);
    expect(isLightboxEntry(marked)).toBe(true);
    expect(isLightboxEntry(routerState)).toBe(false);
    expect(entryKey(marked)).toBe('k1');
  });

  it('首次打开的那条没有 state，key 算 default', () => {
    expect(isLightboxEntry(null)).toBe(false);
    expect(entryKey(null)).toBe('default');
    expect(entryKey(markLightboxEntry(null))).toBe('default');
    expect(entryKey(markLightboxEntry({ idx: 0 }))).toBe('default');
  });

  it('落到关掉的看图器记录上：从同一页过来是前进，从别的页退回来是后退', () => {
    const marked = markLightboxEntry(routerState);
    expect(skipDirection('k1', marked)).toBe(1);
    expect(skipDirection('k2', marked)).toBe(-1);
  });
});

// 历史：[页面 U (k1), 看图器 M (照抄 k1)]，后面可能还有从看图器里点出去的页面 C (k2)
describe('popstate 怎么处理', () => {
  const U = routerState;
  const M = markLightboxEntry(U);
  const C = { key: 'k2', idx: 4 };

  it('看图器开着按后退：不给路由看（不会放整页 View Transition），只把看图器飞回去', () => {
    expect(popAction('k1', U, true)).toEqual({ kind: 'same', putBack: true });
  });

  it('Esc / × / 点背景关掉后退掉那条：同样不给路由看，也不再飞一次', () => {
    expect(popAction('k1', U, false)).toEqual({ kind: 'same', putBack: false });
  });

  it('放回动画还没结束又按了前进：还是同一条，什么都不做', () => {
    expect(popAction('k1', M, true)).toEqual({ kind: 'same', putBack: false });
  });

  it('关掉后按前进，后面没有别的记录：不给路由看，退回原处（滚动和多选都不动）', () => {
    expect(popAction('k1', M, false, false)).toEqual({ kind: 'skip', step: -1 });
  });

  it('改过筛选（路由 replace 成了新 key）再按前进：旧地址那条不给路由看，退回来', () => {
    expect(popAction('k1-filtered', M, false, false)).toEqual({ kind: 'skip', step: -1 });
    // 退回到改过筛选的那条：路由本来就在这条上
    expect(popAction('k1-filtered', { key: 'k1-filtered', idx: 3 }, false)).toEqual({ kind: 'same', putBack: false });
  });

  it('从看图器点出去的页面退回来：跳过看图器那条，真正的换页交给路由', () => {
    expect(popAction('k2', M, false, true)).toEqual({ kind: 'skip', step: -1 });
    expect(popAction('k2', U, false)).toEqual({ kind: 'pass' });
  });

  it('再按前进：跳过看图器那条，回到点出去的页面', () => {
    expect(popAction('k1', M, false, true)).toEqual({ kind: 'skip', step: 1 });
    expect(popAction('k1', C, false)).toEqual({ kind: 'pass' });
  });

  it('没有 Navigation API 时照旧往前跳', () => {
    expect(popAction('k1', M, false)).toEqual({ kind: 'skip', step: 1 });
  });

  it('普通的换页（看图器开不开都一样）交给路由', () => {
    expect(popAction('k1', C, false)).toEqual({ kind: 'pass' });
    expect(popAction('k1', C, true)).toEqual({ kind: 'pass' });
  });

  it('首次打开的那条没有 key：和照抄它的看图器记录算同一条', () => {
    expect(popAction('default', { idx: 0 }, true)).toEqual({ kind: 'same', putBack: true });
    expect(popAction('default', markLightboxEntry({ idx: 0 }), false, false)).toEqual({ kind: 'skip', step: -1 });
  });
});

describe('popstate 监听', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('模块加载时就注册，排在后注册的路由前面，能把事件拦下', async () => {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    vi.resetModules();
    const { setLightboxPopHandler } = await import('./history');
    const routerSaw: string[] = [];
    win.addEventListener('popstate', (e) => routerSaw.push(e.type)); // createBrowserRouter 在这之后才注册

    setLightboxPopHandler((e) => e.stopImmediatePropagation());
    win.dispatchEvent(new Event('popstate'));
    expect(routerSaw).toEqual([]);

    // 看图器卸载后不拦
    setLightboxPopHandler(null);
    win.dispatchEvent(new Event('popstate'));
    expect(routerSaw).toEqual(['popstate']);
  });

  it('热更新重新执行模块：沿用第一次注册的监听，不再多注册一个', async () => {
    const win = new EventTarget();
    const add = vi.spyOn(win, 'addEventListener');
    vi.stubGlobal('window', win);
    vi.resetModules();
    await import('./history');
    vi.resetModules();
    const again = await import('./history');
    expect(add).toHaveBeenCalledTimes(1);

    const seen: string[] = [];
    again.setLightboxPopHandler((e) => seen.push(e.type));
    win.dispatchEvent(new Event('popstate'));
    expect(seen).toEqual(['popstate']);
  });
});
