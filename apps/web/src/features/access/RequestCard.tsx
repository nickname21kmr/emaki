import { DEVICE_DEFAULT_SCOPES, type PairRequestInfo, type Scope } from '@emaki/shared';
import { Check, ChevronDown, Smartphone, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { describeScopes, formatCountdown } from './format';
import { useApproveRequest, useRejectRequest } from './hooks';
import { groupCode } from './pairing';
import { ScopePicker } from './ScopePicker';

/** 6 位校验码，按 3 + 3 分组；读屏逐位念 */
export function PairCode({ code, className }: { code: string; className?: string }) {
  return (
    <span
      className={cn('font-mono font-semibold tracking-[0.08em] whitespace-nowrap tabular', className)}
      aria-label={`校验码 ${code.split('').join(' ')}`}
    >
      {groupCode(code)}
    </span>
  );
}

/** 「Chrome · Android 14 · 来自 192.168.1.23」 */
export const requestMeta = (r: Pick<PairRequestInfo, 'model' | 'address'>) =>
  [r.model, r.address && `来自 ${r.address}`].filter(Boolean).join(' · ');

/**
 * 设置 →「手机访问」里等批准的一条：设备、型号、地址、大号校验码、剩余时间，「批准」「拒绝」；
 * 权限默认折叠（默认权限），展开后可以勾选再批准
 */
export function RequestCard({ request, now, defaultOpen = false }: { request: PairRequestInfo; now: number; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [scopes, setScopes] = useState<Scope[]>([...DEVICE_DEFAULT_SCOPES]);
  const { approve, isPending: approving } = useApproveRequest();
  const { reject, isPending: rejecting } = useRejectRequest();
  const left = Date.parse(request.expiresAt) - now;
  const meta = requestMeta(request);

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-sunken text-fg-muted">
            <Smartphone className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight break-all">{request.name}</div>
            {meta && <div className="mt-0.5 text-[12.5px] text-fg-muted">{meta}</div>}
            <div className="mt-0.5 text-[12px] text-fg-subtle tabular">{left > 0 ? `还剩 ${formatCountdown(left)}` : '已过期'}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11.5px] text-fg-subtle">校验码</div>
          <PairCode code={request.code} className="text-[30px] leading-tight" />
        </div>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-fg-muted">核对手机上显示的数字一样再批准；不一样的话拒绝，可能有人在冒充。</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          icon={<Check />}
          loading={approving}
          disabled={rejecting || left <= 0 || scopes.length === 0}
          onClick={() => approve(request.id, scopes)}
        >
          批准
        </Button>
        <Button size="sm" icon={<X />} loading={rejecting} disabled={approving || left <= 0} onClick={() => reject(request.id)}>
          拒绝
        </Button>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ml-auto flex h-7 items-center gap-1 rounded-sm px-2 text-[12.5px] text-fg-muted hover:bg-hover hover:text-fg"
        >
          权限：{describeScopes(scopes)}
          <ChevronDown className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} />
        </button>
      </div>
      {open && (
        <div className="mt-3 animate-fade-in rounded-lg bg-sunken px-3.5 py-3">
          <ScopePicker value={scopes} onChange={setScopes} />
        </div>
      )}
    </li>
  );
}
