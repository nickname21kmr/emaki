import { useEffect, useRef, useState } from 'react';
import { Slider } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * 松手才保存的滑块：拖动时只改本地草稿，指针抬起 / 失焦时提交一次；键盘连按停下 0.5 秒才提交。
 * 提交后一直显示提交的值，等外面的 value 跟上再放下草稿，滑块不会先跳回旧值。
 * 共享的 Slider 只暴露 onValueChange，这里在外层监听冒泡上来的 pointerup / keyup。
 *
 * onDraftChange：拖动中的实时值（松手后回到 null），给旁边的示意图跟着动。
 */
export function CommitSlider({
  value,
  onCommit,
  onDraftChange,
  min,
  max,
  step,
  label,
  format = String,
  ends,
  className,
}: {
  value: number;
  onCommit: (v: number) => void;
  onDraftChange?: (v: number | null) => void;
  min: number;
  max: number;
  step: number;
  label: string;
  format?: (v: number) => string;
  /** 滑轨两端的小字（「严格」「宽松」） */
  ends?: [string, string];
  className?: string;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const pending = useRef<number | null>(null);
  const keyTimer = useRef<number | undefined>(undefined);
  const settle = useRef<number | undefined>(undefined);
  const shown = draft ?? value;

  // value 变了（保存成功后刷新）就不再需要草稿
  useEffect(() => {
    if (pending.current === null) setDraft(null);
  }, [value]);

  // 卸载时还没提交的也存掉
  const latest = useRef({ value, onCommit });
  latest.current = { value, onCommit };
  useEffect(
    () => () => {
      window.clearTimeout(keyTimer.current);
      window.clearTimeout(settle.current);
      const v = pending.current;
      if (v !== null && v !== latest.current.value) latest.current.onCommit(v);
    },
    [],
  );

  const change = (v: number) => {
    window.clearTimeout(keyTimer.current);
    pending.current = v;
    setDraft(v);
    setEditing(true);
    onDraftChange?.(v);
  };

  const commit = () => {
    window.clearTimeout(keyTimer.current);
    const v = pending.current;
    if (v === null) return;
    pending.current = null;
    setEditing(false);
    onDraftChange?.(null);
    if (v === value) return setDraft(null);
    onCommit(v);
    // 保存失败时 value 不会变：过一会儿还是回到 value
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      if (pending.current === null) setDraft(null);
    }, 4000);
  };

  const commitSoon = () => {
    window.clearTimeout(keyTimer.current);
    keyTimer.current = window.setTimeout(commit, 500);
  };

  return (
    <div
      className={cn('flex items-center gap-4', className)}
      onPointerUp={commit}
      onKeyDown={() => window.clearTimeout(keyTimer.current)}
      onKeyUp={commitSoon}
      onBlur={commit}
    >
      <div className="w-44">
        <Slider value={shown} onValueChange={change} min={min} max={max} step={step} label={label} />
        {ends && (
          <div className="mt-0.5 flex justify-between text-[10.5px] text-fg-subtle select-none">
            <span>{ends[0]}</span>
            <span>{ends[1]}</span>
          </div>
        )}
      </div>
      <output
        aria-live="polite"
        className={cn(
          'numeral w-11 text-right text-[22px] tabular transition-colors duration-150',
          editing ? 'text-shu-fg' : 'text-fg',
        )}
      >
        {format(shown)}
      </output>
    </div>
  );
}
