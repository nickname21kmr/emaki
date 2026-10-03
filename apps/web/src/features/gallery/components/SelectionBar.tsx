import type { BulkImageAction, ID, ImageItem } from '@emaki/shared';
import { Ban, ChevronDown, FolderInput, Heart, Shapes, ShieldHalf, Trash2, UserRoundPlus, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { Menu, MenuItem, MenuLabel, RollingNumber, Spinner, Tooltip } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount, RATING_LABEL } from '@/lib/format';
import { modKeyLabel, useHotkey } from '@/lib/hotkeys';
import { useMutate, useTrashHint } from '@/lib/queries';
import { useLightbox, useSelection } from '@/lib/stores';
import { KindMenu } from '@/components/media/KindMenu';
import { MoveImagesDialog } from '@/components/media/MoveImagesDialog';
import { CharacterPicker } from '../CharacterPicker';
import { RATINGS } from '../useGalleryParams';
import { EASE_OUT } from '@/lib/motion';

const EMPTY: ReadonlySet<ID> = new Set();

/** 这些操作之后图片会离开当前视图（或已经整理完），顺手清空选择 */
const CLEARS_SELECTION: BulkImageAction['type'][] = ['assign', 'exclude', 'trash', 'kind'];

/** sonner 默认 4 秒，多留一点余量等它退场 */
const TOAST_MS = 4400;

/**
 * 多选后底部浮起的墨色胶囊工具栏。
 * 用 sticky 贴在滚动区底部（而不是 fixed 贴窗口），这样它永远居中在「纸」上，不受侧边栏宽度影响。
 *
 * 快捷键：Esc 取消选择 · Ctrl+A 全选已加载 · E 排除 · F 收藏 · C 归入…（改类型，再按 1–7）
 */
export function SelectionBar({ images, scope }: { images: ImageItem[]; scope: string }) {
  const ids = useSelection((s) => (s.scope === scope ? s.ids : EMPTY));
  const trashHint = useTrashHint();
  const setMany = useSelection((s) => s.setMany);
  const clear = useSelection((s) => s.clear);
  const lightboxOpen = useLightbox((s) => s.open);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [kindOpen, setKindOpen] = useState(false);
  const [moving, setMoving] = useState(false);

  const count = ids.size;
  const active = count > 0 && !lightboxOpen && !moving;

  // 收藏 / 分级之后选择还在，而结果 toast 也弹在底部居中 —— 工具栏临时抬高，给 toast 让位
  const [lifted, setLifted] = useState(false);
  const liftTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(liftTimer.current), []);
  const liftForToast = () => {
    setLifted(true);
    window.clearTimeout(liftTimer.current);
    liftTimer.current = window.setTimeout(() => setLifted(false), TOAST_MS);
  };

  const bulk = useMutate((v: { ids: ID[]; action: BulkImageAction }) => api.bulkImages(v), {
    onSuccess: (_, v) => {
      if (CLEARS_SELECTION.includes(v.action.type)) clear();
      else liftForToast();
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
  useHotkey('mod+a', selectAll, { enabled: !lightboxOpen && images.length > 0 });
  useHotkey('e', () => run({ type: 'exclude' }), { enabled: active && !pickerOpen && !kindOpen });
  useHotkey('c', () => setKindOpen(true), { enabled: active && !pickerOpen });
  useHotkey('f', () => run({ type: 'favorite', value: !allFavorite }), { enabled: active && !pickerOpen });

  const pendingType = bulk.isPending ? bulk.variables?.action.type : undefined;

  return (
    <div className="pointer-events-none sticky bottom-6 z-30 flex h-0 justify-center">
      <AnimatePresence>
        {count > 0 && (
          <motion.div
            role="toolbar"
            aria-label="批量操作"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: lifted ? -64 : 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97, transition: { duration: 0.18 } }}
            transition={{ duration: 0.42, ease: EASE_OUT }}
            className="pointer-events-auto absolute bottom-0 left-1/2 flex h-[52px] w-max -translate-x-1/2 items-center gap-0.5 rounded-full bg-ink pr-2 pl-1.5 text-fg-inverse shadow-pop"
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
              <span className="text-[13px] text-fg-inverse/70">已选</span>
              <RollingNumber value={count} appear={false} className="numeral text-[24px] leading-none tabular" />
              <span className="text-[13px] text-fg-inverse/70">张</span>
            </div>

            {!allLoadedSelected && (
              <Tooltip content={`全选已加载的 ${formatCount(images.length)} 张`} shortcut={`${modKeyLabel} A`} side="top">
                <button
                  type="button"
                  onClick={selectAll}
                  className="mr-1 h-7 rounded-full px-2.5 text-xs text-fg-inverse/70 ring-1 ring-fg-inverse/20 transition-colors hover:bg-fg-inverse/10 hover:text-fg-inverse"
                >
                  全选
                </button>
              </Tooltip>
            )}

            <span className="mx-1.5 h-5 w-px bg-fg-inverse/15" />

            <CharacterPicker
              side="top"
              align="center"
              title="归到角色"
              meta={`${formatCount(count)} 张`}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              onPick={(c) => run({ type: 'assign', characterId: c.id })}
            >
              <BarButton icon={<UserRoundPlus />} pending={pendingType === 'assign'} aria-haspopup="dialog">
                归到角色…
              </BarButton>
            </CharacterPicker>

            <Tooltip content={allFavorite ? '取消收藏' : '收藏'} shortcut="F" side="top">
              <BarButton
                icon={<Heart className={cn(allFavorite && 'fill-current')} />}
                pending={pendingType === 'favorite'}
                onClick={() => run({ type: 'favorite', value: !allFavorite })}
              >
                {allFavorite ? '取消收藏' : '收藏'}
              </BarButton>
            </Tooltip>

            <Menu
              align="center"
              width={168}
              trigger={
                <BarButton icon={<ShieldHalf />} pending={pendingType === 'rating'} trailing={<ChevronDown />}>
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
                <BarButton icon={<Shapes />} pending={pendingType === 'kind'} trailing={<ChevronDown />}>
                  归入
                </BarButton>
              }
            />

            <Tooltip content="移到图库里的某个文件夹，磁盘上的文件会真的移动" side="top">
              <BarButton icon={<FolderInput />} onClick={() => setMoving(true)}>
                移动…
              </BarButton>
            </Tooltip>

            <span className="mx-1.5 h-5 w-px bg-fg-inverse/15" />

            <Tooltip content="排除：不再出现在图库和统计里，文件不会被删除" shortcut="E" side="top">
              <BarButton icon={<Ban />} pending={pendingType === 'exclude'} onClick={() => run({ type: 'exclude' })}>
                排除
              </BarButton>
            </Tooltip>

            <Tooltip content={trashHint} side="top">
              <BarButton
                icon={<Trash2 />}
                pending={pendingType === 'trash'}
                onClick={() => run({ type: 'trash' })}
                className="hover:bg-danger hover:text-white"
              >
                回收站
              </BarButton>
            </Tooltip>
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
      {children}
      {trailing && <span className="-mr-1 opacity-50 [&_svg]:size-3.5">{trailing}</span>}
    </button>
  );
});
