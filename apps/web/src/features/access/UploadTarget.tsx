/**
 * 设置 →「手机访问」：每台设备传上来的图放到哪（docs/mobile.md 5.4）。没设过的是默认：第一个自动识别的图库文件夹下的 收件箱/手机/<设备名>。
 * 手动上传再放进「手动上传」，以后同步的相册放进相册名的文件夹；改了只影响之后上传的，已经传上来的不搬。
 */
import type { DeviceInfo, LibraryRoot, UploadTarget } from '@emaki/shared';
import { FolderInput } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Dialog, DialogFooter, Input } from '@/components/ui';
import { useSettings } from '@/lib/queries';
import { useSetDeviceUpload } from './hooks';

/** 电脑上显示的路径：Windows 的盘符路径用反斜杠 */
export function displayPath(rootPath: string, ...parts: string[]): string {
  const joined = [rootPath.replace(/[\\/]+$/, ''), ...parts.filter(Boolean)].join('/');
  return /^[A-Za-z]:[\\/]/.test(rootPath) ? joined.replace(/\//g, '\\') : joined;
}

/** 「传上来的图放到 B:\…\收件箱\手机\小米平板（默认）」 */
export function UploadTargetLine({
  device,
  target,
  onChange,
}: {
  device: DeviceInfo;
  target: UploadTarget | undefined;
  onChange: () => void;
}) {
  if (!device.scopes.includes('upload') || !target) return null;
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-fg-muted">
      <span className="shrink-0">传上来的图放到</span>
      {target.rootPath ? (
        <span className="truncate font-mono text-[12px] text-fg" title={displayPath(target.rootPath, target.dir)}>
          {displayPath(target.rootPath, target.dir)}
        </span>
      ) : (
        <span className="text-warn">还没有能放图的图库文件夹</span>
      )}
      {target.isDefault && <span className="shrink-0 text-fg-subtle">（默认）</span>}
      <button
        type="button"
        onClick={onChange}
        className="shrink-0 text-fg-subtle underline-offset-4 touch-hit hover:text-fg hover:underline"
      >
        更改
      </button>
    </div>
  );
}

export function UploadTargetDialog({
  device,
  target,
  onClose,
}: {
  device: DeviceInfo | null;
  target: UploadTarget | undefined;
  onClose: () => void;
}) {
  // 只有自动识别的图库文件夹能当落点（按漫画导入的会把传上来的图当成漫画页）
  const roots = (useSettings().data?.libraryRoots ?? []).filter((r: LibraryRoot) => r.enabled && r.mode === 'auto');
  const [rootId, setRootId] = useState(target?.rootId ?? roots[0]?.id ?? '');
  const [dir, setDir] = useState(target?.dir ?? '');
  const { save, isPending } = useSetDeviceUpload();
  const root = roots.find((r) => r.id === rootId);
  const cleaned = dir
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!device || !root) return;
    save({ id: device.id, rootId: root.id, dir: cleaned }, onClose);
  };
  return (
    <Dialog
      open={!!device}
      onOpenChange={(o) => !o && onClose()}
      title={`「${device?.name ?? ''}」传上来的图放到`}
      description="手动上传的放进这里的「手动上传」，以后同步的相册放进相册名的文件夹。改了只影响之后上传的，已经传上来的不搬。"
      width={560}
    >
      <form onSubmit={submit}>
        <label htmlFor="upload-root" className="text-sm font-medium">
          图库文件夹
        </label>
        {roots.length > 1 ? (
          <select
            id="upload-root"
            value={rootId}
            onChange={(e) => setRootId(e.target.value)}
            className="mt-1.5 block h-9 w-full rounded-[10px] bg-sunken px-3 text-sm ring-1 ring-line outline-none focus:ring-2 focus:ring-shu/40"
          >
            {roots.map((r) => (
              <option key={r.id} value={r.id}>
                {r.path}
              </option>
            ))}
          </select>
        ) : (
          <div id="upload-root" className="mt-1.5 font-mono text-[12.5px]">
            {root ? root.path : <span className="text-warn">没有自动识别的图库文件夹，先在设置 → 图库里添加一个</span>}
          </div>
        )}
        <label htmlFor="upload-dir" className="mt-5 block text-sm font-medium">
          里面的文件夹
        </label>
        <Input
          id="upload-dir"
          className="mt-1.5"
          value={dir}
          maxLength={400}
          placeholder="例如 下载图片/平板导入；留空就是图库文件夹本身"
          onChange={(e) => setDir(e.target.value)}
          autoComplete="off"
        />
        {root && (
          <p className="mt-3 flex items-start gap-1.5 text-[12.5px] leading-relaxed text-fg-muted">
            <FolderInput className="mt-0.5 size-3.5 shrink-0" />
            <span>
              手动上传的图会放到 <span className="font-mono text-fg">{displayPath(root.path, cleaned, '手动上传')}</span>
            </span>
          </p>
        )}
        <DialogFooter>
          {target && !target.isDefault && device && (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              disabled={isPending}
              onClick={() => save({ id: device.id, rootId: null }, onClose)}
            >
              恢复默认
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={isPending} disabled={!root}>
            保存
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
