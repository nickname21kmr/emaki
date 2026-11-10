import type { ID, ImageItem } from '@emaki/shared';
import { Layers } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Dialog, DialogFooter, Input, SearchInput, Segmented, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { useCollections, useMutate } from '@/lib/queries';
import { usePrefs, useSelection } from '@/lib/stores';

export const selectionIds = (image: ImageItem): ID[] => image.collectionGroup?.memberIds ?? [image.id];
export const toggleImageSelection = (image: ImageItem) => {
  const store = useSelection.getState(),
    ids = selectionIds(image),
    next = new Set(store.ids);
  if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
  else ids.forEach((id) => next.add(id));
  store.setMany([...next]);
  useSelection.setState({ anchor: image.id });
};

export function CollapseCollectionsToggle() {
  const value = usePrefs((s) => s.collapseCollections);
  const set = usePrefs((s) => s.setCollapseCollections);
  return (
    <Button size="sm" variant="ghost" icon={<Layers className="size-3.5" />} onClick={() => set(!value)}>
      {value ? '展开图片' : '收拢合集'}
    </Button>
  );
}

/** Reused by every image selection toolbar, including inside a collection (split/reorganize). */
export function AddToCollection({ ids, onDone, inverse = false }: { ids?: ID[]; onDone?: () => void; inverse?: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [existing, setExisting] = useState(false),
    [search, setSearch] = useState('');
  const [organize, setOrganize] = useState(false);
  const selected = useSelection((s) => s.ids);
  const images = ids ?? [...selected];
  const list = useCollections({});
  const save = useMutate(
    async () =>
      existing && target
        ? api.updateCollection(target, { addImageIds: images, organizeFiles: organize })
        : api.createCollection({ imageIds: images, kind: 'group', title: name.trim() || '新合集', organizeFiles: organize }),
    {
      onSuccess: () => {
        setOpen(false);
        onDone?.();
        useSelection.getState().clear();
      },
    },
  );
  useEffect(() => {
    if (!open) {
      setName('');
      setTarget('');
      setOrganize(false);
      setExisting(false);
      setSearch('');
    }
  }, [open]);
  return (
    <>
      <Button size="sm" variant="ghost" icon={<Layers className="size-3.5" />} className={inverse ? 'text-fg-inverse/85 hover:bg-fg-inverse/10 hover:text-fg-inverse' : undefined} onClick={() => setOpen(true)}>
        加入合集…
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title="加入合集" description={`已选 ${images.length} 张图片`} width={440}>
        <div className="space-y-4 py-3">
          <Segmented<'new' | 'existing'>
            value={existing ? 'existing' : 'new'}
            onChange={(v) => {
              setExisting(v === 'existing');
              setTarget('');
            }}
            options={[
              { value: 'new', label: '新建合集' },
              { value: 'existing', label: '已有合集' },
            ]}
          />
          {existing ? (
            <>
              <SearchInput
                aria-label="搜索合集"
                placeholder="搜索合集名称或投稿号"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div role="listbox" aria-label="选择合集" className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line p-1">
                {list.data
                  ?.filter((c) => (c.title ?? c.folderName).toLowerCase().includes(search.toLowerCase()))
                  .sort(
                    (a, b) =>
                      Number(b.origin === 'manual') - Number(a.origin === 'manual') ||
                      (b.lastAddedAt ?? '').localeCompare(a.lastAddedAt ?? ''),
                  )
                  .slice(0, 60)
                  .map((c) => (
                    <button
                      key={c.id}
                      role="option"
                      aria-selected={target === c.id}
                      onClick={() => setTarget(c.id)}
                      className={`block w-full rounded-md px-3 py-2 text-left text-sm ${target === c.id ? 'bg-shu/15 text-shu' : 'hover:bg-hover'}`}
                    >
                      {c.title ?? c.folderName} · {c.pageCount} 张
                    </button>
                  ))}
              </div>
              {list.isError && <Button onClick={() => void list.refetch()}>重新加载合集</Button>}
              <p className="text-xs text-fg-muted">显示前 60 项，可输入名称或投稿号缩小范围。</p>
            </>
          ) : (
            <Input aria-label="合集名称" placeholder="合集名称" value={name} onChange={(e) => setName(e.target.value)} />
          )}
          <p className="text-xs text-fg-muted">已经收录在其他合集中的图片会移入所选合集。</p>
          <Switch checked={organize} onCheckedChange={setOrganize} label="同时整理文件夹" />
          <p className="text-xs text-fg-muted">同一文件夹内属于此合集的图片归入一个子文件夹。不同目录分别整理，可撤销。</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="primary" disabled={save.isPending || !images.length || (existing && !target)} onClick={() => save.mutate()}>
            {existing ? '添加' : '创建'}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
