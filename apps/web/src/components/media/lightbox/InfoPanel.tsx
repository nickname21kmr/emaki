import type { ImageDetail, ImageItem, ImageSource, Rating } from '@emaki/shared';
import { Ban, ExternalLink, FolderOpen, Heart, Sparkles, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Seal, Segmented, Skeleton, Tooltip } from '@/components/ui';
import {
  formatBytes,
  formatDateTime,
  formatDimensions,
  formatRelative,
  RATING_LABEL,
} from '@/lib/format';
import { CONTENT_KINDS } from '@emaki/shared';
import { cn } from '@/lib/cn';
import { KIND_GLYPH, KIND_HINT, KIND_LABEL } from '@/lib/kinds';
import { PanelCharacters } from './PanelCharacters';
import { PanelCollection } from './PanelCollection';
import { ActionTile, Section } from './PanelParts';
import { PanelTags } from './PanelTags';
import type { ImageActions } from './useImageActions';
import { useCharacter, useTrashHint } from '@/lib/queries';
import { CharacterAvatar } from '@/features/gallery/CharacterPicker';

const RATINGS = Object.keys(RATING_LABEL) as Rating[];

const SITE_LABEL: Record<ImageSource['site'], string> = {
  pixiv: 'Pixiv',
  twitter: 'X / Twitter',
  danbooru: 'Danbooru',
  fanbox: 'FANBOX',
  other: '其他',
};

/**
 * 看图器右侧的信息面板：一张「纸」浮在深色背景上，和应用主体的纸是同一种材质。
 * 详情没回来之前，头部先用列表里缓存的基本信息顶上。
 */
export function InfoPanel({
  base,
  detail,
  error,
  onRetry,
  actions,
  onNavigate,
  onTagClick,
}: {
  /** 详情或缓存里的基本信息 */
  base: ImageItem | undefined;
  detail: ImageDetail | undefined;
  error: unknown;
  onRetry: () => void;
  actions: ImageActions;
  onNavigate: () => void;
  onTagClick: (tag: string) => void;
}) {
  const trashHint = useTrashHint();
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[20px] bg-sheet text-fg shadow-pop ring-1 ring-line">
      <div key={base?.id} className="min-h-0 flex-1 animate-fade-in overflow-y-auto overscroll-contain scrollbar-thin">
        <Header base={base} />

        <div className="grid grid-cols-5 gap-1 px-3 pb-4">
          <ActionTile
            icon={<Heart />}
            label={actions.favorite ? '已收藏' : '收藏'}
            tooltip={actions.favorite ? '取消收藏' : '收藏'}
            shortcut="F"
            active={actions.favorite}
            disabled={!base}
            onClick={actions.toggleFavorite}
          />
          <ActionTile
            icon={<Sparkles />}
            label={actions.original ? '已归原创' : '归为原创'}
            tooltip={actions.original ? '移出原创' : '归为原创：画师自己的原创角色，不再出现在未识别'}
            shortcut="O"
            active={actions.original}
            disabled={!base || (base.kind !== 'illustration' && base.kind !== 'comic')}
            onClick={actions.toggleOriginal}
          />
          <ActionTile
            icon={<FolderOpen />}
            label="定位"
            tooltip="在资源管理器中显示"
            disabled={!base}
            onClick={actions.reveal}
          />
          <ActionTile
            icon={<Ban />}
            label="排除"
            tooltip="排除：不再出现在图库和统计里，文件不会被删除"
            shortcut="E"
            pending={actions.busy.exclude}
            disabled={!base}
            onClick={actions.exclude}
          />
          <ActionTile
            icon={<Trash2 />}
            label="回收站"
            tooltip={trashHint}
            danger
            pending={actions.busy.trash}
            disabled={!base}
            onClick={actions.trash}
          />
        </div>

        {detail ? (
          <>
            <PanelCharacters
              characterIds={actions.characterIds}
              suggestions={detail.characterSuggestions}
              actions={actions}
              onNavigate={onNavigate}
            />

            <Section title="分级">
              <Segmented<Rating>
                size="sm"
                value={actions.rating ?? detail.rating}
                onChange={actions.setRating}
                options={RATINGS.map((r) => ({ value: r, label: RATING_LABEL[r] }))}
              />
            </Section>

            <KindSection detail={detail} actions={actions} />

            <Details detail={detail} onNavigate={onNavigate} />
            <PanelTags tags={detail.tags} onTagClick={onTagClick} />
          </>
        ) : error ? (
          <div className="border-t border-line px-5 py-10 text-center">
            <div className="text-[13px] font-medium">读不到这张图的详情</div>
            <p className="mt-1 text-xs leading-relaxed text-fg-subtle">
              它可能刚被排除、移到了回收站，或者文件已经不在原来的位置。
            </p>
            <Button size="sm" variant="outline" className="mt-4" onClick={onRetry}>
              重试
            </Button>
          </div>
        ) : (
          <PanelSkeleton />
        )}
      </div>
    </div>
  );
}

/**
 * 类型（T32a / T32b）：七枚印章一排，当前类型是白文实底，其余朱文；点一下就改（可撤销）。
 * 下面一行是判定依据；手动改过的可以恢复自动判断。
 */
function KindSection({ detail, actions }: { detail: ImageDetail; actions: ImageActions }) {
  const kind = actions.kind ?? detail.kind;
  const manual = detail.kindSource === 'manual';
  return (
    <Section title="类型" meta={kind !== 'illustration' ? '在别册，不计入角色' : undefined}>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="图片类型">
        {CONTENT_KINDS.map((k) => (
          <Tooltip key={k} content={`${KIND_LABEL[k]} · ${KIND_HINT[k]}`}>
            <button
              type="button"
              aria-pressed={k === kind}
              aria-label={KIND_LABEL[k]}
              disabled={actions.kindBusy}
              onClick={() => k !== kind && actions.setKind(k)}
              className={cn('rounded-[4px] transition-opacity duration-150', k === kind ? 'opacity-100' : 'opacity-70 hover:opacity-100')}
            >
              <Seal variant={k === kind ? 'bai' : 'zhu'} size={24} glyph={k === kind ? KIND_LABEL[k] : KIND_GLYPH[k]} />
            </button>
          </Tooltip>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
        {manual ? (
          <>
            你手动归的 ·{' '}
            <button type="button" onClick={() => actions.setKind('auto')} className="text-fg-muted underline-offset-2 hover:text-fg hover:underline">
              恢复自动判断
            </button>
          </>
        ) : (
          <>自动判断{detail.kindReason ? ` · ${detail.kindReason}` : ''}</>
        )}
      </p>
    </Section>
  );
}

function Header({ base }: { base: ImageItem | undefined }) {
  if (!base) {
    return (
      <div className="space-y-2.5 px-5 pt-6 pb-5">
        <Skeleton className="h-4 w-3/4 rounded-full" />
        <Skeleton className="h-3 w-1/2 rounded-full" />
      </div>
    );
  }
  // 头部先说「这是谁」，文件名降成一行小字（BR-8）
  const names = base.characterNames;
  const art = base.kind === 'illustration' || base.kind === 'comic';
  const artist = base.source?.artist;
  return (
    <div className="px-5 pt-5 pb-4">
      {names.length > 0 ? (
        <div className="flex items-center gap-3">
          <div className="flex shrink-0">
            {base.characterIds.slice(0, 3).map((id, i) => (
              <HeadAvatar key={id} id={id} className={cn(i > 0 && '-ml-2.5')} />
            ))}
          </div>
          <div className="min-w-0">
            <h2 title={names.join('、')} className="line-clamp-1 text-[16px] leading-snug font-semibold tracking-tight">
              {names.join('、')}
            </h2>
            {artist && <div className="truncate text-[12.5px] text-fg-muted">画师 {artist}</div>}
          </div>
        </div>
      ) : (
        <div>
          <h2 className="text-[16px] leading-snug font-semibold tracking-tight">
            {base.original ? '原创' : art ? '未识别' : KIND_LABEL[base.kind]}
          </h2>
          <div className="mt-0.5 text-xs text-fg-subtle">
            {base.original
              ? '画师自己的原创角色，不在未识别里'
              : art
                ? '可以在下方添加角色或采纳识别建议'
                : artist
                  ? `画师 ${artist}`
                  : '别册里的图，不参与角色识别'}
          </div>
        </div>
      )}
      <div title={base.fileName} className="mt-2 truncate text-[12px] text-fg-subtle">
        {base.fileName}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-fg-subtle tabular">
        <span>{formatDimensions(base.width, base.height)}</span>
        <Dot />
        <span>{formatBytes(base.bytes)}</span>
        <Dot />
        <span className="uppercase">{base.format}</span>
      </div>
      {base.status !== 'recognized' ? (
        <Badge tone={base.status === 'excluded' ? 'danger' : 'warn'} dot className="mt-3">
          {base.status === 'excluded' ? '已排除' : '未识别'}
        </Badge>
      ) : (
        base.kind !== 'illustration' && (
          <Badge tone="neutral" className="mt-3">
            别册 · {KIND_LABEL[base.kind]}
          </Badge>
        )
      )}
    </div>
  );
}

/** 头部重叠头像：36px 圆形，只在这里用，按 id 取角色封面 */
function HeadAvatar({ id, className }: { id: string; className?: string }) {
  const { data } = useCharacter(id);
  if (!data) return <Skeleton className={cn('size-9 rounded-full ring-2 ring-sheet', className)} />;
  return <CharacterAvatar character={data.character} size={36} shape="circle" className={cn('ring-2 ring-sheet', className)} />;
}

function Details({ detail: d, onNavigate }: { detail: ImageDetail; onNavigate: () => void }) {
  const megapixels = (d.width * d.height) / 1_000_000;
  const copyPath = () => {
    navigator.clipboard
      .writeText(d.absPath)
      .then(() => toast('已复制文件路径'))
      .catch(() => toast.error('复制失败'));
  };
  return (
    <Section title="信息">
      <dl className="grid grid-cols-[44px_1fr] gap-x-3 gap-y-2.5 text-[12.5px] leading-snug">
        <Row label="尺寸">
          {formatDimensions(d.width, d.height)}
          <span className="text-fg-subtle"> · {megapixels.toFixed(1)} MP</span>
        </Row>
        <Row label="体积">{formatBytes(d.bytes)}</Row>
        <Row label="格式">
          <span className="uppercase">{d.format}</span>
        </Row>
        <Row label="入库">
          {formatDateTime(d.addedAt)}
          <span className="text-fg-subtle"> · {formatRelative(d.addedAt)}</span>
        </Row>
        <Row label="修改">{formatDateTime(d.modifiedAt)}</Row>
        <Row label="来源">
          <SourceValue source={d.source} />
        </Row>
        {(d.collection || d.relPath.includes('/')) && (
          <Row label={d.collection ? '收录于' : '合集'}>
            <PanelCollection detail={d} onNavigate={onNavigate} />
          </Row>
        )}
        <Row label="文件">
          <span className="break-all">{d.fileName}</span>
        </Row>
        <Row label="位置">
          <button
            type="button"
            onClick={copyPath}
            title="点击复制完整路径"
            className="text-left font-mono text-[11px] leading-relaxed break-all text-fg-muted transition-colors hover:text-fg"
          >
            {d.absPath}
          </button>
        </Row>
      </dl>
    </Section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="min-w-0 tabular">{children}</dd>
    </>
  );
}

function SourceValue({ source }: { source: ImageSource | null }) {
  if (!source) return <span className="text-fg-subtle">未知</span>;
  const site = SITE_LABEL[source.site];
  return (
    <div className="min-w-0">
      {source.url ? (
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-center gap-1 font-medium underline-offset-4 transition-colors hover:text-shu-fg hover:underline"
        >
          <span className="truncate">
            {site}
            {source.postId && <span className="font-normal text-fg-muted"> #{source.postId}</span>}
          </span>
          <ExternalLink className="size-3 shrink-0" />
        </a>
      ) : (
        <span>{site}</span>
      )}
      {source.artist && <div className="mt-0.5 truncate text-fg-muted">画师 {source.artist}</div>}
    </div>
  );
}

function Dot() {
  return <span className="text-fg-subtle">·</span>;
}

function PanelSkeleton() {
  return (
    <>
      <div className="border-t border-line px-5 py-4">
        <Skeleton className="mb-3 h-2.5 w-10 rounded-full" />
        <div className="flex gap-1.5">
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-8 w-16 rounded-full" />
        </div>
      </div>
      <div className="border-t border-line px-5 py-4">
        <Skeleton className="mb-3 h-2.5 w-10 rounded-full" />
        <Skeleton className="h-7 w-52 rounded-full" />
      </div>
      <div className="space-y-2.5 border-t border-line px-5 py-4">
        <Skeleton className="mb-3 h-2.5 w-10 rounded-full" />
        {[70, 50, 60, 45].map((w) => (
          <Skeleton key={w} className="h-3 rounded-full" style={{ width: `${w}%` }} />
        ))}
      </div>
    </>
  );
}
