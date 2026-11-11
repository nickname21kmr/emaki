import { BROWSE_THEMES, type BrowseTheme } from '@emaki/shared';
import { ArrowDownUp, ArrowDownWideNarrow, ArrowUpNarrowWide, Shirt } from 'lucide-react';
import { THEME_META } from '@/features/unrecognized/themes';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Button, Chip, IconButton, Menu, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, Segmented } from '@/components/ui';
import { formatCount, RATING_LABEL } from '@/lib/format';
import { RATINGS, SORT_OPTIONS, type ImageFilters } from './useImageFilters';
import { EASE_OUT } from '@/lib/motion';

/**
 * 「全部插画」标题行：左边标题 + 张数，右边分级筛选 chip、排序菜单、升降序。
 * 角色详情和作品页共用。
 */
export function ImagesToolbar({
  title = '全部插画',
  total,
  filters,
  extra,
  otherCount = 0,
}: {
  title?: ReactNode;
  /** 关联的非插画张数：> 0 时出现「插画 | 全部」切换（T32a） */
  otherCount?: number;
  /** 当前筛选下的总张数；还没加载时不显示 */
  total?: number;
  filters: ImageFilters;
  extra?: ReactNode;
}) {
  const sortLabel = SORT_OPTIONS.find((o) => o.value === filters.sort)?.label ?? '排序';
  const random = filters.sort === 'random';

  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      {/* 章节标题：编号接在「常一起出现」「收录于」之后（CSS 计数器） */}
      <div className="flex items-baseline gap-3">
        <span aria-hidden className="chapter-no numeral shrink-0 text-[17px] text-shu tabular" />
        <h2 className="font-serif-cjk text-[19px] font-semibold tracking-[.06em] whitespace-nowrap">
          {filters.allKinds ? '全部图片' : title}
        </h2>
        {total !== undefined && (
          <motion.span
            key={total}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: EASE_OUT }}
            className="text-xs text-fg-subtle tabular"
          >
            {formatCount(total)} 张
          </motion.span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {extra}
        {(otherCount > 0 || filters.allKinds) && (
          <>
            <Segmented<'illust' | 'all'>
              size="sm"
              value={filters.allKinds ? 'all' : 'illust'}
              onChange={(v) => filters.setAllKinds(v === 'all')}
              options={[
                { value: 'illust', label: '插画' },
                { value: 'all', label: `全部 · 含漫画等 ${formatCount(otherCount)}` },
              ]}
            />
            <span className="mx-1.5 h-4 w-px bg-line" aria-hidden />
          </>
        )}
        <div className="flex items-center gap-1" role="group" aria-label="分级筛选">
          {RATINGS.map((r) => (
            <Chip key={r} size="sm" selected={filters.rating.includes(r)} onClick={() => filters.toggleRating(r)}>
              {RATING_LABEL[r]}
            </Chip>
          ))}
        </div>

        <span className="mx-1.5 h-4 w-px bg-line" aria-hidden />

        <Menu
          width={168}
          trigger={
            <Button
              variant="ghost"
              size="sm"
              icon={<Shirt className="size-3.5" />}
              className={filters.theme || filters.custom ? 'text-fg' : undefined}
            >
              {filters.theme ? THEME_META[filters.theme].label : (filters.custom?.name ?? '画面')}
            </Button>
          }
        >
          <MenuLabel>按画面筛选</MenuLabel>
          {/* 自定义画面的值加 custom: 前缀，和内置的区分开 */}
          <MenuRadioGroup
            value={filters.custom ? `custom:${filters.custom.id}` : (filters.theme ?? '')}
            onValueChange={(v) => {
              if (v.startsWith('custom:')) filters.setCustom(v.slice(7));
              else if (v) filters.setTheme(v as BrowseTheme);
              else filters.clearTheme();
            }}
          >
            <MenuRadioItem value="">全部</MenuRadioItem>
            {BROWSE_THEMES.map((t) => (
              <MenuRadioItem key={t} value={t}>
                {THEME_META[t].label}
              </MenuRadioItem>
            ))}
            {filters.customThemes.length > 0 && <MenuSeparator />}
            {filters.customThemes.map((t) => (
              <MenuRadioItem key={t.id} value={`custom:${t.id}`}>
                {t.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </Menu>

        <Menu
          width={180}
          trigger={
            <Button variant="ghost" size="sm" icon={<ArrowDownUp className="size-3.5" />}>
              {sortLabel}
            </Button>
          }
        >
          <MenuLabel>排序方式</MenuLabel>
          <MenuRadioGroup value={filters.sort} onValueChange={filters.setSort}>
            {SORT_OPTIONS.map((o) => (
              <MenuRadioItem key={o.value} value={o.value}>
                {o.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </Menu>
        <IconButton
          size="sm"
          label={random ? '随机排序没有方向' : filters.order === 'desc' ? '降序（点击改为升序）' : '升序（点击改为降序）'}
          disabled={random}
          onClick={filters.toggleOrder}
        >
          {filters.order === 'desc' ? <ArrowDownWideNarrow /> : <ArrowUpNarrowWide />}
        </IconButton>
      </div>
    </div>
  );
}
