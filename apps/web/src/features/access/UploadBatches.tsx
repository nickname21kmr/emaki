/**
 * 设置 →「手机访问」：最近从手机传上来的（docs/mobile.md 5.4）。每一批：哪台设备、手动上传还是哪个相册、什么时候，
 * 新入库几张、本来就有几张、失败几张，新入库的缩略图（点开是看图器）；「撤销这一批」把新入库的移到回收站（可以再撤销）。
 */
import type { UploadBatch } from '@emaki/shared';
import { Undo2 } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import { imageUrl } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount, formatDateTime, formatRelative } from '@/lib/format';
import { useLightbox } from '@/lib/stores';
import { useUndoUploadBatch } from './hooks';

/** 「新入库 8 张 · 本来就有 2 张 · 失败 1 张 · 还在传 1 张」，没有的不写 */
export function batchCounts(b: Pick<UploadBatch, 'imported' | 'existing' | 'failed' | 'receiving'>): string {
  return (
    [
      b.imported && `新入库 ${formatCount(b.imported)} 张`,
      b.existing && `本来就有 ${formatCount(b.existing)} 张`,
      b.failed && `失败 ${formatCount(b.failed)} 张`,
      b.receiving && `还在传 ${formatCount(b.receiving)} 张`,
    ]
      .filter(Boolean)
      .join(' · ') || '还没有传完的图'
  );
}

export function UploadBatches({ batches }: { batches: UploadBatch[] }) {
  const { undoBatch, isPending, variables } = useUndoUploadBatch();
  return (
    <ul className="divide-y divide-line">
      {batches.map((b) => (
        <li key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-2.5 py-3.5">
          <div className="min-w-0 flex-1 basis-60">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-sm font-semibold tracking-tight">{b.deviceName}</span>
              <span className="shrink-0 text-[12.5px] text-fg-subtle">{b.album ? `相册「${b.album}」` : '手动上传'}</span>
              <span className="shrink-0 text-[12.5px] text-fg-subtle" title={formatDateTime(b.updatedAt)}>
                {formatRelative(b.updatedAt)}
              </span>
            </div>
            <div className="mt-0.5 text-[12.5px] text-fg-muted tabular">{batchCounts(b)}</div>
          </div>
          {b.imageIds.length > 0 && (
            // 撤销过的（图在回收站里）调暗
            <div className={cn('flex shrink-0 gap-1', b.undoneAt && 'opacity-40')}>
              {b.imageIds.slice(0, 6).map((id, i) => (
                <button
                  key={id}
                  type="button"
                  aria-label="在看图器里打开"
                  onClick={() => useLightbox.getState().show(b.imageIds, i, `upload:${b.id}`)}
                  className="size-10 overflow-hidden rounded-[8px] bg-sunken ring-1 ring-line transition-opacity hover:opacity-85"
                >
                  <img src={imageUrl.thumb(id, 240)} alt="" loading="lazy" className="size-full object-cover" />
                </button>
              ))}
            </div>
          )}
          <div className="shrink-0">
            {b.undoneAt ? (
              <Badge>已撤销</Badge>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                icon={<Undo2 />}
                disabled={!b.imported || b.receiving > 0}
                loading={isPending && variables === b.id}
                onClick={() => undoBatch(b.id)}
              >
                撤销这一批
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
