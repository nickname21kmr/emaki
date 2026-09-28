import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '@/lib/cn';

/** 这些字符都当作分隔符：回车之外，中英文逗号、顿号、分号 */
const SEPARATORS = /[,，、;；\n]/;

/**
 * 别名的 tag 输入：回车 / 逗号 / 顿号添加，退格删掉最后一个。
 * 输入法组字（打中文 / 日文）时不响应回车，否则选词的那一下会被当成「添加」。
 */
export function AliasInput({
  value,
  onChange,
  placeholder = 'ミカ、mika、未花…',
  id,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  id?: string;
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (raw: string) => {
    const parts = raw
      .split(SEPARATORS)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const seen = new Set(value.map((v) => v.toLowerCase()));
    const next = [...value];
    for (const p of parts) {
      if (seen.has(p.toLowerCase())) continue;
      seen.add(p.toLowerCase());
      next.push(p);
    }
    onChange(next);
  };

  return (
    <div
      onMouseDown={(e) => {
        // 点空白处也聚焦输入框（点在 chip 的删除按钮上除外）
        if (e.target === e.currentTarget) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
      className={cn(
        'flex min-h-9 cursor-text flex-wrap items-center gap-1.5 rounded-md bg-sunken px-2 py-1.5 transition-[box-shadow,background-color] duration-150',
        'focus-within:bg-raised focus-within:shadow-[0_0_0_1px_var(--c-line-strong),0_0_0_4px_var(--c-shu-soft)]',
      )}
    >
      {value.map((alias) => (
        <span
          key={alias}
          className="inline-flex h-6 animate-fade-in items-center gap-0.5 rounded-full bg-raised pr-0.5 pl-2.5 text-xs text-fg shadow-[0_0_0_1px_var(--c-line)]"
        >
          {alias}
          <button
            type="button"
            aria-label={`移除别名 ${alias}`}
            onClick={() => onChange(value.filter((v) => v !== alias))}
            className="flex size-5 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        value={draft}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          // 粘贴「a、b、c」这种带分隔符的一串：直接拆开加进去
          if (SEPARATORS.test(v)) {
            add(v);
            setDraft('');
          } else {
            setDraft(v);
          }
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            // 有内容时回车 = 添加别名，不提交表单；空的时候放行给表单
            if (draft.trim()) {
              e.preventDefault();
              add(draft);
              setDraft('');
            }
          } else if (e.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => {
          if (draft.trim()) {
            add(draft);
            setDraft('');
          }
        }}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm text-fg outline-none placeholder:text-fg-subtle"
      />
    </div>
  );
}
