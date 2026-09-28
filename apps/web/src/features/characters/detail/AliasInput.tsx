import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState } from 'react';
import { cn } from '@/lib/cn';

/** 输入到这些符号时切出一个别名（中英文逗号、顿号、分号） */
const SEPARATORS = /[,，、;；\n]/;

/**
 * 别名 tag 输入：回车 / 逗号 / 失焦时把文字变成一个 chip，空输入时退格删掉最后一个。
 */
export function AliasInput({
  value,
  onChange,
  placeholder = '回车添加，例如 ミカ、mika',
  id,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  id?: string;
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const parts = raw
      .split(SEPARATORS)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) {
      const next = [...value];
      for (const p of parts) if (!next.includes(p)) next.push(p);
      onChange(next);
    }
    setDraft('');
  };

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className={cn(
        'flex min-h-9 cursor-text flex-wrap items-center gap-1.5 rounded-md bg-sunken px-2 py-1.5 transition-[box-shadow,background-color] duration-150',
        'focus-within:bg-raised focus-within:shadow-[0_0_0_1px_var(--c-line-strong),0_0_0_4px_var(--c-shu-soft)]',
      )}
    >
      <AnimatePresence initial={false}>
        {value.map((alias) => (
          <motion.span
            key={alias}
            layout
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.18 }}
            className="inline-flex h-6 items-center gap-0.5 rounded-full bg-raised pr-0.5 pl-2.5 text-[12.5px] ring-1 ring-line"
          >
            {alias}
            <button
              type="button"
              aria-label={`移除别名 ${alias}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((a) => a !== alias));
              }}
              className="flex size-5 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
            >
              <X className="size-3" />
            </button>
          </motion.span>
        ))}
      </AnimatePresence>
      <input
        ref={inputRef}
        id={id}
        value={draft}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (SEPARATORS.test(v)) commit(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          // 输入法组词时的回车不算
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && draft.trim()) {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => draft.trim() && commit(draft)}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-fg-subtle"
      />
    </div>
  );
}
