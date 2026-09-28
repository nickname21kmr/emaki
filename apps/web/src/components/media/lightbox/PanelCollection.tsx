import type { CollectionKind, ImageDetail } from '@emaki/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button, Dialog, DialogFooter, Seal } from '@/components/ui';
import { api } from '@/lib/api';
import { COLLECTION_META } from '@/lib/collections';
import { undo, useMutate } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';

/**
 * 看图器信息里的「收录于」（T38f 第 3 点）：在合集里 → 《书名》第 N / M 页，点击进阅读器这一页；
 * 不在合集里、又不在根目录 → 「把这个文件夹做成合集…」。
 */
export function PanelCollection({ detail: d, onNavigate }: { detail: ImageDetail; onNavigate: () => void }) {
  const c = d.collection;
  if (c) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Link to={`/collections/${c.id}/read?p=${c.pageNo}`} onClick={onNavigate} className="text-fg transition-colors hover:text-shu">
          《{c.title ?? '无题'}》第 {c.pageNo} / {c.pageCount} 页
        </Link>
        <Seal glyph={COLLECTION_META[c.kind].glyph} size={16} />
      </span>
    );
  }
  const slash = d.relPath.lastIndexOf('/');
  if (slash < 0) return null;
  return <MakeCollection imageId={d.id} folder={d.relPath.slice(0, slash).split('/').pop()!} onNavigate={onNavigate} />;
}

function MakeCollection({ imageId, folder, onNavigate }: { imageId: string; folder: string; onNavigate: () => void }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();
  const create = useMutate((kind: CollectionKind) => api.createCollection({ fromImageId: imageId, kind }), {
    silent: true,
    onSuccess: (r) => {
      setOpen(false);
      const token = r.undoToken;
      toast.success(r.message, {
        action: {
          label: '去看看',
          onClick: () => {
            onNavigate();
            navigate(`/collections/${r.collection.id}`);
          },
        },
        ...(token && { cancel: { label: '撤销', onClick: () => void undo(token, client) } }),
      });
    },
  });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="text-left text-fg-muted underline-offset-2 transition-colors hover:text-shu hover:underline">
        把这个文件夹做成合集…
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="成册"
        description={`文件夹「${folder}」里的图会按文件名排成页；原文件不移动。`}
        width={420}
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button disabled={create.isPending} onClick={() => create.mutate('artbook')}>
            做成画集
          </Button>
          <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate('doujin')}>
            做成本子
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
