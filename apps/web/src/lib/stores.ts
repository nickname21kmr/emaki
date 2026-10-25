/**
 * 全局 UI 状态（zustand）。服务端数据不要放这里——那是 TanStack Query 的事。
 */
import type { CollectionKind, ContentKind, ID } from '@emaki/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import type { BlurLevel, BlurPrefs } from './blur';
import type { CoverCrop } from './coverCrop';

// ------------------------------------------------------------------ 偏好（持久化到 localStorage）

export type CharactersView = 'shelf' | 'list';
/** 底色：米纸（默认）/ 黑白 / 薄荷 / 天青 / 雾紫，浅色深色各一套（styles/index.css 的 data-palette） */
export type Palette = 'washi' | 'mono' | 'mint' | 'sky' | 'lilac';

interface PrefsState {
  /** 模糊 questionable / explicit 的图（顶栏眼睛按钮） */
  blurSensitive: boolean;
  palette: Palette;
  setPalette: (v: Palette) => void;
  /** 模糊范围（T29b-4）：较敏感和限制级 / 仅限制级 */
  blurLevel: BlurLevel;
  /** 照片也模糊（D6，默认开：可能有证件、真人） */
  blurPhoto: boolean;
  /** 文字图也模糊（默认关） */
  blurText: boolean;
  /** 鼠标停在模糊的图上约 0.35 秒显示清晰图（默认关，CR-12：防旁人看到） */
  revealOnHover: boolean;
  /** 阅读器（T38e，RV-C-17）：按类型记住双页和翻页方向；本子默认双页右开，画集单页左开 */
  readerSpread: Record<CollectionKind, boolean>;
  readerRtl: Record<CollectionKind, boolean>;
  setReaderSpread: (kind: CollectionKind, v: boolean) => void;
  setReaderRtl: (kind: CollectionKind, v: boolean) => void;
  setBlurLevel: (v: BlurLevel) => void;
  setBlurPhoto: (v: boolean) => void;
  setBlurText: (v: boolean) => void;
  setRevealOnHover: (v: boolean) => void;
  charactersView: CharactersView;
  /** 网格目标行高（px），图库页的缩放滑块 */
  gridRowHeight: number;
  /** 角色封面裁剪：优先保住头（默认）/ 跟着构图 */
  coverCrop: CoverCrop;
  setCoverCrop: (v: CoverCrop) => void;
  sidebarCollapsed: boolean;
  /** 图库 URL 里没写 ?kind 时看哪些类型（默认只看插画，D2）；用户换过就记住 */
  galleryKinds: ContentKind[] | 'all';
  /** 图库「只显示插画」的首次提示条已关掉 */
  galleryKindTipSeen: boolean;
  setGalleryKinds: (v: ContentKind[] | 'all') => void;
  dismissGalleryKindTip: () => void;
  setBlurSensitive: (v: boolean) => void;
  toggleBlurSensitive: () => void;
  setCharactersView: (v: CharactersView) => void;
  setGridRowHeight: (v: number) => void;
  setSidebarCollapsed: (v: boolean) => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      blurSensitive: true,
      palette: 'washi',
      setPalette: (palette) => set({ palette }),
      blurLevel: 'questionable',
      blurPhoto: true,
      blurText: false,
      revealOnHover: false,
      readerSpread: { doujin: true, artbook: false },
      readerRtl: { doujin: true, artbook: false },
      setReaderSpread: (kind, v) => set((st) => ({ readerSpread: { ...st.readerSpread, [kind]: v } })),
      setReaderRtl: (kind, v) => set((st) => ({ readerRtl: { ...st.readerRtl, [kind]: v } })),
      setBlurLevel: (blurLevel) => set({ blurLevel }),
      setBlurPhoto: (blurPhoto) => set({ blurPhoto }),
      setBlurText: (blurText) => set({ blurText }),
      setRevealOnHover: (revealOnHover) => set({ revealOnHover }),
      charactersView: 'shelf',
      gridRowHeight: 240,
      sidebarCollapsed: false,
      galleryKinds: ['illustration'],
      galleryKindTipSeen: false,
      setGalleryKinds: (galleryKinds) => set({ galleryKinds }),
      dismissGalleryKindTip: () => set({ galleryKindTipSeen: true }),
      setBlurSensitive: (blurSensitive) => set({ blurSensitive }),
      toggleBlurSensitive: () => set((s) => ({ blurSensitive: !s.blurSensitive })),
      setCharactersView: (charactersView) => set({ charactersView }),
      setGridRowHeight: (gridRowHeight) => set({ gridRowHeight }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      coverCrop: 'head',
      setCoverCrop: (coverCrop) => set({ coverCrop }),
    }),
    { name: 'emaki.prefs' },
  ),
);

// ------------------------------------------------------------------ 看图器

export interface LightboxRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 网格里这一格用的缩略图宽度：拿起时先用它（已解码，不会白一下） */
  thumb?: 240 | 480 | 960;
}

interface LightboxState {
  /** 当前可左右切换的图片 id 列表（通常是当前网格里已加载的那些） */
  ids: ID[];
  index: number;
  open: boolean;
  /** 打开看图器的来源（某个 ImageGrid 的 id）；同一页有多个网格时，只有来源网格能同步列表 */
  source: string | null;
  /** 整个列表的总数（跨分页，BR-B1）；null = 就是 ids 的长度 */
  total: number | null;
  /** 后面还有没加载的 */
  hasMore: boolean;
  loadMore: (() => void) | null;
  /** 在已加载的最后一张按了「下一张」：等下一页到了自动前进 */
  pendingNext: boolean;
  /** 点中的那一格在屏幕上的位置：看图器从这里「拿起」（SEL-12） */
  originRect: LightboxRect | null;
  /** 正在「放回」：图片缩回这一格，结束后再真正关闭（SEL-12） */
  returning: LightboxRect | null;
  /** 放映（SEL-16）：每张停留的毫秒数；null = 普通看图。关闭时不清，淡出过程中保持原样 */
  autoplay: number | null;
  /** 关闭看图器：那一格在视口里就先缩回去，否则直接淡出 */
  putBack: () => void;
  /** 打开看图器：show(当前列表, 点中的下标, 来源, 格子的位置, { autoplay: 6000 } 放映) */
  show: (
    ids: ID[],
    index: number,
    source?: string | null,
    originRect?: LightboxState['originRect'],
    opts?: { autoplay?: number },
  ) => void;
  /** 来源网格同步总数和加载更多（不是打开者就忽略） */
  syncMeta: (source: string, meta: { total: number | null; hasMore: boolean; loadMore: (() => void) | null }) => void;
  close: () => void;
  go: (delta: number) => void;
  /** 列表变化（比如无限滚动加载了更多）时同步；传了 source 且不是打开看图器的那个来源就忽略 */
  syncIds: (ids: ID[], source?: string) => void;
  /** 刚排除 / 移到回收站、还在原地停留的那张：列表刷新时先不拿掉它 */
  hold: ID | null;
  setHold: (id: ID | null) => void;
}

/** 列表刷新后 hold 那张不在了：放回它在旧列表里的位置（排在旧列表里它后面那张之前） */
export function keepHeld(prev: readonly ID[], ids: ID[], hold: ID | null): ID[] {
  if (!hold || ids.includes(hold)) return ids;
  const i = prev.indexOf(hold);
  if (i < 0) return ids;
  const after = new Set(prev.slice(i + 1));
  const pos = ids.findIndex((x) => after.has(x));
  return pos < 0 ? [...ids, hold] : [...ids.slice(0, pos), hold, ...ids.slice(pos)];
}

export const useLightbox = create<LightboxState>((set, get) => ({
  ids: [],
  index: 0,
  open: false,
  source: null,
  total: null,
  hasMore: false,
  loadMore: null,
  pendingNext: false,
  originRect: null,
  returning: null,
  autoplay: null,
  show: (ids, index, source = null, originRect = null, opts) =>
    set({
      ids,
      index,
      open: true,
      source,
      originRect,
      total: null,
      hasMore: false,
      loadMore: null,
      pendingNext: false,
      hold: null,
      autoplay: opts?.autoplay ?? null,
    }),
  close: () => set({ open: false, originRect: null, returning: null, pendingNext: false }),
  putBack: () => {
    const { ids, index, open, returning, close } = get();
    if (!open || returning) return;
    const id = ids[index];
    const el = id ? document.querySelector(`[data-image-id="${CSS.escape(id)}"]`) : null;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const r = el?.getBoundingClientRect();
    if (!r || reduce || r.width === 0 || r.top < 0 || r.bottom > window.innerHeight) return close();
    const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    set({ returning: rect });
    window.setTimeout(() => {
      if (get().returning === rect) get().close();
    }, 300);
  },
  go: (delta) => {
    const { ids, index, hasMore, loadMore } = get();
    if (!ids.length) return;
    // 已加载的最后一张再往后：先要下一页，到了再前进（BR-B1）
    if (delta > 0 && index + delta > ids.length - 1 && hasMore) {
      set({ pendingNext: true, originRect: null });
      loadMore?.();
      return;
    }
    set({ index: Math.min(Math.max(index + delta, 0), ids.length - 1), originRect: null });
  },
  hold: null,
  setHold: (hold) => set({ hold }),
  syncIds: (fresh, source) => {
    const { ids: prev, index, open, source: owner, pendingNext, hold } = get();
    if (!open || (source !== undefined && source !== owner)) return;
    const ids = keepHeld(prev, fresh, hold);
    const current = prev[index];
    const at = current ? ids.indexOf(current) : -1;
    const base = at >= 0 ? at : Math.min(index, ids.length - 1);
    const advance = pendingNext && base + 1 < ids.length;
    set({ ids, index: advance ? base + 1 : base, pendingNext: pendingNext && !advance });
  },
  syncMeta: (source, meta) => {
    const { open, source: owner } = get();
    if (!open || source !== owner) return;
    set(meta);
  },
}));

// ------------------------------------------------------------------ 多选

interface SelectionState {
  /** 选择所属的上下文（比如 `gallery`、`character:c1`），切页面时自动清空 */
  scope: string;
  ids: Set<ID>;
  /** 上一次点击的 id，用于 shift 连选 */
  anchor: ID | null;
  setScope: (scope: string) => void;
  toggle: (id: ID) => void;
  /** shift+点击：从 anchor 选到 id（需要传入当前顺序） */
  selectRange: (order: ID[], id: ID) => void;
  setMany: (ids: ID[]) => void;
  retain: (scope: string, available: readonly ID[]) => void;
  clear: () => void;
}

export const useSelection = create<SelectionState>((set, get) => ({
  scope: '',
  ids: new Set(),
  anchor: null,
  setScope: (scope) => {
    if (get().scope !== scope) set({ scope, ids: new Set(), anchor: null });
  },
  toggle: (id) =>
    set((s) => {
      const ids = new Set(s.ids);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { ids, anchor: id };
    }),
  selectRange: (order, id) =>
    set((s) => {
      const from = s.anchor ? order.indexOf(s.anchor) : -1;
      const to = order.indexOf(id);
      if (from < 0 || to < 0) return { ids: new Set([...s.ids, id]), anchor: id };
      const [a, b] = from < to ? [from, to] : [to, from];
      return { ids: new Set([...s.ids, ...order.slice(a, b + 1)]), anchor: id };
    }),
  setMany: (ids) => set({ ids: new Set(ids) }),
  retain: (scope, available) => set((s) => {
    if (s.scope !== scope || !s.ids.size) return s;
    const valid = new Set(available), ids = new Set([...s.ids].filter(id => valid.has(id)));
    if (ids.size === s.ids.size) return s;
    return { ids, anchor: s.anchor && ids.has(s.anchor) ? s.anchor : null };
  }),
  clear: () => set({ ids: new Set(), anchor: null }),
}));

// ------------------------------------------------------------------ 撤销栈（顶栏撤销按钮）

export interface UndoEntry {
  token: string;
  label: string;
  /** 记下时后端的启动 id：后端重启后服务端的撤销栈就空了，这条也跟着作废 */
  boot?: string;
  /** 撤销不了的一步：占住位置，撤销时只提示、把它拿掉 */
  barrier?: boolean;
  /** 撤销不了时提示里的补充说明；不写就按「已经放进系统回收站」说 */
  note?: string;
  /** 还在进行的操作（占位）：Ctrl+Z 按到它时等它做完再撤；不存进 sessionStorage */
  pending?: boolean;
  /** 一次点下去产生的多个 token（例如一键处理全部重复）：撤销时倒序一起撤 */
  tokens?: string[];
}

interface UndoState {
  entries: UndoEntry[];
  /** 当前连着的后端的启动 id（SSE 连上时从 /api/health 拿，断开时清空） */
  boot: string | null;
  push: (e: UndoEntry) => void;
  remove: (token: string) => void;
  /** 原地换掉一条（占位落定时用）；null 就是拿掉 */
  replace: (token: string, next: UndoEntry | null) => void;
  /** 这几条撤销不了了（已经放进系统回收站）：原地变成占位，Ctrl+Z 不会越过它们 */
  markBarrier: (tokens: string[]) => void;
  /** 连上后端：丢掉别的启动留下的记录，没连上时记下的归到这次启动 */
  setBoot: (boot: string | null) => void;
}

/**
 * 挨着的、说法一样的「没有撤销」占位只留一条：拖一下设置滑块、连改几次设置不会把撤销栈占满，
 * 把真正能撤销的挤出去（回收站那种不合并）
 */
function squashBarriers(entries: UndoEntry[]): UndoEntry[] {
  return entries.filter((e, i) => {
    const above = entries[i - 1];
    return !(e.barrier && e.note && above?.barrier && above.note === e.note && above.label === e.label);
  });
}

// 按标签页存在 sessionStorage：刷新后顶栏撤销和 Ctrl+Z 还能接着用（服务端的撤销栈在后端重启前一直在）
export const useUndoStore = create<UndoState>()(
  persist(
    (set) => ({
      entries: [],
      boot: null,
      push: (e) => set((s) => ({ entries: squashBarriers([{ ...e, ...(s.boot ? { boot: s.boot } : {}) }, ...s.entries]).slice(0, 20) })),
      remove: (token) => set((s) => ({ entries: s.entries.filter((e) => e.token !== token) })),
      replace: (token, next) =>
        set((s) => ({
          entries: squashBarriers(
            s.entries.flatMap((e) => (e.token !== token ? [e] : next ? [{ ...next, ...(e.boot ? { boot: e.boot } : {}) }] : [])),
          ),
        })),
      markBarrier: (tokens) => {
        // 合并的那种只要有一个 token 过期就整条撤销不了
        const hit = (e: UndoEntry) => tokens.includes(e.token) || !!e.tokens?.some((t) => tokens.includes(t));
        set((s) => (s.entries.some(hit) ? { entries: s.entries.map((e) => (hit(e) ? { ...e, barrier: true, note: undefined } : e)) } : s));
      },
      setBoot: (boot) =>
        set((s) => ({
          boot,
          entries: boot ? s.entries.filter((e) => !e.boot || e.boot === boot).map((e) => (e.boot ? e : { ...e, boot })) : s.entries,
        })),
    }),
    { name: 'emaki.undo', storage: createJSONStorage(() => sessionStorage), partialize: (s) => ({ entries: s.entries.filter((e) => !e.pending) }) },
  ),
);

// ------------------------------------------------------------------ 全局弹层

interface OverlayState {
  commandOpen: boolean;
  helpOpen: boolean;
  setCommandOpen: (v: boolean) => void;
  setHelpOpen: (v: boolean) => void;
  /** 多选栏为 toast 临时抬高了（助手胶囊跟着让） */
  barLifted: boolean;
  setBarLifted: (v: boolean) => void;
  /** 合集阅读器开着（助手胶囊先收起，免得盖住胶片条） */
  readerOpen: boolean;
  setReaderOpen: (v: boolean) => void;
}

export const useOverlays = create<OverlayState>((set) => ({
  commandOpen: false,
  helpOpen: false,
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  barLifted: false,
  setBarLifted: (barLifted) => set({ barLifted }),
  readerOpen: false,
  setReaderOpen: (readerOpen) => set({ readerOpen }),
}));

/** 模糊判断用的四个偏好（配合 lib/blur.ts） */
export function useBlurPrefs(): BlurPrefs {
  return usePrefs(
    useShallow((s) => ({ blurSensitive: s.blurSensitive, blurLevel: s.blurLevel, blurPhoto: s.blurPhoto, blurText: s.blurText })),
  );
}
