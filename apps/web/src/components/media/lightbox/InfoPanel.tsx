import { collectionTitle, volumeUnit, type ImageDetail, type ImageItem, type Rating } from '@emaki/shared';
import { Ban, FolderOpen, Heart, Sparkles, Trash2 } from 'lucide-react';
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
import { copyText } from '@/lib/clipboard';
import { ANIMATED_LABEL, KIND_GLYPH, KIND_HINT, KIND_LABEL } from '@/lib/kinds';
import { AnimatedGlyph } from '../KindBadge';
import { PanelArtists } from './PanelArtists';
import { PanelCharacters } from './PanelCharacters';
import { PanelCollection } from './PanelCollection';
import { ActionTile, Section } from './PanelParts';
import { PanelSource } from './PanelSource';
import { PanelTags } from './PanelTags';
import type { ImageActions } from './useImageActions';
import { TRASH_HINT, useCharacter, useSettings } from '@/lib/queries';
import { CharacterAvatar } from '@/features/gallery/CharacterPicker';
import { PoseInfoRowLazy } from '@/features/pose/lazy';
import { Slot, slotEntries, type SlotRenderers } from '@/blocks/Slot';
import { shortcutOf } from '@/blocks/slots';
import { useDisabledEntries } from '@/lib/plugins';
import { patchable } from '@/lib/points';

const RATINGS = Object.keys(RATING_LABEL) as Rating[];

/**
 * 看图器右侧的信息面板：一张「纸」浮在深色背景上，和应用主体的纸是同一种材质。
 * 详情没回来之前，头部先用列表里缓存的基本信息顶上。
 * variant="sheet"（窄屏的底部面板，A1，InfoSheet.tsx）：操作那一排排在最前面（平时只露出它），展开后才是头部和其余信息；
 * 外面的纸和滚动由 InfoSheet 管。
 */
/** 看图器的信息栏是内部点 component:lightbox.InfoPanel（第 3 层插件能改，lib/points.tsx） */
export const InfoPanel = patchable('component:lightbox.InfoPanel', InfoPanelView);

function InfoPanelView({
  base,
  detail,
  error,
  onRetry,
  actions,
  onNavigate,
  onTagClick,
  variant = 'side',
  expanded = true,
}: {
  /** 详情或缓存里的基本信息 */
  base: ImageItem | undefined;
  detail: ImageDetail | undefined;
  error: unknown;
  onRetry: () => void;
  actions: ImageActions;
  onNavigate: () => void;
  onTagClick: (tag: string) => void;
  variant?: 'side' | 'sheet';
  /** sheet：展开了（没展开时只有操作那一排） */
  expanded?: boolean;
}) {
  const artistsOn = useSettings().data?.tagger.artists ?? false;
  // 各栏按登记的顺序（blocks/slots.ts 的 lightbox.panel）
  const body = detail ? (
    <Slot
      id="lightbox.panel"
      render={{
        'lightbox.characters': () => (
          <PanelCharacters
            characterIds={actions.characterIds}
            links={detail.characterLinks}
            suggestions={detail.characterSuggestions}
            actions={actions}
            onNavigate={onNavigate}
          />
        ),
        // 没开画师识别、也没改过的图不占地方
        'lightbox.artists': () =>
          (artistsOn || detail.artists.length > 0 || detail.artistsManual) && (
            <PanelArtists artists={detail.artists} manual={detail.artistsManual} actions={actions} onNavigate={onNavigate} />
          ),
        'lightbox.rating': () => (
          <Section title="分级">
            {actions.allow.rating ? (
              <Segmented<Rating>
                size="sm"
                value={actions.rating ?? detail.rating}
                onChange={actions.setRating}
                options={RATINGS.map((r) => ({ value: r, label: RATING_LABEL[r] }))}
              />
            ) : (
              <span className="text-[13px]">{RATING_LABEL[actions.rating ?? detail.rating]}</span>
            )}
          </Section>
        ),
        'lightbox.contentKind': () => <KindSection detail={detail} actions={actions} />,
        'lightbox.details': () => <Details detail={detail} actions={actions} onNavigate={onNavigate} />,
        'lightbox.tags': () => <PanelTags tags={detail.tags} onTagClick={onTagClick} />,
      }}
    />
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
  );

  if (variant === 'sheet')
    return (
      <>
        <ActionTiles base={base} actions={actions} />
        {expanded && (
          <div key={base?.id} className="animate-fade-in">
            <Header base={base} artists={detail?.artists} collection={detail?.collection} />
            {body}
          </div>
        )}
      </>
    );

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[20px] bg-sheet text-fg shadow-pop ring-1 ring-line">
      <div key={base?.id} className="min-h-0 flex-1 animate-fade-in overflow-y-auto overscroll-contain scrollbar-thin">
        <Header base={base} artists={detail?.artists} collection={detail?.collection} />

        <ActionTiles base={base} actions={actions} />

        {body}
      </div>
    </div>
  );
}

/**
 * 信息面板顶上的一排操作。每个按钮的能力在 IMAGE_ACTION_NEEDS 里，这台设备没有的不画，剩下的平分一行
 * （手机上默认是收藏、归为原创、排除三个）。
 */
function ActionTiles({ base, actions }: { base: ImageItem | undefined; actions: ImageActions }) {
  const disabled = useDisabledEntries();
  // 按登记的顺序（blocks/slots.ts 的 lightbox.actions）；平分一行要先知道有几个，所以不用 <Slot>
  const render: SlotRenderers<'lightbox.actions'> = {
    'lightbox.favorite': () =>
      actions.allow.favorite && (
        <ActionTile
          key="favorite"
          icon={<Heart />}
          label={actions.favorite ? '已收藏' : '收藏'}
          tooltip={actions.favorite ? '取消收藏' : '收藏'}
          shortcut={shortcutOf('lightbox.favorite')}
          active={actions.favorite}
          disabled={!base}
          onClick={actions.toggleFavorite}
        />
      ),
    'lightbox.original': () =>
      actions.allow.original && (
        <ActionTile
          key="original"
          icon={<Sparkles />}
          label={actions.original ? '已归原创' : '归为原创'}
          tooltip={actions.original ? '移出原创' : '归为原创：画师自己的原创角色，不再出现在未识别'}
          shortcut={shortcutOf('lightbox.original')}
          active={actions.original}
          disabled={!base || (base.kind !== 'illustration' && base.kind !== 'comic')}
          onClick={actions.toggleOriginal}
        />
      ),
    'lightbox.reveal': () =>
      actions.allow.reveal && (
        <ActionTile key="reveal" icon={<FolderOpen />} label="定位" tooltip="在资源管理器中显示" disabled={!base} onClick={actions.reveal} />
      ),
    'lightbox.exclude': () =>
      actions.allow.exclude && (
        <ActionTile
          key="exclude"
          icon={<Ban />}
          label="排除"
          tooltip="排除：不再出现在图库和统计里，文件不会被删除"
          shortcut={shortcutOf('lightbox.exclude')}
          pending={actions.busy.exclude}
          disabled={!base || !!actions.leaving}
          onClick={actions.exclude}
        />
      ),
    'lightbox.trash': () =>
      actions.allow.trash && (
        <ActionTile
          key="trash"
          icon={<Trash2 />}
          label="回收站"
          tooltip={TRASH_HINT}
          danger
          pending={actions.busy.trash}
          // 刚排除 / 移走的那张还停在原地：连点不会落到下一张
          disabled={!base || !!actions.leaving}
          onClick={actions.trash}
        />
      ),
  };
  const tiles = slotEntries('lightbox.actions', disabled)
    .map((id) => render[id]())
    .filter(Boolean);
  if (!tiles.length) return null;
  return (
    <div className="grid gap-1 px-3 pb-4" style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}>
      {tiles}
    </div>
  );
}

/**
 * 类型（T32a / T32b）：六枚印章一排，当前类型是白文实底，其余朱文；点一下就改（可撤销）。
 * 是动图的，下面一行写「动图」和为什么算（D5：另一个维度，按帧数自动认出，不能改，所以不是印章）。
 * 最下面一行是类型的判定依据；手动改过的可以恢复自动判断。
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
              disabled={actions.kindBusy || !actions.allow.kind}
              onClick={() => k !== kind && actions.setKind(k)}
              className={cn('rounded-[4px] transition-opacity duration-150', k === kind ? 'opacity-100' : 'opacity-70 hover:opacity-100')}
            >
              <Seal variant={k === kind ? 'bai' : 'zhu'} size={24} glyph={k === kind ? KIND_LABEL[k] : KIND_GLYPH[k]} />
            </button>
          </Tooltip>
        ))}
      </div>
      {detail.animated && (
        <p className="mt-2.5 flex items-center gap-1.5 text-[11.5px] text-fg-muted">
          <AnimatedGlyph size={16} />
          <span className="font-medium text-fg">{ANIMATED_LABEL}</span>
          <span className="text-fg-subtle">· {detail.animatedReason ?? '按帧数认出'} · 和类型无关，自动判断</span>
        </p>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
        {manual ? (
          <>
            你手动归的
            {actions.allow.kind && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => actions.setKind('auto')}
                  className="text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                >
                  恢复自动判断
                </button>
              </>
            )}
          </>
        ) : (
          <>自动判断{detail.kindReason ? ` · ${detail.kindReason}` : ''}</>
        )}
      </p>
    </Section>
  );
}

function Header({
  base,
  artists,
  collection,
}: {
  base: ImageItem | undefined;
  artists?: ImageDetail['artists'];
  collection?: ImageDetail['collection'];
}) {
  if (!base) {
    return (
      <div className="space-y-2.5 px-5 pt-6 pb-5">
        <Skeleton className="h-4 w-3/4 rounded-full" />
        <Skeleton className="h-3 w-1/2 rounded-full" />
      </div>
    );
  }
  // 头部先说「这是谁」，文件名降成一行小字（BR-8）。状态只读服务端给的事实（角色数、所在队列），不自己从类型推（附录 #27）
  const names = base.characterNames;
  // 认出（或手动改）的画师优先，没有再用文件名、元数据里的
  const artist = artists?.length ? artists.map((a) => a.name).join('、') : base.source?.artist;
  // 整本处理的合集里的页（queue = book）：头部写书名和第几页，不显示「未识别」
  const book = base.characterCount === 0 && base.queue === 'book' && collection ? collection : null;
  // 在未识别「插画 · 漫画」里（含放下的）
  const unrecognized = base.queue === 'art' || base.queue === 'shelved';
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
      ) : book ? (
        <div>
          <h2 className="line-clamp-2 text-[16px] leading-snug font-semibold tracking-tight">
            {collectionTitle(book)}
            {book.volumeNo !== null && ` 第 ${book.volumeNo} ${volumeUnit(book.folderName)}`}
          </h2>
          <div className="mt-0.5 text-xs text-fg-subtle tabular">
            第 {book.pageNo} / {book.pageCount} 页{artist ? ` · 画师 ${artist}` : ''}
          </div>
        </div>
      ) : (
        <div>
          <h2 className="text-[16px] leading-snug font-semibold tracking-tight">
            {base.original ? '原创' : unrecognized ? '未识别' : KIND_LABEL[base.kind]}
          </h2>
          <div className="mt-0.5 text-xs text-fg-subtle">
            {base.original
              ? '画师自己的原创角色，不在未识别里'
              : unrecognized
                ? '可以在下方添加角色或采纳识别建议'
                : artist
                  ? `画师 ${artist}`
                  : base.queue === 'annex'
                    ? '别册里的图，不参与角色识别'
                    : '不在未识别里，可以在下方添加角色'}
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
      {base.excluded || unrecognized ? (
        <Badge tone={base.excluded ? 'danger' : 'warn'} dot className="mt-3">
          {base.excluded ? '已排除' : '未识别'}
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

function Details({ detail: d, actions, onNavigate }: { detail: ImageDetail; actions: ImageActions; onNavigate: () => void }) {
  const megapixels = (d.width * d.height) / 1_000_000;
  const copyPath = () => {
    copyText(d.absPath)
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
          <PanelSource key={d.id} detail={d} editable={actions.allow.source} />
        </Row>
        {/* 不在合集里时这一行是「收进组图…」「成册…」（collections）：没有这项能力就不占地方 */}
        {(d.collection || (actions.allow.collection && d.relPath.includes('/'))) && (
          <Row label={d.collection ? '收录于' : '合集'}>
            <PanelCollection detail={d} onNavigate={onNavigate} />
          </Row>
        )}
        {/* 姿势检索打开、这张有姿势结果时才有这一行 */}
        <PoseInfoRowLazy imageId={d.id} onNavigate={onNavigate} />
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
