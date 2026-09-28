import type { CharacterSort, ID } from '@emaki/shared';
import { useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useCharactersInfinite } from '@/lib/queries';

/**
 * 角色页的筛选状态全部放在 URL 里（刷新 / 前进后退都能保留）：
 *   ?q=      搜索词
 *   ?work=   作品 id，或特殊值 recent（最近在收）；缺省 = 总览
 *   ?sort=   imageCount / recent / name / newCount；缺省时按作用域给默认值
 *   ?source= custom（只看自建角色）
 */

export type WorkScope = ID | 'recent' | null;

export const SORT_OPTIONS: { value: CharacterSort; label: string }[] = [
  { value: 'imageCount', label: '按张数' },
  { value: 'recent', label: '最近添加' },
  { value: 'name', label: '按名字' },
  { value: 'newCount', label: '新图数' },
];

const isSort = (v: string | null): v is CharacterSort => SORT_OPTIONS.some((o) => o.value === v);

/** 「最近在收」默认按最近添加排，其它按张数 */
const defaultSort = (work: WorkScope): CharacterSort => (work === 'recent' ? 'recent' : 'imageCount');

export function useCharactersParams() {
  const [sp, setSp] = useSearchParams();

  // setSearchParams 的引用会随 URL 变化，放进 ref 里让下面的 setter 保持稳定
  const setRef = useRef(setSp);
  setRef.current = setSp;

  const q = sp.get('q') ?? '';
  const work: WorkScope = sp.get('work') || null;
  const source = sp.get('source') === 'custom' ? ('custom' as const) : undefined;
  /** 也列出只出现在漫画、截图等里的角色（?other=1，T32a） */
  const other = sp.get('other') === '1';
  const rawSort = sp.get('sort');
  const sort: CharacterSort = isSort(rawSort) ? rawSort : defaultSort(work);

  const patch = useCallback((changes: Record<string, string | null>, replace = true) => {
    setRef.current(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace },
    );
  }, []);

  const actions = useMemo(
    () => ({
      setQ: (v: string) => patch({ q: v.trim() ? v : null }),
      // 切作品留一条历史记录，方便后退回上一个作品
      setWork: (v: WorkScope) => patch({ work: v }, false),
      setSort: (v: CharacterSort, scope: WorkScope) => patch({ sort: v === defaultSort(scope) ? null : v }),
      setSource: (v: 'custom' | undefined) => patch({ source: v ?? null }, false),
      setOther: (v: boolean) => patch({ other: v ? '1' : null }),
    }),
    [patch],
  );

  return { q, qTrimmed: q.trim(), work, source, sort, other, ...actions };
}

export type CharactersParams = ReturnType<typeof useCharactersParams>;

export const LIST_PAGE_SIZE = 60;

/** 平铺列表（选中作品 / 搜索 / 自建 / 列表视图）用的查询，页面和列表共用同一个 key */
export function useFlatCharacters(p: { work: WorkScope; q: string; sort: CharacterSort; source?: 'custom'; other?: boolean }) {
  return useCharactersInfinite({
    workId: p.work ?? undefined,
    q: p.q || undefined,
    sort: p.sort,
    source: p.source,
    includeOther: p.other || undefined,
    limit: LIST_PAGE_SIZE,
  });
}
