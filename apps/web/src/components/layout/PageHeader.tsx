import { motion } from 'motion/react';
import { EASE_OUT } from '@/lib/motion';
import { Emblem } from '@/components/ui/Emblem';
import { useQueryClient } from '@tanstack/react-query';
import { CircleHelp, Ellipsis, Eye, EyeOff, Search, Undo2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useLocation } from 'react-router';
import { useScrollContainer } from '@/components/layout/ScrollContainer';
import { useNavLabel } from '@/lib/plugins';
import { getChapter } from './chapters';
import { IconButton, Kbd, Menu, MenuItem, MenuSeparator } from '@/components/ui';
import { cn } from '@/lib/cn';
import { modKeyLabel } from '@/lib/hotkeys';
import { useCan } from '@/lib/capabilities';
import { requestUndo, undoTitle } from '@/lib/queries';
import { placeText } from '@/lib/undoPlace';
import { useBlurPrefs, useOverlays, usePrefs, useUndoStore } from '@/lib/stores';
import { stickyHeaderFits, useViewport } from '@/lib/viewport';

/**
 * 页面头部（画册的「卷首」）：
 *
 *   ◎ 第二册　人物                ← kicker：徽记 + 品牌色册号 + 小题（按路由自动生成，见 chapters.ts）
 *   角色  1,126 位角色 · 213 部作品  ← 衬线大标题，副标题同一基线
 *   ════════════════════════════   ← 双线（首次进入时从左向右展开）
 *   （children：搜索框、筛选 chip 行）
 *
 * chapter={false} 时退回无衬线标题（详情页的面包屑头）。
 * sticky：滚动时吸顶，不透明的纸 + 一道细线（不用背景模糊，M5 原则 6）；吸住后收起 kicker、双线和副标题，
 * 标题缩到 20px，并在下面垫回缩掉的高度，内容不跳（RV-A-8）；页头高度写进 --page-head-h，给下面的吸顶条定位（RV-A-5）。
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  children,
  className,
  sticky,
  kicker,
  chapter = true,
  nav,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 放在全局操作左边的页面级操作 */
  actions?: ReactNode;
  /** 标题下方的内容（搜索框、筛选 chip 行等） */
  children?: ReactNode;
  className?: string;
  sticky?: boolean;
  /** 覆盖自动生成的卷号行 */
  kicker?: ReactNode;
  /** 画册式页头（卷号 + 衬线标题 + 双线）；详情页传 false */
  chapter?: boolean;
  /** 这一页的导航项 id：在「插件」页改了这一页的名字，标题跟着变（title 是原名，docs/plugins.md 9.6） */
  nav?: string;
}) {
  const navTitle = useNavLabel(nav ?? '', typeof title === 'string' ? title : '');
  if (nav) title = navTitle;
  const headRef = useRef<HTMLElement>(null);
  // 手机横屏不吸顶（lib/viewport.ts 的 stickyHeaderFits）
  const viewport = useViewport();
  sticky = !!sticky && stickyHeaderFits(viewport);
  const stuck = useStuck(sticky, headRef);
  const scrollRef = useScrollContainer();
  const { pathname } = useLocation();
  const auto = getChapter(pathname);
  const showChapter = chapter && !stuck.value;

  // 双线只在首次进入时展开；吸顶后再回来直接出现，不重播
  const [fresh, setFresh] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setFresh(false), 1000);
    return () => window.clearTimeout(t);
  }, []);

  // 吸住后页头变矮：在下面垫回差值，文档高度不变
  const [gap, setGap] = useState(0);
  useLayoutEffect(() => {
    setGap(stuck.value && headRef.current ? Math.max(0, stuck.fullH.current - headRef.current.offsetHeight) : 0);
  }, [stuck.value, stuck.fullH]);

  // 页头高度 → 滚动容器上的 --page-head-h，SectionBar 这类二级吸顶条吸在它下面。
  // 用 useEffect：首次挂载时父级 AppShell 滚动容器的 ref 在子组件 layout effect 之后才挂上
  useEffect(() => {
    const el = headRef.current;
    const sc = scrollRef.current;
    if (!sticky || !el || !sc) return;
    const set = () => sc.style.setProperty('--page-head-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      sc.style.removeProperty('--page-head-h');
    };
  }, [sticky, scrollRef]);

  return (
    <>
      {sticky && <div ref={stuck.sentinel} aria-hidden className="h-px" />}
      <header
        ref={headRef}
        className={cn(
          // 窄屏（A1）：左右留白收窄；手机横屏（short）上下也收紧
          'px-8 pb-4 @container/head narrow:px-5 compact:px-4 compact:pb-3',
          stuck.value ? 'pt-3' : chapter ? 'pt-7 compact:pt-4 short:pt-3' : 'pt-6 compact:pt-4 short:pt-3',
          sticky && 'sticky top-0 z-20 bg-sheet paper',
          stuck.value && 'shadow-[0_1px_0_var(--c-line)]',
          className,
        )}
      >
        {/* 标题至少留 14rem；放不下时右边那排按钮换到下一行靠右，不压住标题也不被挤出纸外。
            手机竖屏（A1）：标题和按钮同一行，副标题换到下面整行（见下面 compact 的那份） */}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 compact:gap-x-3">
          {chapter ? (
            <div className="min-w-0 flex-[1_1_14rem] animate-fade-in compact:basis-24">
              {showChapter && (
                <div className="kicker flex items-center short:hidden">
                  {kicker ?? (
                    <>
                      <Emblem size={14} className="mr-2" />
                      <span className="font-semibold text-brand compact:shrink-0">{auto.mark}</span>
                      <span className="ml-3 compact:min-w-0 compact:truncate">{auto.sub}</span>
                    </>
                  )}
                </div>
              )}
              {/* 手机竖屏：标题变小（副标题在下面整行） */}
              <div className={cn('flex min-w-0 items-baseline gap-4', showChapter && 'mt-2.5 short:mt-0')}>
                {/* 手机竖屏上长标题（合集书名）折行，不压到右边的按钮上 */}
                <h1
                  className={cn(
                    'display-title shrink-0 compact:min-w-0 compact:shrink compact:leading-[1.15]',
                    stuck.value ? 'text-[20px]' : 'text-[34px] compact:text-[26px] short:text-[24px]',
                  )}
                >
                  {title}
                </h1>
                {subtitle && !stuck.value && <div className="min-w-0 truncate text-[13px] text-fg-muted tabular compact:hidden">{subtitle}</div>}
              </div>
            </div>
          ) : (
            <div className="min-w-0 flex-[1_1_14rem] animate-fade-in compact:basis-24">
              <h1 className={cn('leading-tight font-semibold tracking-tight compact:text-[19px]', stuck.value ? 'text-[18px]' : 'text-[22px]')}>
                {title}
              </h1>
              {subtitle && !stuck.value && <div className="mt-1 text-[13px] text-fg-muted tabular compact:hidden">{subtitle}</div>}
            </div>
          )}
          {/* 窄屏、手机横屏（A1）：按钮多的页面（未识别）这一排自己折行，不伸出纸外 */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5 @max-[400px]/head:shrink @max-[400px]/head:flex-wrap @max-[400px]/head:justify-end narrow:shrink narrow:flex-wrap narrow:justify-end short:shrink short:flex-wrap short:justify-end">
            {actions}
            <GlobalActions />
          </div>
        </div>
        {/* 手机竖屏的副标题：整行，可以折行，不截断（和上面那份是同一个内容，按宽度只显示一份） */}
        {subtitle && !stuck.value && (
          <div className="mt-1.5 hidden text-[12.5px] leading-snug text-fg-muted tabular compact:block">{subtitle}</div>
        )}
        {showChapter && <div aria-hidden className={cn('rule-double mt-5 compact:mt-4 short:hidden', fresh && 'animate-unroll')} />}
        {children && <div className={stuck.value ? 'mt-3' : 'mt-4 short:mt-3'}>{children}</div>}
      </header>
      {gap > 0 && <div aria-hidden style={{ height: gap }} />}
    </>
  );
}

/**
 * 头部是否已经吸住：哨兵越过滚动容器顶部就算（底部无限延伸，一次滚过去也能判断对，见 OV-B3）。
 * 吸住的那一刻记下展开时的高度（fullH），给垫片用。
 */
function useStuck(enabled: boolean, headRef: RefObject<HTMLElement | null>) {
  const scrollRef = useScrollContainer();
  const sentinel = useRef<HTMLDivElement>(null);
  const fullH = useRef(0);
  const [value, setValue] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!enabled || !el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return;
        if (!e.isIntersecting && headRef.current) fullH.current = headRef.current.offsetHeight;
        setValue(!e.isIntersecting);
      },
      { root: scrollRef.current, rootMargin: '0px 0px 100000px 0px', threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, scrollRef, headRef]);
  return { sentinel, value, fullH };
}

/**
 * 截图右上角那一排：跳到角色（⌘K）、模糊开关、撤销、帮助。
 * 宽度 compact（A1）：跳到角色只剩放大镜（点开是全宽的命令面板），模糊、撤销、帮助收进「…」菜单。
 * 高度 short（手机横屏）：跳到角色也只剩放大镜，页头的操作能和标题排在一行。
 */
export function GlobalActions() {
  const client = useQueryClient();
  const setCommandOpen = useOverlays((s) => s.setCommandOpen);
  const setHelpOpen = useOverlays((s) => s.setHelpOpen);
  const { blurSensitive: blur, blurLevel, blurPhoto, blurText } = useBlurPrefs();
  const what = [blurLevel === 'explicit' ? '限制级图片' : '敏感图片', blurPhoto && '照片', blurText && '文字图'].filter(Boolean).join('、');
  const toggleBlur = usePrefs((s) => s.toggleBlurSensitive);
  const lastUndo = useUndoStore((s) => s.entries[0]);
  const canUndo = useCan('history');
  // 提示里的「3 分钟前」每半分钟走一次
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!lastUndo) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [lastUndo]);

  return (
    <>
      {/* 页头窄时（半屏以下）缩成一个圆按钮，给后面的撤销、帮助让位 */}
      <button
        onClick={() => setCommandOpen(true)}
        aria-label="跳到角色"
        className="group ml-1 flex h-9 w-52 shrink-0 items-center gap-2 rounded-full bg-sunken pr-1.5 pl-3.5 text-[13px] text-fg-subtle transition-colors touch-hit hover:bg-hover hover:text-fg-muted @max-[600px]/head:w-9 @max-[600px]/head:justify-center @max-[600px]/head:px-0 compact:ml-0 compact:w-9 compact:justify-center compact:px-0 short:w-9 short:justify-center short:px-0"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left @max-[600px]/head:hidden compact:hidden short:hidden">跳到角色</span>
        <Kbd className="@max-[600px]/head:hidden short:hidden">{modKeyLabel === '⌘' ? '⌘K' : 'Ctrl K'}</Kbd>
      </button>
      <IconButton label={blur ? `显示${what}` : `模糊${what}`} shortcut="B" active={blur} onClick={toggleBlur} className="compact:hidden">
        {blur ? <EyeOff /> : <Eye />}
      </IconButton>
      {/* 没有「撤销」权限的设备（history）：不放撤销按钮 */}
      {canUndo && (
        <IconButton
          label={lastUndo ? undoTitle(lastUndo) + placeText(lastUndo, now) : '没有可撤销的操作'}
          shortcut={`${modKeyLabel} Z`}
          disabled={!lastUndo}
          onClick={() => void requestUndo(client)}
          className="compact:hidden"
        >
          <UndoNod />
        </IconButton>
      )}
      <IconButton label="快捷键与帮助" shortcut="?" onClick={() => setHelpOpen(true)} className="compact:hidden">
        <CircleHelp />
      </IconButton>
      {/* 只在手机竖屏出现：外面包一层 contents，电脑上整个不占位 */}
      <span className="hidden compact:contents">
        <Menu
          align="end"
          width={220}
          trigger={
            <IconButton label="更多操作" className={cn(blur && 'text-shu-fg')}>
              <Ellipsis />
            </IconButton>
          }
        >
          <MenuItem icon={blur ? <Eye /> : <EyeOff />} onSelect={toggleBlur}>
            {blur ? `显示${what}` : `模糊${what}`}
          </MenuItem>
          {canUndo && (
            <MenuItem icon={<Undo2 />} disabled={!lastUndo} onSelect={() => void requestUndo(client)}>
              <span className="line-clamp-2">{lastUndo ? undoTitle(lastUndo) + placeText(lastUndo, now) : '没有可撤销的操作'}</span>
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<CircleHelp />} onSelect={() => setHelpOpen(true)}>
            帮助
          </MenuItem>
        </Menu>
      </span>
    </>
  );
}

/** 页面主体的标准内边距容器 */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-8 pb-16 narrow:px-5 compact:px-4 compact:pb-10', className)}>{children}</div>;
}

/** 撤销栈变长时撤销图标点一下头（SEL-11） */
function UndoNod() {
  const n = useUndoStore((s) => s.entries.length);
  const prev = useRef(n);
  const [nod, setNod] = useState(0);
  useEffect(() => {
    if (n > prev.current) setNod((k) => k + 1);
    prev.current = n;
  }, [n]);
  return (
    <motion.span key={nod} className="flex" animate={nod ? { rotate: [0, -40, 0] } : undefined} transition={{ duration: 0.46, ease: EASE_OUT }}>
      <Undo2 />
    </motion.span>
  );
}
