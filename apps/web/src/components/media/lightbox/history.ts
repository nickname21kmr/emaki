/**
 * 看图器在浏览器历史里占的那一条：打开时在当前记录后面推一条同地址、同 key 的记录（不经过路由），
 * 浏览器后退只关看图器，页面、筛选和滚动位置都还在。
 *
 * 这条和它前面那条在路由看来是同一条记录，两者之间的 popstate 不能让路由看到：
 * 路由会当成一次 POP 导航，这一页用过 viewTransition 链接的话还会放一次整页 View Transition。
 */
const MARK = 'emakiLightbox';

type State = Record<string, unknown>;
const asState = (s: unknown): State | null => (s && typeof s === 'object' ? (s as State) : null);

export const isLightboxEntry = (s: unknown) => asState(s)?.[MARK] === true;

/** 照抄当前记录（路由的 key / idx / usr 都不变），只多一个标记 */
export const markLightboxEntry = (s: unknown): State => ({ ...asState(s), [MARK]: true });

type PopHandler = (e: PopStateEvent) => void;
type Slot = { fn: PopHandler | null };

// 模块加载时就注册：window 上的 popstate 监听按注册顺序执行，要排在 createBrowserRouter 注册的那个前面才拦得住
// （main → router.tsx → AppShell → Lightbox → 这里，都在 router.tsx 调 createBrowserRouter 之前执行）。
// 挂在 window 上：热更新重新执行这个模块时沿用第一次注册的那个，新注册的会排到路由后面
const slot: Slot = (() => {
  if (typeof window === 'undefined') return { fn: null };
  const w = window as Window & { __emakiLightboxPop?: Slot };
  if (!w.__emakiLightboxPop) {
    const s: Slot = { fn: null };
    window.addEventListener('popstate', (e) => s.fn?.(e));
    w.__emakiLightboxPop = s;
  }
  return w.__emakiLightboxPop;
})();

/** 看图器挂着的时候接管 popstate（在路由之前） */
export const setLightboxPopHandler = (fn: PopHandler | null) => {
  slot.fn = fn;
};

/** 和 react-router 一样：没有 key 的记录（首次打开的那条）算 'default' */
export const entryKey = (s: unknown) => {
  const key = asState(s)?.key;
  return typeof key === 'string' && key ? key : 'default';
};

/**
 * 前进 / 后退落到一条看图器已经关掉的记录上，往哪边跳过它。
 * 它和前一条同 key：从前一条过来就是在前进（+1），否则是从后面的页面退回来的（-1）。
 */
export const skipDirection = (prevKey: string, landed: unknown): 1 | -1 => (entryKey(landed) === prevKey ? 1 : -1);

/**
 * 一次 popstate 怎么处理。routerKey 是路由当前显示的那条记录的 key。
 * - pass：真的换了一条路由记录，交给路由（看图器开着的话换页时会关掉）
 * - same：还是路由的同一条记录（看图器那条 ↔ 它前面那条），不给路由看；后退到前面那条时看图器还开着，就飞回去
 * - skip：落到一条看图器已经关掉的记录上，不给路由看（筛选改过的话它的地址是旧的），往 step 方向跳过去
 */
export type PopAction = { kind: 'pass' } | { kind: 'same'; putBack: boolean } | { kind: 'skip'; step: 1 | -1 };

export function popAction(routerKey: string, landed: unknown, open: boolean, canGoForward?: boolean): PopAction {
  if (isLightboxEntry(landed) && !open) {
    const step = skipDirection(routerKey, landed);
    // 前进到一条后面什么都没有的看图器记录：退回原处，前进就当没按（不然下一次后退也是空按）
    return { kind: 'skip', step: step === 1 && canGoForward === false ? -1 : step };
  }
  if (entryKey(landed) !== routerKey) return { kind: 'pass' };
  return { kind: 'same', putBack: open && !isLightboxEntry(landed) };
}
