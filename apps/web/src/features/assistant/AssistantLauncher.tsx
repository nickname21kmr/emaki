import { Component, lazy, Suspense, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { Emblem } from '@/components/ui/Emblem';
import { LbButton } from '@/components/media/lightbox/LbButton';
import { ScrollContainerContext } from '@/components/layout/ScrollContainer';
import { modKeyLabel } from '@/lib/hotkeys';
import { DURATION, EASE_OUT } from '@/lib/motion';
import { useAssistantSettings } from './client';
import { DARKROOM_MIN, LEAF_WIDTH, sheetForm, useAssistantDock, useViewportWidth } from './dock';

// 下载失败（断网、部署后旧 chunk 没了）先再试一次
const loadRoot = () => import('./AssistantRoot').then(module => ({ default: module.AssistantRoot }));
const Root = lazy(() => loadRoot().catch(loadRoot));

const useEnabled = () => useAssistantSettings().data?.enabled ?? false;

/** 助手那一包没加载出来或者渲染出错：只丢掉助手，不让整页换成路由的错误页 */
class AssistantBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: unknown) {
    console.error(error);
    toast.error('助手没加载出来，刷新页面再试');
  }
  override render() { return this.state.failed ? null : this.props.children; }
}

/** 没开启的安装不下载对话和 Markdown 那一包 */
export function AssistantLauncher() {
  return useEnabled() ? <AssistantBoundary><Suspense fallback={null}><Root /></Suspense></AssistantBoundary> : null;
}

// ------------------------------------------------------------------ 主包里的小件（不懒加载）

interface Anchor { id?: string; top?: number; ratio: number }

/** 宽度变化前记下主纸里第一张顶边在可视区内的图 */
function captureAnchor(el: HTMLElement): Anchor | null {
  if (el.scrollTop <= 0) return null;
  const ratio = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
  const top = el.getBoundingClientRect().top;
  for (const node of el.querySelectorAll<HTMLElement>('[data-image-id]')) {
    const r = node.getBoundingClientRect();
    if (r.top >= top && node.dataset.imageId) return { id: node.dataset.imageId, top: r.top, ratio };
  }
  return { ratio };
}
/** 重排后把那张图挪回原来的高度；找不到就按比例保持 */
function restoreAnchor(el: HTMLElement, a: Anchor) {
  const node = a.id ? el.querySelector(`[data-image-id="${CSS.escape(a.id)}"]`) : null;
  if (node && a.top != null) el.scrollTop += node.getBoundingClientRect().top - a.top;
  else el.scrollTop = a.ratio * (el.scrollHeight - el.clientHeight);
}

/**
 * 并排让位（§3.2）：AppShell 里 <main> 之后的 flex 子项。并排可见时占 W + 8，主纸一帧到位不做补间，
 * 宽度变化前后保持主纸的滚动锚点。
 */
export function AssistantSpacer() {
  const enabled = useEnabled();
  const vw = useViewportWidth();
  const layout = useAssistantDock(s => s.layout);
  const shown = useAssistantDock(s => s.shown);
  const width = useAssistantDock(s => s.width);
  // 不看看图器：附页进暗房时主纸在下面保持原宽，免得来回重排两次、看图器飞回时找不准原来那一格
  const bound = sheetForm(vw, layout, width, false, false) === 'bound';
  const w = enabled && bound && shown ? width + 8 : 0;
  const scrollRef = useContext(ScrollContainerContext);
  const previous = useRef(w), anchor = useRef<Anchor | null>(null);
  // 趁 DOM 还是旧宽度时记锚点（渲染期读布局，只在宽度要变的那次）
  if (previous.current !== w) {
    previous.current = w;
    anchor.current = scrollRef?.current ? captureAnchor(scrollRef.current) : null;
  }
  useLayoutEffect(() => {
    const a = anchor.current, el = scrollRef?.current;
    anchor.current = null;
    if (!a || !el) return;
    // 网格要等 ResizeObserver 回调、重渲染后才按新宽度排好，帧数不固定：连着几帧按当前偏差校正，排好后偏差为 0
    let n = 0, frame = 0;
    const step = () => { restoreAnchor(el, a); if (++n < 8) frame = requestAnimationFrame(step); };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [w, scrollRef]);
  return <div aria-hidden className="shrink-0" style={{ width: w }} />;
}

/** 插槽的 ref：卸下时只清自己（宽窄切换时旧插槽还在退场，别把新插槽清掉） */
function slotRef() {
  let mine: HTMLElement | null = null;
  return (el: HTMLElement | null) => {
    const dock = useAssistantDock.getState();
    if (el) { mine = el; dock.setSlotEl(el); }
    else if (dock.slotEl === mine) dock.setSlotEl(null);
  };
}
const wideSlot = slotRef(), narrowSlot = slotRef();
const liveRef = (el: HTMLElement | null) => useAssistantDock.setState({ liveEl: el });

/**
 * 看图器里的插槽（§3.6）：排在 InfoPanel 后面，助手开着时展开，附页 portal 进来。
 * 窄窗（< 900）不并排，只放一个不占位、常驻的宿主，附页在看图器里做底页（还在 Dialog 里，焦点陷阱和 aria-hidden 照常）。
 * 另有一个常驻的宿主给读屏播报区：看图器开着时 Dialog 外的节点都被 aria-hidden
 */
export function AssistantDarkroomSlot() {
  const open = useAssistantDock(s => s.open);
  const enabled = useEnabled();
  const width = useAssistantDock(s => s.width);
  const narrow = useViewportWidth() < DARKROOM_MIN;
  const on = open && enabled;
  const w = Math.min(400, Math.max(LEAF_WIDTH.min, width));
  return (
    <>
      {enabled && <div ref={liveRef} />}
      {/* 窄窗的宿主不跟着 open 卸：附页退场时它还得在，退场动画才走得完 */}
      {enabled && narrow && <div ref={narrowSlot} />}
      <AnimatePresence initial={false}>
        {on && !narrow && (
          <motion.aside
            key="assistant"
            aria-label="助手"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: w + 12, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: DURATION.base, ease: EASE_OUT }}
            className="relative shrink-0 overflow-hidden"
          >
            {/* 看图器飞回原位时和 InfoPanel 一起淡出；放映的 idle 淡出不管它 */}
            <div ref={wideSlot} className="absolute inset-y-3 right-3 transition-opacity duration-200 group-data-returning/lb:opacity-0" style={{ width: w }} />
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}

const STATUS_TEXT = { running: '处理中', waiting: '等你回应', reply: '有新回复', incomplete: '没有完成' } as const;

/** 看图器顶栏「显示信息」左边的助手按钮；收起时带一个小点，和胶囊同样的状态 */
export function AssistantLightboxButton() {
  const enabled = useEnabled();
  const open = useAssistantDock(s => s.open);
  const status = useAssistantDock(s => (s.lastStatus === 'running' || s.lastStatus === 'waiting' ? s.lastStatus : s.unseen));
  if (!enabled) return null;
  const shown = open ? null : status;
  return (
    <LbButton
      label={open ? '收起助手' : shown ? `助手，${STATUS_TEXT[shown]}` : '助手'}
      shortcut={`${modKeyLabel} J`}
      active={open}
      className="relative"
      onClick={() => useAssistantDock.getState().toggle()}
    >
      <Emblem size={16} className="!text-current" />
      {shown && (
        <span
          aria-hidden
          className={
            shown === 'running' ? 'absolute top-1.5 right-1.5 size-1.5 rounded-full bg-white motion-safe:animate-pulse'
            : shown === 'waiting' ? 'absolute top-1.5 right-1.5 size-1.5 rounded-full bg-shu'
            : shown === 'incomplete' ? 'absolute top-1.5 right-1.5 size-1.5 rounded-full bg-warn'
            : 'absolute top-1.5 right-1.5 size-1.5 rounded-full bg-white/80'
          }
        />
      )}
    </LbButton>
  );
}
