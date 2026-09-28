import { useEffect, useRef } from 'react';
import { useTagJob } from '../useTagJob';

/**
 * 识别进行中，未识别列表只标记过期、不自动重排（TR-12）：有新结果时显示这个小按钮，点了才刷新。
 * 识别结束时自动刷新一次。
 */
export function FreshButton({ stale, onRefresh }: { stale: boolean; onRefresh: () => void }) {
  const { running } = useTagJob();
  const was = useRef(running);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    if (was.current && !running) refresh.current();
    was.current = running;
  }, [running]);
  if (!stale || !running) return null;
  return (
    <button
      type="button"
      onClick={onRefresh}
      className="flex h-6 animate-fade-in items-center gap-1 rounded-full bg-ok-soft px-2 text-[11px] font-medium text-ok transition-opacity hover:opacity-80"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-ok" />
      有新结果
    </button>
  );
}
