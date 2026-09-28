import type { UnrecognizedSummary } from '@emaki/shared';
import { ArrowRight } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button, EmptyState, ErrorState } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { useHotkey } from '@/lib/hotkeys';
import { useLightbox } from '@/lib/stores';
import { usePriorityKeys, useTriageKeysEnabled } from '../hooks';
import { useTriage } from '../useTriage';
import type { UnrecognizedView } from '../useUnrecognizedParams';
import { BatchPanel } from './BatchPanel';
import { BatchPreview } from './BatchPreview';
import { DecisionPanel } from './DecisionPanel';
import { PreviewStage } from './PreviewStage';
import { StampOverlay } from './StampOverlay';
import { TriageQueue } from './TriageQueue';
import { TriageSkeleton } from './TriageSkeleton';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * 「有建议」「待识别」两段：逐张三栏（队列 / 预览 / 决策），全程可以只用键盘：
 *   1–9 采纳建议 · / 搜索角色 · J/→ 跳过 · K/← 上一张 · E 排除 · X 多选 · 空格 看大图 · Esc 取消选择
 * 快捷键只在这两段注册（T34b）。
 */
export function TriageBody({
  bucket,
  summary,
  onBucket,
}: {
  bucket: 'suggested' | 'untagged';
  summary?: UnrecognizedSummary;
  onBucket: (b: UnrecognizedView) => void;
}) {
  const navigate = useNavigate();
  const triage = useTriage(bucket);
  const { query, items, current, batch } = triage;
  const searchRef = useRef<HTMLInputElement>(null);

  const keysEnabled = useTriageKeysEnabled();
  const ready = items.length > 0;
  // 「不是插画」菜单打开时，数字键和字母键都归菜单
  const on = keysEnabled && ready && !triage.kindMenuOpen;

  // ---------------------------------------------------------------- 看图器
  // 从这里打开的看图器关掉时，把当前项同步到看图器最后停留的那张
  const latest = useRef(triage);
  latest.current = triage;
  const ownsLightbox = useRef(false);

  useEffect(
    () =>
      useLightbox.subscribe((s, prev) => {
        if (!prev.open || s.open || !ownsLightbox.current) return;
        ownsLightbox.current = false;
        const id = s.ids[s.index];
        if (id) latest.current.focusId(id);
      }),
    [],
  );

  const openLightbox = () => {
    if (!current) return;
    ownsLightbox.current = true;
    useLightbox.getState().show(
      items.map((it) => it.image.id),
      triage.index,
    );
  };

  // ---------------------------------------------------------------- 快捷键
  // 多选时 J/K 仍然移动队列里的当前项，配合 X 就能纯键盘挑一批
  useHotkey(['j', 'arrowright'], () => triage.next(), { enabled: on });
  useHotkey(['k', 'arrowleft'], () => triage.prev(), { enabled: on });
  // 会改数据的键忽略按住不放的自动重复，免得一口气处理掉好几张
  useHotkey('e', (e) => !e.repeat && triage.exclude(), { enabled: on });
  useHotkey('n', (e) => !e.repeat && triage.setKindMenuOpen(true), { enabled: on });
  useHotkey('x', (e) => !e.repeat && triage.toggleCurrent(), { enabled: on });
  useHotkey('a', (e) => !e.repeat && triage.selectSameTop(), { enabled: on && !batch });
  useHotkey('space', (e) => !e.repeat && openLightbox(), { enabled: on });
  useHotkey('esc', () => triage.clearSelection(), { enabled: keysEnabled && batch });

  // 数字键和 / 要抢在全局快捷键（跳页 / 命令面板）前面
  usePriorityKeys(
    [...DIGITS, '/'],
    (key, e) => {
      if (key === '/') {
        searchRef.current?.focus();
        return;
      }
      if (e.repeat) return;
      const i = Number(key) - 1;
      if (batch) {
        const s = triage.aggregated[i];
        if (s) triage.acceptAggregated(s);
        else if (i >= 3) return false;
        return;
      }
      const s = current?.suggestions[i];
      if (s) triage.acceptSuggestion(s);
      // 1–3 在这一页始终表示「采纳」：没有对应建议就吞掉，免得手快误跳到别的页面
      else if (i >= 3) return false;
    },
    on,
  );

  // 已加载的都处理完了但后面还有 → 自动接着拉
  const needsMore = !ready && triage.hasNextPage;
  useEffect(() => {
    if (needsMore) latest.current.loadMore();
  }, [needsMore, query.isFetching]);

  // ---------------------------------------------------------------- 内容
  let body: ReactNode;
  if (query.isPending || (needsMore && !query.isError)) {
    body = <TriageSkeleton />;
  } else if (query.isError && !query.data) {
    body = (
      <div className="flex flex-1 items-center justify-center">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  } else if (!ready) {
    body = (
      <div className="flex flex-1 items-center justify-center">
        <TriageEmpty bucket={bucket} summary={summary} doneCount={triage.doneCount} onBucket={onBucket} onGallery={() => navigate('/gallery')} />
      </div>
    );
  } else {
    body = (
      <>
        <TriageQueue triage={triage} />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {batch ? (
            <BatchPreview items={triage.selectedItems} onToggle={triage.toggleSelect} />
          ) : (
            current && <PreviewStage item={current} direction={triage.direction} onOpen={openLightbox} />
          )}
          <StampOverlay stamp={triage.stamp} />
        </div>
        {batch ? (
          <BatchPanel triage={triage} searchRef={searchRef} />
        ) : (
          current && <DecisionPanel triage={triage} item={current} searchRef={searchRef} />
        )}
      </>
    );
  }

  return <>{body}</>;
}

/** 这一段处理完了：指向下一段还有活的地方（TR-1 第 10 条） */
function TriageEmpty({
  bucket,
  summary,
  doneCount,
  onBucket,
  onGallery,
}: {
  bucket: 'suggested' | 'untagged';
  summary?: UnrecognizedSummary;
  doneCount: number;
  onBucket: (b: UnrecognizedView) => void;
  onGallery: () => void;
}) {
  const art = summary?.art;
  const done = doneCount > 0 ? `这一轮整理了 ${formatCount(doneCount)} 张。` : '';
  if (art && art.total === 0) {
    return (
      <EmptyState
        glyph="清"
        title="全部识别完了"
        description={`${done}新入库的图如果认不出角色，会在这里等你确认。`}
        action={
          <Button variant="secondary" trailing={<ArrowRight className="size-4" />} onClick={onGallery}>
            去图库看看
          </Button>
        }
      />
    );
  }
  const unsure = art?.unsure ?? 0;
  return (
    <EmptyState
      glyph="清"
      title={bucket === 'suggested' ? '有建议的都处理完了' : '都识别过了'}
      description={
        unsure > 0
          ? `${done}还有 ${formatCount(unsure)} 张 tagger 没认出，需要你手动归类。`
          : `${done}新入库的图会自动排队识别。`
      }
      action={
        unsure > 0 ? (
          <Button variant="secondary" trailing={<ArrowRight className="size-4" />} onClick={() => onBucket('unsure')}>
            去处理没认出的
          </Button>
        ) : undefined
      }
    />
  );
}
