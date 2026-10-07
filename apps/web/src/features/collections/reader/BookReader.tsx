import type { CollectionPage, GetCollectionResponse } from '@emaki/shared';
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
import { useBlurPrefs, useLightbox, usePrefs } from '@/lib/stores';
import { buildSpreads, spreadIndexOf } from './spreads';

/**
 * 阅读器（T38e）：本子默认双页右开，画集单页左开（按类型记住）；窗口窄于 1100px 一律单页。
 * 键盘：← → / 空格 / PageUp PageDown 翻页，Home End 首末页，D 单双页，R 方向，I 看图器，B 模糊，Esc 回扉页。
 * 读到最后一开再往后，出现结尾卡；同系列有下一话时可以直接接着读。
 */
export function BookReader() {
  const { id = '' } = useParams();
  const q = useCollection(id);
  if (!q.data) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-stage text-white/70">
        {q.isError ? '读不到这本合集' : <Spinner className="size-5" />}
      </div>
    );
  }
  return <Reader data={q.data} />;
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

  // 窄窗口一律单页
  const [wideEnough, setWideEnough] = useState(() => window.innerWidth >= 1100);
  useEffect(() => {
    const on = () => setWideEnough(window.innerWidth >= 1100);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const spreadOn = spreadPref && wideEnough;
  const spreads = useMemo(() => buildSpreads(pages, spreadOn), [pages, spreadOn]);
  const p = Math.min(n, Math.max(1, Number(params.get('p')) || readProgress.get(c.id) || 1));
  const cur = spreadIndexOf(spreads, p);
  const [ended, setEnded] = useState(false);

  const goTo = useCallback(
    (index: number) => {
      if (index >= spreads.length) return setEnded(true);
      setEnded(false);
      const i = Math.max(0, index);
      const first = spreads[i]![0]!;
      readProgress.set(c.id, first);
      setParams({ p: String(first) }, { replace: true });
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
  const blurred = (pg: CollectionPage) =>
    !revealBook && !revealed.has(pg.imageId) && (shouldBlur({ rating: pg.rating, kind: pg.kind }, prefs) || (prefs.blurSensitive && c.kind === 'doujin' && !pg.tagged));

  // 预读前后一开的原图
  useEffect(() => {
    for (const s of [spreads[cur + 1], spreads[cur - 1]]) {
      for (const no of s ?? []) {
        const pg = pages[no - 1];
        if (pg) new Image().src = imageUrl.file(pg.imageId);
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

  // 滚轮翻页（250ms 节流）
  const lastWheel = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    const now = performance.now();
    if (now - lastWheel.current < 250 || Math.abs(e.deltaY) < 30) return;
    lastWheel.current = now;
    if (e.deltaY > 0) next();
    else prev();
  };

  const openLightbox = () => useLightbox.getState().show(pages.map((x) => x.imageId), Math.max(0, p - 1), `reader:${c.id}`);
  const back = () => navigate(`/collections/${c.id}`);
  const on = !lightboxOpen;
  useHotkey(['arrowright'], () => (rtl ? prev() : next()), { enabled: on });
  useHotkey(['arrowleft'], () => (rtl ? next() : prev()), { enabled: on });
  useHotkey(['space', 'pagedown'], () => next(), { enabled: on });
  useHotkey(['shift+space', 'pageup'], () => prev(), { enabled: on });
  useHotkey('home', () => goTo(0), { enabled: on });
  useHotkey('end', () => goTo(spreads.length - 1), { enabled: on });
  useHotkey('d', () => setSpread(c.kind, !spreadPref), { enabled: on });
  useHotkey('r', () => setRtl(c.kind, !rtl), { enabled: on });
  useHotkey('i', openLightbox, { enabled: on });
  useHotkey('b', toggleBlur, { enabled: on });
  useHotkey('esc', (e) => {
    if (!e.defaultPrevented) back();
  }, { enabled: on, preventDefault: false });

  const group = spreads[cur] ?? [];
  const nextVolume = data.series.find((s) => (s.volumeNo ?? 0) > (c.volumeNo ?? 0) && s.id !== c.id);
  const m = COLLECTION_META[c.kind];

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-stage text-white/85 select-none" onMouseMove={poke} onWheel={onWheel}>
      <header className={cn('flex h-12 shrink-0 items-center gap-3 px-4 transition-opacity duration-300', !chrome && 'opacity-0 hover:opacity-100')}>
        <ReaderButton label="回到扉页" onClick={back}>
          <ArrowLeft className="size-4" />
        </ReaderButton>
        <span className="text-[11px] tracking-[.14em] text-white/50">{m.label}</span>
        <span className="max-w-[40vw] truncate text-[13px] font-semibold">{displayTitle(c)}</span>
        <span className="mx-auto numeral text-[15px] text-white/70 tabular">
          {group[0]}
          {group[1] ? `–${group[1]}` : ''} / {n}
        </span>
        <Toggle on={spreadOn} disabled={!wideEnough} onClick={() => setSpread(c.kind, !spreadPref)} label={spreadOn ? '双页' : '单页'} hint="D" />
        <Toggle on={rtl} onClick={() => setRtl(c.kind, !rtl)} label={rtl ? '右开' : '左开'} hint="R" />
        {prefs.blurSensitive && <Toggle on={revealBook} onClick={toggleReveal} label="本册不模糊" />}
        <ReaderButton label="在看图器里打开当前页（I）" onClick={openLightbox}>
          <Info className="size-4" />
        </ReaderButton>
        <ReaderButton label="关闭（Esc）" onClick={back}>
          <X className="size-4" />
        </ReaderButton>
      </header>

      <main className={cn('relative flex min-h-0 flex-1 items-center justify-center px-6', rtl && 'flex-row-reverse')}>
        <AnimatePresence mode="wait" initial={false}>
          {ended ? (
            <motion.div key="end" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} className="rounded-[14px] bg-white/5 px-8 py-6 text-center ring-1 ring-white/10">
              <div className="font-serif-cjk text-[22px] font-semibold tracking-[.08em] text-white/90">读完了</div>
              <div className="mt-1 text-[12.5px] text-white/50">{displayTitle(c)} · {n} 页</div>
              <div className="mt-5 flex justify-center gap-2">
                <Button variant="ghost" className="text-white/80 hover:bg-white/10" onClick={back}>
                  回到目次
                </Button>
                {nextVolume && (
                  <Button variant="primary" onClick={() => navigate(`/collections/${nextVolume.id}/read?p=1`)}>
                    下一{unitWord(data.series)}：{displayTitle(nextVolume)}（第 {nextVolume.volumeNo} {unitWord(data.series)}）
                  </Button>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key={cur}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18 }}
              className={cn('flex items-center justify-center', rtl && 'flex-row-reverse')}
            >
              {group.map((no) => {
                const pg = pages[no - 1];
                if (!pg) return null;
                const size = cn('object-contain', group.length > 1 ? 'max-w-[calc(50vw-24px)]' : 'max-w-[92vw]', 'max-h-[calc(100vh-7.5rem)]');
                return blurred(pg) ? (
                  <button
                    key={pg.imageId}
                    type="button"
                    aria-label="显示这一页"
                    onClick={() => setRevealed((s) => new Set(s).add(pg.imageId))}
                    className="overflow-hidden"
                    style={{ aspectRatio: `${pg.width} / ${pg.height}`, height: 'calc(100vh - 7.5rem)', maxWidth: group.length > 1 ? 'calc(50vw - 24px)' : '92vw' }}
                  >
                    <Thumb image={{ id: pg.imageId, rating: pg.rating, dominantColor: pg.dominantColor }} width={960} forceBlur blurBadge="center" className="size-full" />
                  </button>
                ) : (
                  <img
                    key={pg.imageId}
                    src={imageUrl.file(pg.imageId)}
                    alt=""
                    draggable={false}
                    decoding="async"
                    className={size}
                    style={{ backgroundColor: pg.dominantColor }}
                  />
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
        {/* 点击区：两侧翻页，中间切换顶栏 */}
        <button type="button" aria-label={rtl ? '下一页' : '上一页'} className="absolute inset-y-0 left-0 w-[30%] cursor-w-resize" onClick={() => (rtl ? next() : prev())} />
        <button type="button" aria-label={rtl ? '上一页' : '下一页'} className="absolute inset-y-0 right-0 w-[30%] cursor-e-resize" onClick={() => (rtl ? prev() : next())} />
      </main>

      <footer className="group/film shrink-0">
        <div className="h-[2px] bg-white/10">
          <div className={cn('h-full bg-shu transition-[width] duration-300', rtl && 'ml-auto')} style={{ width: `${(p / n) * 100}%` }} />
        </div>
        <Filmstrip pages={pages} current={group} rtl={rtl} blurred={blurred} onPick={(no) => goTo(spreadIndexOf(spreads, no))} />
      </footer>
    </div>
  );
}

/** 胶片条：鼠标移到底部时展开，当前页居中、朱色描边 */
function Filmstrip({
  pages,
  current,
  rtl,
  blurred,
  onPick,
}: {
  pages: CollectionPage[];
  current: number[];
  rtl: boolean;
  blurred: (pg: CollectionPage) => boolean;
  onPick: (pageNo: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.querySelector('[data-current="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [open, current]);
  return (
    <div onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} className="h-[96px]">
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
                image={{ id: pg.imageId, rating: pg.rating, dominantColor: pg.dominantColor }}
                width={240}
                blurBadge="none"
                forceBlur={blurred(pg)}
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
      className="flex size-8 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}

function Toggle({ on, onClick, label, hint, disabled }: { on: boolean; onClick: () => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] transition-colors disabled:opacity-40',
        on ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white',
      )}
    >
      {label}
      {hint && <span className="text-[10px] text-white/40">{hint}</span>}
    </button>
  );
}
