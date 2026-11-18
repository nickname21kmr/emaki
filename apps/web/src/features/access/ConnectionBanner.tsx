/**
 * 连不上电脑时顶部的提示（docs/mobile.md 4.3，状态在 lib/connection.ts）：手机浏览器打开局域网入口时，电脑关了、Emaki 停了、
 * 手机离开了家里的网络，几秒内这里出现「连不上电脑，可能电脑关机了或者不在同一个网络」，带「重试」，不会自己消失；
 * 后台每 5 秒探一次（逐步放慢到 30 秒），连上了自己收起。
 *
 * 不显示的时候：
 * - 在安卓 App 里（App 接管，切到原生的「电脑不在线」页面）；
 * - 本机入口（电脑自己的浏览器：后端没开时各处的请求自己报错，这句话的说法也不对）。
 *
 * 样式和结果 toast 一样是墨色胶囊（FRONTEND.md「结果 toast」），放在顶部正中、刘海下面，和底部的 toast、多选栏不抢位置。
 */
import { WifiOff } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Spinner } from '@/components/ui';
import { useCapabilities } from '@/lib/capabilities';
import { cn } from '@/lib/cn';
import { appHandlesOffline, retryNow, useConnection, type ConnectionStatus } from '@/lib/connection';
import { DURATION, EASE_OUT } from '@/lib/motion';

export const OFFLINE_TEXT = '连不上电脑，可能电脑关机了或者不在同一个网络';

/** 要不要显示：offline、不在 App 里、是局域网入口上的设备 */
export const showConnectionBanner = (o: { status: ConnectionStatus; inApp: boolean; local: boolean }): boolean =>
  o.status === 'offline' && !o.inApp && !o.local;

export function ConnectionNotice({ probing, onRetry }: { probing: boolean; onRetry: () => void }) {
  return (
    <div
      className={cn(
        'pointer-events-auto flex max-w-[calc(100vw-24px)] items-center gap-2.5 rounded-[18px] py-2 pr-2 pl-4',
        'bg-ink text-[13px] font-medium text-fg-inverse shadow-pop',
      )}
    >
      <WifiOff className="size-4 shrink-0 opacity-80" aria-hidden />
      <span className="min-w-0 leading-snug">{OFFLINE_TEXT}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={probing}
        className={cn(
          'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-3 font-semibold hover:bg-white/25',
          'transition-[background-color,scale] duration-150 active:scale-[0.97] disabled:opacity-60',
        )}
      >
        {probing && <Spinner className="size-3.5" />}
        重试
      </button>
    </div>
  );
}

export function ConnectionBanner() {
  const status = useConnection((s) => s.status);
  const probing = useConnection((s) => s.probing);
  const { local } = useCapabilities();
  const shown = showConnectionBanner({ status, inApp: appHandlesOffline(), local });
  return <ConnectionBannerView shown={shown} probing={probing} onRetry={() => void retryNow()} />;
}

export function ConnectionBannerView({ shown, probing, onRetry }: { shown: boolean; probing: boolean; onRetry: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-[80] flex justify-center px-3 pt-[max(12px,env(safe-area-inset-top))]"
    >
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: DURATION.fast, ease: EASE_OUT }}
          >
            <ConnectionNotice probing={probing} onRetry={onRetry} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
