/**
 * 批准提示（docs/mobile.md 2.3）：手机发来连接请求时，本机入口上不管在哪个页面都弹出来，一条请求一张，不会自动消失：
 * 「Pixel 7 请求连接这台电脑 · 校验码 123 456」，「批准」（默认权限）「拒绝」「设置…」（跳到设置 →「手机访问」，可以改权限再批准）。
 *
 * 为什么不用 sonner 的 toast：toast 是操作的结果（墨色胶囊 + 朱色引信，几秒后烧完，FRONTEND.md「结果 toast」），堆在底部正中，
 * 最多叠 3 条、后来的会把前面的压下去；这里是要你做决定的请求，要一直留着、几条并排都看得见、按钮要多。所以单独一叠卡片，
 * 放在右上角（页头全局操作的下面），和底部的 toast、多选栏、助手胶囊都不抢位置。
 *
 * 数据只认 GET /api/access 的 requests（SSE 的 access 事件让它重新取，requested 时先放进缓存）：请求过期、在设置页里处理掉、
 * 别的标签页处理掉（重新取的 requests 里没有它了）时，提示自动收起。局域网入口上这个查询是 null（403），什么也不显示。
 */
import type { PairRequestInfo } from '@emaki/shared';
import { Check, Smartphone, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui';
import { useNow } from '@/features/settings/hooks';
import { DURATION, EASE_OUT } from '@/lib/motion';
import { useAccessStatus } from '@/lib/queries';
import { formatCountdown } from './format';
import { useApproveRequest, useRejectRequest } from './hooks';
import { PairCode, requestMeta } from './RequestCard';

/**
 * 要弹出的请求：没过期、没在这里处理掉的；点过「设置…」的在设置页上不再弹（设置页里已经列着）。
 * handled：这一页批准、拒绝成功了、还没等到重新取的
 */
export function visiblePrompts(
  requests: readonly PairRequestInfo[],
  o: { now: number; handled: ReadonlySet<string>; handedOff: ReadonlySet<string>; onSettings: boolean },
): PairRequestInfo[] {
  return requests.filter((r) => Date.parse(r.expiresAt) > o.now && !o.handled.has(r.id) && !(o.onSettings && o.handedOff.has(r.id)));
}

export function AccessPrompts() {
  const requests = useAccessStatus().data?.requests;
  const now = useNow(!!requests?.length);
  const { pathname } = useLocation();
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
  const [handedOff, setHandedOff] = useState<ReadonlySet<string>>(new Set());
  const shown = visiblePrompts(requests ?? [], { now, handled, handedOff, onSettings: pathname === '/settings' });
  const add = (set: ReadonlySet<string>, id: string) => new Set([...set, id]);

  return (
    <div
      role="region"
      aria-label="连接请求"
      className="pointer-events-none fixed top-[72px] z-[55] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2.5"
      style={{ right: 'calc(var(--assistant-right, 0px) + 24px)' }}
    >
      <AnimatePresence initial={false}>
        {shown.map((r) => (
          <motion.div
            key={r.id}
            layout
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: DURATION.base, ease: EASE_OUT }}
          >
            <PromptCard
              request={r}
              now={now}
              onDone={() => setHandled((s) => add(s, r.id))}
              onHandOff={() => setHandedOff((s) => add(s, r.id))}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

interface PromptCardProps {
  request: PairRequestInfo;
  now: number;
  /** 批准、拒绝成功了 */
  onDone: () => void;
  /** 点了「设置…」 */
  onHandOff: () => void;
}

function PromptCard({ request, now, onDone, onHandOff }: PromptCardProps) {
  const navigate = useNavigate();
  const { approve, isPending: approving } = useApproveRequest();
  const { reject, isPending: rejecting } = useRejectRequest();
  const titleId = `access-prompt-${request.id}`;
  const meta = requestMeta(request);
  return (
    <section aria-labelledby={titleId} className="pointer-events-auto rounded-xl bg-raised p-4 shadow-pop ring-1 ring-line">
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sunken text-fg-muted">
          <Smartphone className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p id={titleId} className="text-[13.5px] leading-snug font-semibold break-words">
            {request.name} 请求连接这台电脑
          </p>
          {meta && <p className="mt-0.5 truncate text-[12px] text-fg-muted">{meta}</p>}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-sunken px-3 py-2">
        <span className="text-[12px] text-fg-muted">
          校验码
          <span className="ml-2 text-fg-subtle tabular">还剩 {formatCountdown(Date.parse(request.expiresAt) - now)}</span>
        </span>
        <PairCode code={request.code} className="text-[24px] leading-tight" />
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-fg-muted">和手机上显示的数字一样再批准。</p>
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          icon={<Check />}
          loading={approving}
          disabled={rejecting}
          title="用默认权限批准；要改权限点「设置…」"
          onClick={() => approve(request.id, undefined, onDone)}
        >
          批准
        </Button>
        <Button size="sm" icon={<X />} loading={rejecting} disabled={approving} onClick={() => reject(request.id, onDone)}>
          拒绝
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => {
            onHandOff();
            void navigate('/settings#phone', { state: { section: 'phone', request: request.id } });
          }}
        >
          设置…
        </Button>
      </div>
    </section>
  );
}
