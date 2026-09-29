import type { ContentKind, ID } from '@emaki/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Pause, PanelRight, Play, Shapes, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Dialog as D } from 'radix-ui';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import { imageUrl } from '@/lib/api';
import { blurLabel, blurReason } from '@/lib/blur';
import { formatCount } from '@/lib/format';
import { useHotkey } from '@/lib/hotkeys';
import { useImage } from '@/lib/queries';
import { useBlurPrefs, useLightbox } from '@/lib/stores';
import { findCachedImage, preloadAhead, preloadNeighbors, whenDecoded } from './lightbox/cache';
import { InfoPanel } from './lightbox/InfoPanel';
import { KindMenu } from './KindMenu';
import { LbButton } from './lightbox/LbButton';
import { cn } from '@/lib/cn';
import { useLightboxPrefs } from './lightbox/prefs';
import { Stage } from './lightbox/Stage';
import { useImageActions } from './lightbox/useImageActions';
import { useZoomPan } from './lightbox/useZoomPan';
import { EASE_OUT } from '@/lib/motion';

const PANEL_W = 332;
const EASE = EASE_OUT;

/**
 * 全局看图器（挂在 AppShell 里）。任何地方调用 useLightbox.getState().show(ids, index) 打开。
 *
 * 布局：深色 scrim 上左边是舞台（图片居中、可缩放），右边一张可折叠的信息「纸」（I 切换）。
 * 不论亮暗主题，看图器本身都是深色的 —— 让图片说话；信息面板仍跟随主题。
 *
 * 快捷键：← → 切换 · I 信息面板 · F 收藏 · E 排除 · + - 0 缩放 · Esc 先还原缩放再关闭
 *
 * 放映（SEL-16）：show(..., { autoplay: 6000 }) 打开。每张停 6 秒，新旧图交叉淡化；
 * 底部朱色引信烧完就换下一张（放到最后绕回开头），Space 暂停 / 继续；鼠标 2 秒不动，顶栏和信息面板淡出。
 */
export function Lightbox() {
  const open = useLightbox((s) => s.open);
  const ids = useLightbox((s) => s.ids);
  const index = useLightbox((s) => s.index);
  const close = useLightbox((s) => s.close);
  const putBack = useLightbox((s) => s.putBack);
  const returning = useLightbox((s) => !!s.returning);
  const contentRef = useRef<HTMLDivElement>(null);
  const escapeRef = useRef<() => boolean>(() => false);

  // 列表被清空（比如最后一张也被排除了）就关掉
  useEffect(() => {
    if (open && ids.length === 0) close();
  }, [open, ids.length, close]);

  const id = ids[index];

  return (
    <D.Root open={open} onOpenChange={(v) => !v && putBack()}>
      <D.Portal>
        {/* 暗房：不透明的底，不用全屏背景模糊（缩放拖动时每帧重算，纯成本） */}
        <D.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-stage transition-opacity duration-300 data-[state=closed]:animate-[fade-in_180ms_ease-in_reverse_both] data-[state=open]:animate-fade-in',
            returning && 'opacity-0',
          )}
        />
        <D.Content
          ref={contentRef}
          tabIndex={-1}
          onOpenAutoFocus={(e) => {
            // 不把焦点放到第一个按钮上（会出现焦点环），直接聚焦整个看图器
            e.preventDefault();
            contentRef.current?.focus();
          }}
          onEscapeKeyDown={(e) => {
            // 放大状态下 Esc 先还原缩放
            if (escapeRef.current()) e.preventDefault();
          }}
          className="fixed inset-0 z-50 flex outline-none data-[state=closed]:animate-[fade-in_180ms_ease-in_reverse_both] data-[state=open]:animate-fade-in"
        >
          <D.Title className="sr-only">看图</D.Title>
          <D.Description className="sr-only">
            左右方向键切换，I 显示信息，F 收藏，E 排除，Esc 关闭
          </D.Description>
          {/* 关闭时内容保留到淡出结束，快捷键里再判断 open */}
          {id && <LightboxView id={id} ids={ids} index={index} escapeRef={escapeRef} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function LightboxView({
  id,
  ids,
  index,
  escapeRef,
}: {
  id: ID;
  ids: ID[];
  index: number;
  escapeRef: RefObject<() => boolean>;
}) {
  const client = useQueryClient();
  const total = useLightbox((s) => s.total);
  const hasMore = useLightbox((s) => s.hasMore);
  const pendingNext = useLightbox((s) => s.pendingNext);
  const originRect = useLightbox((s) => s.originRect);
  const navigate = useNavigate();
  const go = useLightbox((s) => s.go);
  const close = useLightbox((s) => s.close);
  const putBack = useLightbox((s) => s.putBack);
  const returning = useLightbox((s) => s.returning);
  const panelOpen = useLightboxPrefs((s) => s.panelOpen);
  const togglePanel = useLightboxPrefs((s) => s.togglePanel);
  const blurPrefs = useBlurPrefs();
  const open = useLightbox((s) => s.open);
  const autoplay = useLightbox((s) => s.autoplay);
  const slideshow = autoplay !== null;
  const reduce = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const idle = useIdle(slideshow && open, 2000);
  const pageHidden = usePageHidden();

  const detailQuery = useImage(id);
  const detail = detailQuery.data?.id === id ? detailQuery.data : undefined;
  const cached = useMemo(() => findCachedImage(client, id), [client, id]);
  const base = detail ?? cached;

  // 「显示」只对点过的那几张生效，关掉看图器就忘掉
  const [revealed, setRevealed] = useState<ReadonlySet<ID>>(() => new Set());
  const zoomApi = useZoomPan(id);
  const actions = useImageActions(
    base ? { id, favorite: base.favorite, original: !!base.original, rating: base.rating, kind: base.kind, characterIds: base.characterIds } : undefined,
  );

  // 记录切换方向，给入场动画用
  const prevIndex = useRef(index);
  const direction = Math.sign(index - prevIndex.current);
  useEffect(() => {
    prevIndex.current = index;
  }, [index]);

  useEffect(() => {
    preloadNeighbors(client, ids, index);
    if (slideshow) preloadAhead(ids, index);
  }, [client, ids, index, slideshow]);

  escapeRef.current = () => {
    if (!zoomApi.zoomed) return false;
    zoomApi.reset();
    return true;
  };

  // 焦点在菜单 / 弹出框里时，方向键和字母键留给它们；淡出过程中也不再响应
  const guard = (fn: () => void) => (e: KeyboardEvent) => {
    if (!useLightbox.getState().open) return;
    if (e.target instanceof Element && e.target.closest('[data-radix-popper-content-wrapper]')) return;
    fn();
  };
  useHotkey('arrowleft', guard(() => go(-1)));
  useHotkey('arrowright', guard(() => go(1)));
  useHotkey('i', guard(togglePanel));
  useHotkey('f', guard(actions.toggleFavorite));
  useHotkey('e', guard(actions.exclude));
  useHotkey('o', guard(actions.toggleOriginal));
  const [kindOpen, setKindOpen] = useState(false);
  useHotkey('c', guard(() => setKindOpen(true)), { enabled: !!base && !kindOpen });
  useHotkey('space', guard(() => setPaused((p) => !p)), { enabled: slideshow });

  // 引信烧完：等下一张的 960 缩略图解码好再前进，最后一张之后绕回开头
  const advance = () => {
    const s = useLightbox.getState();
    if (!s.open || s.returning || s.ids.length < 2) return;
    const next = (s.index + 1) % s.ids.length;
    void whenDecoded(imageUrl.thumb(s.ids[next]!, 960)).then(() => {
      const t = useLightbox.getState();
      // 等的时候被手动翻页或关掉了，就不再自动前进
      if (t.open && !t.returning && t.ids === s.ids && t.index === s.index) useLightbox.setState({ index: next, originRect: null });
    });
  };
  // 放大看细节、切到后台、正在关闭时，引信也停住
  const halted = paused || zoomApi.zoomed || pageHidden || !open || !!returning;

  const rating = actions.rating ?? base?.rating;
  const reason = rating && !revealed.has(id) ? blurReason({ rating, kind: base?.kind }, blurPrefs) : null;
  const blurred = reason !== null;

  const leave = () => putBack();
  const searchTag = (tag: string) => {
    close();
    navigate(`/gallery?q=${encodeURIComponent(tag)}&kind=all`); // 标签跳转看全部类型（BI-10）
  };

  return (
    // 再叠一层黑，亮色主题下也足够暗（看图器始终是深色的）
    <div
      className={cn('group/lb relative flex size-full transition-colors duration-300', returning ? 'bg-transparent' : 'bg-black/30')}
      data-returning={returning ? '' : undefined}
      data-slideshow={slideshow ? (halted ? 'paused' : 'playing') : undefined}
    >
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* 背后一团图片主色的柔光，让深色背景不死板 */}
        {base && (
          <div
            key={id}
            aria-hidden
            className="pointer-events-none absolute inset-0 animate-fade-in transition-opacity duration-300 group-data-returning/lb:opacity-0!"
            style={{
              background: `radial-gradient(52% 58% at 50% 50%, ${base.dominantColor} 0%, transparent 72%)`,
              opacity: 0.2,
            }}
          />
        )}

        <TopBar
          index={index}
          total={total ?? ids.length}
          fileName={base?.fileName}
          panelOpen={panelOpen}
          onTogglePanel={togglePanel}
          onClose={leave}
          idle={idle}
          playing={slideshow ? !paused : undefined}
          onTogglePlay={() => setPaused((p) => !p)}
          kind={base ? (actions.kind ?? base.kind) : undefined}
          kindOpen={kindOpen}
          onKindOpenChange={setKindOpen}
          onSetKind={actions.setKind}
        />

        <Stage
          id={id}
          meta={base}
          blurred={blurred}
          blurLabel={reason && rating ? blurLabel(reason, rating) : ''}
          onReveal={() => setRevealed((s) => new Set(s).add(id))}
          zoomApi={zoomApi}
          direction={direction}
          hasPrev={index > 0}
          hasNext={index < ids.length - 1 || hasMore}
          loadingNext={pendingNext}
          originRect={originRect}
          returnRect={returning}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
          onBackdropClick={leave}
          slideshow={slideshow ? { crossfade: reduce ? 0.15 : 0.8, idle } : null}
        />

        {slideshow && ids.length > 1 && (
          <>
            {/* 底部 2px 朱色引信：和 toast 的引信同一个 fuse 动画，烧完换下一张 */}
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[2px]">
              <div
                key={id}
                // 动画写成 class：@theme 里的 keyframes 只有被 animate-[…] 引用到才会输出。
                // 时长按 autoplay 用行内 important 覆盖 —— reduced-motion 的全局规则会把时长压成 0.01ms，否则会连续跳图
                ref={(el) => el?.style.setProperty('animation-duration', `${autoplay}ms`, 'important')}
                className="fuse h-full origin-left animate-[fuse_6s_linear_forwards] bg-shu"
                style={{ animationPlayState: halted ? 'paused' : 'running' }}
                onAnimationEnd={advance}
              />
            </div>
            <AnimatePresence>
              {paused && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="pointer-events-none absolute right-6 bottom-5 z-20 flex h-7 items-center gap-1.5 rounded-full bg-black/45 px-3 text-[11.5px] text-white/80 ring-1 ring-white/10 backdrop-blur-md"
                >
                  <Pause className="size-3" />
                  已暂停 · 空格继续
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </div>

      <AnimatePresence initial={false}>
        {panelOpen && (
          <motion.aside
            key="panel"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: PANEL_W, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.34, ease: EASE }}
            className="relative shrink-0 overflow-hidden transition-opacity duration-200 group-data-returning/lb:opacity-0"
            aria-label="图片信息"
          >
            <div
              data-lb-chrome
              className={cn('absolute inset-y-3 right-3 w-[320px] transition-opacity duration-300', idle && 'pointer-events-none opacity-0')}
            >
              <InfoPanel
                base={base}
                detail={detail}
                error={detailQuery.isError ? detailQuery.error : null}
                onRetry={() => void detailQuery.refetch()}
                actions={actions}
                onNavigate={leave}
                onTagClick={searchTag}
              />
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}

function TopBar({
  index,
  total,
  fileName,
  panelOpen,
  onTogglePanel,
  onClose,
  idle,
  playing,
  onTogglePlay,
  kind,
  kindOpen,
  onKindOpenChange,
  onSetKind,
}: {
  index: number;
  total: number;
  fileName: string | undefined;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onClose: () => void;
  /** 放映时鼠标 2 秒不动：淡出 300ms */
  idle?: boolean;
  /** 放映中：true 在放 / false 暂停；undefined = 不是放映 */
  playing?: boolean;
  onTogglePlay?: () => void;
  /** 当前类型；undefined = 详情还没到，不显示「归入」 */
  kind?: ContentKind;
  kindOpen: boolean;
  onKindOpenChange: (open: boolean) => void;
  onSetKind: (kind: ContentKind | 'auto') => void;
}) {
  return (
    <div
      data-lb-chrome
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 z-20 flex h-16 items-center justify-between gap-6 bg-linear-to-b from-black/30 to-transparent pr-4 pl-6 transition-opacity group-data-returning/lb:opacity-0',
        idle ? 'opacity-0 duration-300 [&_*]:pointer-events-none!' : 'duration-200',
      )}
    >
      <div className="pointer-events-auto flex min-w-0 items-baseline gap-4 text-white">
        <span className="flex shrink-0 items-baseline gap-1.5">
          <span className="numeral text-[30px] leading-none tabular">{index + 1}</span>
          <span className="text-[13px] text-white/40 tabular">/ {formatCount(total)}</span>
        </span>
        {fileName && <span className="truncate text-[13px] text-white/55">{fileName}</span>}
      </div>
      <div className="pointer-events-auto flex shrink-0 items-center gap-1">
        {playing !== undefined && (
          <LbButton label={playing ? '暂停放映' : '继续放映'} shortcut="Space" onClick={onTogglePlay}>
            {playing ? <Pause /> : <Play />}
          </LbButton>
        )}
        {kind && (
          <KindMenu
            label="把这张归入"
            current={kind}
            align="end"
            open={kindOpen}
            onOpenChange={onKindOpenChange}
            onSelect={onSetKind}
            trigger={
              <LbButton label="归入…" shortcut="C" active={kindOpen}>
                <Shapes />
              </LbButton>
            }
          />
        )}
        <LbButton label={panelOpen ? '收起信息' : '显示信息'} shortcut="I" active={panelOpen} onClick={onTogglePanel}>
          <PanelRight />
        </LbButton>
        <LbButton label="关闭" shortcut="Esc" onClick={onClose}>
          <X />
        </LbButton>
      </div>
    </div>
  );
}

/** 放映时鼠标停了 ms 毫秒就算「闲」；指针停在顶栏 / 信息面板上时不算 */
function useIdle(on: boolean, ms: number) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    setIdle(false);
    if (!on) return;
    let timer = 0;
    const wake = (e?: Event) => {
      setIdle(false);
      window.clearTimeout(timer);
      if (e?.target instanceof Element && e.target.closest('[data-lb-chrome]')) return;
      timer = window.setTimeout(() => setIdle(true), ms);
    };
    wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
    };
  }, [on, ms]);
  return idle;
}

function usePageHidden() {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return hidden;
}
