import type { ID } from '@emaki/shared';
import { FolderInput, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Dialog, DialogFooter, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useMutate, useSettings } from '@/lib/queries';

/** 角色名当默认文件夹名：去掉 Windows 不允许的字符 */
export function folderNameOf(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^[.$]+/, '')
    .replace(/[. ]+$/, '')
    .trim();
}

export type MoveTarget = { characterId: ID; ids?: undefined } | { ids: ID[]; characterId?: undefined };

/**
 * 移到图库里的某个文件夹（issue #1：识别完按角色分文件夹）。
 * 只能选图库里的文件夹，移完图还在图库里，识别和整理结果都保留；toast 里可以撤销。
 */
export function MoveImagesDialog({
  open,
  onOpenChange,
  target,
  count,
  what,
  defaultDir = '',
  onMoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: MoveTarget;
  count: number;
  /** 「圣园未花的」「选中的」 */
  what: string;
  defaultDir?: string;
  onMoved?: () => void;
}) {
  const { data: settings } = useSettings();
  const roots = (settings?.libraryRoots ?? []).filter((r) => r.enabled);
  const [rootId, setRootId] = useState<ID | null>(null);
  const [dir, setDir] = useState(defaultDir);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都从默认值开始
  useEffect(() => {
    if (!open) return;
    setDir(defaultDir);
    setError(null);
  }, [open, defaultDir]);
  const root = roots.find((r) => r.id === rootId) ?? roots[0];

  const move = useMutate(() => api.moveImages({ ...target, rootId: root!.id, dir }), {
    onError: setError,
    onSuccess: () => {
      onOpenChange(false);
      onMoved?.();
    },
  });

  const clean = dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
  const dest = root ? (clean ? `${root.path.replace(/\/$/, '')}/${clean}` : root.path) : '';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="移动到文件夹"
      description={`把${what} ${formatCount(count)} 张图移到图库里的一个文件夹。磁盘上的文件会真的移动，识别和整理结果都保留，可以撤销。`}
      width={520}
    >
      <div className="text-[13px] font-medium">图库文件夹</div>
      <div role="radiogroup" aria-label="图库文件夹" className="mt-2 flex flex-col gap-1">
        {roots.map((r) => (
          <button
            key={r.id}
            type="button"
            role="radio"
            aria-checked={r.id === root?.id}
            onClick={() => setRootId(r.id)}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-left font-mono text-[12.5px] transition-colors',
              r.id === root?.id ? 'bg-shu-soft text-shu-fg' : 'text-fg-muted hover:bg-hover',
            )}
          >
            <FolderOpen className="size-4 shrink-0" />
            <span className="truncate">{r.path}</span>
          </button>
        ))}
        {!roots.length && <p className="text-[13px] text-fg-muted">没有启用的图库文件夹。</p>}
      </div>

      <label className="mt-4 block text-[13px] font-medium" htmlFor="move-dir">
        里面的文件夹
      </label>
      <Input
        id="move-dir"
        className="mt-2 font-mono"
        value={dir}
        onChange={(e) => {
          setDir(e.target.value);
          setError(null);
        }}
        placeholder="留空就直接放在图库文件夹里"
        spellCheck={false}
        autoComplete="off"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && root && !move.isPending) move.mutate(undefined);
        }}
      />
      <p className={cn('mt-2 text-xs leading-relaxed', error ? 'text-danger' : 'text-fg-subtle')}>
        {error ?? '可以写多层，比如「角色/未花」。文件夹不存在会新建；重名的文件会改成「名字 (1)」；合集（本子、画集）里的页不会移动。'}
      </p>

      {dest && (
        <div className="mt-4 rounded-lg bg-sunken px-3.5 py-2.5 text-[12.5px]">
          <span className="text-fg-muted">移到 </span>
          <span className="font-mono break-all">{dest}</span>
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button variant="primary" icon={<FolderInput />} disabled={!root} loading={move.isPending} onClick={() => move.mutate(undefined)}>
          移动 {formatCount(count)} 张
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
