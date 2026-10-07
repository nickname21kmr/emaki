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
 * 头部下方的工具条：左搜索 / 中筛选 chip / 右排序 + 缩放。
 * 高度固定一行（chip 多了横向滚动），这样网格的位置不会因为筛选而跳动。
 */
export function GalleryToolbar({
  filters,
  update,
  hasFilters,
  onClearFilters,
  customThemes,
}: {
  filters: GalleryFilters;
  update: (patch: Partial<GalleryFilters>) => void;
  hasFilters: boolean;
  onClearFilters: () => void;
  /** 用户自己加的画面（设置里的 browse.customThemes） */
  customThemes: CustomTheme[];
}) {
  const toggleRating = (r: GalleryFilters['rating'][number]) =>
    update({ rating: filters.rating.includes(r) ? filters.rating.filter((x) => x !== r) : [...filters.rating, r] });
  // 自定义画面的对话框：null = 关着；theme 为空 = 新建
  const [editing, setEditing] = useState<{ theme?: CustomTheme } | null>(null);

  return (
    <div className="flex items-center gap-3">
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
      <GallerySearch value={filters.q} onCommit={(q) => update({ q })} className="w-[248px] shrink-0" />

      {/* 中间的筛选 chip：放不下时横向滚动，左右渐隐 */}
      <div className="-ml-3 min-w-0 flex-1 overflow-x-auto scrollbar-none fade-x">
        <div className="flex w-max items-center gap-1.5 py-1 pr-8 pl-4">
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

          <Divider />
          <GroupLabel>画面</GroupLabel>
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
          <Tooltip content="用识别标签自己组一个">
            <Chip size="sm" aria-label="新建画面" className="px-2 text-fg-muted" onClick={() => setEditing({})}>
              <Plus className="size-3.5" />
            </Chip>
          </Tooltip>

          <Divider />
          <Chip size="sm" selected={filters.favorite} onClick={() => update({ favorite: !filters.favorite })}>
            <span className="inline-flex items-center gap-1.5">
              <Heart className={cn('size-3', filters.favorite && 'fill-current')} />
              只看收藏
            </span>
          </Chip>

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

      <div className="flex shrink-0 items-center gap-0.5">
        <Menu
          width={188}
          trigger={
            <Button variant="ghost" size="sm" icon={<ArrowDownUp className="size-3.5" />} className="text-[12.5px]">
              {SORT_LABEL[filters.sort]}
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

        <div className="mx-2.5 h-4 w-px bg-line-strong" />
        <RowHeightSlider />
      </div>
    </div>
  );
}

/** 行高缩放：左小图标 / 右大图标，中间滑块，存到偏好 */
function RowHeightSlider() {
  const rowHeight = usePrefs((s) => s.gridRowHeight);
  const setRowHeight = usePrefs((s) => s.setGridRowHeight);
  return (
    <Tooltip content={`行高 ${rowHeight}px`}>
      <div className="flex w-[128px] items-center gap-2 text-fg-subtle">
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
