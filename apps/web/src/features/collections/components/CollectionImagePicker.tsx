import { useMemo, useState } from 'react';
import { Button, Dialog, DialogFooter, SearchInput, Switch } from '@/components/ui';
import { Thumb } from '@/components/media/Thumb';
import { useImagesInfinite, useMutate } from '@/lib/queries';
import { api } from '@/lib/api';

export function CollectionImagePicker({
  id,
  open,
  onOpenChange,
  memberIds,
}: {
  id: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  memberIds: string[];
}) {
  const [q, setQ] = useState(''),
    [selected, setSelected] = useState<Set<string>>(new Set());
  const [similar, setSimilar] = useState(false);
  const [organize, setOrganize] = useState(false);
  const list = useImagesInfinite({
    ...(similar && memberIds[0] ? { similarTo: memberIds[0] } : {}),
    q: q || undefined,
    collapseCollections: false,
    limit: 60,
  });
  const images = useMemo(() => {
    const known = new Set(memberIds);
    return list.data?.pages.flatMap((p) => p.items).filter((i) => !known.has(i.id)) ?? [];
  }, [list.data, memberIds]);
  const add = useMutate(() => api.updateCollection(id, { addImageIds: [...selected], organizeFiles: organize }), {
    onSuccess: () => {
      setSelected(new Set());
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="添加图片"
      description={`已选 ${selected.size} 张；已有合集的图片会移入此合集。`}
      width={760}
    >
      <div className="mb-3 flex items-center justify-between">
        <Button size="sm" variant="ghost" onClick={() => setSimilar(!similar)} disabled={!memberIds.length}>
          {similar ? '浏览全部图片' : '找构图相近的图片'}
        </Button>
        {similar && <span className="text-xs text-fg-muted">参考组内第一张图，勾选后添加</span>}
      </div>
      <SearchInput aria-label="搜索图片" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索文件名、角色或标签" />
      <div className="mt-3 grid max-h-[55vh] grid-cols-5 gap-2 overflow-y-auto p-1">
        {images.map((image) => (
          <button
            key={image.id}
            aria-label={image.fileName}
            aria-pressed={selected.has(image.id)}
            className={`relative h-28 overflow-hidden rounded-lg ${selected.has(image.id) ? 'ring-3 ring-shu' : ''}`}
            onClick={() =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(image.id)) next.delete(image.id);
                else next.add(image.id);
                return next;
              })
            }
          >
            <Thumb image={image} width={240} className="size-full" />
            {selected.has(image.id) && <span className="absolute top-1 left-1 rounded-full bg-shu px-1.5 text-white">✓</span>}
          </button>
        ))}
        {list.hasNextPage && (
          <Button onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            加载更多
          </Button>
        )}
        {!list.isPending && !images.length && (
          <p className="col-span-5 py-8 text-center text-sm text-fg-muted">
            {similar ? '没有找到合集外构图相近的图片，可切回全部图片挑选。' : '没有符合搜索的图片'}
          </p>
        )}
        {list.isError && <Button onClick={() => void list.refetch()}>重新加载</Button>}
      </div>
      <div className="mt-3"><Switch checked={organize} onCheckedChange={setOrganize} label="同时整理文件夹" /></div>
    <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button variant="primary" disabled={!selected.size || add.isPending} onClick={() => add.mutate()}>
          添加 {selected.size} 张
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
