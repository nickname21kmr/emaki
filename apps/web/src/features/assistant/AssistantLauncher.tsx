import { lazy, Suspense, useContext, useLayoutEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Emblem } from '@/components/ui/Emblem';
import { LbButton } from '@/components/media/lightbox/LbButton';
import { ScrollContainerContext } from '@/components/layout/ScrollContainer';
import { modKeyLabel } from '@/lib/hotkeys';
import { DURATION, EASE_OUT } from '@/lib/motion';
import { useAssistantSettings } from './client';
import { LEAF_WIDTH, sheetForm, useAssistantDock, useViewportWidth } from './dock';

const Root = lazy(() => import('./AssistantRoot').then(module => ({ default: module.AssistantRoot })));

const useEnabled = () => useAssistantSettings().data?.enabled ?? false;

/** 没开启的安装不下载对话和 Markdown 那一包 */
export function AssistantLauncher() {
  return useEnabled() ? <Suspense fallback={null}><Root /></Suspense> : null;
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
    // 虚拟网格要一两帧才按新宽度排好
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => restoreAnchor(el, a)); });
    return () => cancelAnimationFrame(frame);
  }, [w, scrollRef]);
  return <div aria-hidden className="shrink-0" style={{ width: w }} />;
}

/** 看图器里的插槽（§3.6）：排在 InfoPanel 后面，助手开着时展开，附页 portal 进来 */
export function AssistantDarkroomSlot() {
  const open = useAssistantDock(s => s.open);
  const enabled = useEnabled();
  const width = useAssistantDock(s => s.width);
  const on = open && enabled;
  const w = Math.min(400, Math.max(LEAF_WIDTH.min, width));
  return (
    <AnimatePresence initial={false}>
      {on && (
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
          <div ref={useAssistantDock.getState().setSlotEl} className="absolute inset-y-3 right-3 transition-opacity duration-200 group-data-returning/lb:opacity-0" style={{ width: w }} />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/** 看图器顶栏「显示信息」左边的助手按钮 */
export function AssistantLightboxButton() {
  const enabled = useEnabled();
  const open = useAssistantDock(s => s.open);
  if (!enabled) return null;
  return (
    <LbButton label={open ? '收起助手' : '助手'} shortcut={`${modKeyLabel} J`} active={open} onClick={() => useAssistantDock.getState().toggle()}>
      <Emblem size={16} className="!text-current" />
    </LbButton>
  );
}
