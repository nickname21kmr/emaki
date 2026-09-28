import { useRef, useState } from 'react';
import { Slider } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * 松手才保存的滑块：拖动时只改本地草稿，指针抬起 / 按键松开 / 失焦时提交一次。
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
  const pending = useRef<number | null>(null);
  const shown = draft ?? value;

  const change = (v: number) => {
    pending.current = v;
    setDraft(v);
    onDraftChange?.(v);
  };

  const commit = () => {
    const v = pending.current;
    if (v === null) return;
    pending.current = null;
    setDraft(null);
    onDraftChange?.(null);
    if (v !== value) onCommit(v);
  };

  return (
    <div className={cn('flex items-center gap-4', className)} onPointerUp={commit} onKeyUp={commit} onBlur={commit}>
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
          draft !== null ? 'text-shu-fg' : 'text-fg',
        )}
      >
        {format(shown)}
      </output>
    </div>
  );
}
