import { CollapseGroupsMenu } from '@/components/media/CollectionControls';
import { BROWSE_THEMES, type CustomTheme } from '@emaki/shared';
import { THEME_META } from '@/features/unrecognized/themes';
import {
  ArrowDownAZ,
  ArrowDownUp,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  CalendarPlus,
  FilePenLine,
  HardDrive,
  Heart,
  Image as ImageIcon,
  Pencil,
  Play,
  Plus,
  Shuffle,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  Button,
  Chip,
  IconButton,
  Menu,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  Sheet,
  Slider,
  Tooltip,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { themeItems, themeSentence } from '@/lib/customTheme';
import { RATING_LABEL } from '@/lib/format';
import { usePrefs } from '@/lib/stores';
import {
  ORIENTATIONS,
  RATINGS,
  SORTS,
  type GalleryFilters,
  type GallerySort,
  type Orientation,
  type SortOrder,
} from '../useGalleryParams';
import { CustomThemeDialog } from './CustomThemeDialog';
import { GallerySearch } from './GallerySearch';

/** 合集页序 'page' 不出现在图库的排序菜单里（RV-C-7） */
export const SORT_LABEL: Record<GallerySort, string> = {
  addedAt: '最近添加',
  modifiedAt: '修改时间',
  fileName: '文件名',
  bytes: '体积',
  random: '随机',
};

const SORT_ICON: Record<GallerySort, ReactNode> = {
  addedAt: <CalendarPlus />,
  modifiedAt: <FilePenLine />,
  fileName: <ArrowDownAZ />,
  bytes: <HardDrive />,
  random: <Shuffle />,
};

const ORIENT_LABEL: Record<Orientation, string> = { portrait: '竖', landscape: '横', square: '方' };

/** 升降序的说法随排序变：时间说「新 / 旧」，体积说「大 / 小」 */
function orderLabel(sort: GallerySort, order: SortOrder): string {
  switch (sort) {
    case 'fileName':
      return order === 'asc' ? 'A → Z' : 'Z → A';
    case 'bytes':
      return order === 'desc' ? '从大到小' : '从小到大';
    case 'random':
      return '随机排序没有方向';
    default:
      return order === 'desc' ? '最新的在前' : '最早的在前';
  }
}

/**
 * 头部下方的工具条：左搜索 / 右筛选 chip。
 * 高度固定一行（chip 多了横向滚动），这样网格的位置不会因为筛选而跳动。
 * 收藏、排序、缩放不在这一行，在上面目次那一行的右端（GalleryViewControls），这一行整行留给筛选。
 * 宽度 compact（手机竖屏，A1）：搜索框占满一行，chip 收进「筛选」按钮打开的底部面板（sheetTop 放在面板最上面，图库给收藏和排序）。
 */
export function GalleryToolbar({
  filters,
  update,
  hasFilters,
  onClearFilters,
  customThemes,
  animatedChip = true,
  sheetTop,
}: {
  filters: GalleryFilters;
  update: (patch: Partial<GalleryFilters>) => void;
  hasFilters: boolean;
  onClearFilters: () => void;
  /** 用户自己加的画面（设置里的 browse.customThemes） */
  customThemes: CustomTheme[];
  /** 显示「动图」chip（别册的动图页本身就是这个筛选，不显示） */
  animatedChip?: boolean;
  /** 手机上筛选面板最上面的一段（图库：收藏、排序、收拢组图） */
  sheetTop?: ReactNode;
}) {
  const toggleRating = (r: GalleryFilters['rating'][number]) =>
    update({ rating: filters.rating.includes(r) ? filters.rating.filter((x) => x !== r) : [...filters.rating, r] });
  // 自定义画面的对话框：null = 关着；theme 为空 = 新建
  const [editing, setEditing] = useState<{ theme?: CustomTheme } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // 手机上「筛选」按钮旁边的数：开着几个筛选
  const active =
    filters.rating.length + (filters.orientation ? 1 : 0) + (filters.animated ? 1 : 0) + (filters.theme ? 1 : 0) + (filters.custom ? 1 : 0);

  const ratingChips = RATINGS.map((r) => (
    <Chip key={r} size="sm" selected={filters.rating.includes(r)} onClick={() => toggleRating(r)}>
      {RATING_LABEL[r]}
    </Chip>
  ));
  const orientChips = ORIENTATIONS.map((o) => (
    <Chip key={o} size="sm" selected={filters.orientation === o} onClick={() => update({ orientation: filters.orientation === o ? undefined : o })}>
      <span className="inline-flex items-center gap-1.5">
        <OrientGlyph orientation={o} />
        {ORIENT_LABEL[o]}
      </span>
    </Chip>
  ));
  const animatedChipEl = (
    // 是否动图（D5）：不是类型，是在当前类型里再筛一层
    <Tooltip content="只看动图：按帧数自动认出，和类型无关">
      <Chip size="sm" selected={filters.animated} onClick={() => update({ animated: !filters.animated })}>
        <span className="inline-flex items-center gap-1.5">
          <Play className="size-2.5 fill-current" strokeWidth={0} aria-hidden />
          动图
        </span>
      </Chip>
    </Tooltip>
  );
  const themeChips = (
    <>
      {BROWSE_THEMES.map((t) => (
        <Chip key={t} size="sm" selected={filters.theme === t} onClick={() => update({ theme: filters.theme === t ? undefined : t })}>
          {THEME_META[t].label}
        </Chip>
      ))}
      {customThemes.map((t) => (
        <CustomChip
          key={t.id}
          theme={t}
          selected={filters.custom === t.id}
          onClick={() => update({ custom: filters.custom === t.id ? undefined : t.id })}
          onEdit={() => setEditing({ theme: t })}
        />
      ))}
    </>
  );
  const newThemeChip = (
    <Tooltip content="用识别标签自己组一个">
      <Chip size="sm" aria-label="新建画面" className="px-2 text-fg-muted" onClick={() => setEditing({})}>
        <Plus className="size-3.5" />
      </Chip>
    </Tooltip>
  );

  return (
    <div className="@container/toolbar">
      <div className="flex items-center gap-x-3">
        <CustomThemeDialog
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          theme={editing?.theme}
          onSaved={(t) => {
            if (!editing?.theme) update({ custom: t.id });
          }}
          onDeleted={(id) => {
            if (filters.custom === id) update({ custom: undefined });
          }}
        />
        <GallerySearch
          value={filters.q}
          onCommit={(q) => update({ q })}
          className="w-[248px] shrink-0 @max-[600px]/toolbar:w-[168px] compact:min-w-0 compact:flex-1"
        />

        {/* 手机竖屏：「筛选」按钮，chip 都在底部面板里 */}
        <span className="hidden compact:contents">
          <Button
            variant={active ? 'primary' : 'outline'}
            size="md"
            icon={<SlidersHorizontal />}
            onClick={() => setSheetOpen(true)}
            aria-haspopup="dialog"
            className="rounded-full"
          >
            筛选{active > 0 && <span className="tabular opacity-70">{active}</span>}
          </Button>
          <Sheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            title="筛选"
            actions={
              hasFilters && (
                <Button variant="ghost" size="sm" icon={<X />} onClick={onClearFilters}>
                  清除筛选
                </Button>
              )
            }
          >
            <div className="flex flex-col gap-5 pt-1">
              {sheetTop}
              <SheetGroup label="分级">{ratingChips}</SheetGroup>
              <SheetGroup label="方向">
                {orientChips}
                {animatedChip && animatedChipEl}
              </SheetGroup>
              <SheetGroup label="画面">
                {themeChips}
                {newThemeChip}
              </SheetGroup>
            </div>
          </Sheet>
        </span>

        {/* 筛选 chip：放不下时横向滚动，左右渐隐。「+」和「清除筛选」跟在 chip 后面，但不在滚动区里，放不下时停在右端不会被挤走 */}
        <div className="-ml-3 flex min-w-0 flex-1 items-center compact:hidden">
          <div className="min-w-0 overflow-x-auto scrollbar-none fade-x">
            <div className="flex w-max items-center gap-1.5 py-1 pr-8 pl-4">
              <GroupLabel>分级</GroupLabel>
              {ratingChips}

              <Divider />
              <GroupLabel>方向</GroupLabel>
              {orientChips}

              {animatedChip && (
                <>
                  <Divider />
                  {animatedChipEl}
                </>
              )}

              <Divider />
              <GroupLabel>画面</GroupLabel>
              {themeChips}
            </div>
          </div>
          {/* 往回压进滚动区右边留给渐隐的空白里，没溢出时紧跟在最后一个 chip 后面 */}
          <div className="-ml-6 flex shrink-0 items-center gap-1.5">
            {newThemeChip}
            {hasFilters && (
              <button
                type="button"
                onClick={onClearFilters}
                className="ml-1 inline-flex h-7 shrink-0 animate-fade-in items-center gap-1 rounded-full px-2 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
              >
                <X className="size-3" />
                清除筛选
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 收藏、排序、缩放：放在目次（全部 · 插画 · 别册…）那一行的右端，不会滚走。
 * 筛选 chip 那一行会横向滚动，常用的开关放在那里容易被挤到看不见的地方。
 * 这一行放不下时按顺序让地方（看的是这一行的宽度，容器名 kindbar）：
 * 窄于 1420 收藏、排序只留图标 → 窄于 1300 缩放滑块变短、目次不显示张数 → 窄于 940 目次每项收窄（后两步见 KindIndex）。
 */
export function GalleryViewControls({
  filters,
  update,
  collapsed,
  layout = 'bar',
}: {
  filters: GalleryFilters;
  update: (patch: Partial<GalleryFilters>) => void;
  /** 当前列表收拢着组图（接口返回的 collapsed） */
  collapsed?: boolean;
  /** bar：目次那一行的右端；sheet：手机上筛选面板的最上面（A1），排成两组 chip，没有缩放（行高按窗口定） */
  layout?: 'bar' | 'sheet';
}) {
  if (layout === 'sheet')
    return (
      <>
        <SheetGroup label="排序">
          {SORTS.map((s) => (
            <Chip key={s} size="sm" selected={filters.sort === s} onClick={() => update({ sort: s })}>
              {SORT_LABEL[s]}
            </Chip>
          ))}
          <Chip
            size="sm"
            disabled={filters.sort === 'random'}
            onClick={() => update({ order: filters.order === 'desc' ? 'asc' : 'desc' })}
            className="disabled:opacity-40"
          >
            <span className="inline-flex items-center gap-1 [&_svg]:size-3.5">
              {filters.order === 'desc' ? <ArrowDownWideNarrow /> : <ArrowUpNarrowWide />}
              {orderLabel(filters.sort, filters.order)}
            </span>
          </Chip>
        </SheetGroup>
        <SheetGroup label="显示">
          <Chip size="sm" selected={filters.favorite} onClick={() => update({ favorite: !filters.favorite })}>
            <span className="inline-flex items-center gap-1.5">
              <Heart className={cn('size-3.5', filters.favorite && 'fill-current')} />
              只看收藏
            </span>
          </Chip>
          <CollapseGroupsMenu collapsed={collapsed} />
        </SheetGroup>
      </>
    );
  return (
    <div className="flex items-center gap-0.5">
      {/* 只看收藏：常用的开关，开着时整个按钮变朱色，一眼看得出现在只显示收藏 */}
      <Tooltip content={filters.favorite ? '正在只看收藏，点一下看全部' : '只看收藏的图'}>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={filters.favorite}
          aria-label="只看收藏"
          icon={<Heart className={cn(filters.favorite && 'fill-current')} />}
          onClick={() => update({ favorite: !filters.favorite })}
          className={cn(
            'text-[12.5px] @max-[1420px]/kindbar:gap-0 @max-[1420px]/kindbar:px-2',
            filters.favorite && 'bg-shu-soft text-shu-fg hover:bg-shu-soft hover:text-shu-fg',
          )}
        >
          <span className="@max-[1420px]/kindbar:hidden">收藏</span>
        </Button>
      </Tooltip>
      <div className="mx-1.5 h-4 w-px shrink-0 bg-line-strong" />

      <Menu
        width={188}
        trigger={
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowDownUp className="size-3.5" />}
            aria-label={`排序：${SORT_LABEL[filters.sort]}`}
            title={`排序：${SORT_LABEL[filters.sort]}`}
            className="text-[12.5px] @max-[1420px]/kindbar:gap-0 @max-[1420px]/kindbar:px-2"
          >
            <span className="@max-[1420px]/kindbar:hidden">{SORT_LABEL[filters.sort]}</span>
          </Button>
        }
      >
        <MenuLabel>排序方式</MenuLabel>
        <MenuRadioGroup value={filters.sort} onValueChange={(sort) => update({ sort })}>
          {SORTS.map((s) => (
            <MenuRadioItem key={s} value={s} icon={SORT_ICON[s]}>
              {SORT_LABEL[s]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Menu>

      <IconButton
        size="sm"
        label={orderLabel(filters.sort, filters.order)}
        disabled={filters.sort === 'random'}
        onClick={() => update({ order: filters.order === 'desc' ? 'asc' : 'desc' })}
      >
        {filters.order === 'desc' ? <ArrowDownWideNarrow /> : <ArrowUpNarrowWide />}
      </IconButton>
      <CollapseGroupsMenu collapsed={collapsed} />

      {/* 窄屏的行高按窗口定（lib/viewport.ts），不放缩放滑块 */}
      <div className="mx-2.5 h-4 w-px shrink-0 bg-line-strong @max-[1300px]/kindbar:mx-1.5 narrow:hidden" />
      <RowHeightSlider className="@max-[1300px]/kindbar:w-[84px] narrow:hidden" />
    </div>
  );
}

/** 行高缩放：左小图标 / 右大图标，中间滑块，存到偏好 */
function RowHeightSlider({ className }: { className?: string }) {
  const rowHeight = usePrefs((s) => s.gridRowHeight);
  const setRowHeight = usePrefs((s) => s.setGridRowHeight);
  return (
    <Tooltip content={`行高 ${rowHeight}px`}>
      <div className={cn('flex w-[128px] min-w-[72px] items-center gap-2 text-fg-subtle', className)}>
        <button
          type="button"
          aria-label="缩小"
          onClick={() => setRowHeight(Math.max(120, rowHeight - 40))}
          className="flex shrink-0 transition-colors hover:text-fg"
        >
          <ImageIcon className="size-3" />
        </button>
        <Slider value={rowHeight} min={120} max={400} step={10} onValueChange={setRowHeight} label="缩放图片" />
        <button
          type="button"
          aria-label="放大"
          onClick={() => setRowHeight(Math.min(400, rowHeight + 40))}
          className="flex shrink-0 transition-colors hover:text-fg"
        >
          <ImageIcon className="size-4" />
        </button>
      </div>
    </Tooltip>
  );
}

/**
 * 自定义画面的 chip：悬停时右上角出现小铅笔，右键也能编辑。
 * 铅笔是 chip 外面的兄弟元素（button 里不能套 button）。
 */
function CustomChip({
  theme,
  selected,
  onClick,
  onEdit,
}: {
  theme: CustomTheme;
  selected: boolean;
  onClick: () => void;
  onEdit: () => void;
}) {
  return (
    <span className="group/custom relative inline-flex shrink-0">
      <Chip
        size="sm"
        selected={selected}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          onEdit();
        }}
        title={`${themeSentence(themeItems(theme))}\n右键编辑`}
      >
        {theme.name}
      </Chip>
      <button
        type="button"
        aria-label={`编辑「${theme.name}」`}
        onClick={onEdit}
        className={cn(
          'absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-raised text-fg-muted shadow-[0_0_0_1px_var(--c-line-strong)]',
          'opacity-0 transition-opacity duration-150 group-hover/custom:opacity-100 hover:text-fg focus-visible:opacity-100',
        )}
      >
        <Pencil className="size-2.5" />
      </button>
    </span>
  );
}

/** 手机筛选面板里的一组：小标题 + 一片可以折行的 chip */
function SheetGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-medium text-fg-subtle">{label}</h3>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </section>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <span className="mr-0.5 shrink-0 text-[11px] font-medium text-fg-subtle">{children}</span>;
}

function Divider() {
  return <span className="mx-2 h-4 w-px shrink-0 bg-line-strong" />;
}

/** 一个小线框矩形，比文字更快看出竖 / 横 / 方 */
function OrientGlyph({ orientation }: { orientation: Orientation }) {
  const dims = { portrait: 'h-[11px] w-2', landscape: 'h-2 w-[11px]', square: 'size-[9px]' }[orientation];
  return <span aria-hidden className={cn('inline-block rounded-[2px] border-[1.5px] border-current opacity-75', dims)} />;
}
