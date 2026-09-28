import type { Exclusion, ID } from '@emaki/shared';
import { CheckCheck, Plus, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useMemo, useState } from 'react';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { Button, EmptyState, ErrorState, SectionTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { modKeyLabel, useHotkey } from '@/lib/hotkeys';
import { useExclusions, useMutate, useStats } from '@/lib/queries';
import { useLightbox, useOverlays } from '@/lib/stores';
import { AddRuleDialog } from './components/AddRuleDialog';
import { ExcludedSkeleton } from './components/ExcludedSkeleton';
import { RuleRow } from './components/RuleRow';
import { SelectionBar } from './components/SelectionBar';
import { SingleImagesSection } from './components/SingleImagesSection';
import { useSinglesSelection } from './useSinglesSelection';
import { sortRules } from './utils';

/**
 * 已排除 —— 规则（标签 / 文件夹 / 角色）在上，单张图片在下。
 * 恢复都带撤销；单张可以多选后一次恢复。
 */
export function ExcludedPage() {
  const query = useExclusions();
  const stats = useStats();
  const [addOpen, setAddOpen] = useState(false);

  const all = useMemo(() => query.data ?? [], [query.data]);
  const rules = useMemo(() => sortRules(all.filter((e) => e.kind !== 'image')), [all]);
  const singles = useMemo(() => all.filter((e) => e.kind === 'image'), [all]);
  const singleIds = useMemo(() => singles.map((e) => e.target), [singles]);
  const selection = useSinglesSelection(singleIds);
  const selectedCount = selection.selected.size;

  // 规则 / 单张都走 deleteExclusion；多选恢复走 bulk restore，一次一个撤销
  const restore = useMutate((id: ID) => api.deleteExclusion(id));
  const restoreMany = useMutate((ids: ID[]) => api.bulkImages({ ids, action: { type: 'restore' } }), {
    onSuccess: () => selection.clear(),
  });
  const busyId = restore.isPending ? (restore.variables ?? null) : null;
  const restoreRule = (e: Exclusion) => {
    if (!restore.isPending) restore.mutate(e.id);
  };

  const lightboxOpen = useLightbox((s) => s.open);
  const overlayOpen = useOverlays((s) => s.commandOpen || s.helpOpen);
  const keysOn = !addOpen && !lightboxOpen && !overlayOpen;
  useHotkey('esc', () => selection.clear(), { enabled: keysOn && selectedCount > 0 });
  useHotkey('mod+a', () => selection.selectAll(), { enabled: keysOn && singles.length > 0 });

  const excludedTotal = stats.data?.excludedCount ?? all.reduce((n, e) => n + e.imageCount, 0);
  const subtitle = query.data
    ? [
        `${formatCount(excludedTotal)} 张`,
        `${formatCount(rules.length)} 条规则`,
        singles.length ? `${formatCount(singles.length)} 张单独排除` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '正在加载…';

  return (
    <>
      <PageHeader
        title="已排除"
        subtitle={subtitle}
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>
            添加规则
          </Button>
        }
      >
        <p className="inline-flex items-center gap-2 rounded-full bg-sunken px-3.5 py-1.5 text-[12.5px] text-fg-muted">
          <ShieldCheck className="size-3.5 shrink-0 text-fg-subtle" />
          排除的图片不会出现在图库和统计里，文件本身不会被删除。
        </p>
      </PageHeader>

      <PageBody className="pt-4">
        {query.isPending ? (
          <ExcludedSkeleton />
        ) : query.isError && !query.data ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : all.length === 0 ? (
          <EmptyState
            glyph="除"
            title="没有排除任何图片"
            description="不想在图库里看到的图，可以在图库或看图器里按 E 排除；也可以按标签、文件夹或角色添加规则整批排除。"
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>
                添加规则
              </Button>
            }
          />
        ) : (
          <div className="animate-fade-in space-y-10">
            <section>
              <SectionTitle hint={`${formatCount(rules.length)} 条 · 按标签、文件夹或角色整批排除`}>规则</SectionTitle>
              {rules.length ? (
                <ul className="relative flex flex-col gap-2.5">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {rules.map((rule) => (
                      <RuleRow
                        key={rule.id}
                        rule={rule}
                        busy={busyId === rule.id}
                        onRestore={() => restoreRule(rule)}
                      />
                    ))}
                  </AnimatePresence>
                </ul>
              ) : (
                <RulesEmpty onAdd={() => setAddOpen(true)} />
              )}
            </section>

            {singles.length > 0 && (
              <SingleImagesSection
                singles={singles}
                selection={selection}
                busyId={busyId}
                onRestore={restoreRule}
              />
            )}
          </div>
        )}
      </PageBody>

      <SelectionBar
        count={selectedCount}
        actions={[
          {
            key: 'restore',
            label: '恢复',
            icon: <RotateCcw />,
            loading: restoreMany.isPending,
            onClick: () => restoreMany.mutate([...selection.selected]),
          },
          {
            key: 'all',
            label: '全选',
            icon: <CheckCheck />,
            shortcut: `${modKeyLabel} A`,
            onClick: selection.selectAll,
          },
          { key: 'clear', label: '取消选择', icon: <X />, shortcut: 'Esc', onClick: selection.clear },
        ]}
      />

      <AddRuleDialog open={addOpen} onOpenChange={setAddOpen} existing={all} />
    </>
  );
}

/** 没有规则时的安静提示（单张排除还在下面） */
function RulesEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[16px] border border-dashed border-line-strong px-5 py-5">
      <div>
        <div className="text-sm font-medium">还没有规则</div>
        <div className="mt-0.5 text-[12.5px] text-fg-muted">
          比如排除所有带 comic 标签的漫画分镜，或者整个表情包文件夹。
        </div>
      </div>
      <Button size="sm" icon={<Plus className="size-3.5" />} onClick={onAdd}>
        添加规则
      </Button>
    </div>
  );
}
