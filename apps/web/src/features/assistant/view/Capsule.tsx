import { forwardRef, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { Kbd } from '@/components/ui';
import { Emblem } from '@/components/ui/Emblem';
import { cn } from '@/lib/cn';
import { modKeyLabel } from '@/lib/hotkeys';
import { DURATION } from '@/lib/motion';
import { useSelection } from '@/lib/stores';
import { openAssistant, useAssistantDock } from '../dock';
import { capsuleStatus, formatClock, type CapsuleStatus } from '../presentation';
import { useFloatingDrag } from '../useFloatingDrag';
import { SHU_GLINT } from './glint';
import { useClock } from './useClock';

export interface CapsuleProps {
  /** 只展示（DevUiPage）：不定位、不拖动，状态从 props 取 */
  static?: boolean;
  status?: CapsuleStatus;
  /** running 时从这里开始计时；不传就用 dock.runStartedAt */
  startedAt?: number | null;
}

/** 收起时的启动器：墨色胶囊，和 toast、多选栏同一类浮在纸上的器物（§4） */
export function Capsule({ static: isStatic = false, status, startedAt }: CapsuleProps) {
  if (isStatic) return <CapsuleButton status={status ?? 'idle'} startedAt={startedAt ?? null} />;
  return <LiveCapsule />;
}

function LiveCapsule() {
  const drag = useFloatingDrag('emaki.assistant.bubble-position');
  const status = useAssistantDock(s => capsuleStatus(s.lastStatus, s.unseen));
  const startedAt = useAssistantDock(s => s.runStartedAt);
  // 有选图、胶囊没被拖过时抬到多选栏上面
  const lift = useSelection(s => s.ids.size > 0) && !drag.style;
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // 收起附页后焦点回到这里
    const dock = useAssistantDock.getState();
    if (dock.focusCapsule) { button.current?.focus({ preventScroll: true }); dock.setFocusCapsule(false); }
  }, []);
  return (
    <div
      ref={el => { drag.ref.current = el; }}
      style={drag.style}
      {...drag.handle}
      className={cn('fixed right-6 z-40 touch-none transition-[bottom] duration-[350ms] ease-[var(--ease-out-soft)]', lift ? 'bottom-[84px]' : 'bottom-6', 'max-sm:right-4 max-sm:bottom-4')}
    >
      <CapsuleButton ref={button} status={status} startedAt={startedAt} onClick={openAssistant} />
    </div>
  );
}

const STATUS_TEXT: Record<CapsuleStatus, string> = { idle: '', running: '处理中', waiting: '等你回应', reply: '有新回复', incomplete: '没有完成' };

const CapsuleButton = forwardRef<HTMLButtonElement, { status: CapsuleStatus; startedAt: number | null; onClick?: () => void }>(
  function CapsuleButton({ status, startedAt, onClick }, ref) {
    const running = status === 'running';
    const now = useClock(running);
    const text = STATUS_TEXT[status];
    return (
      <motion.button
        ref={ref}
        type="button"
        layout
        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, transition: { duration: DURATION.fast } }}
        aria-label={`打开助手${text ? `，${text}` : ''}`}
        aria-keyshortcuts={modKeyLabel === '⌘' ? 'Meta+J' : 'Control+J'}
        onClick={onClick}
        className={cn(
          'group relative flex h-11 items-center gap-2 overflow-hidden rounded-full bg-ink pr-2 pl-3.5 text-[13px] font-medium text-fg-inverse shadow-pop transition-[background-color,scale] duration-150 select-none hover:bg-ink-hover active:scale-[0.97]',
          // 窄屏不显示 Kbd 时，右边和左边留一样的空
          !text && 'max-sm:pr-3.5',
        )}
      >
        <Emblem size={18} spin className="!text-fg-inverse" />
        <span>助手</span>
        {text ? (
          <>
            <span aria-hidden className="h-4 w-px bg-fg-inverse/15" />
            <span className="flex items-center gap-1.5 pr-1.5">
              {status === 'waiting' && <span aria-hidden className="size-1.5 rounded-full bg-shu" />}
              {status === 'incomplete' && <span aria-hidden className="size-1.5 rounded-full bg-warn" />}
              {text}
              {running && startedAt != null && <span aria-hidden className="tabular text-fg-inverse/60">{formatClock(now - startedAt)}</span>}
            </span>
          </>
        ) : (
          <Kbd tone="inverse" className="max-sm:hidden">{modKeyLabel} J</Kbd>
        )}
        {running && (
          <span aria-hidden className="pointer-events-none absolute inset-x-4 bottom-[3px] h-px animate-shimmer motion-reduce:animate-none motion-reduce:[background-position:50%_0]" style={SHU_GLINT} />
        )}
      </motion.button>
    );
  },
);
