import { POSEWEAR_SET_LABEL, type PoseWearMatch, type PoseWearOfResponse, type PoseWearPose, type PoseWearSet, type PoseWearSetGroup } from '@emaki/shared';
import { PersonStanding, X } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Chip, Dialog, SearchInput, Segmented, Skeleton, Switch } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useBlurPrefs, usePrefs } from '@/lib/stores';
import { findPoseWear, usePoseWear, usePoseWearOf } from './client';
import { moveFocus } from './ui';

/**
 * PoseWear 姿势库（实验）的界面零件：图库工具条里的入口 / 已选的 chip、挑姿势的对话框、看图器信息里的「姿势」一行。
 * 线稿是 PoseWear 的图，用户导入后从本机数据目录取（不随软件分发）。
 */

/** 线稿：白底黑线，放在一小块白纸上（深色主题里也是白纸） */
export function PoseWearArt({ src, className }: { src: string; className?: string }) {
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      className={cn('aspect-[3/4] shrink-0 bg-white object-contain', className)}
    />
  );
}

// ------------------------------------------------------------------ 工具条入口

export interface PoseWearEntryProps {
  pose: string | undefined;
  onPick: (id: string) => void;
  onClear: () => void;
}

/** 没选时是「按姿势」chip；选了是线稿 + 姿势名 + 叉，点名字换一个 */
export function PoseWearEntry({ pose, onPick, onClear }: PoseWearEntryProps) {
  const [open, setOpen] = useState(false);
  // 选着的姿势可能已经没有图了：用全部的目录找名字
  const catalog = usePoseWear(!!pose, true);
  const p = findPoseWear(catalog.data, pose);
  const reliable = usePrefs((s) => s.poseReliableOnly);
  const setReliable = usePrefs((s) => s.setPoseReliableOnly);
  return (
    <>
      {pose ? (
        <span className="inline-flex h-7 shrink-0 animate-fade-in items-center rounded-full bg-ink pr-1 text-xs font-medium text-fg-inverse">
          <button
            type="button"
            onClick={() => setOpen(true)}
            title={p ? `${POSEWEAR_SET_LABEL[p.set]} · ${p.category} · ${p.name}（点一下换一个）` : '换一个姿势'}
            className="inline-flex h-full items-center gap-1.5 rounded-l-full pr-1 pl-1"
          >
            {p ? (
              <img src={p.thumbUrl} alt="" draggable={false} className="h-5 w-[15px] rounded-[3px] bg-white object-contain" />
            ) : (
              <span className="size-5 rounded-full bg-fg-inverse/20" />
            )}
            <span className="max-w-[12em] truncate">{p?.name ?? '姿势'}</span>
          </button>
          {/* 这个姿势有低置信的图时才给开关：只看可靠的（本机记住） */}
          {p && p.low > 0 && (
            <button
              type="button"
              aria-pressed={reliable}
              onClick={() => setReliable(!reliable)}
              title={reliable ? `只看可靠的（去掉了 ${p.low} 张低置信的）；点一下全看` : `只看可靠的：去掉 ${p.low} 张低置信的`}
              className={cn(
                'mr-0.5 h-5 rounded-full px-1.5 text-[11px] font-normal transition-colors',
                reliable ? 'bg-fg-inverse/20 text-fg-inverse' : 'text-fg-inverse/55 hover:bg-fg-inverse/10 hover:text-fg-inverse/85',
              )}
            >
              只看可靠的
            </button>
          )}
          <button
            type="button"
            aria-label={`去掉姿势筛选${p ? `「${p.name}」` : ''}`}
            onClick={onClear}
            className="flex size-5 items-center justify-center rounded-full text-fg-inverse/60 hover:bg-fg-inverse/15 hover:text-fg-inverse"
          >
            <X className="size-3" />
          </button>
        </span>
      ) : (
        <Chip size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
          <span className="inline-flex items-center gap-1">
            <PersonStanding className="size-3.5" strokeWidth={1.8} aria-hidden />
            按姿势
          </span>
        </Chip>
      )}
      <PoseWearBrowser
        open={open}
        onOpenChange={setOpen}
        current={pose}
        onPick={(id) => {
          setOpen(false);
          onPick(id);
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ 挑姿势

type SetTab = PoseWearSet | 'all';

/** 显示的张数：只看可靠的时候去掉低置信的 */
export const shownCount = (p: Pick<PoseWearPose, 'count' | 'low'>, reliable: boolean) => (reliable ? p.count - p.low : p.count);

/** 去掉成人的姿势（双人的成人一类）；adultOk = 顶栏的模糊关着。空了的分类、套也去掉 */
export function withoutAdult(sets: readonly PoseWearSetGroup[], adultOk: boolean): PoseWearSetGroup[] {
  if (adultOk) return [...sets];
  return sets
    .map((s) => {
      const categories = s.categories
        .map((c) => {
          const poses = c.poses.filter((p) => !p.adult);
          return { ...c, poses, count: poses.reduce((n, p) => n + p.count, 0) };
        })
        .filter((c) => c.poses.length > 0);
      return { ...s, categories, count: categories.reduce((n, c) => n + c.count, 0) };
    })
    .filter((s) => s.categories.length > 0);
}

export function PoseWearBrowser({
  open,
  onOpenChange,
  current,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string | undefined;
  onPick: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [tab, setTab] = useState<SetTab>('all');
  const [search, setSearch] = useState('');
  const term = useDeferredValue(search.trim().toLowerCase());
  const catalog = usePoseWear(open, showAll);
  const grid = useRef<HTMLDivElement>(null);
  const reliable = usePrefs((s) => s.poseReliableOnly);
  const setReliable = usePrefs((s) => s.setPoseReliableOnly);
  // 双人的「成人」一类：模糊敏感图（顶栏眼睛）开着时不显示
  const adultOk = !useBlurPrefs().blurSensitive;
  const sets = useMemo(() => withoutAdult(catalog.data?.sets ?? [], adultOk), [catalog.data, adultOk]);

  // 打开时：焦点落到当前选中的那格
  const loaded = !!catalog.data;
  useEffect(() => {
    if (!open || !loaded || !current) return;
    const id = requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>('[data-pose-cell][aria-pressed="true"]')?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, loaded, current]);

  // 按套、名字（也认编号 P012）筛
  const shown = useMemo(() => {
    const hit = (p: PoseWearPose) =>
      (!term || p.name.toLowerCase().includes(term) || p.number.toLowerCase() === term || p.category.includes(term)) &&
      // 只看可靠的：全是低置信的姿势这时没有图
      (showAll || shownCount(p, reliable) > 0);
    return sets
      .filter((s) => tab === 'all' || s.id === tab)
      .map((s) => ({
        ...s,
        categories: s.categories
          .map((c) => {
            const poses = c.poses.filter(hit);
            return { ...c, poses, count: poses.reduce((n, p) => n + shownCount(p, reliable), 0) };
          })
          .filter((c) => c.poses.length > 0),
      }))
      .filter((s) => s.categories.length > 0);
  }, [sets, tab, term, reliable, showAll]);

  const options = [
    { value: 'all' as SetTab, label: '全部' },
    ...sets.map((s) => ({ value: s.id as SetTab, label: s.name })),
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={880}
      title="按姿势"
      description="PoseWear 姿势库，按骨架和标签匹配。点一个姿势只看这个姿势的图，最像的排在前面。"
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {sets.length > 1 && <Segmented size="sm" value={tab} onChange={setTab} options={options} />}
        <SearchInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜姿势名"
          aria-label="搜姿势名"
          className="w-[200px]"
        />
        <span className="ml-auto flex items-center gap-4 text-[12px] text-fg-muted">
          <span className="flex items-center gap-2" title="去掉低置信的匹配：标签对不太上、主要靠骨架的那些">
            只看可靠的
            <Switch label="只看可靠的" checked={reliable} onCheckedChange={setReliable} />
          </span>
          <span className="flex items-center gap-2">
            没有图的也显示
            <Switch label="没有图的姿势也显示" checked={showAll} onCheckedChange={setShowAll} />
          </span>
        </span>
      </div>
      <div ref={grid} onKeyDown={(e) => moveFocus(e, grid.current)} className="-mx-1 space-y-6">
        {catalog.isPending ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-3 px-1">
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton key={i} className="aspect-[3/5] rounded-[6px]" />
            ))}
          </div>
        ) : catalog.isError ? (
          <p className="px-1 text-[13px] text-danger">{catalog.error.message}</p>
        ) : catalog.data.poses === 0 ? (
          <p className="px-1 py-6 text-center text-[13px] text-fg-muted">还没有导入 PoseWear 姿势库：设置 → 姿势检索 → 导入。</p>
        ) : shown.length === 0 ? (
          <p className="px-1 py-6 text-center text-[13px] text-fg-muted">
            {term ? `没有叫「${search.trim()}」的姿势。` : '还没有图匹配到姿势：设置 → 姿势检索 → 导入姿势匹配结果。'}
          </p>
        ) : (
          shown.map((s) => (
            <section key={s.id} aria-label={s.name} className="space-y-4 px-1">
              {s.categories.map((c) => (
                <div key={c.name} role="group" aria-labelledby={`pw-${s.id}-${c.name}`}>
                  <h3 id={`pw-${s.id}-${c.name}`} className="mb-2.5 flex items-baseline gap-3 text-[13px] font-semibold tracking-tight">
                    {(tab === 'all' || s.id === 'pair') && c.name !== s.name && <span className="font-normal text-fg-muted">{s.name} ·</span>}
                    <span className="-ml-2 first:ml-0">{c.name}</span>
                    <span className="text-[11.5px] font-normal text-fg-subtle tabular">{formatCount(c.count)} 张</span>
                    <span aria-hidden className="h-px flex-1 translate-y-[-3px] bg-line" />
                  </h3>
                  <div role="list" className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-3">
                    {c.poses.map((p) => {
                      const selected = p.id === current;
                      const n = shownCount(p, reliable);
                      return (
                        <div role="listitem" key={p.id}>
                          <button
                            type="button"
                            data-pose-cell
                            aria-pressed={selected}
                            aria-label={`${s.name}·${c.name}·${p.name}，${n} 张`}
                            title={s.id === 'pair' ? p.name : `${p.number} ${p.name}`}
                            onClick={() => onPick(p.id)}
                            className={cn(
                              'flex w-full flex-col items-stretch rounded-[8px] p-1.5 text-left transition-colors hover:bg-hover',
                              selected && 'bg-hover',
                              n === 0 && 'opacity-55',
                            )}
                          >
                            <PoseWearArt src={p.thumbUrl} className={cn('w-full rounded-[6px] ring-1 ring-line', selected && 'ring-2 ring-ink')} />
                            <span className="mt-1.5 line-clamp-2 text-[12px] leading-snug font-medium">{p.name}</span>
                            <span className="text-[11px] text-fg-subtle tabular">
                              {formatCount(n)} 张
                              {!reliable && p.low > 0 && <span title="其中低置信的张数"> · 低 {formatCount(p.low)}</span>}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </section>
          ))
        )}
      </div>
      <p className="mt-5 border-t border-line pt-3 text-[11.5px] leading-relaxed text-fg-subtle">
        线稿来自 PoseWear（MIT）。一张图像几个姿势就在几个姿势下都有；按骨架和标签的加权分排；「低」是标签对不太上、主要靠骨架匹配的，可以只看可靠的。
        双人按互动类型分，同一组差分只出现一张{adultOk ? '' : '；成人的几类要先关掉顶栏的模糊才显示'}。新加的图要重新跑匹配、再导入匹配结果才会出现在这里。
      </p>
    </Dialog>
  );
}

// ------------------------------------------------------------------ 看图器信息

/** 看图器里列的匹配：主要的在前；成人的双人类型只在 adultOk（顶栏的模糊关着）时列 */
export function visibleMatches(of: PoseWearOfResponse | undefined, adultOk: boolean): PoseWearMatch[] {
  return [of?.primary, ...(of?.related ?? [])].filter((m): m is PoseWearMatch => !!m && (adultOk || !m.pose.adult));
}

/** 看图器里的「低」：和网格上的一样淡 */
function LowTag() {
  return (
    <span title="低置信：标签对不太上，主要靠骨架匹配" className="ml-1 rounded-[3px] bg-sunken px-1 text-[10px] text-fg-subtle">
      低
    </span>
  );
}

/**
 * 信息面板「信息」里的一行：主要姿势（线稿 + 名字，点了按这个姿势筛），下面是其他也匹配上的姿势（单人、双人分开，低置信的标「低」）。
 * 成人的双人类型在模糊敏感图时不列。没有匹配就不占地方
 */
export function PoseWearInfoRow({ imageId, onNavigate }: { imageId: string; onNavigate: () => void }) {
  const of = usePoseWearOf(imageId, true);
  const all = visibleMatches(of.data, !useBlurPrefs().blurSensitive);
  const primary = all[0];
  if (!primary) return null;
  const rest = all.slice(1);
  const singles = rest.filter((r) => r.pose.set !== 'pair');
  const pairs = rest.filter((r) => r.pose.set === 'pair');
  const link = (id: string) => `/gallery?pwPose=${encodeURIComponent(id)}`;
  const line = (label: string, list: PoseWearMatch[]) =>
    list.length > 0 && (
      <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
        <span className="text-fg-subtle">{label}</span>
        {list.map((r) => (
          <span key={r.pose.id} className="inline-flex items-center">
            <Link
              to={link(r.pose.id)}
              onClick={onNavigate}
              title={`${POSEWEAR_SET_LABEL[r.pose.set]} · ${r.pose.category}：看这个姿势的 ${r.pose.count} 张`}
              className="text-fg-muted underline-offset-2 transition-colors hover:text-shu hover:underline"
            >
              {r.pose.name}
            </Link>
            {r.low && <LowTag />}
          </span>
        ))}
      </span>
    );
  return (
    <>
      <dt className="text-fg-subtle">姿势</dt>
      <dd className="min-w-0">
        <Link
          to={link(primary.pose.id)}
          onClick={onNavigate}
          title={`${POSEWEAR_SET_LABEL[primary.pose.set]} · ${primary.pose.category}：看这个姿势的 ${primary.pose.count} 张`}
          className="group/pw flex items-center gap-2.5"
        >
          <PoseWearArt src={primary.viewThumbUrl} className="w-9 rounded-[3px] ring-1 ring-line transition-shadow group-hover/pw:ring-ink" />
          <span className="min-w-0">
            <span className="block text-[12.5px] leading-snug text-fg transition-colors group-hover/pw:text-shu">
              {primary.pose.name}
              {primary.low && <LowTag />}
            </span>
            <span className="block text-[11px] text-fg-subtle">
              {POSEWEAR_SET_LABEL[primary.pose.set]} · {primary.pose.category}
            </span>
          </span>
        </Link>
        {line('也像', singles)}
        {line('双人', pairs)}
      </dd>
    </>
  );
}
