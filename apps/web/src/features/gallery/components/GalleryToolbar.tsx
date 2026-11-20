import { CollapseGroupsMenu } from '@/components/media/CollectionControls';
import { BROWSE_THEMES, type CustomTheme, type ListImagesQuery } from '@emaki/shared';
import { useQuery } from '@tanstack/react-query';
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
  Check,
  Pencil,
  PersonStanding,
  Play,
  Plus,
  Shuffle,
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
  Slider,
  Tooltip,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { plainTag, themeItems, themeSentence } from '@/lib/customTheme';
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
 */
export function GalleryToolbar({
  filters,
  query,
  update,
  hasFilters,
  onClearFilters,
  customThemes,
  animatedChip = true,
  leading,
}: {
  filters: GalleryFilters;
  /** 当前的图片查询（搜索下拉里的张数按它数） */
  query: Omit<ListImagesQuery, 'cursor'>;
  update: (patch: Partial<GalleryFilters>) => void;
  hasFilters: boolean;
  onClearFilters: () => void;
  /** 用户自己加的画面（设置里的 browse.customThemes） */
  customThemes: CustomTheme[];
  /** 显示「动图」chip（别册的动图页本身就是这个筛选，不显示） */
  animatedChip?: boolean;
  /** 放在筛选最前面的东西（图库：姿势检索打开时的「按姿势」） */
  leading?: ReactNode;
}) {
  const toggleRating = (r: GalleryFilters['rating'][number]) =>
    update({ rating: filters.rating.includes(r) ? filters.rating.filter((x) => x !== r) : [...filters.rating, r] });
  // 自定义画面的对话框：null = 关着；theme 为空 = 新建
  const [editing, setEditing] = useState<{ theme?: CustomTheme } | null>(null);

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
          onAddTags={(tags, q) => update({ tags: [...filters.tags, ...tags], q })}
          baseQuery={query}
          className="w-[248px] shrink-0 @max-[600px]/toolbar:w-[168px]"
        />

        {/* 筛选 chip：放不下时横向滚动，左右渐隐。「+」和「清除筛选」跟在 chip 后面，但不在滚动区里，放不下时停在右端不会被挤走 */}
        <div className="-ml-3 flex min-w-0 flex-1 items-center">
          <div className="min-w-0 overflow-x-auto scrollbar-none fade-x">
            <div className="flex w-max items-center gap-1.5 py-1 pr-8 pl-4">
              {leading && (
                <>
                  {leading}
                  <Divider />
                </>
              )}
              {/* 搜索框「按标签」和 ⌘K 加进来的必含标签 */}
              {filters.tags.length > 0 && (
                <>
                  <GroupLabel>必含</GroupLabel>
                  {filters.tags.map((t) => (
                    <TagFilterChip key={t} tag={t} onRemove={() => update({ tags: filters.tags.filter((x) => x !== t) })} />
                  ))}
                  <Divider />
                </>
              )}
              <GroupLabel>分级</GroupLabel>
              {RATINGS.map((r) => (
                <Chip key={r} size="sm" selected={filters.rating.includes(r)} onClick={() => toggleRating(r)}>
                  {RATING_LABEL[r]}
                </Chip>
              ))}

              <Divider />
              <GroupLabel>方向</GroupLabel>
              {ORIENTATIONS.map((o) => (
                <Chip
                  key={o}
                  size="sm"
                  selected={filters.orientation === o}
                  onClick={() => update({ orientation: filters.orientation === o ? undefined : o })}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <OrientGlyph orientation={o} />
                    {ORIENT_LABEL[o]}
                  </span>
                </Chip>
              ))}

              {animatedChip && (
                <>
                  <Divider />
                  {/* 是否动图（D5）：不是类型，是在当前类型里再筛一层 */}
                  <Tooltip content="只看动图：按帧数自动认出，和类型无关">
                    <Chip size="sm" selected={filters.animated} onClick={() => update({ animated: !filters.animated })}>
                      <span className="inline-flex items-center gap-1.5">
                        <Play className="size-2.5 fill-current" strokeWidth={0} aria-hidden />
                        动图
                      </span>
                    </Chip>
                  </Tooltip>
                </>
              )}

              <Divider />
              <GroupLabel>画面</GroupLabel>
              {BROWSE_THEMES.map((t) => (
                <Chip
                  key={t}
                  size="sm"
                  selected={filters.theme === t}
                  onClick={() => update({ theme: filters.theme === t ? undefined : t })}
                >
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
            </div>
          </div>
          {/* 往回压进滚动区右边留给渐隐的空白里，没溢出时紧跟在最后一个 chip 后面 */}
          <div className="-ml-6 flex shrink-0 items-center gap-1.5">
            <Tooltip content="用识别标签自己组一个">
              <Chip size="sm" aria-label="新建画面" className="px-2 text-fg-muted" onClick={() => setEditing({})}>
                <Plus className="size-3.5" />
              </Chip>
            </Tooltip>
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
}: {
  filters: GalleryFilters;
  update: (patch: Partial<GalleryFilters>) => void;
  /** 当前列表收拢着组图（接口返回的 collapsed） */
  collapsed?: boolean;
}) {
  // 选了姿势类别时多一种排法：离这一类代表姿势近的在前；「找同姿势的图」按和那张图相近排
  const sortLabel = filters.poseLike ? '姿势相近' : filters.poseOrder ? (filters.pwPose ? '姿势最像' : '姿势典型') : SORT_LABEL[filters.sort];
  const noDirection = filters.sort === 'random' || filters.poseOrder || !!filters.poseLike;
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
            aria-label={`排序：${sortLabel}`}
            title={`排序：${sortLabel}`}
            className="text-[12.5px] @max-[1420px]/kindbar:gap-0 @max-[1420px]/kindbar:px-2"
          >
            <span className="@max-[1420px]/kindbar:hidden">{sortLabel}</span>
          </Button>
        }
      >
        <MenuLabel>排序方式</MenuLabel>
        <MenuRadioGroup
          value={filters.poseLike ? 'like' : filters.poseOrder ? 'pose' : filters.sort}
          onValueChange={(v) => {
            if (v === 'pose') update({ poseOrder: true });
            else if (v !== 'like') update({ sort: v as GallerySort });
          }}
        >
          {filters.poseLike && (
            <MenuRadioItem value="like" icon={<PersonStanding />}>
              和那张姿势相近
            </MenuRadioItem>
          )}
          {(filters.poseClass || filters.pwPose) && (
            <MenuRadioItem value="pose" icon={<PersonStanding />}>
              {filters.pwPose ? '和姿势最像的在前' : '姿势典型的在前'}
            </MenuRadioItem>
          )}
          {SORTS.map((s) => (
            <MenuRadioItem key={s} value={s} icon={SORT_ICON[s]}>
              {SORT_LABEL[s]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Menu>

      <IconButton
        size="sm"
        label={noDirection && filters.sort !== 'random' ? '按姿势排没有方向' : orderLabel(filters.sort, filters.order)}
        disabled={noDirection}
        onClick={() => update({ order: filters.order === 'desc' ? 'asc' : 'desc' })}
      >
        {filters.order === 'desc' ? <ArrowDownWideNarrow /> : <ArrowUpNarrowWide />}
      </IconButton>
      <CollapseGroupsMenu collapsed={collapsed} />

      <div className="mx-2.5 h-4 w-px shrink-0 bg-line-strong @max-[1300px]/kindbar:mx-1.5" />
      <RowHeightSlider className="@max-[1300px]/kindbar:w-[84px]" />
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

/**
 * 必含的一个标签：样子和自定义画面对话框里「必含」的标签一样（墨色实心 + 对勾），右边的叉去掉。
 * 中文名按标签名查一次（搜索下拉选的时候已经记下了，不会再请求）
 */
function TagFilterChip({ tag, onRemove }: { tag: string; onRemove: () => void }) {
  const { data } = useQuery({ queryKey: ['tag-name', tag], queryFn: () => api.tags(tag, 1), staleTime: Infinity });
  const hit = data?.find((s) => s.tag === tag);
  const label = hit?.name ?? plainTag(tag);
  return (
    <span
      title={hit ? `${tag} · ${hit.count.toLocaleString()} 张` : tag}
      className="inline-flex h-7 shrink-0 animate-fade-in items-center gap-1 rounded-full bg-ink pr-1 pl-2.5 text-xs font-medium text-fg-inverse"
    >
      <Check className="size-3" />
      {label}
      <button
        type="button"
        aria-label={`去掉 ${label}`}
        onClick={onRemove}
        className="flex size-5 items-center justify-center rounded-full text-fg-inverse/60 hover:bg-fg-inverse/15 hover:text-fg-inverse"
      >
        <X className="size-3" />
      </button>
    </span>
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
