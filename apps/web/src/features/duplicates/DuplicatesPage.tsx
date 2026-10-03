import type { DuplicateGroup, ID } from '@emaki/shared';
import { CheckCheck } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { Button, EmptyState, ErrorState, Kbd, Progress, Segmented } from '@/components/ui';
import { api } from '@/lib/api';
import { formatBytes, formatCount } from '@/lib/format';
import { useHotkey } from '@/lib/hotkeys';
import { useDuplicates, useMutate, useSettings, useStats } from '@/lib/queries';
import { useLightbox, useOverlays } from '@/lib/stores';
import { DuplicateGroupCard } from './components/DuplicateGroupCard';
import { DuplicateSetFrame } from './components/DuplicateSetFrame';
import { DuplicatesSkeleton } from './components/DuplicatesSkeleton';
import { RescanButton, useDedupeJob } from './components/RescanButton';
import { ResolveAllDialog, type ResolvePlan } from './components/ResolveAllDialog';
import { ResolvedGroups, ResolvedGroupsSkeleton } from './components/ResolvedGroups';
import { useIncremental } from './useIncremental';
import { reclaimBytes, resolveKeep } from './utils';

type View = 'pending' | 'resolved';

/** 焦点在按钮 / 链接上时，Enter 留给它自己（否则会同时触发「处理当前组」） */
const isInteractive = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('button, a[href], [role="button"], [role="radio"], [role="checkbox"], [role="menuitem"]');

/**
 * 重复 —— 逐组确认保留哪张，其余移到回收站。
 * 键盘：J / K 在组间移动，Enter 按当前选择（默认即推荐）处理当前组。
 */
/** 挨着的、setId 相同的组归成一段，外面套一个「可能是同一套」的框；i 是全局序号（J / K、编号用） */
function segments(groups: DuplicateGroup[]): { setId: ID | null; items: { g: DuplicateGroup; i: number }[] }[] {
  const out: { setId: ID | null; items: { g: DuplicateGroup; i: number }[] }[] = [];
  groups.forEach((g, i) => {
    const last = out.at(-1);
    if (g.setId && last?.setId === g.setId) last.items.push({ g, i });
    else out.push({ setId: g.setId, items: [{ g, i }] });
  });
  return out;
}

export function DuplicatesPage() {
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'resolved' ? 'resolved' : 'pending';
  const setView = (v: View) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'resolved') next.set('view', 'resolved');
        else next.delete('view');
        return next;
      },
      { replace: true },
    );

  const pendingQ = useDuplicates(false);
  const resolvedQ = useDuplicates(true);
  const stats = useStats();
  const settings = useSettings();
  const roots = useMemo(() => new Map((settings.data?.libraryRoots ?? []).map((r) => [r.id, r] as const)), [settings.data]);
  const job = useDedupeJob();

  // 用户对每组「保留哪些」的调整；没动过的组用推荐
  const [overrides, setOverrides] = useState<Record<ID, ID[]>>({});
  // 刚处理完的组先藏起来，不等刷新；刷新后它不在列表里了就清掉（撤销回来的组会重新出现）
  const [dismissed, setDismissed] = useState<ReadonlySet<ID>>(() => new Set());
  const [busy, setBusy] = useState<ReadonlySet<ID>>(() => new Set());
  const [activeId, setActiveId] = useState<ID | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    const data = pendingQ.data;
    if (!data) return;
    setDismissed((prev) => {
      if (!prev.size) return prev;
      const alive = new Set(data.map((g) => g.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [pendingQ.data]);

  const groups = useMemo(() => (pendingQ.data ?? []).filter((g) => !dismissed.has(g.id)), [pendingQ.data, dismissed]);
  const groupsRef = useRef(groups);
  useEffect(() => {
    groupsRef.current = groups;
  });

  const found = groups.findIndex((g) => g.id === activeId);
  const activeIndex = found >= 0 ? found : groups.length ? 0 : -1;
  const keepOf = (g: DuplicateGroup) => resolveKeep(g, overrides[g.id]);

  /** 隐藏处理完的组；如果当前组被处理了，焦点落到它后面那组（没有就前一组） */
  const dismiss = useCallback((ids: ID[]) => {
    const gone = new Set(ids);
    setActiveId((cur) => {
      const list = groupsRef.current;
      const i = Math.max(
        list.findIndex((g) => g.id === cur),
        0,
      );
      if (!list[i] || !gone.has(list[i].id)) return cur;
      const next =
        list.slice(i + 1).find((g) => !gone.has(g.id)) ??
        list
          .slice(0, i)
          .reverse()
          .find((g) => !gone.has(g.id));
      return next?.id ?? null;
    });
    setDismissed((prev) => new Set([...prev, ...ids]));
  }, []);

  const resolveM = useMutate((v: { id: ID; keepIds: ID[] }) => api.resolveDuplicate(v.id, v.keepIds), {
    onSuccess: (_, v) => dismiss([v.id]),
  });
  const ignoreM = useMutate((id: ID) => api.ignoreDuplicate(id), { onSuccess: (_, id) => dismiss([id]) });

  /** 每组各自的 loading（可以连续处理多组，不互相阻塞） */
  const track = (id: ID, promise: Promise<unknown>) => {
    setBusy((s) => new Set(s).add(id));
    void promise
      .catch(() => undefined) // 错误 toast 由 useMutate 负责
      .finally(() =>
        setBusy((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        }),
      );
  };
  const resolveGroup = (g: DuplicateGroup) => {
    if (!busy.has(g.id)) track(g.id, resolveM.mutateAsync({ id: g.id, keepIds: keepOf(g) }));
  };
  const ignoreGroup = (g: DuplicateGroup) => {
    if (!busy.has(g.id)) track(g.id, ignoreM.mutateAsync(g.id));
  };

  const toggle = (g: DuplicateGroup, imageId: ID) => {
    const current = keepOf(g);
    const next = current.includes(imageId) ? current.filter((x) => x !== imageId) : [...current, imageId];
    if (!next.length) {
      toast('每组至少保留一张');
      return;
    }
    setOverrides((o) => ({ ...o, [g.id]: next }));
  };

  // ------------------------------------------------------------ 分批渲染 + 键盘
  const { count, hasMore, sentinelRef, ensure } = useIncremental(groups.length);
  const scrollTarget = useRef<ID | null>(null);
  useEffect(() => {
    const id = scrollTarget.current;
    if (!id) return;
    scrollTarget.current = null;
    document.getElementById(`dup-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  const moveTo = (index: number) => {
    const g = groups[Math.min(Math.max(index, 0), groups.length - 1)];
    if (!g) return;
    ensure(groups.indexOf(g));
    setActiveId(g.id);
    scrollTarget.current = g.id;
  };

  const lightboxOpen = useLightbox((s) => s.open);
  const showLightbox = useLightbox((s) => s.show);
  const overlayOpen = useOverlays((s) => s.commandOpen || s.helpOpen);
  const keysOn = view === 'pending' && groups.length > 0 && !confirmOpen && !lightboxOpen && !overlayOpen;

  const [lensGroup, setLensGroup] = useState<ID | null>(null);
  useHotkey('z', () => setLensGroup((cur) => (cur && cur === groups[activeIndex]?.id ? null : (groups[activeIndex]?.id ?? null))), {
    enabled: keysOn,
  });
  useHotkey('j', () => moveTo(activeIndex + 1), { enabled: keysOn });
  useHotkey('k', () => moveTo(activeIndex - 1), { enabled: keysOn });
  useHotkey(
    'enter',
    (e) => {
      if (isInteractive(e.target)) return;
      e.preventDefault();
      const g = groups[activeIndex];
      if (g) resolveGroup(g);
    },
    { enabled: keysOn, preventDefault: false },
  );

  // ------------------------------------------------------------ 头部
  const suggestedReclaim = useMemo(() => groups.reduce((n, g) => n + reclaimBytes(g, g.suggestedKeepIds), 0), [groups]);
  // 打开确认框时把计划定格下来，处理过程中列表变化不影响弹窗里的数字
  const [plans, setPlans] = useState<ResolvePlan[]>([]);
  const openConfirm = () => {
    // 「可能是同一套」的不跟着一键处理；全是书里的页（没有可删的）也跳过
    setPlans(
      groups
        .filter((g) => !g.setId)
        .map((g) => {
          const keepIds = keepOf(g);
          return { id: g.id, exact: g.kind === 'exact', keepIds, trashCount: g.images.length - keepIds.length, bytes: reclaimBytes(g, keepIds) };
        })
        .filter((p) => p.trashCount > 0),
    );
    setConfirmOpen(true);
  };

  let subtitle: string;
  if (view === 'resolved') {
    subtitle = resolvedQ.data ? `已处理 ${formatCount(resolvedQ.data.length)} 组` : '正在加载…';
  } else if (pendingQ.data) {
    subtitle = groups.length ? `${formatCount(groups.length)} 组 · 可释放 ${formatBytes(suggestedReclaim)}` : '没有待处理的重复';
  } else {
    subtitle = stats.data ? `${formatCount(stats.data.duplicateGroupCount)} 组` : '正在加载…';
  }

  const pendingCount = pendingQ.data ? groups.length : stats.data?.duplicateGroupCount;

  return (
    <>
      <PageHeader title="重复" subtitle={subtitle} actions={<RescanButton />} sticky>
        <div className="flex items-center gap-3">
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              {
                value: 'pending',
                label: (
                  <>
                    待处理
                    {pendingCount !== undefined && pendingCount > 0 && (
                      <span className="text-[11px] text-fg-subtle tabular">{formatCount(pendingCount)}</span>
                    )}
                  </>
                ),
              },
              { value: 'resolved', label: '已处理' },
            ]}
          />
          {view === 'pending' && groups.length > 0 && (
            <div className="ml-auto flex items-center gap-4">
              <span className="hidden items-center gap-1.5 text-[12px] text-fg-subtle lg:flex">
                <span className="size-1.5 rounded-full bg-shu" aria-hidden />
                <span className="mr-3">朱色为组内最优</span>
                <Kbd>J</Kbd>
                <Kbd>K</Kbd>
                <span className="mr-2">切换</span>
                <Kbd>↵</Kbd>
                <span className="mr-2">处理当前组</span>
                <Kbd>Z</Kbd>
                <span>放大对比</span>
              </span>
              <Button variant="outline" icon={<CheckCheck className="size-4" />} onClick={openConfirm}>
                全部按推荐处理
              </Button>
            </div>
          )}
        </div>
        {job && <Progress value={job.total ? job.progress / job.total : null} tone="shu" className="mt-4 animate-fade-in" />}
      </PageHeader>

      <PageBody className="pt-2">
        {view === 'pending' ? (
          pendingQ.isPending ? (
            <DuplicatesSkeleton />
          ) : pendingQ.isError && !pendingQ.data ? (
            <ErrorState error={pendingQ.error} onRetry={() => void pendingQ.refetch()} />
          ) : groups.length === 0 ? (
            // 三种状态分开说（TR-B2）：正在查 / 从没查过 / 查完了
            job ? (
              <EmptyState glyph="查" title="正在查找重复" description="按内容和画面相似度比对全部图片，找到的会陆续出现在这里。" />
            ) : !settings.data?.dedupe.lastRunAt ? (
              <EmptyState
                glyph="查"
                title="还没有查找过重复"
                description="扫描和缩略图完成后会自动查找，也可以现在开始。"
                action={<RescanButton variant="primary" />}
              />
            ) : (
              <EmptyState
                glyph="净"
                title="没有重复了"
                description="所有重复组都处理完了。新图入库后，可以再查找一遍。"
                action={<RescanButton variant="primary" />}
              />
            )
          ) : (
            <div className="relative flex animate-fade-in flex-col gap-5">
              <AnimatePresence mode="popLayout" initial={false}>
                {segments(groups.slice(0, count)).map((seg) => {
                  const cards = seg.items.map(({ g, i }) => (
                    <DuplicateGroupCard
                      key={g.id}
                      group={g}
                      index={i}
                      keepIds={keepOf(g)}
                      active={i === activeIndex}
                      busy={busy.has(g.id)}
                      roots={roots}
                      onActivate={() => setActiveId(g.id)}
                      onToggle={(imageId) => toggle(g, imageId)}
                      onResolve={() => resolveGroup(g)}
                      onIgnore={() => ignoreGroup(g)}
                      lensOn={lensGroup === g.id}
                      onToggleLens={() => setLensGroup((cur) => (cur === g.id ? null : g.id))}
                      onOpen={(k) =>
                        showLightbox(
                          g.images.map((img) => img.id),
                          k,
                        )
                      }
                    />
                  ));
                  return seg.setId ? (
                    <DuplicateSetFrame key={`set-${seg.setId}`} count={seg.items.length}>
                      <AnimatePresence mode="popLayout" initial={false}>
                        {cards}
                      </AnimatePresence>
                    </DuplicateSetFrame>
                  ) : (
                    cards
                  );
                })}
              </AnimatePresence>
              {hasMore ? (
                <div ref={sentinelRef} className="h-px" aria-hidden />
              ) : (
                <p className="pt-4 text-center text-[12px] text-fg-subtle tabular">— 以上是全部 {formatCount(groups.length)} 组 —</p>
              )}
            </div>
          )
        ) : resolvedQ.isPending ? (
          <ResolvedGroupsSkeleton />
        ) : resolvedQ.isError && !resolvedQ.data ? (
          <ErrorState error={resolvedQ.error} onRetry={() => void resolvedQ.refetch()} />
        ) : !resolvedQ.data?.length ? (
          <EmptyState glyph="迹" title="还没有处理过的重复" description="在「待处理」里保留或标记「不是重复」之后，会留在这里方便回看。" />
        ) : (
          <ResolvedGroups groups={resolvedQ.data} />
        )}
      </PageBody>

      <ResolveAllDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        plans={plans}
        skipped={groups.filter((g) => g.setId).length}
        onDone={dismiss}
      />
    </>
  );
}
