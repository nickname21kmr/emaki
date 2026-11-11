import type { ID } from '@emaki/shared';
import { useMemo, useState } from 'react';
import { MountFrame, SelectCircle } from '@/components/media/ImageGrid';
import { Thumb } from '@/components/media/Thumb';
import { Button, Dialog, DialogFooter, SearchInput, Segmented, Skeleton } from '@/components/ui';
import { useDebounced } from '@/features/gallery/useDebounced';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useImagesInfinite, useMutate } from '@/lib/queries';

/**
 * 给组图添加图片：搜图库，或者参考组里第一张找构图相近的（复用查重的 dHash 范围，只给候选，不自动归组）。
 * 选中的样式和网格一致：勾选圈 + 装裱框。
 */
export function CollectionImagePicker({
  id,
  open,
  onOpenChange,
  memberIds,
}: {
  id: ID;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  memberIds: ID[];
}) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const [mode, setMode] = useState<'all' | 'similar'>('all');
  const [selected, setSelected] = useState<Set<ID>>(new Set());
  const similar = mode === 'similar' && !!memberIds[0];
  const list = useImagesInfinite({
    ...(similar ? { similarTo: memberIds[0] } : {}),
    q: q || undefined,
    collapseCollections: false,
    limit: 60,
  });
  const images = useMemo(() => {
    const known = new Set(memberIds);
    return list.data?.pages.flatMap((p) => p.items).filter((i) => !known.has(i.id)) ?? [];
  }, [list.data, memberIds]);
  const add = useMutate(() => api.updateCollection(id, { addImageIds: [...selected] }), {
    onSuccess: () => {
      setSelected(new Set());
      onOpenChange(false);
    },
  });
  const toggle = (imageId: ID) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(imageId)) next.delete(imageId);
      else next.add(imageId);
      return next;
    });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="添加图片"
      description={selected.size ? `已选 ${formatCount(selected.size)} 张 · 原来在别的组图里的会移过来` : '点图选择；原来在别的组图里的会移过来'}
      width={780}
    >
      <div className="flex items-center gap-3">
        <SearchInput aria-label="搜索图片" value={text} onChange={(e) => setText(e.target.value)} placeholder="搜索角色、作品、标签或文件名" className="flex-1" />
        <Segmented<'all' | 'similar'>
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'all', label: '全部' },
            { value: 'similar', label: '构图相近' },
          ]}
        />
      </div>

      <div className="mt-4 h-[52vh] overflow-y-auto pr-1 scrollbar-thin">
        {list.isPending ? (
          <div className="grid grid-cols-5 gap-1.5">
            {Array.from({ length: 15 }, (_, i) => (
              <Skeleton key={i} className="aspect-square rounded-[var(--radius-plate-sm)]" />
            ))}
          </div>
        ) : images.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-fg-muted">
            {similar ? '组外没有构图相近的图，可以切回「全部」挑。' : q ? `没有找到「${q}」` : '没有可以添加的图'}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-5 gap-1.5">
              {images.map((image) => {
                const on = selected.has(image.id);
                return (
                  <div
                    key={image.id}
                    role="checkbox"
                    aria-checked={on}
                    aria-label={image.fileName}
                    tabIndex={0}
                    onClick={() => toggle(image.id)}
                    onKeyDown={(e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        toggle(image.id);
                      }
                    }}
                    className={cn(
                      'group/tile group/reveal relative aspect-square cursor-pointer overflow-hidden rounded-[var(--radius-plate-sm)] outline-none',
                      'transition-[scale] duration-200 ease-[var(--ease-out-soft)] focus-visible:ring-2 focus-visible:ring-shu',
                      on && 'motion-safe:scale-[.955]',
                    )}
                  >
                    <Thumb image={image} width={240} blurBadge="corner" className="size-full" />
                    <MountFrame selected={on} />
                    <SelectCircle selected={on} selecting onToggle={() => toggle(image.id)} />
                  </div>
                );
              })}
            </div>
            {list.hasNextPage && (
              <div className="flex justify-center py-4">
                <Button variant="ghost" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  再加载一些
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button variant="primary" disabled={!selected.size} loading={add.isPending} onClick={() => add.mutate()}>
          {selected.size ? `添加 ${formatCount(selected.size)} 张` : '添加'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
