import type { BulkImageAction, CharacterSuggestion, ContentKind, ID, UnrecognizedItem } from '@emaki/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, imageUrl } from '@/lib/api';
import { isSensitive } from '@/lib/format';
import { KIND_LABEL } from '@/lib/kinds';
import { useMutate, useUnrecognizedInfinite } from '@/lib/queries';
import { useSelection } from '@/lib/stores';
import type { AggregatedSuggestion, AssignTarget, Direction, StampEvent } from './types';

const SCOPE = 'unrecognized';
const EMPTY: ReadonlySet<ID> = new Set();

/** 点击队列项时关心的修饰键 */
export interface ClickModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * 未识别页的全部状态：队列、当前项、多选、乐观移除、会话内的小记忆。
 *
 * 乐观移除：采纳 / 归入 / 排除后立刻把图从队列里藏起来并前进到下一张，
 * 不等接口返回——这一页讲究的就是手不停。失败时再放回来（useMutate 已经弹了错误 toast）。
 */
export function useTriage(bucket: 'suggested' | 'untagged') {
  const query = useUnrecognizedInfinite({ area: 'art', bucket });
  const { data, dataUpdatedAt, hasNextPage, isFetching, isFetchingNextPage, fetchNextPage } = query;
  // 修改成功后会整体刷新；这时再 fetchNextPage 会把那次刷新取消掉，拼回旧页面，
  // 刚处理掉的图就会闪回来。所以只在完全空闲时翻页。
  const canLoadMore = !!hasNextPage && !isFetching;

  // 多页拼起来；偏移分页在删改后可能出现重叠，按 id 去重
  const allItems = useMemo(() => {
    const seen = new Set<ID>();
    const out: UnrecognizedItem[] = [];
    for (const page of data?.pages ?? []) {
      for (const it of page.items) {
        if (seen.has(it.image.id)) continue;
        seen.add(it.image.id);
        out.push(it);
      }
    }
    return out;
  }, [data]);

  // ---------------------------------------------------------------- 乐观隐藏
  // value = 修改成功的时间；null = 还在请求中
  const [pending, setPending] = useState<ReadonlyMap<ID, number | null>>(() => new Map());

  // 修改成功之后又拿到了新数据 → 服务端已经反映了结果，可以放掉隐藏标记。
  // 不放掉的话，撤销后图片回到列表里也会一直被藏着。
  useEffect(() => {
    setPending((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [id, settledAt] of prev) {
        if (settledAt !== null && dataUpdatedAt >= settledAt) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [dataUpdatedAt]);

  const items = useMemo(
    () => (pending.size ? allItems.filter((it) => !pending.has(it.image.id)) : allItems),
    [allItems, pending],
  );

  // ---------------------------------------------------------------- 当前项
  // 记 id 为主、下标兜底：id 消失（被别处处理掉）时停在原来的位置
  const [cursor, setCursor] = useState<{ id: ID | null; index: number }>({ id: null, index: 0 });
  const [direction, setDirection] = useState<Direction>(1);

  const index = useMemo(() => {
    if (!items.length) return -1;
    if (cursor.id) {
      const i = items.findIndex((it) => it.image.id === cursor.id);
      if (i >= 0) return i;
    }
    return Math.min(Math.max(cursor.index, 0), items.length - 1);
  }, [items, cursor]);
  const current: UnrecognizedItem | undefined = index >= 0 ? items[index] : undefined;

  // 靠下标兜底落到某张图上之后，把 id 记下来，之后列表再变也跟着这张图走。
  // 下标超出已加载范围时（在等下一页）不记，否则下一页到了也前进不过去。
  const currentId = current?.image.id;
  useEffect(() => {
    if (currentId && cursor.id !== currentId && cursor.index < items.length) {
      setCursor({ id: currentId, index });
    }
  }, [currentId, cursor, index, items.length]);

  // 快到已加载的末尾就提前拉下一页，前进时不会卡住
  useEffect(() => {
    if (index >= 0 && index >= items.length - 8 && canLoadMore) void fetchNextPage();
  }, [index, items.length, canLoadMore, fetchNextPage]);

  // 预加载后两张的大图，按 J 时直接出图
  useEffect(() => {
    if (index < 0) return;
    for (const it of items.slice(index + 1, index + 3)) {
      const img = new Image();
      img.src = imageUrl.thumb(it.image.id, 960);
    }
  }, [items, index]);

  // ---------------------------------------------------------------- 多选
  const scope = useSelection((s) => s.scope);
  const rawSelected = useSelection((s) => s.ids);
  // 作用域还没切过来时，别把别的页面的选择当成自己的
  const selected = scope === SCOPE ? rawSelected : EMPTY;

  useEffect(() => {
    useSelection.getState().setScope(SCOPE);
    return () => useSelection.getState().clear();
  }, []);

  const selectedItems = useMemo(
    () => (selected.size ? items.filter((it) => selected.has(it.image.id)) : []),
    [items, selected],
  );
  const batch = selectedItems.length > 0;

  // 多选时的「共同建议」：同一个角色被几张图建议过
  const aggregated = useMemo<AggregatedSuggestion[]>(() => {
    const map = new Map<string, AggregatedSuggestion>();
    for (const it of selectedItems) {
      for (const s of it.suggestions) {
        // 需要新建角色的建议没法批量归入，只在单张模式里提供
        if (!s.characterId) continue;
        const prev = map.get(s.danbooruTag);
        if (prev) {
          prev.hits += 1;
          prev.score = Math.max(prev.score, s.score);
        } else {
          map.set(s.danbooruTag, { ...s, hits: 1 });
        }
      }
    }
    return [...map.values()].sort((a, b) => b.hits - a.hits || b.score - a.score).slice(0, 5);
  }, [selectedItems]);

  // 队列里首条建议和当前项相同的图（TR-3）：按 A 一次选中，批量面板的「共同建议」第一条就是它
  const sameTop = useMemo(() => {
    const s = current?.suggestions[0];
    if (!s?.characterId) return []; // 新角色没法批量归入
    return items.filter((it) => it.suggestions[0]?.danbooruTag === s.danbooruTag);
  }, [items, current]);
  const selectSameTop = () => {
    if (sameTop.length > 1) useSelection.getState().setMany(sameTop.map((it) => it.image.id));
  };

  // ---------------------------------------------------------------- 会话内的小记忆
  const [doneCount, setDoneCount] = useState(0);
  const [recent, setRecent] = useState<AssignTarget[]>([]);
  const [stamp, setStamp] = useState<StampEvent | null>(null);

  useEffect(() => {
    if (!stamp) return;
    const t = window.setTimeout(() => setStamp(null), 760);
    return () => window.clearTimeout(t);
  }, [stamp]);

  const remember = useCallback((t: AssignTarget) => {
    setRecent((prev) => [t, ...prev.filter((p) => p.id !== t.id)].slice(0, 5));
  }, []);

  // ---------------------------------------------------------------- 修改
  const settle = useCallback((ids: ID[]) => {
    const now = Date.now();
    setPending((prev) => {
      const next = new Map(prev);
      for (const id of ids) if (next.has(id)) next.set(id, now);
      return next;
    });
    setDoneCount((n) => n + ids.length);
  }, []);

  const unhide = useCallback((ids: ID[]) => {
    setPending((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const acceptMut = useMutate(
    (v: { ids: ID[]; imageId: ID; danbooruTag: string }) => api.acceptSuggestion(v.imageId, { danbooruTag: v.danbooruTag }),
    { onSuccess: (_r, v) => settle(v.ids) },
  );
  const bulkMut = useMutate((v: { ids: ID[]; action: BulkImageAction }) => api.bulkImages({ ids: v.ids, action: v.action }), {
    onSuccess: (_r, v) => settle(v.ids),
  });

  /** 从队列里藏起来；当前项在其中就先算好下一张 */
  const hide = (ids: ID[]) => {
    const gone = new Set(ids);
    if (current && gone.has(current.image.id)) {
      const keep = (it: UnrecognizedItem) => !gone.has(it.image.id);
      const after = items.slice(index + 1).find(keep) ?? items.slice(0, index).findLast(keep);
      const rest = items.filter(keep);
      setDirection(1);
      setCursor({ id: after?.image.id ?? null, index: after ? rest.indexOf(after) : index });
    }
    setPending((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, null);
      return next;
    });
  };

  const targetIds = (): ID[] =>
    batch ? selectedItems.map((it) => it.image.id) : current ? [current.image.id] : [];

  const stampIt = (glyph: string, label: string, tone: StampEvent['tone'] = 'shu') =>
    setStamp({ key: Date.now(), glyph, label, tone });

  /** 单张：采纳 tagger 的第 N 个建议（可能会新建角色） */
  const acceptSuggestion = (s: CharacterSuggestion) => {
    if (!current) return;
    const img = current.image;
    hide([img.id]);
    stampIt('归', s.name);
    if (s.characterId) {
      remember({
        id: s.characterId,
        name: s.name,
        workName: s.workName,
        // 刚归进去的这张就是它在本次会话里的「头像」；敏感图不拿来当头像
        coverImageId: isSensitive(img.rating) ? null : img.id,
      });
    }
    acceptMut.mutateAsync({ ids: [img.id], imageId: img.id, danbooruTag: s.danbooruTag }).catch(() => unhide([img.id]));
  };

  /** 归到指定角色：单张或多选 */
  const assign = (t: AssignTarget) => {
    const ids = targetIds();
    if (!ids.length) return;
    hide(ids);
    if (batch) useSelection.getState().clear();
    stampIt('归', batch ? `${ids.length} 张 · ${t.name}` : t.name);
    remember(t);
    bulkMut.mutateAsync({ ids, action: { type: 'assign', characterId: t.id } }).catch(() => unhide(ids));
  };

  /** 多选时采纳「共同建议」 */
  const acceptAggregated = (s: AggregatedSuggestion) => {
    if (!s.characterId) return;
    assign({ id: s.characterId, name: s.name, workName: s.workName, coverImageId: null });
  };

  /** 「不是插画」（T32a）：标成别的类型，这张离开队列（漫画除外，漫画仍在队列里） */
  const [kindMenuOpen, setKindMenuOpen] = useState(false);
  const markKind = (kind: ContentKind | 'auto') => {
    const ids = targetIds();
    if (!ids.length) return;
    const leaves = kind !== 'comic' && kind !== 'illustration' && kind !== 'auto';
    if (leaves) {
      hide(ids);
      if (batch) useSelection.getState().clear();
    }
    const label = kind === 'auto' ? '自动判断' : KIND_LABEL[kind];
    stampIt(label.slice(0, 1), batch ? `${ids.length} 张 · ${label}` : label, 'muted');
    bulkMut.mutateAsync({ ids, action: { type: 'kind', value: kind } }).catch(() => leaves && unhide(ids));
  };

  const exclude = () => {
    const ids = targetIds();
    if (!ids.length) return;
    hide(ids);
    if (batch) useSelection.getState().clear();
    stampIt('除', batch ? `已排除 ${ids.length} 张` : '已排除', 'muted');
    bulkMut.mutateAsync({ ids, action: { type: 'exclude' } }).catch(() => unhide(ids));
  };

  // ---------------------------------------------------------------- 导航
  const step = (delta: Direction) => {
    if (index < 0) return;
    const target = index + delta;
    if (target < 0) {
      toast('已经是第一张了');
      return;
    }
    if (target >= items.length) {
      if (hasNextPage) {
        // 正忙着刷新的话，上面「快到末尾就拉下一页」的 effect 会在空闲后接上
        if (canLoadMore) void fetchNextPage();
        // 下一页到了之后按下标落到新的一张上
        setDirection(1);
        setCursor({ id: null, index: target });
      } else {
        toast('已经是最后一张了');
      }
      return;
    }
    setDirection(delta);
    setCursor({ id: items[target]!.image.id, index: target });
  };

  const focus = (id: ID) => {
    const i = items.findIndex((it) => it.image.id === id);
    if (i < 0 || i === index) return;
    setDirection(i > index ? 1 : -1);
    setCursor({ id, index: i });
  };

  /** 队列项点击：普通点击切换当前；Ctrl/⌘ 切换选中；Shift 连选 */
  const clickItem = (id: ID, mods: ClickModifiers) => {
    const sel = useSelection.getState();
    const order = items.map((it) => it.image.id);
    if (mods.shiftKey) {
      if (sel.anchor && order.includes(sel.anchor)) {
        sel.selectRange(order, id);
      } else {
        // 还没有锚点时从当前项连到点中的那张
        const from = current ? order.indexOf(current.image.id) : order.indexOf(id);
        const to = order.indexOf(id);
        const [a, b] = from < to ? [from, to] : [to, from];
        sel.setMany([...sel.ids, ...order.slice(a, b + 1)]);
      }
      return;
    }
    if (mods.ctrlKey || mods.metaKey) {
      sel.toggle(id);
      return;
    }
    if (sel.ids.size) sel.clear();
    focus(id);
  };

  const toggleSelect = (id: ID) => useSelection.getState().toggle(id);
  const toggleCurrent = () => current && toggleSelect(current.image.id);
  const clearSelection = () => useSelection.getState().clear();

  // ---------------------------------------------------------------- 头部统计
  const total = data?.pages[0]?.total ?? 0;
  const hiddenCount = useMemo(
    () => (pending.size ? allItems.reduce((n, it) => n + (pending.has(it.image.id) ? 1 : 0), 0) : 0),
    [allItems, pending],
  );

  // 后端给出整个队列里有建议的张数；刚处理、还没从列表消失的那几张先减掉
  const suggestedTotal = data?.pages[0]?.suggestedCount ?? 0;
  const suggested = useMemo(() => {
    const hidden = pending.size ? allItems.filter((it) => pending.has(it.image.id) && it.suggestions.length).length : 0;
    return { count: Math.max(0, suggestedTotal - hidden), exact: true };
  }, [suggestedTotal, allItems, pending]);

  return {
    query,
    items,
    total: Math.max(0, total - hiddenCount),
    suggested,
    current,
    index,
    direction,
    stamp,
    doneCount,
    recent,
    selected,
    selectedItems,
    batch,
    aggregated,
    hasNextPage: !!hasNextPage,
    isFetchingNextPage,
    loadMore: () => {
      if (canLoadMore) void fetchNextPage();
    },
    acceptSuggestion,
    acceptAggregated,
    sameTop,
    selectSameTop,
    assign,
    exclude,
    markKind,
    kindMenuOpen,
    setKindMenuOpen,
    next: () => step(1),
    prev: () => step(-1),
    focusId: focus,
    clickItem,
    toggleSelect,
    toggleCurrent,
    clearSelection,
  };
}

export type Triage = ReturnType<typeof useTriage>;
