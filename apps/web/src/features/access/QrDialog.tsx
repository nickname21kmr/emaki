import type { AccessTicket } from '@emaki/shared';
import { useMutation } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { encode } from 'uqr';
import { Button, Dialog, Spinner } from '@/components/ui';
import { useNow } from '@/features/settings/hooks';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/queries';
import { formatCountdown } from './format';

/**
 * 二维码的点阵画成一条 SVG path（uqr 只负责编码）。深色模块用 currentColor：外面包一层 data-theme="light"，
 * 深色主题下也是浅底深码（有的扫码器不认反色的码），颜色仍然来自 token
 */
export function QrCode({ text, size = 232, className }: { text: string; size?: number; className?: string }) {
  const { d, n } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 0 });
    let path = '';
    qr.data.forEach((row, y) => row.forEach((on, x) => on && (path += `M${x} ${y}h1v1h-1z`)));
    return { d: path, n: qr.size };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" role="img" aria-label="二维码" className={className}>
      <path d={d} fill="currentColor" />
    </svg>
  );
}

/**
 * 「用二维码添加」：打开时生成一次性口令（access.createTicket，2 分钟有效、用一次就失效），画成二维码；
 * 显示剩余时间，过期后变淡，点「刷新」再生成一个。扫码的是 Emaki App：扫了就算你在电脑上同意了，不用再批准
 */
export function QrDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ticket = useMutation({ mutationFn: api.createAccessTicket, onError: (err) => toast.error(errorMessage(err)) });
  const { mutate, reset } = ticket;
  useEffect(() => {
    if (open) mutate();
    else reset();
  }, [open, mutate, reset]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="用二维码添加"
      description="用手机上的 Emaki App 扫这个码。扫了就算你已经在电脑上同意了，不用再批准。"
      width={420}
    >
      <TicketView ticket={ticket.data} pending={ticket.isPending} failed={ticket.isError} onRefresh={() => mutate()} />
    </Dialog>
  );
}

export function TicketView({
  ticket,
  pending,
  failed,
  onRefresh,
}: {
  ticket: AccessTicket | undefined;
  pending: boolean;
  failed: boolean;
  onRefresh: () => void;
}) {
  const now = useNow(!!ticket);
  const left = ticket ? Date.parse(ticket.expiresAt) - now : 0;
  const expired = !!ticket && left <= 0;
  return (
    <div className="flex flex-col items-center">
      <div data-theme="light" className="relative rounded-xl bg-raised p-4 text-fg ring-1 ring-line">
        {ticket ? (
          <QrCode text={ticket.uri} className={cn('transition-opacity duration-300', (expired || pending) && 'opacity-15')} />
        ) : (
          <div className="size-[232px]" />
        )}
        {(pending || expired || (failed && !ticket)) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            {pending ? (
              <Spinner className="size-5 text-fg-muted" />
            ) : (
              <>
                <span className="text-[13px] font-medium">{expired ? '二维码过期了' : '没能生成二维码'}</span>
                <Button size="sm" variant="primary" icon={<RotateCw />} onClick={onRefresh}>
                  刷新
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      <p className="mt-3 h-5 text-[12.5px] text-fg-muted tabular" aria-live="polite">
        {ticket && !expired && !pending ? `还剩 ${formatCountdown(left)} · 只能用一次` : ''}
      </p>
    </div>
  );
}
