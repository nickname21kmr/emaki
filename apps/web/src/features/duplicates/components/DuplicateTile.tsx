import type { ImageItem } from '@emaki/shared';
import { Check, Folder, Maximize2, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Thumb } from '@/components/media/Thumb';
import { imageUrl } from '@/lib/api';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes, formatDate, formatDimensions } from '@/lib/format';
import { TILE_HEIGHT } from '../utils';

/**
 * 重复组里的一张图 + 下方的对比信息。
 * 点图片在「保留 / 移到回收站」之间切换；删除态变灰、信息加删除线。
 */
export function DuplicateTile({
  image,
  ratio,
  kept,
  suggested,
  bestResolution,
  bestBytes,
  folder,
  folderParts,
  lens,
  onLensMove,
  onLensLeave,
  onToggle,
  onOpen,
}: {
  image: ImageItem;
  /** 布局用的宽高比（已限制过范围） */
  ratio: number;
  kept: boolean;
  suggested: boolean;
  bestResolution: boolean;
  bestBytes: boolean;
  folder: { short: string; full: string };
  /** 完全相同组：路径里公共的前缀和不同的那段（TR-11） */
  folderParts?: { prefix: string; rest: string };
  /** 放大镜位置（0–1 相对坐标），组内共享 */
  lens: { x: number; y: number } | null;
  onLensMove?: (x: number, y: number) => void;
  onLensLeave: () => void;
  onToggle: () => void;
  onOpen: () => void;
}) {
  // 高分屏上宽图按显示尺寸会超过 480，取 960 档保证清晰
  const thumbWidth = ratio * TILE_HEIGHT * (window.devicePixelRatio || 1) > 480 ? 960 : 480;
  return (
    <div className="flex min-w-0 flex-col" style={{ flex: `${ratio} 1 0%` }}>
      <div
        className={cn(
          'group/dup relative overflow-hidden rounded-[12px] transition-[scale,box-shadow] duration-500 ease-[var(--ease-out-soft)]',
          kept ? 'shadow-card hover:shadow-lift' : 'scale-[0.97]',
        )}
        style={{ aspectRatio: ratio }}
        onMouseMove={
          onLensMove
            ? (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onLensMove((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
              }
            : undefined
        }
        onMouseLeave={onLensMove ? onLensLeave : undefined}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={kept}
          aria-label={`${image.fileName}：${kept ? '保留' : '移到回收站'}`}
          // 鼠标点击不抢焦点，否则之后按 Enter 会再次触发这张图，而不是处理整组
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggle}
          className="block size-full"
        >
          <Thumb
            image={image}
            width={thumbWidth}
            className={cn(
              'size-full transition-[opacity,filter] duration-500 ease-[var(--ease-out-soft)]',
              !kept && 'opacity-35 grayscale',
            )}
            imgClassName="group-hover/dup:[transform:scale(1.035)]"
          />
        </button>

        {/* 同步放大镜：原图 3 倍，组内同一位置 */}
        {lens && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 animate-fade-in bg-sunken bg-no-repeat"
            style={{ backgroundImage: `url(${imageUrl.file(image.id)})`, backgroundSize: '300%', backgroundPosition: `${lens.x * 100}% ${lens.y * 100}%` }}
          />
        )}

        {/* 左上：保留 / 删除状态 */}
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute top-2.5 left-2.5 flex size-6 items-center justify-center rounded-full transition-colors duration-300',
            kept ? 'bg-shu text-white shadow-[0_2px_8px_rgb(0_0_0/0.25)]' : 'bg-black/45 text-white/85 backdrop-blur-sm',
          )}
        >
          {kept ? <Check className="size-3.5" strokeWidth={3} /> : <Trash2 className="size-3.5" />}
        </span>

        {/* 右上：推荐保留的印章 */}
        {suggested && (
          <span className="pointer-events-none absolute top-2.5 right-2.5 inline-flex h-6 items-center gap-1.5 rounded-full bg-black/40 pr-2.5 pl-1 text-[11px] font-semibold text-white ring-1 ring-white/15 backdrop-blur-md">
            <span className="flex size-4 -rotate-6 items-center justify-center rounded-[4px] bg-shu font-display text-[10px] leading-none">
              荐
            </span>
            建议保留
          </span>
        )}

        {/* 悬停提示：点击后会变成什么 */}
        <span className="pointer-events-none absolute bottom-2.5 left-2.5 translate-y-1 rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-medium whitespace-nowrap text-white opacity-0 backdrop-blur-md transition-[opacity,translate] duration-300 group-hover/dup:translate-y-0 group-hover/dup:opacity-100">
          {kept ? '移到回收站' : '改为保留'}
        </span>

        <Tooltip content="查看大图">
          <button
            type="button"
            aria-label="查看大图"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-full bg-black/40 text-white opacity-0 ring-1 ring-white/15 backdrop-blur-md transition-opacity duration-200 group-hover/dup:opacity-100 hover:bg-black/60 focus-visible:opacity-100"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </Tooltip>
      </div>

      <TileInfo
        image={image}
        kept={kept}
        bestResolution={bestResolution}
        bestBytes={bestBytes}
        folder={folder}
        folderParts={folderParts}
      />
    </div>
  );
}

function TileInfo({
  image,
  kept,
  bestResolution,
  bestBytes,
  folder,
  folderParts,
}: {
  image: ImageItem;
  kept: boolean;
  bestResolution: boolean;
  bestBytes: boolean;
  folder: { short: string; full: string };
  folderParts?: { prefix: string; rest: string };
}) {
  return (
    <div
      className={cn(
        'mt-3 space-y-1 px-0.5 text-[12px] leading-snug transition-colors duration-300',
        !kept && 'text-fg-subtle line-through decoration-fg-subtle/70',
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-1.5 tabular">
        <Metric best={bestResolution} kept={kept} hint="分辨率最高">
          {formatDimensions(image.width, image.height)}
        </Metric>
        <span className="text-fg-subtle">·</span>
        <Metric best={bestBytes} kept={kept} hint="体积最大">
          {formatBytes(image.bytes)}
        </Metric>
      </div>
      <div className={cn('flex min-w-0 items-center gap-1', kept ? 'text-fg-muted' : 'text-fg-subtle')} title={folder.full}>
        <Folder className="size-3 shrink-0 opacity-70" />
        {folderParts?.rest ? (
          <span className="truncate">
            <span className="text-fg-subtle">{folderParts.prefix}</span>
            <span className={cn('font-medium', kept && 'text-fg')}>{folderParts.rest}</span>
          </span>
        ) : (
          <span className="truncate">{folder.short}</span>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-fg-subtle">
        <span className="rounded-[4px] bg-sunken px-1 text-[10px] font-semibold tracking-wide uppercase">
          {image.format}
        </span>
        <span className="truncate tabular">{formatDate(image.addedAt)} 入库</span>
      </div>
    </div>
  );
}

/** 对比值：组内最好的那个用朱色 + 小圆点标出 */
function Metric({ best, kept, hint, children }: { best: boolean; kept: boolean; hint: string; children: ReactNode }) {
  if (!best) return <span className={kept ? 'text-fg' : undefined}>{children}</span>;
  return (
    <span
      title={hint}
      className={cn('inline-flex items-center gap-1 font-semibold text-shu-fg', !kept && 'opacity-60')}
    >
      <span className="size-1 shrink-0 rounded-full bg-shu" aria-hidden />
      {children}
    </span>
  );
}
