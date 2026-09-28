import { cn } from '@/lib/cn';
import { Thumb } from '@/components/media/Thumb';
import type { ImageItem, UnrecognizedItem } from '@emaki/shared';
import { Ban, ChevronLeft, ChevronRight, ExternalLink, Shapes } from 'lucide-react';
import { KindMenu } from '@/components/media/KindMenu';
import type { ReactNode, RefObject } from 'react';
import { Badge, Kbd } from '@/components/ui';
import {
  formatBytes,
  formatCount,
  formatDimensions,
  formatRelative,
  isSensitive,
  RATING_LABEL,
} from '@/lib/format';
import type { Triage } from '../useTriage';
import { CharacterSearch } from './CharacterSearch';
import { ActionKey, PanelSection, SuggestionRow } from './PanelParts';
import { RunTaggerButton } from './RunTaggerButton';
import { useUnrecognizedSummary } from '@/lib/queries';
import { useTagJob } from '../useTagJob';

const SITE_LABEL: Record<NonNullable<ImageItem['source']>['site'], string> = {
  pixiv: 'pixiv',
  twitter: 'X / Twitter',
  danbooru: 'Danbooru',
  fanbox: 'FANBOX',
  other: '其他来源',
};

/**
 * 右侧决策面板（单张）：这张图是什么 → tagger 怎么说 → 或者自己搜 → 跳过 / 排除。
 */
export function DecisionPanel({
  triage,
  item,
  searchRef,
}: {
  triage: Triage;
  item: UnrecognizedItem;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const { suggestions, tagged } = item;

  return (
    <PanelShell
      footer={
        <>
          <div className="grid grid-cols-4 gap-2">
            <ActionKey icon={<ChevronLeft />} label="上一张" keys={['K', '←']} onClick={triage.prev} disabled={triage.index <= 0} />
            <ActionKey icon={<ChevronRight />} label="跳过" keys={['J', '→']} onClick={triage.next} />
            <KindMenu
              align="end"
              label="这张其实是"
              includeIllustration={false}
              open={triage.kindMenuOpen}
              onOpenChange={triage.setKindMenuOpen}
              onSelect={triage.markKind}
              trigger={
                <div className="grid">
                  <ActionKey icon={<Shapes />} label="不是插画" keys={['N']} onClick={() => triage.setKindMenuOpen(true)} />
                </div>
              }
            />
            <ActionKey icon={<Ban />} label="排除" keys={['E']} onClick={triage.exclude} tone="danger" />
          </div>
          <SessionNote count={triage.doneCount} />
        </>
      }
    >
      {/* 换图时整块淡入，眼睛知道「内容变了」 */}
      <div key={item.image.id} className="animate-fade-in">
        <ImageMeta image={item.image} position={triage.index + 1} total={triage.total} />

        <PanelSection title="tagger 建议" hint={suggestions.length ? '按数字键直接采纳' : undefined}>
          {suggestions.length ? (
            <div className="space-y-2">
              {/* 只给前 9 条编号，正好对应数字键 */}
              {suggestions.slice(0, 9).map((s, i) => (
                <SuggestionRow
                  key={s.danbooruTag}
                  n={i + 1}
                  name={s.name}
                  workName={s.workName}
                  value={s.score}
                  valueLabel={Math.round(s.score * 100)}
                  valueUnit="%"
                  isNew={!s.characterId}
                  title={`${s.danbooruTag} · 按 ${i + 1} 采纳`}
                  onPick={() => triage.acceptSuggestion(s)}
                />
              ))}
            </div>
          ) : (
            <NoSuggestion tagged={tagged} />
          )}
          {triage.sameTop.length > 1 && (
          <button
            type="button"
            onClick={triage.selectSameTop}
            className="mt-2.5 flex h-10 w-full items-center gap-2.5 rounded-[12px] bg-sunken px-3 text-left text-[12.5px] text-fg-muted transition-colors duration-150 hover:bg-hover hover:text-fg"
          >
            <span className="flex shrink-0">
              {triage.sameTop.slice(0, 3).map((it, k) => (
                <Thumb key={it.image.id} image={it.image} width={240} className={cn('size-6 rounded-[5px] ring-2 ring-sunken', k > 0 && '-ml-2')} />
              ))}
            </span>
            <span className="flex-1 truncate">
              队列里还有 <b className="font-semibold text-fg tabular">{triage.sameTop.length - 1}</b> 张也像 {item.suggestions[0]?.name}
            </span>
            <Kbd>A</Kbd>
          </button>
        )}
        </PanelSection>
      </div>

      <PanelSection title="归到其他角色" hint="↑↓ 选择 · ↵ 归入">
        <CharacterSearch inputRef={searchRef} recent={triage.recent} onPick={triage.assign} />
      </PanelSection>
    </PanelShell>
  );
}

/** 面板外壳：内容区独立滚动，操作键固定在底部 */
export function PanelShell({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <section className="flex min-h-0 w-[300px] shrink-0 flex-col xl:w-[340px] 2xl:w-[380px]">
      {/* 左右各留 12px：卡片描边、hover 阴影和输入框的焦点光圈不会被滚动容器裁掉 */}
      <div className="-mx-3 min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-6 scrollbar-thin">{children}</div>
      <div className="shrink-0 border-t border-line pt-4">{footer}</div>
    </section>
  );
}

function ImageMeta({ image, position, total }: { image: ImageItem; position: number; total: number }) {
  const source = image.source;
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="numeral text-[48px] text-fg">{formatCount(position)}</span>
          <span className="text-[13px] text-fg-subtle tabular">/ {formatCount(total)}</span>
        </div>
        {image.rating !== 'general' && (
          <Badge tone={isSensitive(image.rating) ? 'warn' : 'neutral'} className="mb-1.5">
            {RATING_LABEL[image.rating]}
          </Badge>
        )}
      </div>

      <div className="mt-4 truncate text-[14.5px] font-semibold tracking-tight" title={image.relPath}>
        {image.fileName}
      </div>
      <div className="mt-1 text-[12.5px] text-fg-muted tabular">
        {formatDimensions(image.width, image.height)} · {image.format.toUpperCase()} · {formatBytes(image.bytes)}
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[12.5px] text-fg-subtle">
        {source ? (
          source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1 underline-offset-4 transition-colors hover:text-fg-muted hover:underline"
            >
              <span className="truncate">
                {SITE_LABEL[source.site]}
                {source.artist && ` · ${source.artist}`}
              </span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : (
            <span className="truncate">
              {SITE_LABEL[source.site]}
              {source.artist && ` · ${source.artist}`}
            </span>
          )
        ) : (
          <span>来源未知</span>
        )}
        <span className="shrink-0">· {formatRelative(image.addedAt)}入库</span>
      </div>
    </div>
  );
}

/** 没有建议：分清「tagger 没把握」和「还没跑过识别」 */
function NoSuggestion({ tagged }: { tagged: boolean }) {
  const { running, job } = useTagJob();
  const { data: summary } = useUnrecognizedSummary();
  if (!tagged && running) {
    return (
      <div className="rounded-[14px] border border-dashed border-line-strong px-4 py-4">
        <div className="text-[13px] font-medium">识别中 · 这张会自动处理</div>
        {job?.message && <p className="mt-1 text-[12px] text-fg-muted tabular">{job.message}</p>}
        <p className="mt-2 text-[12.5px] leading-relaxed text-fg-muted">认得出的会直接归到角色，拿不准的会进入「有建议」，一般不必手动处理这里。</p>
      </div>
    );
  }
  if (!tagged) {
    const n = summary?.art.untagged ?? 0;
    return (
      <div className="rounded-[14px] border border-dashed border-line-strong px-4 py-4">
        <div className="text-[13px] font-medium">这张还没跑过识别</div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">运行识别后，tagger 的建议会出现在这里。</p>
        <RunTaggerButton size="sm" variant="primary" label={n > 0 ? `继续识别 ${formatCount(n)} 张` : undefined} className="mt-3" />
      </div>
    );
  }
  return (
    <div className="rounded-[14px] border border-dashed border-line-strong px-4 py-4">
      <div className="text-[13px] font-medium">{tagged ? 'tagger 没认出熟悉的角色' : '这张还没跑过识别'}</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
        {tagged ? '可以在下面搜索角色手动归类，或者按 J 先跳过。' : '运行识别后，tagger 的建议会出现在这里。'}
      </p>
      {!tagged && <RunTaggerButton size="sm" className="mt-3" />}
    </div>
  );
}

/** 本次会话的小计：给一点「在推进」的感觉 */
export function SessionNote({ count, idle }: { count: number; idle?: ReactNode }) {
  return (
    <div className="mt-3 flex h-4 items-center justify-center gap-1.5 text-[11.5px] text-fg-subtle tabular">
      {count > 0 ? (
        <>
          <span className="size-1.5 rounded-full bg-shu" />
          本次已处理 {formatCount(count)} 张
        </>
      ) : (
        (idle ?? '数字键采纳 · / 搜索 · X 多选')
      )}
    </div>
  );
}
