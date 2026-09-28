import type { JobItemEvent } from '@emaki/shared';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useLiveJobs } from '@/lib/events';
import { EASE_OUT, SPRING } from '@/lib/motion';
import { Thumb } from './Thumb';

/** 胶卷上最多几格 */
const FRAMES = 6;
/** 相邻两格进场的最短间隔：后端一批来得快时也一格一格地走 */
const GAP_MS = 280;
/** 「识别为 …」小签停留多久 */
const LABEL_MS = 900;

type Frame = JobItemEvent & { seq: number };

/**
 * 识别胶卷（SEL-19）：后台识别时，刚识别完的缩略图从右边一格格滑进来，认出角色时短暂亮出「识别为 …」。
 * 真实库要识别好几个小时，进度条每几秒才动 1px，有它才看得出程序在干活。数据来自 SSE 的 job-item。
 */
export function JobFilmstrip({ jobId, className }: { jobId: string; className?: string }) {
  const incoming = useLiveJobs((s) => s.items[jobId]);
  const reduce = useReducedMotion();
  const [frames, setFrames] = useState<Frame[]>([]);
  const [label, setLabel] = useState<{ seq: number; name: string } | null>(null);
  const queue = useRef<Frame[]>([]);
  const seen = useRef(0);
  const timer = useRef(0);

  // 新条目先排队，保证出现间隔 ≥ GAP_MS
  useEffect(() => {
    if (!incoming) return;
    const fresh = incoming.filter((e) => e.seq > seen.current);
    if (!fresh.length) return;
    seen.current = fresh[fresh.length - 1]!.seq;
    queue.current.push(...fresh);
    queue.current = queue.current.slice(-FRAMES);
    const pump = () => {
      const next = queue.current.shift();
      if (!next) {
        timer.current = 0;
        return;
      }
      setFrames((f) => [...f, next].slice(-FRAMES));
      const name = next.characterNames[0];
      if (name) setLabel({ seq: next.seq, name });
      timer.current = window.setTimeout(pump, GAP_MS);
    };
    if (!timer.current) pump();
  }, [incoming]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!label) return;
    const t = window.setTimeout(() => setLabel((l) => (l?.seq === label.seq ? null : l)), LABEL_MS);
    return () => window.clearTimeout(t);
  }, [label]);

  if (!frames.length) return null;
  return (
    <div className={cn('relative flex h-[26px] items-center gap-1', className)} aria-hidden>
      <AnimatePresence mode="popLayout" initial={false}>
        {frames.map((f) => (
          <motion.span
            key={f.seq}
            layout={!reduce}
            initial={reduce ? false : { x: 12, scale: 0.8, opacity: 0 }}
            animate={{ x: 0, scale: 1, opacity: 1 }}
            exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { x: -8, opacity: 0, transition: { duration: 0.18, ease: EASE_OUT } }}
            transition={reduce ? { duration: 0 } : { ...SPRING, layout: { duration: 0.3, ease: EASE_OUT } }}
            className="relative block size-[26px] shrink-0"
          >
            <Thumb
              image={{ id: f.imageId, dominantColor: f.dominantColor ?? 'var(--c-sunken)', rating: f.rating, kind: f.kind }}
              width={240}
              blurBadge="none"
              className="size-full rounded-[4px] ring-1 ring-line"
            />
          </motion.span>
        ))}
      </AnimatePresence>
      <AnimatePresence>
        {label && (
          <motion.span
            key={label.seq}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="pointer-events-none absolute right-0 bottom-full mb-1.5 rounded-full bg-ink px-2 py-0.5 text-[11px] whitespace-nowrap text-fg-inverse shadow-pop"
          >
            识别为 {label.name}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
