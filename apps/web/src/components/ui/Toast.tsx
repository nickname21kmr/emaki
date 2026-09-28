import type { QueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { modKeyLabel } from '@/lib/hotkeys';
import { useUndoStore } from '@/lib/stores';
import { Kbd } from './Kbd';
import { Spinner } from './Button';
import { errorMessage } from '@/lib/queries';

/** 正在显示的可撤销 toast：Ctrl+Z 优先交给它，胶囊原地变成「已撤销」 */
const live = new Map<string, () => void>();

/** 有对应的 toast 在显示就由它来撤销，返回 true；否则返回 false，调用方走普通撤销 */
export function undoViaToast(token: string): boolean {
  const fn = live.get(token);
  if (!fn) return false;
  fn();
  return true;
}

/** 结果 toast（SEL-11）：墨色胶囊 + 底部朱色引信；可撤销的 6 秒、不可撤销的 3.2 秒燃尽后消失 */
export function showResultToast(message: string, undoToken: string | null, client: QueryClient) {
  toast.custom((id) => <ResultToast id={id} message={message} undoToken={undoToken} client={client} />, {
    duration: Infinity,
    unstyled: true,
    // 自绘的 li 没有宽度；铺满 toaster 再居中，长消息向两侧溢出
    className: '!pointer-events-auto flex w-full justify-center',
  });
}

type Phase = 'idle' | 'undoing' | 'undone' | 'failed';

function ResultToast({ id, message, undoToken, client }: { id: string | number; message: string; undoToken: string | null; client: QueryClient }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState(document.hidden);
  // 悬停 / 键盘聚焦 / 切到后台时引信停烧（内联 animation 会盖过 class，所以用 state）
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const reduce = useReducedMotion();
  const fuse = undoToken ? 6000 : 3200;

  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  const doUndo = useRef<() => void>(() => {});
  doUndo.current = async () => {
    if (!undoToken || phase !== 'idle') return;
    setPhase('undoing');
    try {
      await api.undo(undoToken);
      useUndoStore.getState().remove(undoToken);
      setPhase('undone');
      void client.invalidateQueries();
      window.setTimeout(() => toast.dismiss(id), 1400);
    } catch (err) {
      setError(errorMessage(err));
      setPhase('failed');
      window.setTimeout(() => toast.dismiss(id), 3200);
    }
  };
  useEffect(() => {
    if (!undoToken) return;
    const fn = () => doUndo.current();
    live.set(undoToken, fn);
    return () => {
      if (live.get(undoToken) === fn) live.delete(undoToken);
    };
  }, [undoToken]);

  const burning = phase === 'idle';
  return (
    <motion.div
      layout
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      animate={phase === 'failed' && !reduce ? { x: [0, -4, 4, -2, 0] } : { x: 0 }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocus(false)}
      role="status"
      aria-live="polite"
      className="group/toast relative flex h-11 items-center gap-3 overflow-hidden rounded-full bg-ink pr-2 pl-[18px] text-[13px] font-medium text-fg-inverse shadow-pop"
    >
      {phase === 'undone' ? (
        <motion.span key="undone" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="flex items-center gap-2 pr-3">
          <Undo2 className="size-4 text-ok" />
          已撤销 · {message}
        </motion.span>
      ) : phase === 'failed' ? (
        <span className="pr-3 text-danger-soft">撤销失败：{error}</span>
      ) : (
        <>
          <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden>
            <circle cx="8" cy="8" r="7.2" fill="none" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.4" />
            <path
              d="M4.6 8.3 L7 10.6 L11.4 5.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength={1}
              className="motion-safe:animate-[draw_320ms_80ms_var(--ease-out-soft)_both]"
            />
          </svg>
          <span className={cn('max-w-[46ch] truncate', !undoToken && 'pr-3')}>{message}</span>
          {undoToken && (
            <button
              type="button"
              onClick={() => doUndo.current()}
              className="ml-1 flex h-8 items-center gap-2 rounded-full bg-fg-inverse/15 px-3 text-[12.5px] font-semibold transition-colors hover:bg-fg-inverse/25"
            >
              {phase === 'undoing' ? <Spinner className="size-3.5" /> : '撤销'}
              <Kbd tone="inverse">{modKeyLabel} Z</Kbd>
            </button>
          )}
        </>
      )}
      {burning && (
        <div className="absolute inset-x-[18px] bottom-[5px] h-[2px] rounded-full bg-fg-inverse/12">
          <div
            className="fuse h-full origin-left rounded-full bg-shu"
            style={{ animation: `fuse ${fuse}ms linear forwards`, animationPlayState: hidden || hover || focus ? 'paused' : 'running' }}
            onAnimationEnd={() => toast.dismiss(id)}
          />
        </div>
      )}
    </motion.div>
  );
}
