import {
  UNRECOGNIZED_ANNEX_KINDS,
  UNRECOGNIZED_THEMES,
  type UnrecognizedAnnexKind,
  type UnrecognizedSummary,
  type UnrecognizedTheme,
} from '@emaki/shared';
import { ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ScrollContainerContext } from '@/components/layout/ScrollContainer';
import { ImageGrid, ImageGridSkeleton } from '@/components/media/ImageGrid';
import { Button, EmptyState, ErrorState, Kbd, SectionTitle, Skeleton } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { KIND_LABEL } from '@/lib/kinds';
import { useHotkey } from '@/lib/hotkeys';
import { type UnrecognizedParams } from '@/lib/queries';
import { NewCharacterDialog } from '@/features/characters/overview/NewCharacterDialog';
import { usePriorityKeys, useTriageKeysEnabled } from '../hooks';
import { useSheet } from '../useSheet';
import { ANNEX_HINT, CJK_NO, ORDER_NOTE, PRECEDENCE_NOTE, THEME_META } from '../themes';
import type { UnrecognizedParamsApi } from '../useUnrecognizedParams';
import { PanelShell, SessionNote } from './DecisionPanel';
import { FreshButton } from './FreshButton';
import { PanelSection } from './PanelParts';
import { SheetBatchPanel } from './SheetBatchPanel';
import { StampOverlay } from './StampOverlay';
import { ChipRow, ThemeIndex, type IndexEntry } from './ThemeIndex';

export type SheetMode = 'unsure' | 'shelved' | 'annex';

/**
 * 印样（T34b）：目次 + 两端对齐的网格 + 本组说明。用于「没认出」（按主题）、「放下的」和「照片 · 文字等」。
 * 批量处理在 T34c 加。
 */
export function SheetLayout({ mode, p, summary }: { mode: SheetMode; p: UnrecognizedParamsApi; summary?: UnrecognizedSummary }) {
  const navigate = useNavigate();
  const entries: IndexEntry[] | null = useMemo(() => {
    if (!summary) return null;
    if (mode === 'unsure')
      return UNRECOGNIZED_THEMES.map((t) => ({ key: t, label: THEME_META[t].label, hint: THEME_META[t].hint, count: summary.art.themes[t] }));
    if (mode === 'annex')
      return UNRECOGNIZED_ANNEX_KINDS.map((k) => ({ key: k, label: KIND_LABEL[k], hint: ANNEX_HINT[k], count: summary.annex.kinds[k] }));
    return null;
  }, [mode, summary]);
  const active = mode === 'unsure' ? p.theme : mode === 'annex' ? p.kind : undefined;
  const pickEntry = (key: string) => (mode === 'unsure' ? p.setTheme(key as UnrecognizedTheme) : p.setKind(key as UnrecognizedAnnexKind));

  const params: UnrecognizedParams =
    mode === 'unsure' ? { area: 'art', bucket: 'unsure', theme: p.theme } : mode === 'shelved' ? { area: 'art', bucket: 'shelved' } : { area: 'annex', kind: p.kind };
  // 主题 / 类型还没补上默认值时先不拉
  const ready = mode === 'shelved' || !!active;
  const sheet = useSheet(params, ready);
  const { query, items, total } = sheet;

  // ---------------------------------------------------------------- 批量处理（T34c）
  const searchRef = useRef<HTMLInputElement>(null);
  const [kindOpen, setKindOpen] = useState(false);
  const [ratingOpen, setRatingOpen] = useState(false);
  const [createName, setCreateName] = useState<string | null>(null);
  const keysOn = useTriageKeysEnabled() && !kindOpen && !ratingOpen && createName === null;
  const edit = keysOn && sheet.batch;
  const once = (fn: () => void) => (e: KeyboardEvent) => !e.repeat && fn();
  useHotkey('mod+a', () => sheet.selectLoaded(), { enabled: keysOn && items.length > 0 });
  useHotkey('h', once(() => sheet.shelve(mode !== 'shelved')), { enabled: edit && mode !== 'annex' });
  useHotkey('o', once(() => sheet.markOriginal(true)), { enabled: edit && mode !== 'annex' });
  useHotkey('c', once(() => setKindOpen(true)), { enabled: edit });
  useHotkey('r', once(() => setRatingOpen(true)), { enabled: edit });
  useHotkey('e', once(() => sheet.exclude()), { enabled: edit });
  useHotkey('esc', () => sheet.clear(), { enabled: keysOn && sheet.batch });
  const stepGroup = (d: 1 | -1) => {
    if (!entries) return;
    const i = entries.findIndex((e) => e.key === active);
    for (let k = i + d; k >= 0 && k < entries.length; k += d) {
      if (entries[k]!.count > 0) return pickEntry(entries[k]!.key);
    }
  };
  useHotkey('[', () => stepGroup(-1), { enabled: keysOn && !!entries });
  useHotkey(']', () => stepGroup(1), { enabled: keysOn && !!entries });
  usePriorityKeys(['/'], () => searchRef.current?.focus(), keysOn && sheet.batch);

  // 切组时回到顶部
  const scrollRef = useRef<HTMLDivElement>(null);
  const groupKey = `${mode}:${active ?? ''}`;
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [groupKey]);

  const index = entries ? entries.findIndex((e) => e.key === active) : -1;
  const entry = index >= 0 ? entries![index]! : null;
  const label = mode === 'shelved' ? '放下的' : (entry?.label ?? '');
  const nextEntry = entries?.slice(index + 1).find((e) => e.count > 0) ?? entries?.find((e) => e.count > 0 && e.key !== active);

  let grid: React.ReactNode;
  if (!summary || !ready || query.isPending) {
    grid = <ImageGridSkeleton rows={4} rowHeight={184} />;
  } else if (query.isError && !query.data) {
    grid = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else if (items.length === 0) {
    const allZero = entries ? entries.every((e) => e.count === 0) : true;
    grid =
      allZero && mode === 'unsure' ? (
        <EmptyState glyph="清" title="没有认不出的图" />
      ) : allZero && mode === 'annex' ? (
        <EmptyState glyph="净" title="没有需要单独处理的照片、文字" />
      ) : (
        <EmptyState
          glyph="清"
          title={`「${label}」这一组处理完了`}
          action={
            nextEntry ? (
              <Button variant="secondary" trailing={<ArrowRight className="size-4" />} onClick={() => pickEntry(nextEntry.key)}>
                下一组：{nextEntry.label}
              </Button>
            ) : undefined
          }
        />
      );
  } else {
    grid = (
      <ImageGrid
        images={items}
        selectionScope="unrecognized"
        rowHeight={184}
        gap={8}
        total={total}
        hasMore={query.hasNextPage}
        loadingMore={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage({ cancelRefetch: false })}
      />
    );
  }

  const order = mode === 'annex' ? ORDER_NOTE.annex : mode === 'shelved' ? ORDER_NOTE.shelved : p.theme === 'comic' ? ORDER_NOTE.comic : ORDER_NOTE.theme;

  return (
    <>
      {entries ? <ThemeIndex entries={entries} active={active} onPick={pickEntry} /> : !summary && mode !== 'shelved' && <IndexSkeleton />}
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {entries && <ChipRow entries={entries} active={active} onPick={pickEntry} />}
        <SectionTitle
          numbered={mode !== 'shelved'}
          className="mb-3"
          actions={
            <>
              <FreshButton stale={query.isStale} onRefresh={() => void query.refetch()} />
              {total > 0 && (
                <Button variant="ghost" size="sm" onClick={() => void sheet.selectAll()}>
                  全选本组 {formatCount(total)} 张
                </Button>
              )}
            </>
          }
          hint={
            summary && (
              <>
                {formatCount(total)} 张 · {order}
                {mode === 'annex' && p.kind && (
                  <Link to={`/annex/${p.kind}`} className="ml-2 text-fg-muted hover:text-fg">
                    在别册里看全部 →
                  </Link>
                )}
              </>
            )
          }
        >
          {label || <Skeleton className="inline-block h-4 w-16 align-middle" />}
        </SectionTitle>
        <div ref={scrollRef} className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-8 scrollbar-thin">
          <ScrollContainerContext.Provider value={scrollRef}>{grid}</ScrollContainerContext.Provider>
        </div>
        <StampOverlay stamp={sheet.stamp} />
      </section>
      {sheet.batch ? (
        <SheetBatchPanel
          sheet={sheet}
          label={label}
          mode={mode}
          searchRef={searchRef}
          onCreate={setCreateName}
          kindOpen={kindOpen}
          onKindOpen={setKindOpen}
          ratingOpen={ratingOpen}
          onRatingOpen={setRatingOpen}
        />
      ) : (
      <GroupNotePanel
        mode={mode}
        no={index}
        label={label}
        total={total}
        theme={mode === 'unsure' ? p.theme : undefined}
        onAnnex={() => p.kind && navigate(`/annex/${p.kind}`)}
      />
      )}
      <NewCharacterDialog
        open={createName !== null}
        onOpenChange={(o) => !o && setCreateName(null)}
        initialName={createName ?? ''}
        onCreated={(c) => sheet.assign({ id: c.id, name: c.name, workName: null, coverImageId: null })}
      />
    </>
  );
}

/** 右栏：本组说明（第几组、怎么分进来的、处理小贴士） */
function GroupNotePanel({
  mode,
  no,
  label,
  total,
  theme,
  onAnnex,
}: {
  mode: SheetMode;
  no: number;
  label: string;
  total: number;
  theme?: UnrecognizedTheme;
  onAnnex: () => void;
}) {
  const meta = theme ? THEME_META[theme] : null;
  return (
    <PanelShell footer={<SessionNote count={0} idle="悬停勾选 · Ctrl+A 全选已加载 · [ ] 换组" />}>
      {mode !== 'shelved' && no >= 0 && (
        <div className="kicker">
          <span className="text-shu">目次</span>
          <span className="ml-3">第{CJK_NO[no]}组</span>
        </div>
      )}
      <div className="mt-2.5 flex items-baseline gap-3">
        <h2 className="font-serif-cjk text-[26px] font-semibold tracking-[.06em]">{label}</h2>
        <span className="numeral text-[40px] leading-none">{formatCount(total)}</span>
        <span className="text-[13px] text-fg-muted">张</span>
      </div>
      <PanelSection title="怎么分到这一组">
        {mode === 'annex' ? (
          <p className="text-[12.5px] leading-relaxed text-fg-muted">
            这些不是插画，不需要逐张认角色，已经放在别册里。这里只列没有角色的，方便挑出分错的。
          </p>
        ) : mode === 'shelved' ? (
          <p className="text-[12.5px] leading-relaxed text-fg-muted">放下 = 不找角色了：图还在图库里，只是不再出现在未识别。选中后可以放回来。</p>
        ) : (
          <>
            <p className="text-[12.5px] leading-relaxed text-fg-muted">{meta?.rule}</p>
            <p className="mt-2 text-[11.5px] leading-relaxed text-fg-subtle">{PRECEDENCE_NOTE}</p>
          </>
        )}
      </PanelSection>
      {meta?.tip && <div className="mt-4 rounded-[12px] bg-sunken px-3.5 py-3 text-[12.5px] leading-relaxed text-fg-muted">{meta.tip}</div>}
      <PanelSection title="一组一组处理">
        <ul className="space-y-1.5 text-[12.5px] text-fg-muted">
          <li>
            认得出的 · 选中后搜索角色归入 <Kbd>/</Kbd>
          </li>
          {mode !== 'annex' && (
            <li>
              原创角色 · 选中后归为原创 <Kbd>O</Kbd>；不认识的 · 放下 <Kbd>H</Kbd>
            </li>
          )}
          <li>
            不是插画的（多在末尾）· 改类型 <Kbd>C</Kbd>
          </li>
        </ul>
      </PanelSection>
      {mode === 'annex' && (
        <Button variant="secondary" className="mt-4" trailing={<ArrowRight className="size-4" />} onClick={onAnnex}>
          去别册看{label}
        </Button>
      )}
    </PanelShell>
  );
}

function IndexSkeleton() {
  return (
    <div className="hidden w-[216px] shrink-0 flex-col gap-1 xl:flex">
      {Array.from({ length: 10 }, (_, i) => (
        <Skeleton key={i} className="h-[46px] w-full rounded-[10px]" />
      ))}
    </div>
  );
}
