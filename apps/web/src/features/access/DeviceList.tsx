import type { DeviceInfo, Scope, UploadTarget } from '@emaki/shared';
import { Pencil, Smartphone, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Dialog, DialogFooter, Input } from '@/components/ui';
import { formatDateTime, formatRelative } from '@/lib/format';
import { describeScopes, scopeText, sortScopes } from './format';
import { useRevokeDevice, useUpdateDevice } from './hooks';
import { ScopePicker } from './ScopePicker';
import { UploadTargetDialog, UploadTargetLine } from './UploadTarget';

/** 「3 分钟前 · 192.168.1.23」；还没用过时写「还没连接过」 */
export function lastSeenText(d: Pick<DeviceInfo, 'lastSeenAt' | 'lastAddress'>, now = Date.now()): string {
  if (!d.lastSeenAt) return '还没连接过';
  return [formatRelative(d.lastSeenAt, now), d.lastAddress].filter(Boolean).join(' · ');
}

/**
 * 设置 →「手机访问」里已批准的设备：名称、型号、最后访问、权限、传上来的图放到哪（有上传权限的）；
 * 「编辑」（改名称、权限）「移除」，「更改」落点
 */
export function DeviceList({ devices, targets = [] }: { devices: DeviceInfo[]; targets?: UploadTarget[] }) {
  const [editing, setEditing] = useState<DeviceInfo | null>(null);
  const [removing, setRemoving] = useState<DeviceInfo | null>(null);
  const [placing, setPlacing] = useState<DeviceInfo | null>(null);
  const targetOf = (id: string) => targets.find((t) => t.deviceId === id);
  return (
    <>
      <ul className="divide-y divide-line">
        {devices.map((d) => (
          <li key={d.id} className="flex items-center gap-3 py-3.5">
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sunken text-fg-muted">
              <Smartphone className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-sm font-semibold tracking-tight">{d.name}</span>
                {d.model && <span className="truncate text-[12.5px] text-fg-subtle">{d.model}</span>}
              </div>
              <div className="mt-0.5 truncate text-[12.5px] text-fg-muted">
                <span title={d.lastSeenAt ? formatDateTime(d.lastSeenAt) : undefined}>{lastSeenText(d)}</span>
                <span className="text-fg-subtle"> · </span>
                <span title={sortScopes(d.scopes).map((s) => scopeText(s).head).join('、')}>{describeScopes(d.scopes)}</span>
              </div>
              <UploadTargetLine device={d} target={targetOf(d.id)} onChange={() => setPlacing(d)} />
            </div>
            <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(d)}>
              编辑
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setRemoving(d)}>
              移除
            </Button>
          </li>
        ))}
      </ul>
      {/* key：换一台设备时表单从头来 */}
      <EditDeviceDialog key={editing?.id ?? 'none'} device={editing} onClose={() => setEditing(null)} />
      <RemoveDeviceDialog device={removing} onClose={() => setRemoving(null)} />
      <UploadTargetDialog key={`place-${placing?.id ?? 'none'}`} device={placing} target={placing ? targetOf(placing.id) : undefined} onClose={() => setPlacing(null)} />
    </>
  );
}

function EditDeviceDialog({ device, onClose }: { device: DeviceInfo | null; onClose: () => void }) {
  const [name, setName] = useState(device?.name ?? '');
  const [scopes, setScopes] = useState<Scope[]>(device ? sortScopes(device.scopes) : []);
  const { update, isPending } = useUpdateDevice();
  const trimmed = name.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!device || !trimmed || !scopes.length) return;
    update({ id: device.id, name: trimmed, scopes }, onClose);
  };
  return (
    <Dialog
      open={!!device}
      onOpenChange={(o) => !o && onClose()}
      title="编辑设备"
      description="改了权限，这台设备的下一个请求就按新的来。"
      width={560}
    >
      <form onSubmit={submit}>
        <label htmlFor="device-name" className="text-sm font-medium">
          名称
        </label>
        <Input
          id="device-name"
          className="mt-1.5"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
        />
        <div className="mt-5 text-sm font-medium">权限</div>
        <div className="mt-2">
          <ScopePicker value={scopes} onChange={setScopes} />
        </div>
        <DialogFooter>
          {!scopes.length && <span className="mr-auto text-[12.5px] text-warn">至少勾一项</span>}
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={isPending} disabled={!trimmed || !scopes.length}>
            保存
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function RemoveDeviceDialog({ device, onClose }: { device: DeviceInfo | null; onClose: () => void }) {
  const { revoke, isPending } = useRevokeDevice();
  return (
    <Dialog open={!!device} onOpenChange={(o) => !o && onClose()} title={`移除「${device?.name ?? ''}」？`} width={440}>
      <p className="text-[13px] leading-relaxed">
        移除后这台设备立即断开，之后的请求一律被拒绝。要再用的话，得在它上面重新请求连接，你再批准一次。
      </p>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button variant="danger" icon={<Trash2 />} loading={isPending} onClick={() => device && revoke(device.id, onClose)}>
          移除
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
