/**
 * 同步相册（B2，docs/mobile.md 5.5）：一台设备上的相册、盘点结果（电脑上已有几张、没有几张）、哪些在同步、新图放到哪、
 * 只在 Wi-Fi / 充电时同步。
 * - 电脑上：设置 →「手机访问」每台设备的「同步相册」（给 deviceId）；
 * - 手机上（App 0.3.0 起）：图库页头「从手机添加」→「同步相册」，看、改自己的，还能让 App 盘点、马上同步
 *   （window.EmakiApp.syncAlbums）。
 * 新图放到哪由电脑定（跟着老图走，没有老图按相册路径取名），第一次打开同步时定下来，之后可以改。
 */
import type { AlbumSyncInfo, DeviceAlbum } from '@emaki/shared';
import { ChevronDown, FolderInput, RefreshCw, ScanSearch } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Dialog, DialogFooter, Input, Skeleton, Spinner, Switch } from '@/components/ui';
import { cn } from '@/lib/cn';
import { appBridge } from '@/lib/deviceAuth';
import { formatBytes, formatCount, formatDateTime, formatRelative } from '@/lib/format';
import { errorMessage, useAlbumSync } from '@/lib/queries';
import { useSetAlbums } from './hooks';
import { displayPath } from './UploadTarget';

/** 「正在盘点相册：3,000 / 12,363」「同步 3 个相册 · 上次 5 分钟前 · 同步了 12 张」 */
export function syncStatusText(info: Pick<AlbumSyncInfo, 'state' | 'albums'>, now = Date.now()): string {
  const s = info.state;
  const progress = s.total ? `：${formatCount(s.done ?? 0)} / ${formatCount(s.total)}` : '…';
  if (s.running === 'inventory') return `正在盘点相册${progress}`;
  if (s.running === 'sync') return `正在同步${progress}`;
  const on = info.albums.filter((a) => a.sync).length;
  if (!on) return s.inventoriedAt ? `${formatRelative(s.inventoriedAt, now)}盘点过，还没有同步的相册` : '还没盘点过';
  return [`同步 ${on} 个相册`, s.syncedAt ? `上次 ${formatRelative(s.syncedAt, now)}` : '还没同步过', s.summary]
    .filter(Boolean)
    .join(' · ');
}

/** 「8,725 张 · 13.2 GB · 电脑上已有 8,571 张 · 没有的 152 张（194 MB）」；同步过的写还有几张没传上来 */
export function albumCountsText(a: DeviceAlbum): string {
  const head = `${formatCount(a.count)} 张 · ${formatBytes(a.bytes)}`;
  if (a.sync && a.syncedAt && a.pending !== null)
    return `${head} · ${a.pending ? `还有 ${formatCount(a.pending)} 张没传上来` : '都传上来了'}`;
  const inv = a.inventory;
  if (!inv) return `${head} · 没盘点过`;
  if (!inv.have && !inv.deleted) return `${head} · 电脑上一张都没有`;
  if (!inv.new && !inv.deleted) return `${head} · 都在电脑上`;
  return [
    head,
    inv.have && `电脑上已有 ${formatCount(inv.have)} 张`,
    inv.new && `没有的 ${formatCount(inv.new)} 张（${formatBytes(inv.newBytes)}）`,
    inv.deleted && `删过的 ${formatCount(inv.deleted)} 张不再传`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function AlbumSyncDialog({
  deviceId,
  deviceName,
  open,
  onOpenChange,
}: {
  deviceId?: string;
  deviceName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={deviceName ? `同步相册 · ${deviceName}` : '同步相册'} width={720}>
      {open && <AlbumSyncPanel deviceId={deviceId} />}
    </Dialog>
  );
}

export function AlbumSyncPanel({ deviceId }: { deviceId?: string }) {
  const bridge = appBridge();
  // 在 App 里看自己的：能让 App 盘点、马上同步
  const inApp = !deviceId && typeof bridge?.syncAlbums === 'function';
  const [kickedAt, setKickedAt] = useState<number | null>(null);
  // 刚让 App 开始：App 报上来之前也每 3 秒取一次（最多 3 分钟）
  const q = useAlbumSync(deviceId, { poll: kickedAt !== null && Date.now() - kickedAt < 180_000 });
  const kick = (mode: 'inventory' | 'sync') => {
    bridge?.syncAlbums?.(mode);
    setKickedAt(Date.now());
  };
  const { save, isPending } = useSetAlbums(deviceId, inApp ? () => kick('sync') : undefined);
  const [editing, setEditing] = useState<DeviceAlbum | null>(null);
  const [showOthers, setShowOthers] = useState(false);

  if (q.isPending) return <Skeleton className="h-28 w-full rounded-lg" />;
  if (q.isError) return <p className="text-[13px] text-danger">{errorMessage(q.error)}</p>;
  const info = q.data;
  const running = info.state.running !== null;
  // 同步着的、建议的放前面；其余的收起来
  const main = info.albums.filter((a) => a.sync || a.suggested);
  const others = info.albums.filter((a) => !a.sync && !a.suggested);
  const suggestedOff = info.albums.filter((a) => a.suggested && !a.sync);
  const noneOn = !info.albums.some((a) => a.sync);
  const target = info.target.rootPath ? displayPath(info.target.rootPath, info.target.dir) : null;
  const toggle = (a: DeviceAlbum, sync: boolean) => save({ albums: [{ path: a.path, sync }] });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex items-center gap-2 text-sm font-medium">
            {running && <Spinner className="size-3.5 text-fg-subtle" />}
            <span className="tabular">{syncStatusText(info)}</span>
          </div>
          {info.state.error && <p className="mt-1 text-[12.5px] leading-relaxed text-warn">{info.state.error}</p>}
          {info.state.reportedAt && (
            <div className="mt-0.5 text-[12px] text-fg-subtle" title={formatDateTime(info.state.reportedAt)}>
              App 上次报告：{formatRelative(info.state.reportedAt)}
            </div>
          )}
        </div>
        {inApp && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="ghost" icon={<ScanSearch />} disabled={running} onClick={() => kick('inventory')}>
              {info.state.inventoriedAt ? '重新盘点' : '盘点相册'}
            </Button>
            {!noneOn && (
              <Button size="sm" icon={<RefreshCw />} disabled={running} onClick={() => kick('sync')}>
                现在同步
              </Button>
            )}
          </div>
        )}
      </div>

      {!info.albums.length ? (
        <p className="rounded-xl px-5 py-4 text-[13px] leading-relaxed text-fg-muted ring-1 ring-line ring-inset">
          {inApp
            ? '还没盘点过。盘点会读这台设备上所有相册里的图，算出每张图的指纹问电脑有没有（只问，不上传），然后建议同步哪些相册。第一次要允许读照片。'
            : `还没盘点过。在「${info.deviceName}」上打开 Emaki，图库页头「从手机添加」→「同步相册」，点「盘点相册」（要 App 0.3.0 或更新）。`}
        </p>
      ) : (
        <>
          {noneOn && suggestedOff.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl bg-ok-soft px-4 py-3">
              <p className="min-w-0 flex-1 basis-72 text-[13px] leading-relaxed">
                以前从这台设备拷过这 {suggestedOff.length} 个相册的图（电脑上已有的大多在「上传到」里），建议同步它们：
                电脑上没有的会传上来，以后的新图也会。
              </p>
              <Button
                size="sm"
                variant="primary"
                loading={isPending}
                onClick={() => save({ albums: suggestedOff.map((a) => ({ path: a.path, sync: true })) })}
              >
                按建议同步
              </Button>
            </div>
          )}
          <ul className="divide-y divide-line">
            {main.map((a) => (
              <AlbumRow key={a.path} album={a} busy={isPending} onToggle={(v) => toggle(a, v)} onEditDir={() => setEditing(a)} />
            ))}
          </ul>
          {others.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowOthers((v) => !v)}
                className="flex items-center gap-1 text-[13px] font-medium text-fg-muted touch-hit hover:text-fg"
              >
                <ChevronDown className={cn('size-4 transition-transform', !showOthers && '-rotate-90')} />
                {main.length ? '其他相册' : '相册'} <span className="text-fg-subtle tabular">{others.length}</span>
              </button>
              {showOthers && (
                <ul className="mt-1 divide-y divide-line">
                  {others.map((a) => (
                    <AlbumRow key={a.path} album={a} busy={isPending} onToggle={(v) => toggle(a, v)} onEditDir={() => setEditing(a)} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      <div className="space-y-2.5 border-t border-line pt-4">
        <SettingRow
          label="只在 Wi-Fi 下同步"
          hint="用流量时不传（连得上电脑的话）。"
          checked={info.wifiOnly}
          disabled={isPending}
          onChange={(wifiOnly) => save({ wifiOnly })}
        />
        <SettingRow
          label="只在充电时同步"
          hint="盘点、手动点的「现在同步」不受影响。"
          checked={info.chargingOnly}
          disabled={isPending}
          onChange={(chargingOnly) => save({ chargingOnly })}
        />
      </div>

      <p className="text-[12px] leading-relaxed text-fg-subtle">
        {target ? (
          <>
            传上来的图放到 <span className="font-mono">{target}</span> 下面各相册的文件夹。
          </>
        ) : (
          '电脑上还没有能放图的图库文件夹。'
        )}
        只增不减：手机上删了图，电脑上不删；电脑上删掉的图不会再被同步回来。
        {inApp ? '' : '改了的设置，App 下次同步时生效（打开 App 会马上同步）。'}
      </p>

      <DirDialog
        key={editing?.path ?? 'none'}
        album={editing}
        info={info}
        busy={isPending}
        onSave={(dir, done) => editing && save({ albums: [{ path: editing.path, dir }] }, done)}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function AlbumRow({
  album: a,
  busy,
  onToggle,
  onEditDir,
}: {
  album: DeviceAlbum;
  busy: boolean;
  onToggle: (sync: boolean) => void;
  onEditDir: () => void;
}) {
  return (
    <li className={cn('flex items-start gap-3 py-3', a.gone && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-semibold tracking-tight" title={a.path}>
            {a.path}
          </span>
          {a.suggested && !a.sync && (
            <Badge tone="ok" className="shrink-0">
              建议同步
            </Badge>
          )}
          {a.gone && <Badge className="shrink-0">手机上没有这个文件夹了</Badge>}
        </div>
        <div className="mt-0.5 text-[12.5px] text-fg-muted tabular">{albumCountsText(a)}</div>
        {(a.sync || a.suggested) && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-fg-muted">
            <FolderInput className="size-3.5 shrink-0" />
            <span className="shrink-0">放到</span>
            <span className="truncate font-mono text-[12px] text-fg">{a.dir || '「上传到」本身'}</span>
            <span className="shrink-0 text-fg-subtle compact:hidden">（{a.dirNote}）</span>
            <button
              type="button"
              onClick={onEditDir}
              className="shrink-0 text-fg-subtle underline-offset-4 touch-hit hover:text-fg hover:underline"
            >
              改
            </button>
          </div>
        )}
      </div>
      <div className="shrink-0 pt-0.5">
        <Switch checked={a.sync} onCheckedChange={onToggle} disabled={busy} label={`同步「${a.path}」`} />
      </div>
    </li>
  );
}

function SettingRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="text-[12px] text-fg-subtle">{hint}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

function DirDialog({
  album,
  info,
  busy,
  onSave,
  onClose,
}: {
  album: DeviceAlbum | null;
  info: AlbumSyncInfo;
  busy: boolean;
  onSave: (dir: string | null, done: () => void) => void;
  onClose: () => void;
}) {
  const [dir, setDir] = useState(album?.dir ?? '');
  const cleaned = dir
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(cleaned, onClose);
  };
  return (
    <Dialog
      open={!!album}
      onOpenChange={(o) => !o && onClose()}
      title={`「${album?.path ?? ''}」的新图放到`}
      description="相对这台设备的「上传到」。只影响之后传上来的，已经传上来的不搬。"
      width={520}
    >
      <form onSubmit={submit}>
        <Input
          value={dir}
          maxLength={400}
          placeholder="例如 下载；留空就是「上传到」本身"
          onChange={(e) => setDir(e.target.value)}
          autoComplete="off"
        />
        {info.target.rootPath && (
          <p className="mt-3 flex items-start gap-1.5 text-[12.5px] leading-relaxed text-fg-muted">
            <FolderInput className="mt-0.5 size-3.5 shrink-0" />
            <span className="font-mono break-all text-fg">{displayPath(info.target.rootPath, info.target.dir, cleaned)}</span>
          </p>
        )}
        <DialogFooter>
          {album?.dirReason === 'manual' && (
            <Button type="button" variant="ghost" className="mr-auto" disabled={busy} onClick={() => onSave(null, onClose)}>
              恢复自动
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            保存
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
