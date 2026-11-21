import { bookBlurContext, type BlurContext, type CollectionPage, type GetCollectionResponse } from '@emaki/shared';
import { ArrowLeft, Info, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Thumb } from '@/components/media/Thumb';
import { Button, Spinner } from '@/components/ui';
import { imageUrl } from '@/lib/api';
import { shouldBlur } from '@/lib/blur';
import { cn } from '@/lib/cn';
import { COLLECTION_META, displayTitle, readProgress, unitWord } from '@/lib/collections';
import { useHotkey } from '@/lib/hotkeys';
import { useCollection } from '@/lib/queries';
import { useBlurPrefs, useLightbox, useOverlays, usePrefs } from '@/lib/stores';
import { readerSpreadFits, useViewport } from '@/lib/viewport';
import { previousPath } from './previousPath';
import { slotStyle, usePageTrack, useTrackpadPager } from '@/lib/usePageTrack';
import { useSwipePager } from '@/lib/useSwipePager';
import { buildSpreads, spreadIndexOf } from './spreads';
import { useReaderZoom } from './useReaderZoom';

/**
 * 阅读器（T38e）：本子默认双页右开，画集单页左开（按类型记住）；竖屏和窄窗口一律单页（横屏而且宽度 ≥ 840 才双页，A1）。
 * 键盘：← → / 空格 / PageUp PageDown 翻页，Home End 首末页，D 单双页，R 方向，I 看图器，B 模糊，Esc 回扉页。
 * 触屏：左右滑、点两侧翻页，点中间切换顶栏；双指捏合放大（放大后单指拖动是平移，双击还原，useReaderZoom）。
 * 翻页都是同一个动作（lib/usePageTrack.ts）：前后一开并排摆在轨道上，拖动、触控板左右滑跟手，点击、按键、滚轮一格滑一页；跳页直接换。
 * 读到最后一开再往后，出现结尾卡；同系列有下一话时可以直接接着读。
 */
/** 助手附页并排或覆盖时，阅读器右边让出它的宽度（和 toast 一样） */
const YIELD = { right: 'var(--assistant-right, 0px)' } as const;

export function BookReader() {
  const { id = '' } = useParams();
  const q = useCollection(id);
  const setReaderOpen = useOverlays((s) => s.setReaderOpen);
  useEffect(() => {
    setReaderOpen(true);
    // 触控板左右滑是翻页：别让浏览器当成「后退 / 前进」
    const root = document.documentElement.style;
    const was = root.overscrollBehaviorX;
    root.overscrollBehaviorX = 'none';
    return () => {
      setReaderOpen(false);
      root.overscrollBehaviorX = was;
    };
  }, [setReaderOpen]);
  if (!q.data) {
    return (
      <div data-assistant-yield style={YIELD} className="fixed inset-0 z-40 flex items-center justify-center bg-stage text-white/70">
        {q.isError ? '读不到这本合集' : <Spinner className="size-5" />}
      </div>
    );
  }
  // 换了合集（结尾卡的「下一话」）就重新开始：显示的页记在 Reader 自己的状态里
  return <Reader key={q.data.collection.id} data={q.data} />;
}

const revealKey = (id: string) => `emaki.reader.reveal.${id}`;
const readReveal = (id: string) => {
  try {
    return sessionStorage.getItem(revealKey(id)) === '1';
  } catch {
    return false;
  }
};

function Reader({ data }: { data: GetCollectionResponse }) {
  const c = data.collection;
  const pages = data.pages;
  const n = pages.length;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const lightboxOpen = useLightbox((s) => s.open);
  const prefs = useBlurPrefs();
  const spreadPref = usePrefs((s) => s.readerSpread[c.kind]);
  const rtl = usePrefs((s) => s.readerRtl[c.kind]);
  const setSpread = usePrefs((s) => s.setReaderSpread);
  const setRtl = usePrefs((s) => s.setReaderRtl);
  const toggleBlur = usePrefs((s) => s.toggleBlurSensitive);

  // 竖屏、窄窗口一律单页；横屏而且宽度 expanded 才能双页（lib/viewport.ts 的 readerSpreadFits，A1）
  const viewport = useViewport();
  const wideEnough = readerSpreadFits(viewport);
  const spreadOn = spreadPref && wideEnough;
  const spreads = useMemo(() => buildSpreads(pages, spreadOn), [pages, spreadOn]);
  // 显示的是哪一页先记在这里、立刻换（轨道马上开始滑）；地址栏的 ?p= 等翻完 350ms 再写：
  // 写地址会让整个路由树重新渲染（无窗口的 Chrome 里约 100ms），放在动画前面就是「点了没反应、再一下子滑过去」
  const urlP = Number(params.get('p')) || 0;
  const [shown, setShown] = useState(() => urlP || readProgress.get(c.id) || 1);
  const written = useRef(urlP);
  useEffect(() => {
    // 地址栏的 p 从外面变了（前进后退、手动改地址）：跟过去
    if (urlP && urlP !== written.current) {
      written.current = urlP;
      setShown(urlP);
    }
  }, [urlP]);
  const urlTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(urlTimer.current), []);
  const p = Math.min(n, Math.max(1, shown));
  const cur = spreadIndexOf(spreads, p);
  const [ended, setEnded] = useState(false);

  const goTo = useCallback(
    (index: number) => {
      if (index >= spreads.length) return setEnded(true);
      setEnded(false);
      const i = Math.max(0, index);
      const first = spreads[i]![0]!;
      readProgress.set(c.id, first);
      setShown(first);
      window.clearTimeout(urlTimer.current);
      urlTimer.current = window.setTimeout(() => {
        written.current = first;
        setParams({ p: String(first) }, { replace: true });
      }, 350);
    },
    [spreads, setParams, c.id],
  );
  const next = () => (ended ? undefined : goTo(cur + 1));
  const prev = () => (ended ? setEnded(false) : goTo(cur - 1));
  useEffect(() => readProgress.set(c.id, p), [c.id, p]);

  // 本册不模糊：只在这个标签页里有效
  const [revealBook, setRevealBook] = useState(() => readReveal(c.id));
  const toggleReveal = () => {
    const v = !revealBook;
    setRevealBook(v);
    try {
      if (v) sessionStorage.setItem(revealKey(c.id), '1');
      else sessionStorage.removeItem(revealKey(c.id));
    } catch {
      /* 无痕模式等 */
    }
  };
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  // 本子页分级不可信（没识别过）时打码：场合由 bookBlurContext 决定，判断只有共用的 blurReason 一套（附录 #30）
  const context = bookBlurContext(c.kind);
  const pageRevealed = (pg: CollectionPage) => revealBook || revealed.has(pg.imageId);
  const blurred = (pg: CollectionPage) =>
    !pageRevealed(pg) && shouldBlur({ rating: pg.rating, kind: pg.kind, rated: pg.tagged }, prefs, context);

  // 前后一开已经摆在轨道上：先解码好，滑进来的第一帧就有图（不闪主色块）；再往前后各预读一开
  const trackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    trackRef.current?.querySelectorAll<HTMLImageElement>('img[data-neighbor]').forEach((img) => void img.decode().catch(() => {}));
    for (const s of [spreads[cur + 2], spreads[cur - 2]]) {
      for (const no of s ?? []) {
        const pg = pages[no - 1];
        if (pg) new Image().src = imageUrl.file(pg.imageId, pg.modifiedAt);
      }
    }
  }, [cur, spreads, pages]);

  // 顶栏：鼠标 2.5 秒不动就淡出
  const [chrome, setChrome] = useState(true);
  const idle = useRef<number | undefined>(undefined);
  const poke = useCallback(() => {
    setChrome(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setChrome(false), 2500);
  }, []);
  useEffect(() => {
    poke();
    return () => window.clearTimeout(idle.current);
  }, [poke]);

  // 轨道：第 pos 格是当前这一开，读完后的结尾卡是最后一格（spreads.length）
  const pos = ended ? spreads.length : cur;
  usePageTrack({ pos, layout: spreads, rtl, trackRef });

  // 触控板左右滑跟手（和触屏的拖动一样）；鼠标滚轮一格翻一页（250ms 节流，动画和点击一样）
  const trackpad = useTrackpadPager({
    trackRef,
    rtl,
    hasPrev: cur > 0 || ended,
    hasNext: !ended,
    onForward: () => next(),
    onBack: () => prev(),
  });
  const lastWheel = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    if (zoom.zoomed || trackpad(e)) return;
    const now = performance.now();
    if (now - lastWheel.current < 250 || Math.abs(e.deltaY) < 30) return;
    lastWheel.current = now;
    if (e.deltaY > 0) next();
    else prev();
  };

  const openLightbox = () => useLightbox.getState().show(pages.map((x) => x.imageId), Math.max(0, p - 1), `reader:${c.id}`);
  // 关掉阅读器不多一条历史：从扉页进来的就退回去，别的地方进来的换成扉页（后退不会又回到阅读器）
  const back = () => {
    window.clearTimeout(urlTimer.current);
    const detail = `/collections/${c.id}`;
    if (previousPath() === detail) navigate(-1);
    else navigate(detail, { replace: true });
  };
  const on = !lightboxOpen;
  useHotkey(['arrowright'], () => (rtl ? prev() : next()), { enabled: on, repeat: true });
  useHotkey(['arrowleft'], () => (rtl ? next() : prev()), { enabled: on, repeat: true });
  useHotkey(['space', 'pagedown'], () => next(), { enabled: on, repeat: true });
  useHotkey(['shift+space', 'pageup'], () => prev(), { enabled: on, repeat: true });
  useHotkey('home', () => goTo(0), { enabled: on });
  useHotkey('end', () => goTo(spreads.length - 1), { enabled: on });
  useHotkey('d', () => setSpread(c.kind, !spreadPref), { enabled: on });
  useHotkey('r', () => setRtl(c.kind, !rtl), { enabled: on });
  useHotkey('i', openLightbox, { enabled: on });
  useHotkey('b', toggleBlur, { enabled: on });
  useHotkey('esc', (e) => {
    if (!e.defaultPrevented) back();
  }, { enabled: on, preventDefault: false });

  // 触屏（A1）：左右滑翻页（跟手，过阈值翻、没过弹回），点两侧三分之一翻页（热区按钮），点中间切换顶栏和胶片条
  const toggleChrome = () => {
    window.clearTimeout(idle.current);
    setChrome((v) => !v);
  };
  const swipe = useSwipePager({
    hasPrev: cur > 0 || ended,
    rtl,
    onForward: next,
    onBack: prev,
    onCenterTap: toggleChrome,
    settle: (go) => (go === 'forward' ? next() : prev()),
  });
  // 双指捏合放大（真机走查）：放大时一根手指的拖动、点按归它，翻页的滑动和两侧热区让开；换一开自动还原
  const stageRef = useRef<HTMLElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const zoom = useReaderZoom(`${cur}:${ended}`, stageRef, boxRef, {
    onTap: toggleChrome,
    onPinchStart: () => swipe.handlers.onPointerCancel(),
  });
  // 刚触摸过：浏览器补发的 mousemove 不算「鼠标动了」（不然每点一下顶栏都亮 2.5 秒）
  const onMouseMove = () => {
    if (!swipe.fromTouch()) poke();
  };

  const group = spreads[cur] ?? [];
  const nextVolume = data.series.find((s) => (s.volumeNo ?? 0) > (c.volumeNo ?? 0) && s.id !== c.id);
  const m = COLLECTION_META[c.kind];

  return (
    // --reader-page-h：一页最高多高。电脑上扣掉顶栏 48 和底部进度条 + 胶片条 98；触屏上顶栏、胶片条浮在页面上，页面用满整屏
    <div
      data-assistant-yield
      style={YIELD}
      className="fixed inset-0 z-40 flex flex-col bg-stage text-white/85 select-none [--reader-page-h:calc(100vh-146px)] touch:[--reader-page-h:calc(100dvh-16px)]"
      onMouseMove={onMouseMove}
      onWheel={onWheel}
    >
      <header
        className={cn(
          'flex h-12 shrink-0 items-center gap-3 px-4 transition-opacity duration-300',
          'touch:absolute touch:inset-x-0 touch:top-0 touch:z-20 touch:box-content touch:bg-linear-to-b touch:from-black/60 touch:to-transparent touch:pt-[env(safe-area-inset-top)] compact:gap-1.5 compact:px-2',
          !chrome && 'opacity-0 hover:opacity-100 touch:pointer-events-none',
        )}
      >
        <ReaderButton label="回到扉页" onClick={back}>
          <ArrowLeft className="size-4" />
        </ReaderButton>
        <span className="text-[11px] tracking-[.14em] text-white/50 compact:hidden">{m.label}</span>
        <span className="max-w-[40vw] truncate text-[13px] font-semibold compact:hidden">{displayTitle(c)}</span>
        <span className="mx-auto numeral text-[15px] text-white/70 tabular">
          {group[0]}
          {group[1] ? `–${group[1]}` : ''} / {n}
        </span>
        {/* 竖屏一律单页：手机上不放这个点不动的开关 */}
        <Toggle
          on={spreadOn}
          disabled={!wideEnough}
          onClick={() => setSpread(c.kind, !spreadPref)}
          label={spreadOn ? '双页' : '单页'}
          hint="D"
          className="compact:hidden"
        />
        <Toggle on={rtl} onClick={() => setRtl(c.kind, !rtl)} label={rtl ? '右开' : '左开'} hint="R" />
        {prefs.blurSensitive && <Toggle on={revealBook} onClick={toggleReveal} label="本册不模糊" />}
        <ReaderButton label="在看图器里打开当前页（I）" onClick={openLightbox}>
          <Info className="size-4" />
        </ReaderButton>
        <ReaderButton label="关闭（Esc）" onClick={back}>
          <X className="size-4" />
        </ReaderButton>
      </header>

      <main
        ref={stageRef}
        onPointerDown={(e) => zoom.handlers.onPointerDown(e) || swipe.handlers.onPointerDown(e)}
        onPointerMove={(e) => zoom.handlers.onPointerMove(e) || swipe.handlers.onPointerMove(e)}
        onPointerUp={(e) => zoom.handlers.onPointerUp(e) || swipe.handlers.onPointerUp(e)}
        onPointerCancel={(e) => zoom.handlers.onPointerCancel(e) || swipe.handlers.onPointerCancel()}
        className="relative min-h-0 flex-1 touch-none overflow-hidden"
      >
        {/* 轨道：前后一开并排摆着（lib/usePageTrack.ts）。结尾卡那一格叠在两侧翻页热区上面：窗口窄时按钮会落进热区里，点不到 */}
        <div
          ref={(el) => {
            trackRef.current = el;
            swipe.layerRef.current = el;
          }}
          data-reader-track
          className={cn('absolute inset-0', ended && 'pointer-events-none z-10')}
        >
          {[pos - 1, pos, pos + 1].map((i) =>
            i < 0 || i > spreads.length ? null : (
              <div
                key={i === spreads.length ? 'end' : `s${spreads[i]![0]}`}
                aria-hidden={i !== pos || undefined}
                inert={i !== pos || undefined}
                style={slotStyle(i - pos, rtl)}
                className="absolute inset-0 flex items-center justify-center px-6 compact:px-2"
              >
                {i === spreads.length ? (
                  <EndCard
                    title={displayTitle(c)}
                    pages={n}
                    onBack={back}
                    next={nextVolume}
                    unit={unitWord(data.series)}
                    onNext={(v) => navigate(`/collections/${v.id}/read?p=1`)}
                  />
                ) : (
                  <Spread
                    group={spreads[i]!}
                    current={i === pos}
                    boxRef={i === pos ? boxRef : undefined}
                    zoomStyle={i === pos ? zoom.style : undefined}
                    pages={pages}
                    rtl={rtl}
                    blurred={blurred}
                    context={context}
                    onReveal={(pg) => setRevealed((s) => new Set(s).add(pg.imageId))}
                  />
                )}
              </div>
            ),
          )}
        </div>
        {/* 点击区：两侧翻页，中间切换顶栏 */}
        {/* 触屏上正好三分之一（中间那块点了切换顶栏）；放大时让开，点按、拖动归缩放 */}
        <button
          type="button"
          aria-label={rtl ? '下一页' : '上一页'}
          className={cn('absolute inset-y-0 left-0 w-[30%] cursor-w-resize touch:w-1/3', zoom.zoomed && 'pointer-events-none')}
          onClick={() => (rtl ? next() : prev())}
        />
        <button
          type="button"
          aria-label={rtl ? '上一页' : '下一页'}
          className={cn('absolute inset-y-0 right-0 w-[30%] cursor-e-resize touch:w-1/3', zoom.zoomed && 'pointer-events-none')}
          onClick={() => (rtl ? prev() : next())}
        />
        <AnimatePresence>
          {zoom.zoomed && (
            <motion.button
              key="zoom"
              type="button"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              onClick={zoom.reset}
              className="absolute top-[calc(env(safe-area-inset-top)+60px)] left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-2 rounded-full bg-black/45 px-3.5 text-xs whitespace-nowrap text-white/85 ring-1 ring-white/10 backdrop-blur-md touch-hit"
            >
              <span className="font-medium tabular">{Math.round(zoom.zoom.scale * 100)}%</span>
              <span className="text-white/45">点这里或双击还原</span>
            </motion.button>
          )}
        </AnimatePresence>
      </main>

      {/* 触屏：浮在页面底边，顶栏亮着时胶片条一起展开（没有悬停） */}
      <footer
        className={cn(
          'group/film shrink-0 touch:absolute touch:inset-x-0 touch:bottom-0 touch:z-20 touch:pb-[env(safe-area-inset-bottom)] touch:transition-opacity',
          !chrome && 'touch:pointer-events-none touch:opacity-0',
        )}
      >
        <div className="h-[2px] bg-white/10">
          <div className={cn('h-full bg-shu transition-[width] duration-300', rtl && 'ml-auto')} style={{ width: `${(p / n) * 100}%` }} />
        </div>
        <Filmstrip
          pages={pages}
          current={group}
          rtl={rtl}
          touchOpen={chrome}
          blurred={blurred}
          context={context}
          onPick={(no) => goTo(spreadIndexOf(spreads, no))}
        />
      </footer>
    </div>
  );
}

/** 轨道上的一开：一页或并排两页。只有当前这一开接缩放（boxRef、zoomStyle） */
function Spread({
  group,
  current,
  boxRef,
  zoomStyle,
  pages,
  rtl,
  blurred,
  context,
  onReveal,
}: {
  group: number[];
  current: boolean;
  boxRef?: React.Ref<HTMLDivElement>;
  zoomStyle?: React.CSSProperties;
  pages: CollectionPage[];
  rtl: boolean;
  blurred: (pg: CollectionPage) => boolean;
  context: BlurContext;
  onReveal: (pg: CollectionPage) => void;
}) {
  return (
    // 缩放的盒子：适应窗口时的大小就是这一开的大小，放大是在它上面 translate + scale
    <div ref={boxRef} style={zoomStyle} className={cn('flex items-center justify-center', rtl && 'flex-row-reverse')}>
      {group.map((no) => {
        const pg = pages[no - 1];
        if (!pg) return null;
        // 高度扣掉顶栏 48 和底部进度条 + 胶片条 98，不盖住它们；宽度扣掉助手附页让出的那块
        const maxWidth = group.length > 1 ? 'calc(50vw - 24px - var(--assistant-right, 0px) / 2)' : 'calc(92vw - var(--assistant-right, 0px))';
        return blurred(pg) ? (
          <button
            key={pg.imageId}
            type="button"
            aria-label="显示这一页"
            onClick={() => onReveal(pg)}
            className="overflow-hidden"
            style={{ aspectRatio: `${pg.width} / ${pg.height}`, height: 'var(--reader-page-h)', maxWidth }}
          >
            <Thumb image={pageThumb(pg)} rated={pg.tagged} blurContext={context} width={960} blurBadge="center" className="size-full" />
          </button>
        ) : (
          <img
            key={pg.imageId}
            src={imageUrl.file(pg.imageId, pg.modifiedAt)}
            alt=""
            draggable={false}
            decoding="async"
            data-neighbor={current ? undefined : ''}
            className="max-h-[var(--reader-page-h)] object-contain"
            style={{ backgroundColor: pg.dominantColor, maxWidth }}
          />
        );
      })}
    </div>
  );
}

/** 读完最后一开再往后：结尾卡（同系列有下一话时可以直接接着读） */
function EndCard({
  title,
  pages,
  onBack,
  next,
  unit,
  onNext,
}: {
  title: string;
  pages: number;
  onBack: () => void;
  next: GetCollectionResponse['series'][number] | undefined;
  unit: string;
  onNext: (v: GetCollectionResponse['series'][number]) => void;
}) {
  return (
    <div className="pointer-events-auto relative rounded-[14px] bg-white/5 px-8 py-6 text-center ring-1 ring-white/10">
      <div className="font-serif-cjk text-[22px] font-semibold tracking-[.08em] text-white/90">读完了</div>
      <div className="mt-1 text-[12.5px] text-white/50">
        {title} · {pages} 页
      </div>
      <div className="mt-5 flex justify-center gap-2">
        <Button variant="ghost" className="text-white/80 hover:bg-white/10" onClick={onBack}>
          回到目次
        </Button>
        {next && (
          <Button variant="primary" onClick={() => onNext(next)}>
            下一{unit}：{displayTitle(next)}（第 {next.volumeNo} {unit}）
          </Button>
        )}
      </div>
    </div>
  );
}

/** 一页的缩略图（带类型：照片、文字也按共用的模糊判断） */
const pageThumb = (pg: CollectionPage) => ({
  id: pg.imageId,
  rating: pg.rating,
  kind: pg.kind,
  dominantColor: pg.dominantColor,
  modifiedAt: pg.modifiedAt,
});

/** 胶片条：鼠标移到底部时展开，当前页居中、朱色描边 */
function Filmstrip({
  pages,
  current,
  rtl,
  blurred,
  context,
  onPick,
  touchOpen,
}: {
  pages: CollectionPage[];
  current: number[];
  rtl: boolean;
  /** 触屏上没有悬停：顶栏亮着时就展开 */
  touchOpen: boolean;
  /** 和主视图同一个判断：主视图里显示出来的页，胶片条里也不糊 */
  blurred: (pg: CollectionPage) => boolean;
  context: BlurContext;
  onPick: (pageNo: number) => void;
}) {
  const [hovered, setOpen] = useState(false);
  const touch = useViewport().touch;
  const open = touch ? touchOpen : hovered;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.querySelector('[data-current="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [open, current]);
  return (
    <div onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} className="h-[96px] touch:bg-linear-to-t touch:from-black/60 touch:to-transparent">
      <div
        ref={ref}
        className={cn(
          'flex gap-1.5 overflow-x-auto px-4 pt-2 pb-3 transition-opacity duration-200 scrollbar-none',
          rtl && 'flex-row-reverse',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        {open &&
          pages.map((pg) => (
            <button
              key={pg.imageId}
              type="button"
              data-current={current.includes(pg.pageNo)}
              onClick={() => onPick(pg.pageNo)}
              className={cn('shrink-0 rounded-[3px] outline-none', current.includes(pg.pageNo) && 'ring-2 ring-shu')}
              style={{ width: Math.round((72 * pg.width) / pg.height) }}
              aria-label={`第 ${pg.pageNo} 页`}
            >
              <Thumb
                image={pageThumb(pg)}
                width={240}
                blurBadge="none"
                rated={pg.tagged}
                blurContext={context}
                revealed={!blurred(pg)}
                className="h-[72px] w-full rounded-[3px]"
              />
            </button>
          ))}
      </div>
    </div>
  );
}

function ReaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-white/70 transition-colors touch-hit hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}

function Toggle({
  on,
  onClick,
  label,
  hint,
  disabled,
  className,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] whitespace-nowrap transition-colors touch-hit disabled:opacity-40',
        on ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white',
        className,
      )}
    >
      {label}
      {hint && <span className="text-[10px] text-white/40 touch:hidden">{hint}</span>}
    </button>
  );
}
