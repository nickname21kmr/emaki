import type { ID, ImageItem } from '@emaki/shared';
import { ChevronLeft, ChevronRight, Eye, EyeOff, ImageOff } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Spinner, Tooltip } from '@/components/ui';
import { imageUrl } from '@/lib/api';
import { cn } from '@/lib/cn';
import { isTypingTarget } from '@/lib/hotkeys';
import { clampPan, zoomAround, type ZoomApi, type ZoomBounds } from './useZoomPan';
import { EASE_OUT } from '@/lib/motion';
import type { LightboxRect } from '@/lib/stores';

export type StageMeta = Pick<ImageItem, 'width' | 'height' | 'rating' | 'dominantColor' | 'fileName'>;

/** 图片四周留白：左右给切换箭头，上下给顶栏和缩放提示 */
const PAD_X = 84;
const PAD_Y = 68;
const EASE = EASE_OUT;

/**
 * 看图器的舞台：居中显示图片，先 960 缩略图再换原图；滚轮 / 双击缩放，放大后拖动平移。
 * 点击图片外的空白处关闭。
 */
export function Stage({
  id,
  meta,
  blurred,
  blurLabel,
  onReveal,
  zoomApi,
  direction,
  hasPrev,
  hasNext,
  loadingNext,
  originRect,
  returnRect,
  onPrev,
  onNext,
  onBackdropClick,
  slideshow,
}: {
  id: ID;
  meta: StageMeta | undefined;
  /** 当前是否模糊（敏感分级 + 偏好 + 没点过「显示」） */
  blurred: boolean;
  /** 模糊原因：分级名 / 照片 / 文字 */
  blurLabel: string;
  onReveal: () => void;
  zoomApi: ZoomApi;
  /** 切换方向（-1 / 0 / 1），决定入场从哪边滑进来 */
  direction: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** 在已加载的最后一张往后翻，正在等下一页 */
  loadingNext?: boolean;
  /** 打开时点中的格子位置：从那里放大出来（SEL-12）；切换后为 null */
  originRect?: LightboxRect | null;
  /** 正在放回：缩回这一格 */
  returnRect?: LightboxRect | null;
  onPrev: () => void;
  onNext: () => void;
  onBackdropClick: () => void;
  /** 放映中（SEL-16）：新旧图交叉淡化 crossfade 秒；idle = 鼠标停了，箭头和光标一起藏起来 */
  slideshow?: { crossfade: number; idle: boolean } | null;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(stageRef);
  const { zoom, setZoom, reset, zoomed } = zoomApi;

  // 「适应窗口」的尺寸：不放大小图（最多 1:1）
  const availW = Math.max(0, size.w - PAD_X * 2);
  const availH = Math.max(0, size.h - PAD_Y * 2);
  const fit = meta && availW > 0 && availH > 0 ? Math.min(availW / meta.width, availH / meta.height, 1) : 0;
  const boxW = meta ? Math.round(meta.width * fit) : 0;
  const boxH = meta ? Math.round(meta.height * fit) : 0;
  // 至少能放到 4 倍，大图至少能看到原始像素的 200%
  const maxScale = fit > 0 ? Math.max(4, 2 / fit) : 4;
  const bounds: ZoomBounds = { boxW, boxH, stageW: size.w, stageH: size.h, maxScale };
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  // 相对舞台中心的坐标
  const toStage = (clientX: number, clientY: number) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { px: clientX - rect.left - rect.width / 2, py: clientY - rect.top - rect.height / 2 };
  };

  // 滚轮缩放：需要 non-passive 监听才能阻止页面默认行为
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const b = boundsRef.current;
      if (!b.boxW) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left - rect.width / 2;
      const py = e.clientY - rect.top - rect.height / 2;
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      setZoom((z) => zoomAround(z, z.scale * Math.exp(-delta * 0.0022), px, py, b, false));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoom]);

  // + / - / 0：以中心缩放 / 还原（'+' 是组合键分隔符，useHotkey 表达不了，这里自己监听）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const b = boundsRef.current;
      if (e.key === '+' || e.key === '=') setZoom((z) => zoomAround(z, z.scale * 1.4, 0, 0, b, true));
      else if (e.key === '-' || e.key === '_') setZoom((z) => zoomAround(z, z.scale / 1.4, 0, 0, b, true));
      else if (e.key === '0') reset();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setZoom, reset]);

  // 拖动平移
  const drag = useRef<{ sx: number; sy: number; x0: number; y0: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !zoomed) return;
    if ((e.target as Element).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, x0: zoom.x, y0: zoom.y, moved: false };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true;
    setZoom((z) => clampPan({ ...z, x: d.x0 + dx, y: d.y0 + dy, smooth: false }, boundsRef.current));
  };
  const endDrag = () => {
    if (!drag.current) return;
    suppressClick.current = drag.current.moved;
    drag.current = null;
    setDragging(false);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!fit) return;
    if (zoomed) return reset();
    const { px, py } = toStage(e.clientX, e.clientY);
    // 双击放到原始像素 100%（小图至少 2.5 倍）
    setZoom((z) => zoomAround(z, Math.max(2.5, 1 / fit), px, py, boundsRef.current, true));
  };

  const percent = Math.round(zoom.scale * fit * 100);

  // 从格子里「拿起」：第一张从格子的位置和大小放大到居中（SEL-12）；切换时照旧左右滑入
  const stageRect = stageRef.current?.getBoundingClientRect();
  const toRect = (r: LightboxRect) =>
    stageRect && boxW > 0
      ? {
          x: r.left + r.width / 2 - (stageRect.left + size.w / 2),
          y: r.top + r.height / 2 - (stageRect.top + size.h / 2),
          scale: Math.max(r.width / boxW, r.height / boxH),
        }
      : null;
  const from = originRect ? toRect(originRect) : null;
  const back = returnRect ? toRect(returnRect) : null;
  const initial = from
    ? { opacity: 1, ...from }
    : slideshow
      ? { opacity: 0, x: 0, y: 0, scale: 1 }
      : { opacity: 0, x: direction * 28, y: 0, scale: direction ? 1 : 0.985 };
  const idle = !!slideshow?.idle;

  const plate =
    meta && fit > 0 ? (
      <motion.div
        key={id}
        initial={initial}
        animate={back ? { opacity: 1, ...back } : returnRect ? { opacity: 0, x: 0, y: 0, scale: 0.96 } : { opacity: 1, x: 0, y: 0, scale: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: returnRect ? 0.3 : originRect ? 0.46 : (slideshow?.crossfade ?? 0.42), ease: slideshow ? 'linear' : EASE }}
        className="absolute"
        style={{ left: (size.w - boxW) / 2, top: (size.h - boxH) / 2, width: boxW, height: boxH }}
      >
        <div
          className={cn('size-full', !zoomed && !idle && 'cursor-zoom-in')}
          onDoubleClick={onDoubleClick}
          style={{
            transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`,
            transition: zoom.smooth ? 'transform 320ms var(--ease-out-soft)' : 'none',
            willChange: 'transform',
          }}
        >
          <StageImage
            key={id}
            id={id}
            meta={meta}
            blurred={blurred}
            blurLabel={blurLabel}
            onReveal={onReveal}
            placeholder={originRect?.thumb}
            flat={!!returnRect}
            slide={!!slideshow}
          />
        </div>
      </motion.div>
    ) : null;

  return (
    <div
      ref={stageRef}
      className={cn(
        'group/stage relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden select-none',
        zoomed ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : idle && 'cursor-none',
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        if (e.target === e.currentTarget && !zoomed) onBackdropClick();
      }}
    >
      {/* 放映时旧图留在原位淡出，新图同时淡入（交叉淡化）；平时直接换 */}
      {slideshow ? <AnimatePresence>{plate}</AnimatePresence> : plate}
      {!plate && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner className="size-5 text-white/50" />
        </div>
      )}

      <NavArrow dir={-1} hidden={!hasPrev || !!returnRect} idle={idle} onClick={onPrev} />
      <NavArrow dir={1} hidden={!hasNext || !!returnRect} idle={idle} onClick={onNext} loading={loadingNext} />

      <AnimatePresence>
        {zoomed ? (
          <motion.button
            key="zoom"
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.25, ease: EASE }}
            onClick={reset}
            className="absolute bottom-5 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-2 rounded-full bg-black/45 px-3.5 text-xs text-white/85 ring-1 ring-white/10 backdrop-blur-md transition-colors hover:bg-black/60"
          >
            <span className="font-medium tabular">{percent}%</span>
            <span className="text-white/45">点击或按 0 还原</span>
          </motion.button>
        ) : (
          <motion.div
            key="hint"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={cn(
              'pointer-events-none absolute bottom-6 left-1/2 z-10 -translate-x-1/2 text-[11px] whitespace-nowrap text-white/0 transition-colors duration-500',
              !idle && 'group-hover/stage:text-white/35',
            )}
          >
            {slideshow ? '放映中 · 空格暂停 · ← → 切换 · Esc 退出' : '滚轮缩放 · 双击放大 · ← → 切换 · I 信息'}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** 一张图：主色占位 → 960 缩略图 → 原图淡入。按 id 重新挂载，加载状态天然隔离。 */
function StageImage({
  id,
  meta,
  blurred,
  blurLabel,
  onReveal,
  placeholder,
  flat,
  slide,
}: {
  id: ID;
  meta: StageMeta;
  blurred: boolean;
  blurLabel: string;
  onReveal: () => void;
  /** 网格里同一张的缩略图宽度：拿起时垫在最下面 */
  placeholder?: 240 | 480 | 960;
  /** 放回时去掉投影 */
  flat?: boolean;
  /** 放映中：外层已经在交叉淡化，缩略图（已预先解码）直接出现，不再叠一层淡入 */
  slide?: boolean;
}) {
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [fullLoaded, setFullLoaded] = useState(false);
  const [fullFailed, setFullFailed] = useState(false);

  const imgClass = cn(
    'absolute inset-0 size-full object-contain transition-[opacity,filter,scale] duration-500 ease-[var(--ease-out-soft)]',
    blurred && 'scale-110 blur-3xl saturate-150',
  );

  return (
    <div
      className={cn(
        'relative size-full overflow-hidden rounded-[3px] transition-shadow duration-300',
        !flat && 'shadow-[0_40px_120px_-30px_rgb(0_0_0/0.8)]',
      )}
      style={{ backgroundColor: placeholder || thumbLoaded || fullLoaded ? undefined : meta.dominantColor }}
    >
      {placeholder && !fullLoaded && <img src={imageUrl.thumb(id, placeholder)} alt="" draggable={false} className={imgClass} />}
      <img
        src={imageUrl.thumb(id, 960)}
        alt=""
        draggable={false}
        onLoad={() => setThumbLoaded(true)}
        className={cn(
          imgClass,
          // 原图淡入完成后再隐藏缩略图，避免透明 PNG 叠出重影
          thumbLoaded && !fullLoaded ? 'opacity-100' : 'opacity-0',
          fullLoaded && 'delay-300',
        )}
        style={slide && !fullLoaded ? { transitionDuration: '0ms' } : undefined}
      />
      {!fullFailed && (
        <img
          src={imageUrl.file(id)}
          alt={meta.fileName}
          draggable={false}
          decoding="async"
          onLoad={() => setFullLoaded(true)}
          onError={() => setFullFailed(true)}
          className={cn(imgClass, fullLoaded ? 'opacity-100' : 'opacity-0')}
        />
      )}

      {!fullLoaded && !fullFailed && (
        <div className="pointer-events-none absolute right-3 bottom-3 animate-[fade-in_0.3s_0.6s_both]">
          <Spinner className="size-4 text-white/70 drop-shadow" />
        </div>
      )}
      {fullFailed && (
        <div className="pointer-events-none absolute top-3 left-3 flex h-6 items-center gap-1.5 rounded-full bg-black/45 px-2.5 text-[11px] text-white/85 backdrop-blur-md">
          <ImageOff className="size-3.5" />
          原图读取失败，显示的是缩略图
        </div>
      )}

      <AnimatePresence>
        {blurred && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white"
          >
            <span className="flex size-12 items-center justify-center rounded-full bg-black/25 ring-1 ring-white/20 backdrop-blur-md">
              <EyeOff className="size-5" />
            </span>
            <div className="text-center">
              <div className="text-sm font-medium drop-shadow">{blurLabel} · 已模糊</div>
              <div className="mt-1 text-xs text-white/65 drop-shadow">只对这一张生效，关掉看图器后恢复</div>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReveal();
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              className="flex h-9 items-center gap-2 rounded-full bg-white/18 px-4 text-[13px] font-medium ring-1 ring-white/30 backdrop-blur-md transition-colors hover:bg-white/28"
            >
              <Eye className="size-4" />
              显示
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function NavArrow({
  dir,
  hidden,
  idle,
  onClick,
  loading,
}: {
  dir: -1 | 1;
  hidden: boolean;
  /** 放映时鼠标停了：连悬停也不显示 */
  idle?: boolean;
  onClick: () => void;
  loading?: boolean;
}) {
  if (hidden) return null;
  const label = dir < 0 ? '上一张' : '下一张';
  return (
    <Tooltip content={label} shortcut={dir < 0 ? '←' : '→'} side={dir < 0 ? 'right' : 'left'}>
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={cn(
          'absolute top-1/2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-full',
          'bg-white/8 text-white/80 ring-1 ring-white/10 backdrop-blur-md transition-[opacity,background-color,color,scale] duration-200',
          loading
            ? 'opacity-100'
            : idle
              ? 'pointer-events-none opacity-0'
              : 'opacity-0 group-hover/stage:opacity-100 hover:bg-white/16 hover:text-white focus-visible:opacity-100 active:scale-95',
          dir < 0 ? 'left-5' : 'right-5',
        )}
      >
        {loading ? <Spinner className="size-4" /> : dir < 0 ? <ChevronLeft className="size-5" /> : <ChevronRight className="size-5" />}
      </button>
    </Tooltip>
  );
}

function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
