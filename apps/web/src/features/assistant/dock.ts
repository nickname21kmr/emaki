import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { AssistantSession } from '@emaki/shared';
import { useLightbox } from '@/lib/stores';

/**
 * 助手附页的停靠状态（主包）：开没开、贴边还是浮起、宽度、暗房插槽，以及收起时胶囊要显示的状态。
 * 对话本身在 useConversation，视图状态在 viewState。
 */
export type Layout = 'leaf' | 'float';
/** bound 并排 / overlay 覆盖 / float 浮页 / darkroom 暗房 / sheet 底页 */
export type SheetForm = 'bound' | 'overlay' | 'float' | 'darkroom' | 'sheet';
export type Unseen = 'reply' | 'incomplete' | null;

const LAYOUT_KEY = 'emaki.assistant.layout';
const WIDTH_KEY = 'emaki.assistant.leaf-width';
export const LEAF_WIDTH = { min: 340, max: 600, initial: 400 } as const;

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* 存不了就只在这次生效 */ }
}
// 旧版「展开」档的位置不再用
try { localStorage.removeItem('emaki.assistant.panel-position.expanded'); } catch { /* 没有 localStorage */ }

function initialWidth() {
  const n = Number(read(WIDTH_KEY));
  return Number.isFinite(n) && n > 0 ? clamp(Math.round(n), LEAF_WIDTH.min, LEAF_WIDTH.max) : LEAF_WIDTH.initial;
}

interface DockState {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  /** localStorage 'emaki.assistant.layout'，默认 leaf */
  layout: Layout;
  setLayout: (v: Layout) => void;
  /** 附页宽度，localStorage 'emaki.assistant.leaf-width'，默认 400 */
  width: number;
  setWidth: (v: number) => void;
  /** 看图器里的插槽（AssistantDarkroomSlot 挂上） */
  slotEl: HTMLElement | null;
  setSlotEl: (el: HTMLElement | null) => void;
  /** 看图器里给读屏播报区的常驻宿主（AssistantDarkroomSlot 挂上） */
  liveEl: HTMLElement | null;
  /** 附页可见（含退场动画），给 Spacer 和 CSS 变量用 */
  shown: boolean;
  setShown: (v: boolean) => void;
  /** 挂着的附页个数（含退场中的）。收起时没有附页就直接清 shown，不等退场回调 */
  sheets: number;
  /** 附页挂上时调，返回卸下时调的函数 */
  mountSheet: () => () => void;
  /** 胶囊状态，由 useConversation 写 */
  lastStatus: AssistantSession['status'] | null;
  /** 这一轮从什么时候开始跑（最后一条提问的 createdAt），胶囊计时用 */
  runStartedAt: number | null;
  setStatus: (status: AssistantSession['status'] | null, runStartedAt: number | null) => void;
  /** 会话的事件流连着没有；断开时胶囊计时停住（由 useConversation 写） */
  connected: boolean;
  setConnected: (v: boolean) => void;
  unseen: Unseen;
  setUnseen: (v: Unseen) => void;
  /** 打开前的焦点，收起时还回去 */
  opener: HTMLElement | null;
  /** 输入框（Footer 用 ref={setComposer} 挂上），给 focusComposer 用 */
  composer: HTMLTextAreaElement | null;
  setComposer: (el: HTMLTextAreaElement | null) => void;
  /** 刚打开、还等着把焦点放进去（输入框挂上时接走；没有输入框时 Sheet 挂上后调 focusAssistant） */
  wantsFocus: boolean;
  /** 收起后焦点该落在胶囊上（Capsule 挂上时接走） */
  focusCapsule: boolean;
  setFocusCapsule: (v: boolean) => void;
}

export const useAssistantDock = create<DockState>((set, get) => ({
  open: false,
  // 打开时 Spacer 先到位（shown），清掉胶囊上的「有新回复」；收起后 shown 等附页退场卸下再清，
  // 还没有附页挂上（刚点开就收起）就马上清
  setOpen: (open) => set(open ? { open, unseen: null, shown: true } : { open, wantsFocus: false, shown: get().sheets > 0 }),
  toggle: () => (get().open ? closeAssistant() : openAssistant()),
  layout: read(LAYOUT_KEY) === 'float' ? 'float' : 'leaf',
  setLayout: (layout) => { write(LAYOUT_KEY, layout); set({ layout }); },
  width: initialWidth(),
  setWidth: (v) => {
    const width = clamp(Math.round(v), LEAF_WIDTH.min, LEAF_WIDTH.max);
    write(WIDTH_KEY, String(width));
    set({ width });
  },
  slotEl: null,
  setSlotEl: (slotEl) => set({ slotEl }),
  liveEl: null,
  shown: false,
  setShown: (shown) => set({ shown }),
  sheets: 0,
  mountSheet: () => {
    set((s) => ({ sheets: s.sheets + 1 }));
    return () => set((s) => {
      const sheets = Math.max(0, s.sheets - 1);
      return { sheets, shown: s.open || sheets > 0 ? s.shown : false };
    });
  },
  lastStatus: null,
  runStartedAt: null,
  setStatus: (lastStatus, runStartedAt) => set({ lastStatus, runStartedAt }),
  connected: true,
  setConnected: (connected) => set({ connected }),
  unseen: null,
  setUnseen: (unseen) => set({ unseen }),
  opener: null,
  composer: null,
  setComposer: (composer) => {
    set({ composer });
    if (composer && get().wantsFocus) {
      // 重新挂上时值已经带着草稿，光标放到末尾
      composer.focus({ preventScroll: true });
      composer.setSelectionRange(composer.value.length, composer.value.length);
      set({ wantsFocus: false });
    }
  },
  wantsFocus: false,
  focusCapsule: false,
  setFocusCapsule: (focusCapsule) => set({ focusCapsule }),
}));

/** 真正的附页（/dev/ui 里摆出来的静态附页标成 data-assistant-sheet="static"，不算） */
export const LIVE_SHEET = '[data-assistant-sheet]:not([data-assistant-sheet="static"])';

/** 打开附页：记下原来的焦点，等输入框挂上后把焦点放进去。已经开着就只把焦点移进去 */
export function openAssistant() {
  const dock = useAssistantDock.getState();
  if (dock.open) return focusAssistant();
  const active = document.activeElement;
  useAssistantDock.setState({
    opener: active instanceof HTMLElement && active !== document.body ? active : null,
    wantsFocus: true,
    focusCapsule: false,
  });
  dock.setOpen(true);
}

/** 收起附页（不停止任务）。焦点在助手里时还给打开前的位置；不在就不动它 */
export function closeAssistant() {
  const dock = useAssistantDock.getState();
  if (!dock.open) return;
  const active = document.activeElement;
  const inside = !active || active === document.body || Boolean(active.closest?.(LIVE_SHEET));
  dock.setOpen(false);
  if (!inside) return;
  const opener = dock.opener;
  // 看图器里还给看图器本身：还给顶栏「助手」按钮会弹出 tooltip，下一下 Esc 被它吃掉
  if (useLightbox.getState().open) document.querySelector<HTMLElement>('[data-lightbox-root]')?.focus({ preventScroll: true });
  else if (opener?.isConnected && !opener.closest(LIVE_SHEET)) opener.focus({ preventScroll: true });
  else useAssistantDock.setState({ focusCapsule: true });
}

/** Footer 的 textarea 用 ref={bindComposer}：挂上时登记（等着的焦点在这里接走），卸下时只清自己 */
export function bindComposer(el: HTMLTextAreaElement | null) {
  if (!el) return;
  useAssistantDock.getState().setComposer(el);
  return () => {
    if (useAssistantDock.getState().composer === el) useAssistantDock.getState().setComposer(null);
  };
}

/** 把焦点放进输入框；caretEnd 时光标移到末尾。没有输入框就什么都不做 */
export function focusComposer(caretEnd = false) {
  const el = useAssistantDock.getState().composer;
  if (!el) return false;
  el.focus({ preventScroll: true });
  if (caretEnd) el.setSelectionRange(el.value.length, el.value.length);
  return true;
}

/** 焦点移进附页：优先输入框；没有页脚时给标 data-autofocus 的控件（「去设置」或标题按钮），再不行给第一个按钮 */
export function focusAssistant() {
  if (focusComposer()) { useAssistantDock.setState({ wantsFocus: false }); return; }
  const sheet = document.querySelector(LIVE_SHEET);
  const target = sheet?.querySelector<HTMLElement>('[data-autofocus]') ?? sheet?.querySelector<HTMLElement>('button');
  // 附页还没挂上（胶囊还在退场、连按两次）：留着 wantsFocus，输入框挂上时接走
  if (!target) { useAssistantDock.setState({ wantsFocus: true }); return; }
  useAssistantDock.setState({ wantsFocus: false });
  target.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ 形态

/** 暗房里并排放附页的最小视口宽度；再窄图会被挤没，改成看图器里的底页 */
export const DARKROOM_MIN = 900;

/** 选形态（§2.2）：底页（窄屏）> 暗房 > 浮页 > 并排（主纸留得下 720）> 覆盖 */
export function sheetForm(vw: number, layout: Layout, width: number, lightboxOpen: boolean, hasSlot: boolean): SheetForm {
  if (vw < 640) return 'sheet';
  if (lightboxOpen && hasSlot) return vw >= DARKROOM_MIN ? 'darkroom' : 'sheet';
  if (layout === 'float' && vw >= 900) return 'float';
  // 76 侧栏 + 8 + 720 主纸 + 8 缝 + W + 8 右距
  if (layout === 'leaf' && vw >= 812 + width) return 'bound';
  return 'overlay';
}

/** 宽度手柄的范围：并排时主纸至少留 720，覆盖时左边至少露出 100 */
export function sheetWidthRange(form: SheetForm, vw: number): { min: number; max: number } {
  const min = LEAF_WIDTH.min;
  if (form === 'bound') return { min, max: Math.max(min, Math.min(LEAF_WIDTH.max, vw - 812)) };
  if (form === 'overlay') return { min, max: Math.max(min, Math.min(560, vw - 100)) };
  if (form === 'darkroom') return { min, max: 400 };
  return { min, max: LEAF_WIDTH.max };
}

/** 这个形态下附页实际占的宽度（float 和 sheet 不贴边，返回 0） */
export function leafWidth(form: SheetForm, width: number, vw: number): number {
  if (form === 'bound') return width;
  // 覆盖时和手柄同一个范围：从宽的并排缩窗过来，也不会比手柄声明的上限还宽
  if (form === 'overlay') {
    const { min, max } = sheetWidthRange(form, vw);
    return clamp(width, min, max);
  }
  if (form === 'darkroom') return clamp(width, LEAF_WIDTH.min, 400);
  return 0;
}

const subscribeResize = (onChange: () => void) => {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
};
/** 视口宽度（resize 时更新） */
export function useViewportWidth() {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth, () => 1440);
}

export function useSheetForm(): SheetForm {
  const vw = useViewportWidth();
  const layout = useAssistantDock((s) => s.layout);
  const width = useAssistantDock((s) => s.width);
  const hasSlot = useAssistantDock((s) => Boolean(s.slotEl));
  const lightboxOpen = useLightbox((s) => s.open);
  return sheetForm(vw, layout, width, lightboxOpen, hasSlot);
}
