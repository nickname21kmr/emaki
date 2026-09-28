import type { Exclusion } from '@emaki/shared';
import { Folder, FolderOpen, Hash } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { Chip, Input } from '@/components/ui';
import { useSettings } from '@/lib/queries';

/** 常被整批排除的 Danbooru 标签：漫画分镜、四格、黑白、草稿、AI 图、照片 */
const COMMON_TAGS = ['comic', '4koma', 'monochrome', 'sketch', 'ai-generated', 'photo_(medium)'];

export function TagField({
  value,
  onChange,
  normalized,
  existing,
}: {
  value: string;
  onChange: (v: string) => void;
  /** 实际提交的标签（空格已换成下划线） */
  normalized: string;
  existing: Exclusion[];
}) {
  const taken = new Set(existing.filter((e) => e.kind === 'tag').map((e) => e.target));
  const suggestions = COMMON_TAGS.filter((t) => !taken.has(t));
  const changed = !!normalized && normalized !== value.trim();

  return (
    <div>
      <FieldLabel htmlFor="rule-tag">标签</FieldLabel>
      <Input
        id="rule-tag"
        autoFocus
        leading={<Hash />}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClear={() => onChange('')}
        placeholder="例如 comic、monochrome"
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
      />
      <Hint>
        {changed ? (
          <>
            将按 <code className="font-mono text-fg">{normalized}</code> 精确匹配
          </>
        ) : (
          '带这个标签的图都会被排除。用 Danbooru 的写法，空格会自动换成下划线。'
        )}
      </Hint>
      {suggestions.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[12px] text-fg-subtle">常用</div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((t) => (
              <Chip key={t} type="button" size="sm" selected={normalized === t} onClick={() => onChange(t)}>
                <span className="font-mono">{t}</span>
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function FolderField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const roots = useSettings().data?.libraryRoots ?? [];

  return (
    <div>
      <FieldLabel htmlFor="rule-folder">文件夹路径</FieldLabel>
      <Input
        ref={inputRef}
        id="rule-folder"
        autoFocus
        leading={<Folder />}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClear={() => onChange('')}
        placeholder="D:/Pictures/twitter/表情包"
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
      />
      <Hint>填绝对路径。这个文件夹里（包括子文件夹）的图都会被排除。</Hint>
      {roots.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[12px] text-fg-subtle">从图库文件夹开始</div>
          <div className="flex flex-wrap gap-1.5">
            {roots.map((r) => (
              <Chip
                key={r.id}
                type="button"
                size="sm"
                leading={
                  <span className="flex size-5 items-center justify-center text-fg-muted">
                    <FolderOpen className="size-3.5" />
                  </span>
                }
                onClick={() => {
                  onChange(`${r.path.replace(/\\/g, '/').replace(/\/$/, '')}/`);
                  inputRef.current?.focus();
                }}
              >
                <span className="font-mono">{r.path}</span>
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-2 block text-[13px] font-medium">
      {children}
    </label>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[12.5px] leading-relaxed text-fg-muted">{children}</p>;
}
