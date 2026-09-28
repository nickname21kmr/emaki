import type { BulkImageAction, ContentKind, ID, ImageItem, Rating } from '@emaki/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { KIND_LABEL } from '@/lib/kinds';
import { useMutate, useUnrecognizedInfinite, type UnrecognizedParams } from '@/lib/queries';
import { useSelection } from '@/lib/stores';
import type { AssignTarget, StampEvent } from './types';

const SCOPE = 'unrecognized';
const EMPTY: ReadonlySet<ID> = new Set();
const ANNEX: readonly string[] = ['screenshot', 'text', 'photo', 'meme', 'animated'];
const MAX_SELECT = 2000;

/**
 * 印样的数据与批量处理（T34c）：列表、乐观隐藏、多选、会话记忆和各个动作。
 * 乐观隐藏照 useTriage：先藏起来，失败再放回；拿到修改后的新数据再放掉隐藏标记。
 */
export function useSheet(params: UnrecognizedParams, enabled: boolean) {
  const query = useUnrecognizedInfinite(params, 120);
  const { data, dataUpdatedAt } = query;

  const all = useMemo(() => {
    const seen = new Set<ID>();
    const out: ImageItem[] = [];
    for (const pg of data?.pages ?? []) for (const x of pg.items) if (!seen.has(x.image.id)) (seen.add(x.image.id), out.push(x.image));
    return out;
  }, [data]);

  // ---------------------------------------------------------------- 乐观隐藏
  const [pending, setPending] = useState<ReadonlyMap<ID, number | null>>(() => new Map());
  useEffect(() => {
    setPending((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [id, at] of prev) if (at !== null && dataUpdatedAt >= at) (next.delete(id), (changed = true));
      return changed ? next : prev;
    });
  }, [dataUpdatedAt]);
  const items = useMemo(() => (pending.size ? all.filter((i) => !pending.has(i.id)) : all), [all, pending]);
  const hide = (ids: ID[]) =>
    setPending((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, null);
      return next;
    });
  const settle = useCallback((ids: ID[]) => {
    const now = Date.now();
    setPending((prev) => {
      const next = new Map(prev);
      for (const id of ids) if (next.has(id)) next.set(id, now);
      return next;
    });
    setDoneCount((n) => n + ids.length);
  }, []);
  const unhide = (ids: ID[]) =>
    setPending((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.delete(id);
      return next;
    });

  // ---------------------------------------------------------------- 多选：参数一变就清空
  const scope = useSelection((s) => s.scope);
  const raw = useSelection((s) => s.ids);
  const selected = scope === SCOPE ? raw : EMPTY;
  const key = `${params.area}|${params.bucket}|${params.theme}|${params.kind}`;
  useEffect(() => {
    useSelection.getState().setScope(SCOPE);
    useSelection.getState().clear();
  }, [key]);
  const selectedItems = useMemo(() => (selected.size ? items.filter((i) => selected.has(i.id)) : []), [items, selected]);
  const batch = selectedItems.length > 0;

  // ---------------------------------------------------------------- 会话记忆
  const [doneCount, setDoneCount] = useState(0);
  const [recent, setRecent] = useState<AssignTarget[]>([]);
  const [stamp, setStamp] = useState<StampEvent | null>(null);
  useEffect(() => {
    if (!stamp) return;
    const t = window.setTimeout(() => setStamp(null), 760);
    return () => window.clearTimeout(t);
  }, [stamp]);
  const stampIt = (glyph: string, label: string, tone: StampEvent['tone'] = 'shu') => setStamp({ key: Date.now(), glyph, label, tone });

  // ---------------------------------------------------------------- 动作
  const bulk = useMutate((v: { ids: ID[]; action: BulkImageAction }) => api.bulkImages(v), { onSuccess: (_r, v) => settle(v.ids) });
  const run = (action: BulkImageAction, opts: { hide: boolean; stamp: [string, string, StampEvent['tone']?] }) => {
    const ids = selectedItems.map((i) => i.id);
    if (!ids.length || !enabled) return;
    if (opts.hide) hide(ids);
    useSelection.getState().clear();
    stampIt(...opts.stamp);
    bulk.mutateAsync({ ids, action }).catch(() => opts.hide && unhide(ids));
  };

  const assign = (t: AssignTarget) => {
    const n = selectedItems.length;
    setRecent((prev) => [t, ...prev.filter((p) => p.id !== t.id)].slice(0, 5));
    run({ type: 'assign', characterId: t.id }, { hide: true, stamp: ['归', `${n} 张 · ${t.name}`] });
  };
  const shelve = (value: boolean) => {
    const n = selectedItems.length;
    run({ type: 'shelve', value }, { hide: true, stamp: value ? ['放', `放下 ${n} 张`, 'muted'] : ['回', `放回 ${n} 张`] });
  };
  /** 归为原创（true）/ 移出原创（false） */
  const markOriginal = (value: boolean) => {
    const n = selectedItems.length;
    run({ type: 'original', value }, { hide: true, stamp: value ? ['原', `${n} 张 · 原创`] : ['回', `移出原创 ${n} 张`] });
  };
  const setKind = (k: ContentKind | 'auto') => {
    const art = params.area === 'art';
    const comicGroup = params.theme === 'comic';
    const leaves =
      (art && ANNEX.includes(k)) ||
      (!art && (k === 'illustration' || k === 'comic')) ||
      (comicGroup && k === 'illustration') ||
      (art && !comicGroup && k === 'comic');
    run({ type: 'kind', value: k }, { hide: leaves, stamp: ['类', k === 'auto' ? '自动' : KIND_LABEL[k], 'muted'] });
  };
  const setRating = (r: Rating) => run({ type: 'rating', value: r }, { hide: false, stamp: ['级', '已改分级', 'muted'] });
  const exclude = () => run({ type: 'exclude' }, { hide: true, stamp: ['除', `已排除 ${selectedItems.length} 张`, 'muted'] });

  const selectLoaded = () => useSelection.getState().setMany(items.map((i) => i.id));
  /** 全选本组：循环拉页（用 fetchNextPage 的返回值，不用闭包里的旧值，RV-T-3），最多 2,000 张 */
  const selectAll = async () => {
    let d = query.data;
    let more = query.hasNextPage;
    const flat = (x?: typeof d) => (x?.pages ?? []).flatMap((p) => p.items.map((it) => it.image.id));
    for (let k = 0; more && flat(d).length < MAX_SELECT && k < 20; k++) {
      const r = await query.fetchNextPage({ cancelRefetch: false });
      d = r.data;
      more = r.hasNextPage;
    }
    const ids = [...new Set(flat(d))].filter((id) => !pending.has(id)).slice(0, MAX_SELECT);
    useSelection.getState().setScope(SCOPE);
    useSelection.getState().setMany(ids);
    if ((d?.pages[0]?.total ?? 0) > MAX_SELECT) toast('这一组太多，先选了前 2,000 张');
  };

  const hiddenCount = useMemo(() => (pending.size ? all.filter((i) => pending.has(i.id)).length : 0), [all, pending]);
  const total = Math.max(0, (data?.pages[0]?.total ?? 0) - hiddenCount);

  return {
    query,
    items,
    total,
    selectedItems,
    batch,
    stamp,
    recent,
    doneCount,
    assign,
    shelve,
    markOriginal,
    setKind,
    setRating,
    exclude,
    selectLoaded,
    selectAll,
    clear: () => useSelection.getState().clear(),
  };
}

export type Sheet = ReturnType<typeof useSheet>;
