import type { Artist, UpdateArtistLinksBody } from '@emaki/shared';
import { Ellipsis, GitMerge, RotateCcw, Split } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Chip, Dialog, DialogFooter, IconButton, Menu, MenuItem } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutate } from '@/lib/queries';
import { ArtistPickerPanel } from '../ArtistPicker';

const plain = (tag: string) => tag.replace(/_/g, ' ');

/**
 * 按画师看图时标题旁的「…」：自动合并猜错了可以拆开、合并到另一位、恢复自动（都能撤销）。
 * 自动合并按 Danbooru 资料猜：旧名、社团名并到本人；猜错的例子是 A 的其他名字里写着同伴 B 的标签。
 */
export function ArtistMenu({ artist, onMoved }: { artist: Artist; onMoved: (tag: string) => void }) {
  const [dialog, setDialog] = useState<'split' | 'merge' | null>(null);
  const links = useMutate((body: UpdateArtistLinksBody) => api.updateArtistLinks(body), {
    onSuccess: (_, body) => {
      setDialog(null);
      // 合并之后去看并到的那位；拆开之后这一页还在（剩下的标签还是这位）
      if (body.mode === 'merge' && body.into) onMoved(body.into);
    },
  });
  return (
    <>
      <Menu
        align="end"
        width={200}
        trigger={
          <IconButton label="画师的更多操作">
            <Ellipsis />
          </IconButton>
        }
      >
        {artist.tags.some((t) => t !== artist.tag) && (
          <MenuItem icon={<Split />} onSelect={() => setDialog('split')}>
            拆开…
          </MenuItem>
        )}
        <MenuItem icon={<GitMerge />} onSelect={() => setDialog('merge')}>
          合并到…
        </MenuItem>
        {artist.manual && (
          <MenuItem icon={<RotateCcw />} onSelect={() => links.mutate({ tags: artist.tags, mode: 'auto' })}>
            恢复自动合并
          </MenuItem>
        )}
      </Menu>
      <SplitDialog open={dialog === 'split'} onOpenChange={(o) => setDialog(o ? 'split' : null)} artist={artist} busy={links.isPending} onSplit={(tags) => links.mutate({ tags, mode: 'split' })} />
      <Dialog
        open={dialog === 'merge'}
        onOpenChange={(o) => setDialog(o ? 'merge' : null)}
        title={`把「${artist.name}」合并到…`}
        description="其实是同一个人（旧名、社团名、另一个账号）：合并后按一位画师算。"
        width={420}
      >
        <ArtistPickerPanel
          allowNew={false}
          autoHighlight={false}
          selectedTags={artist.tags}
          selectedLabel="就是这位"
          onPick={(tag) => links.mutate({ tags: artist.tags, mode: 'merge', into: tag })}
        />
      </Dialog>
    </>
  );
}

/** 拆开：选出哪些标签其实是别人，它们各自单独算一位 */
function SplitDialog({
  open,
  onOpenChange,
  artist,
  busy,
  onSplit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artist: Artist;
  busy: boolean;
  onSplit: (tags: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  // 每次打开都重新选（上次拆开过、取消过、换了画师都不带过来）
  useEffect(() => {
    if (open) setPicked([]);
  }, [open, artist.tag]);
  // 能拆的是被并进来的标签；代表标签就是这位画师本人，拆它等于什么都没拆
  const candidates = artist.tags.filter((t) => t !== artist.tag);
  const sel = picked.filter((t) => candidates.includes(t));
  const toggle = (t: string) => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));
  const valid = sel.length > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setPicked([]);
        onOpenChange(o);
      }}
      title={`拆开「${artist.name}」`}
      description="下面是被合并到这位画师的标签。选出其实是别人的，它们会各自单独算一位画师。"
      width={440}
    >
      <div className="flex flex-wrap gap-1.5">
        <Chip type="button" size="sm" disabled title="这位画师本人">
          {plain(artist.tag)} · 本人
        </Chip>
        {candidates.map((t) => (
          <Chip key={t} type="button" size="sm" selected={sel.includes(t)} onClick={() => toggle(t)}>
            {plain(t)}
          </Chip>
        ))}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button type="button" variant="primary" loading={busy} disabled={!valid} onClick={() => onSplit(sel)}>
          拆开 {sel.length || ''}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
