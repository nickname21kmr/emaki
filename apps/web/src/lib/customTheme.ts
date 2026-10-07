import type { CustomTheme, ListImagesQuery } from '@emaki/shared';

/** 自定义画面里一个标签的归组：必含 / 任一 / 不含 */
export type TagMode = 'all' | 'any' | 'none';

export const TAG_MODE_LABEL: Record<TagMode, string> = { all: '必含', any: '任一', none: '不含' };

/** 标签的显示名：没有中文名时把下划线换成空格 */
export const plainTag = (tag: string) => tag.replace(/_/g, ' ');

/** 自定义画面 → 图片查询的三组标签；空组不传 */
export function themeQuery(t: CustomTheme | undefined): Pick<ListImagesQuery, 'tags' | 'tagsAll' | 'tagsNone'> {
  if (!t) return {};
  return {
    tags: t.tags.length ? t.tags : undefined,
    tagsAll: t.all?.length ? t.all : undefined,
    tagsNone: t.none?.length ? t.none : undefined,
  };
}

/** 按归组列出（必含、任一、不含） */
export function themeItems(t: CustomTheme): { tag: string; mode: TagMode }[] {
  return [
    ...(t.all ?? []).map((tag) => ({ tag, mode: 'all' as const })),
    ...t.tags.map((tag) => ({ tag, mode: 'any' as const })),
    ...(t.none ?? []).map((tag) => ({ tag, mode: 'none' as const })),
  ];
}

/** 一句话说清楚筛什么：「同时含 白发、眼镜，含 丝袜、连裤袜 之一，不含 漫画」 */
export function themeSentence(items: { tag: string; mode: TagMode }[], nameOf: (tag: string) => string = plainTag): string {
  const of = (m: TagMode) => items.filter((i) => i.mode === m).map((i) => nameOf(i.tag));
  let all = of('all');
  let any = of('any');
  const none = of('none');
  // 任一只有一个时等于必含，合在一起说
  if (any.length === 1) [all, any] = [[...all, ...any], []];
  const parts: string[] = [];
  if (all.length) parts.push(`${all.length > 1 ? '同时含' : '含'} ${all.join('、')}`);
  if (any.length) parts.push(`含 ${any.join('、')} 之一`);
  if (none.length) parts.push(`不含 ${none.join('、')}`);
  return parts.join('，');
}
