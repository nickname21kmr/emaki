import { CONTENT_KINDS, type BulkImageAction, type ID, type ImageItem } from '@emaki/shared';
import { Ban, ChevronDown, CircleMinus, Ellipsis, FolderInput, Heart, Palette, Shapes, ShieldHalf, Trash2, UserRoundPlus, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useSonner } from 'sonner';
import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuSub, RollingNumber, Spinner, Tooltip } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount, RATING_LABEL } from '@/lib/format';
import { KIND_ICON, KIND_LABEL } from '@/lib/kinds';
import { modKeyLabel, useHotkey } from '@/lib/hotkeys';
import { TRASH_HINT, useMutate } from '@/lib/queries';
import { useLightbox, useOverlays, useSelection } from '@/lib/stores';
import { KindMenu } from '@/components/media/KindMenu';
import { MoveImagesDialog } from '@/components/media/MoveImagesDialog';
import { ArtistPicker } from '../ArtistPicker';
import { CharacterPicker } from '../CharacterPicker';
import { RATINGS } from '../useGalleryParams';
import { EASE_OUT } from '@/lib/motion';

const EMPTY: ReadonlySet<ID> = new Set();

/** 这些操作之后图片会离开当前视图（或已经整理完），顺手清空选择 */
const CLEARS_SELECTION: BulkImageAction['type'][] = ['assign', 'exclude', 'trash', 'kind', 'artist', 'artist-auto'];

/**
 * 多选后底部浮起的墨色胶囊工具栏。
 * 用 sticky 贴在滚动区底部（而不是 fixed 贴窗口），这样它永远居中在「纸」上，不受侧边栏宽度影响。
 *
 * 快捷键：Esc 取消选择 · Ctrl+A 全选已加载 · E 排除 · F 收藏 · C 归入…（改类型，再按 1–7）
 * 按画师看时（artist）多一个「移出画师」：认错了的图从这位画师里拿掉。
 */
export function SelectionBar({
  images,
  scope,
  artist,
}: {
  images: ImageItem[];
  scope: string;
  artist?: { tag: string; name: string; tags: string[] };
}) {
  const ids = useSelection((s) => (s.scope === scope ? s.ids : EMPTY));
  const setMany = useSelection((s) => s.setMany);
  const clear = useSelection((s) => s.clear);
  const lightboxOpen = useLightbox((s) => s.open);
  const [charOpen, setCharOpen] = useState(false);
  const [artistOpen, setArtistOpen] = useState(false);
  const pickerOpen = charOpen || artistOpen;
  const [kindOpen, setKindOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  // 露出的纸窄于 400（助手覆盖在纸上）时，全选、画师、移出画师、收藏也收进「更多」；窄于 190 时连归到角色也收进去
  // 菜单在 portal 里用不了容器查询：打开「更多」时量一下外层，和 @max-[400px]/bar、@max-[190px]/bar 对上
  const shell = useRef<HTMLDivElement>(null);
  const [shellWidth, setShellWidth] = useState(Infinity);
  const narrow = shellWidth < 400, tiny = shellWidth < 190;
  // 「更多」里点了画师：等菜单关掉、不还焦点，再打开选择器，免得选择器一开就因为焦点跑走而关掉
  const afterMenu = useRef<(() => void) | null>(null);

  const count = ids.size;
  const active = count > 0 && !lightboxOpen && !moving;

  // toast 也弹在底部居中 —— 不管是谁弹的（这里的收藏、助手的撤销…），有 toast 时工具栏就抬高给它让位
  const lifted = useSonner().toasts.length > 0;
  // 助手胶囊在工具栏右端上方，抬高时告诉它一起让
  const barUp = lifted && count > 0;
  useEffect(() => {
    useOverlays.getState().setBarLifted(barUp);
    return () => useOverlays.getState().setBarLifted(false);
  }, [barUp]);

  const bulk = useMutate((v: { ids: ID[]; action: BulkImageAction }) => api.bulkImages(v), {
    onSuccess: (_, v) => {
      if (CLEARS_SELECTION.includes(v.action.type)) clear();
    },
  });
  const run = (action: BulkImageAction) => {
    if (!count || bulk.isPending) return;
    bulk.mutate({ ids: [...ids], action });
  };

  // 选中的里面（已加载的部分）全是收藏 → 按钮变「取消收藏」
  const allFavorite = useMemo(() => {
    if (!count) return false;
    let seen = 0;
    for (const img of images) {
      if (!ids.has(img.id)) continue;
      if (!img.favorite) return false;
      seen++;
    }
    return seen > 0;
  }, [images, ids, count]);

  const allLoadedSelected = images.length > 0 && images.every((img) => ids.has(img.id));
  const selectAll = () => setMany(images.map((i) => i.id));

  useHotkey(
    'esc',
    (e) => {
      // 弹出框 / 菜单 / 看图器先吃掉 Esc（它们会 preventDefault），这里只处理「空闲」时的 Esc
      if (e.defaultPrevented || pickerOpen) return;
      e.preventDefault();
      clear();
    },
    { enabled: active, preventDefault: false },
  );
  // 页面上别的对话框、菜单开着时（比如画师的拆开 / 合并）不响应，免得按 E 把选中的图排除了
  const fromOverlay = (e: KeyboardEvent) => e.target instanceof Element && !!e.target.closest('[role="dialog"],[role="menu"],[data-assistant-sheet]');
  useHotkey(
    'mod+a',
    (e) => {
      if (fromOverlay(e)) return;
      e.preventDefault();
      selectAll();
    },
    // 按住时也要每次拦下浏览器的全选
    { enabled: !lightboxOpen && images.length > 0, preventDefault: false, repeat: true },
  );
  useHotkey('e', (e) => !fromOverlay(e) && run({ type: 'exclude' }), { enabled: active && !pickerOpen && !kindOpen });
  useHotkey('c', (e) => !fromOverlay(e) && setKindOpen(true), { enabled: active && !pickerOpen });
  useHotkey('f', (e) => !fromOverlay(e) && run({ type: 'favorite', value: !allFavorite }), { enabled: active && !pickerOpen });

  const pendingType = bulk.isPending ? bulk.variables?.action.type : undefined;

  return (
    // assistant-cover-shift：助手附页覆盖在纸上时，在露出的那块里居中（index.css）
    <div ref={shell} className="assistant-cover-shift pointer-events-none sticky bottom-6 z-30 flex h-0 justify-center @container/bar">
      <AnimatePresence>
        {count > 0 && (
          <motion.div
            role="toolbar"
            aria-label="批量操作"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: lifted ? -64 : 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97, transition: { duration: 0.18 } }}
            transition={{ duration: 0.42, ease: EASE_OUT }}
            // 纸窄（半屏窗口）时按钮只留图标；再窄就在胶囊里横向滚动，两头的按钮都够得着
            className="pointer-events-auto absolute bottom-0 left-1/2 flex h-[52px] w-max max-w-[calc(100%-24px)] @max-[190px]/bar:max-w-[calc(100%-8px)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-full bg-ink pr-2 pl-1.5 text-fg-inverse shadow-pop scrollbar-none *:shrink-0"
          >
            <Tooltip content="取消选择" shortcut="Esc" side="top">
              <button
                type="button"
                aria-label="取消选择"
                onClick={clear}
                className="flex size-9 items-center justify-center rounded-full text-fg-inverse/70 transition-colors hover:bg-fg-inverse/10 hover:text-fg-inverse"
              >
                <X className="size-4" />
              </button>
            </Tooltip>

            <div className="flex items-baseline gap-1.5 pr-2 pl-1 whitespace-nowrap">
              <span className="text-[13px] text-fg-inverse/70 @max-[480px]/bar:hidden">已选</span>
              <RollingNumber value={count} appear={false} className="numeral text-[24px] leading-none tabular" />
              <span className="text-[13px] text-fg-inverse/70 @max-[480px]/bar:hidden">张</span>
            </div>

            {!allLoadedSelected && (
              <Tooltip content={`全选已加载的 ${formatCount(images.length)} 张`} shortcut={`${modKeyLabel} A`} side="top">
                <button
                  type="button"
                  onClick={selectAll}
                  className="mr-1 h-7 rounded-full px-2.5 text-xs text-fg-inverse/70 ring-1 ring-fg-inverse/20 transition-colors hover:bg-fg-inverse/10 hover:text-fg-inverse @max-[400px]/bar:hidden"
                >
                  全选
                </button>
              </Tooltip>
            )}

            <span className="mx-1.5 h-5 w-px bg-fg-inverse/15 @max-[400px]/bar:mx-0.5 @max-[190px]/bar:hidden" />

            <CharacterPicker
              side="top"
              align="center"
              title="归到角色"
              meta={`${formatCount(count)} 张`}
              open={charOpen}
              onOpenChange={setCharOpen}
              onPick={(c) => run({ type: 'assign', characterId: c.id })}
            >
              {/* 露出的纸窄于 190 时也收进「更多」，sr-only 留着当锚点 */}
              <BarButton icon={<UserRoundPlus />} pending={pendingType === 'assign'} aria-haspopup="dialog" className="@max-[190px]/bar:sr-only">
                归到角色…
              </BarButton>
            </CharacterPicker>

            <ArtistPicker
              side="top"
              align="center"
              title="改画师"
              meta={`${formatCount(count)} 张`}
              open={artistOpen}
              onOpenChange={setArtistOpen}
              onPick={(tag) => run({ type: 'artist', mode: 'set', artists: [tag] })}
              actions={[
                { key: 'none', label: '没有画师 / 不知道是谁', hint: '去掉认出的画师，以后也不再自动认', onSelect: () => run({ type: 'artist', mode: 'set', artists: [] }) },
                { key: 'auto', label: '改回自动识别', hint: '清掉手动改的，交给「识别画师」重新认', onSelect: () => run({ type: 'artist-auto' }) },
              ]}
            >
              {/* 很窄时收进「更多」；sr-only 留着当选择器的锚点 */}
              <BarButton icon={<Palette />} pending={pendingType === 'artist' || pendingType === 'artist-auto'} aria-haspopup="dialog" className="@max-[400px]/bar:sr-only">
                画师…
              </BarButton>
            </ArtistPicker>

            {artist && (
              <Tooltip content={`这几张不是「${artist.name}」画的：去掉这位画师，以后识别也不再动它们`} side="top">
                <BarButton icon={<CircleMinus />} onClick={() => run({ type: 'artist', mode: 'remove', artists: artist.tags })} className="@max-[400px]/bar:hidden">
                  移出画师
                </BarButton>
              </Tooltip>
            )}

            <Tooltip content={allFavorite ? '取消收藏' : '收藏'} shortcut="F" side="top">
              <BarButton
                icon={<Heart className={cn(allFavorite && 'fill-current')} />}
                pending={pendingType === 'favorite'}
                onClick={() => run({ type: 'favorite', value: !allFavorite })}
                className="@max-[400px]/bar:hidden"
              >
                {allFavorite ? '取消收藏' : '收藏'}
              </BarButton>
            </Tooltip>

            <Menu
              align="center"
              width={168}
              trigger={
                <BarButton icon={<ShieldHalf />} pending={pendingType === 'rating'} trailing={<ChevronDown />} className="@max-[600px]/bar:hidden">
                  分级
                </BarButton>
              }
            >
              <MenuLabel>把 {formatCount(count)} 张设为</MenuLabel>
              {RATINGS.map((r, i) => (
                <MenuItem key={r} icon={<RatingPips level={i} />} onSelect={() => run({ type: 'rating', value: r })}>
                  {RATING_LABEL[r]}
                </MenuItem>
              ))}
            </Menu>

            <KindMenu
              label={`把 ${formatCount(count)} 张归入`}
              open={kindOpen}
              onOpenChange={setKindOpen}
              onSelect={(value) => run({ type: 'kind', value })}
              trigger={
                // 窄时收进「更多」；用 sr-only 而不是 hidden，按 C 打开时菜单还能贴着胶囊弹出
                <BarButton icon={<Shapes />} pending={pendingType === 'kind'} trailing={<ChevronDown />} className="@max-[600px]/bar:sr-only">
                  归入
                </BarButton>
              }
            />

            {/* 露出的纸窄于 600（助手覆盖在纸上、半屏窗口）时，分级、归入和最后三个收进「更多」，不在胶囊里藏着滚 */}
            <Tooltip content="移到图库里的某个文件夹，磁盘上的文件会真的移动" side="top">
              <BarButton icon={<FolderInput />} onClick={() => setMoving(true)} className="@max-[600px]/bar:hidden">
                移动…
              </BarButton>
            </Tooltip>

            <span className="mx-1.5 h-5 w-px bg-fg-inverse/15 @max-[600px]/bar:hidden" />

            <Tooltip content="排除：不再出现在图库和统计里，文件不会被删除" shortcut="E" side="top">
              <BarButton icon={<Ban />} pending={pendingType === 'exclude'} onClick={() => run({ type: 'exclude' })} className="@max-[600px]/bar:hidden">
                排除
              </BarButton>
            </Tooltip>

            <Tooltip content={TRASH_HINT} side="top">
              <BarButton
                icon={<Trash2 />}
                pending={pendingType === 'trash'}
                onClick={() => run({ type: 'trash' })}
                className="hover:bg-danger hover:text-white @max-[600px]/bar:hidden"
              >
                回收站
              </BarButton>
            </Tooltip>

            <Menu
              align="end"
              width={168}
              onOpenChange={(open) => open && setShellWidth(shell.current?.getBoundingClientRect().width ?? Infinity)}
              onCloseAutoFocus={(e) => {
                const next = afterMenu.current;
                if (!next) return;
                afterMenu.current = null;
                e.preventDefault();
                next();
              }}
              trigger={
                <BarButton
                  icon={<Ellipsis />}
                  pending={pendingType === 'exclude' || pendingType === 'trash' || pendingType === 'rating' || pendingType === 'kind'}
                  className="@min-[600px]/bar:hidden"
                >
                  更多
                </BarButton>
              }
            >
              {narrow && (
                <>
                  {!allLoadedSelected && <MenuItem shortcut={`${modKeyLabel} A`} onSelect={selectAll}>全选已加载的 {formatCount(images.length)} 张</MenuItem>}
                  {tiny && <MenuItem icon={<UserRoundPlus />} onSelect={() => { afterMenu.current = () => setCharOpen(true); }}>归到角色…</MenuItem>}
                  <MenuItem icon={<Palette />} onSelect={() => { afterMenu.current = () => setArtistOpen(true); }}>画师…</MenuItem>
                  {artist && <MenuItem icon={<CircleMinus />} onSelect={() => run({ type: 'artist', mode: 'remove', artists: artist.tags })}>移出画师</MenuItem>}
                  <MenuItem icon={<Heart className={cn(allFavorite && 'fill-current')} />} shortcut="F" onSelect={() => run({ type: 'favorite', value: !allFavorite })}>
                    {allFavorite ? '取消收藏' : '收藏'}
                  </MenuItem>
                  <MenuSeparator />
                </>
              )}
              <MenuSub icon={<ShieldHalf />} label="分级">
                <MenuLabel>把 {formatCount(count)} 张设为</MenuLabel>
                {RATINGS.map((r, i) => (
                  <MenuItem key={r} icon={<RatingPips level={i} />} onSelect={() => run({ type: 'rating', value: r })}>
                    {RATING_LABEL[r]}
                  </MenuItem>
                ))}
              </MenuSub>
              <MenuSub icon={<Shapes />} label="归入">
                <MenuLabel>把 {formatCount(count)} 张归入</MenuLabel>
                {CONTENT_KINDS.map((k) => {
                  const Icon = KIND_ICON[k];
                  return (
                    <MenuItem key={k} icon={<Icon />} onSelect={() => run({ type: 'kind', value: k })}>
                      {KIND_LABEL[k]}
                    </MenuItem>
                  );
                })}
                <MenuSeparator />
                <MenuItem onSelect={() => run({ type: 'kind', value: 'auto' })}>恢复自动判断</MenuItem>
              </MenuSub>
              <MenuSeparator />
              <MenuItem icon={<FolderInput />} onSelect={() => setMoving(true)}>移动…</MenuItem>
              <MenuItem icon={<Ban />} shortcut="E" onSelect={() => run({ type: 'exclude' })}>排除</MenuItem>
              <MenuItem icon={<Trash2 />} danger onSelect={() => run({ type: 'trash' })}>回收站</MenuItem>
            </Menu>
          </motion.div>
        )}
      </AnimatePresence>
      <MoveImagesDialog open={moving} onOpenChange={setMoving} target={{ ids: [...ids] }} count={count} what="选中的" onMoved={clear} />
    </div>
  );
}

/** 分级的小刻度：0~3 格实心，比图标更直观地表达「程度」 */
export function RatingPips({ level, className }: { level: number; className?: string }) {
  return (
    <span aria-hidden className={cn('flex w-4 shrink-0 items-end gap-[2px]', className)}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn('w-[3px] rounded-full', i < level ? 'bg-fg-muted' : 'bg-line-strong')}
          style={{ height: 5 + i * 3 }}
        />
      ))}
    </span>
  );
}

interface BarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  trailing?: ReactNode;
  pending?: boolean;
}

/** 墨色胶囊里的按钮：反色文字，悬停一层淡淡的反色底 */
const BarButton = forwardRef<HTMLButtonElement, BarButtonProps>(function BarButton(
  { icon, trailing, pending, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap text-fg-inverse/85',
        'transition-[background-color,color,transform] duration-150 hover:bg-fg-inverse/10 hover:text-fg-inverse active:scale-[0.96]',
        'data-[state=open]:bg-fg-inverse/10 data-[state=open]:text-fg-inverse [&_svg]:size-4',
        className,
      )}
      {...rest}
    >
      {pending ? <Spinner className="size-4" /> : icon}
      {/* 纸窄于 960px 时文字只给读屏（带文字的整条要 930 上下） */}
      <span className="@max-[960px]/bar:sr-only">{children}</span>
      {trailing && <span className="-mr-1 opacity-50 [&_svg]:size-3.5">{trailing}</span>}
    </button>
  );
});
