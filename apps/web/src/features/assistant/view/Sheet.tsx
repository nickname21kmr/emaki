import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { ChevronDown, Minus, PanelRight, PanelRightClose, PictureInPicture2, Plus } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { Emblem } from '@/components/ui/Emblem';
import { cn } from '@/lib/cn';
import { DURATION, EASE_OUT } from '@/lib/motion';
import { useLightbox, useSelection } from '@/lib/stores';
import { closeAssistant, focusAssistant, focusComposer, LEAF_WIDTH,leafWidth, sheetWidthRange, useAssistantDock, useViewportWidth, type SheetForm } from '../dock';
import { BACKEND_LABEL } from '../presentation';
import type { ConversationView } from '../useConversation';
import { useFloatingDrag } from '../useFloatingDrag';
import { useFloatingResize } from '../useFloatingResize';
import { Footer } from './Footer';
import { SessionMenu } from './SessionMenu';
import { Transcript } from './Transcript';
import { SHU_GLINT } from './glint';

export interface SheetProps {
  conv: ConversationView;
  form: SheetForm;
  /** static：DevUiPage 里用，relative size-full，不挂拖动缩放、不写 CSS 变量 */
  frame?: 'fixed' | 'static';
}

// 定位（外层，不裁切，手柄可以伸出纸边）和材质（里层，裁切内容）分开
const PLACE: Record<Exclude<SheetForm, 'float'>, string> = {
  bound: 'fixed top-2 right-2 bottom-2 z-40',
  overlay: 'fixed top-2 right-2 bottom-2 z-40',
  darkroom: 'absolute inset-0',
  sheet: 'fixed inset-x-0 bottom-0 z-40 h-[88dvh]',
};
const FLOAT = 'fixed right-6 z-40 w-[400px] transition-[bottom] duration-[350ms] ease-[var(--ease-out-soft)]';
const MATERIAL: Record<SheetForm, string> = {
  // 和主纸同一种纸，不加纸纹
  bound: 'rounded-[var(--radius-sheet)] bg-sheet shadow-[var(--shadow-sheet)]',
  overlay: 'rounded-[var(--radius-sheet)] bg-raised ring-1 ring-line shadow-pop',
  float: 'rounded-[var(--radius-sheet)] bg-raised ring-1 ring-line shadow-pop',
  darkroom: 'rounded-[20px] bg-sheet ring-1 ring-line shadow-pop',
  sheet: 'rounded-t-[var(--radius-sheet)] bg-raised ring-1 ring-line shadow-pop',
};
const ENTER = { duration: DURATION.base, ease: EASE_OUT };
const LEAVE = { duration: DURATION.fast, ease: EASE_OUT };
const SLIDE = { initial: { x: 24, opacity: 0 }, animate: { x: 0, opacity: 1, transition: ENTER }, exit: { x: 16, opacity: 0, transition: LEAVE } };
const MOTION = {
  bound: SLIDE,
  overlay: SLIDE,
  float: { initial: { opacity: 0, y: 18, scale: 0.97 }, animate: { opacity: 1, y: 0, scale: 1, transition: ENTER }, exit: { opacity: 0, y: 12, scale: 0.98, transition: LEAVE } },
  darkroom: { initial: { opacity: 0 }, animate: { opacity: 1, transition: ENTER }, exit: { opacity: 0, transition: LEAVE } },
  sheet: { initial: { y: 24, opacity: 0 }, animate: { y: 0, opacity: 1, transition: ENTER }, exit: { y: 16, opacity: 0, transition: LEAVE } },
} as const;

// 浮起 / 贴边会换一张纸（先退后进）。新纸挂上后：键盘按的把焦点还给这个按钮；
// 鼠标点的放进输入框（还给按钮会让它的 tooltip 一直挂着）
let refocusFlip: 'key' | 'pointer' | null = null;

/**
 * 附页外壳（§3、§5）：五种形态、页眉（册号、会话菜单、新对话、浮起 / 贴边、收起）、运行细光、
 * 并排和覆盖时的宽度手柄、浮页的拖动和缩放、按键隔离和 Esc。
 */
export function Sheet({ conv, form, frame = 'fixed' }: SheetProps) {
  const titleId = useId();
  const kickerId = useId();
  const fixed = frame === 'fixed';
  const vw = useViewportWidth();
  const width = useAssistantDock(s => s.width);
  const layout = useAssistantDock(s => s.layout);
  const floating = fixed && form === 'float';
  const leaf = fixed && (form === 'bound' || form === 'overlay');
  const drag = useFloatingDrag('emaki.assistant.panel-position');
  const positioned = Boolean(drag.style);
  // 浮页没被拖过时，有多选栏就抬到它上面
  const lift = useSelection(s => s.ids.size > 0) && floating && !positioned;
  // 多选栏顶边离窗口底 84（纸边 8 + sticky 24 + 栏高 52），再留 12 的空
  const resize = useFloatingResize(drag.ref, drag.place, positioned ? 16 : lift ? 120 : 48);
  const flipButton = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  // 覆盖时拖宽度手柄：拖动中只改这张纸自己的宽，松手才写进 dock（免得半路换成并排）
  const [preview, setPreview] = useState<number | null>(null);

  useEffect(() => {
    if (!fixed) return;
    if (refocusFlip) {
      const how = refocusFlip;
      refocusFlip = null;
      if (how === 'key') flipButton.current?.focus({ preventScroll: true });
      else if (!focusComposer()) focusAssistant();
      return;
    }
    // 没有输入框（没选 backend）时，打开后焦点给「去设置」或标题按钮
    if (useAssistantDock.getState().wantsFocus) focusAssistant();
  }, [fixed]);

  // 缩放窗口换了外壳（浮页 ↔ 页面）时这张纸会卸下：焦点在里面的话，新纸挂上后放回输入框。
  // 卸下前（layout 清理时 DOM 还在）判断；收起（open 已经是 false）和进出看图器不管
  useLayoutEffect(() => {
    if (!fixed) return;
    const inBox = useLightbox.getState().open;
    return () => {
      if (!useAssistantDock.getState().open || useLightbox.getState().open !== inBox) return;
      if (asideRef.current?.contains(document.activeElement)) refocusFlip ??= 'pointer';
    };
  }, [fixed]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Menu 的按键在它自己的 portal 里，DOM 上不在附页里，不归这里管
    const inside = (e.target as Element).closest?.('[data-assistant-sheet]');
    // stopPropagation：页面上挂在 window 的 Esc（清空多选这类）不再跟着响
    if (e.key === 'Escape' && inside && fixed && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); closeAssistant(); return; }
    // 看图器和页面的单键快捷键不从助手里漏出去；Tab 放行给焦点陷阱
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation();
  };

  const canFlip = vw >= 900 && form !== 'darkroom' && form !== 'sheet';
  const flip = (e: MouseEvent) => {
    if (!fixed) return;
    refocusFlip = e.detail === 0 ? 'key' : 'pointer';
    useAssistantDock.getState().setLayout(layout === 'leaf' ? 'float' : 'leaf');
  };
  const running = conv.session?.status === 'running';
  // 名字读作「助手 + 会话标题」
  const labelledBy = `${kickerId} ${titleId}`;
  const a11y = form === 'bound' ? { 'aria-labelledby': labelledBy } : { role: 'dialog', 'aria-modal': false, 'aria-labelledby': labelledBy };
  const w = form === 'overlay' && preview !== null ? preview : leafWidth(form, width, vw);
  const place = !fixed ? 'relative size-full'
    : floating ? cn(FLOAT, lift ? 'bottom-[96px] h-[min(640px,calc(100vh_-_120px))]' : 'bottom-6 h-[min(640px,calc(100vh_-_48px))]')
    : PLACE[form as Exclude<SheetForm, 'float'>];
  const style = floating ? { transformOrigin: 'bottom right', ...drag.style, ...resize.style } : leaf ? { width: w } : undefined;

  return (
    <motion.aside
      ref={(el: HTMLElement | null) => { asideRef.current = el; if (floating) drag.ref.current = el; }}
      // 静态的（/dev/ui）标成 static，focusAssistant 这类找附页的地方跳过它
      data-assistant-sheet={fixed ? '' : 'static'}
      {...a11y}
      {...MOTION[form]}
      onKeyDown={onKeyDown}
      style={style}
      className={cn('group/sheet outline-none', place)}
    >
      <div className={cn('relative flex size-full flex-col overflow-hidden text-fg @container', MATERIAL[form])}>
        {form === 'sheet' && (
          // 底页的把手只是装饰，不能拖；单独占一条，不和下面的册号挤在一起
          <span aria-hidden className="pointer-events-none flex h-3 shrink-0 justify-center pt-1.5">
            <span className="h-1 w-9 rounded-full bg-line-strong" />
          </span>
        )}
        <header
          {...(floating ? drag.handle : {})}
          className={cn('flex h-14 shrink-0 items-center gap-0.5 pr-2.5 pl-5', floating && 'cursor-grab touch-none select-none active:cursor-grabbing')}
        >
          <div className="min-w-0 flex-1">
            <div className="kicker flex items-center">
              <Emblem size={14} className="mr-2" />
              <span id={kickerId} className="font-semibold text-brand">助手</span>
              {conv.backend && <span className="ml-3">{BACKEND_LABEL[conv.backend]}</span>}
            </div>
            <SessionMenu conv={conv} titleId={titleId} />
          </div>
          <IconButton size="sm" label="新对话" disabled={!conv.backend || conv.busy} onClick={conv.actions.newSession}>
            <Plus strokeWidth={1.8} />
          </IconButton>
          {canFlip && (
            <IconButton ref={flipButton} size="sm" label={layout === 'leaf' ? '浮起' : '贴边'} onClick={flip}>
              {layout === 'leaf' ? <PictureInPicture2 strokeWidth={1.8} /> : <PanelRight strokeWidth={1.8} />}
            </IconButton>
          )}
          {/* 收起不停止任务，所以浮页用 Minus 不用 X */}
          <IconButton size="sm" label="收起" shortcut="Esc" onClick={fixed ? closeAssistant : undefined}>
            {form === 'float' ? <Minus strokeWidth={1.8} /> : form === 'sheet' ? <ChevronDown strokeWidth={1.8} /> : <PanelRightClose strokeWidth={1.8} />}
          </IconButton>
        </header>
        <div className="relative h-px shrink-0 bg-line">
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-x-0 -bottom-px h-px animate-shimmer transition-opacity duration-300 motion-reduce:animate-none motion-reduce:[background-position:50%_0]',
              running ? 'opacity-100' : 'opacity-0',
            )}
            style={SHU_GLINT}
          />
        </div>
        <Transcript conv={conv} />
        {conv.backend && <Footer conv={conv} floating={form === 'overlay' || form === 'float' || form === 'sheet'} register={fixed} safeBottom={form === 'sheet'} />}
      </div>
      {/* 手柄放在 DOM 最后：Tab 顺序在页脚之后 */}
      {leaf && <WidthHandle form={form} width={w} vw={vw} onPreview={setPreview} />}
      {floating && resize.handles}
    </motion.aside>
  );
}

/**
 * 附页左边缘的宽度手柄（§3.3）。并排时拖动只画一条参考线，松手才写入宽度（主纸只重排一次）；
 * 覆盖时实时改。← 加宽、→ 变窄（Shift 一次 64），Home 最窄、End 最宽，Enter 或双击还原 400。
 */
function WidthHandle({ form, width, vw, onPreview }: { form: 'bound' | 'overlay'; width: number; vw: number; onPreview: (n: number | null) => void }) {
  const { min, max } = sheetWidthRange(form, vw);
  const [guide, setGuide] = useState<number | null>(null);
  // 形态和范围在按下时定住：拖动中不因为宽度跨过并排的门槛而换形态
  const gesture = useRef<{ id: number; x: number; width: number; next: number; form: 'bound' | 'overlay'; min: number; max: number } | null>(null);
  const fit = (n: number, lo = min, hi = max) => Math.min(hi, Math.max(lo, Math.round(n)));
  const commit = (n: number, lo = min, hi = max) => useAssistantDock.getState().setWidth(fit(n, lo, hi));
  const release = () => {
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  };
  useEffect(() => () => { release(); onPreview(null); }, [onPreview]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    gesture.current = { id: e.pointerId, x: e.clientX, width, next: width, form, min, max };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    if (form === 'bound') setGuide(width);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    // 手柄在左边：往左拖是加宽
    g.next = fit(g.width + g.x - e.clientX, g.min, g.max);
    if (g.form === 'bound') setGuide(g.next);
    else onPreview(g.next);
  };
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    release();
    setGuide(null);
    onPreview(null);
    if (g.next !== g.width) commit(g.next, g.min, g.max);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const next = e.key === 'ArrowLeft' ? width + step
      : e.key === 'ArrowRight' ? width - step
      : e.key === 'Home' ? min
      : e.key === 'End' ? max
      : e.key === 'Enter' ? LEAF_WIDTH.initial
      : null;
    if (next === null) return;
    e.preventDefault();
    commit(next);
  };

  return (
    <>
      {/* 整条纸边都能拖；能聚焦的只是中间把手那一小段，焦点框是把手外的一枚小胶囊，不画成贯穿整页的竖框 */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={() => commit(LEAF_WIDTH.initial)}
        className="group absolute inset-y-5 -left-2 z-10 w-3 cursor-col-resize touch-none pointer-coarse:-left-3 pointer-coarse:w-5"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整助手宽度"
          tabIndex={0}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={width}
          onKeyDown={onKeyDown}
          className="absolute top-1/2 left-1/2 h-12 w-2 -translate-1/2 rounded-full focus-visible:outline-offset-0"
        />
        <span aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 h-8 w-[3px] -translate-1/2 rounded-full bg-line-strong opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-active:opacity-100 group-has-focus-visible:opacity-100" />
      </div>
      {guide !== null && createPortal(
        <div aria-hidden className="pointer-events-none fixed top-2 bottom-2 z-[45] w-px bg-fg-muted" style={{ right: 8 + guide }} />,
        document.body,
      )}
    </>
  );
}
