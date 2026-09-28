import { CUSTOM_THEME_LIMITS, type CustomTheme } from '@emaki/shared';
import { useQueries } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Dialog, DialogFooter, Input, SearchInput, Spinner } from '@/components/ui';
import { useSaveSettings } from '@/features/settings/hooks';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useCustomThemes, useTagSuggestions } from '@/lib/queries';
import { useDebounced } from '../useDebounced';

/**
 * 新建 / 编辑自定义「画面」：起个名字，再从识别标签里挑几个（有任一个就算）。
 * 存在设置的 browse.customThemes 里；theme 为空 = 新建。
 */
export function CustomThemeDialog({
  open,
  onOpenChange,
  theme,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  theme?: CustomTheme;
  /** 保存后（新建时用来直接选中它） */
  onSaved?: (theme: CustomTheme) => void;
  onDeleted?: (id: string) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={theme ? '编辑画面' : '新建画面'}
      description="挑几个识别标签，图里有其中任一个就算。"
      width={520}
    >
      {/* 表单放在内容里：每次打开都重新初始化 */}
      <ThemeForm
        theme={theme}
        onDone={() => onOpenChange(false)}
        onSaved={onSaved}
        onDeleted={onDeleted}
      />
    </Dialog>
  );
}

/** 标签的显示名：中文名优先，没有就把下划线换成空格 */
const plain = (tag: string) => tag.replace(/_/g, ' ');

function ThemeForm({
  theme,
  onDone,
  onSaved,
  onDeleted,
}: {
  theme?: CustomTheme;
  onDone: () => void;
  onSaved?: (theme: CustomTheme) => void;
  onDeleted?: (id: string) => void;
}) {
  const uid = useId();
  const themes = useCustomThemes();
  const save = useSaveSettings();
  const [name, setName] = useState(theme?.name ?? '');
  const [tags, setTags] = useState<string[]>(theme?.tags ?? []);
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 200);
  const suggestions = useTagSuggestions(debounced);
  // 挑过的标签记下中文名（编辑已有画面时，下面再按标签名查一次）
  const [names, setNames] = useState<Record<string, string>>({});
  const known = useQueries({
    queries: (theme?.tags ?? []).map((tag) => ({
      queryKey: ['tag-name', tag],
      queryFn: () => api.tags(tag, 1),
      staleTime: Infinity,
    })),
  });
  const nameOf = (tag: string) =>
    names[tag] ?? known.map((k) => k.data?.[0]).find((s) => s?.tag === tag)?.name ?? plain(tag);

  const full = tags.length >= CUSTOM_THEME_LIMITS.tags;
  const toggle = (tag: string, label: string) => {
    if (tags.includes(tag)) {
      setTags(tags.filter((t) => t !== tag));
      return;
    }
    if (full) return;
    setTags([...tags, tag]);
    setNames((m) => ({ ...m, [tag]: label }));
    // 名字还空着：先用第一个标签的中文名
    if (!name.trim()) setName(label.slice(0, CUSTOM_THEME_LIMITS.name));
  };

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && tags.length > 0;
  const dirty = !theme || trimmed !== theme.name || tags.join('\n') !== theme.tags.join('\n');
  const tooMany = !theme && themes.length >= CUSTOM_THEME_LIMITS.themes;

  const submit = () => {
    if (!valid || !dirty || tooMany) return;
    const next: CustomTheme = { id: theme?.id ?? newId(), name: trimmed, tags };
    save({ browse: { customThemes: theme ? themes.map((t) => (t.id === theme.id ? next : t)) : [...themes, next] } });
    onSaved?.(next);
    onDone();
  };

  const remove = () => {
    if (!theme) return;
    save({ browse: { customThemes: themes.filter((t) => t.id !== theme.id) } });
    onDeleted?.(theme.id);
    onDone();
  };

  const list = suggestions.data ?? [];
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // 回车 = 加上第一条（没选过的）
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = list.find((s) => !tags.includes(s.tag));
    if (first && q.trim()) {
      toggle(first.tag, first.name);
      setQ('');
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-5"
    >
      <FormField label="名字" htmlFor={`${uid}-name`} hint={`最多 ${CUSTOM_THEME_LIMITS.name} 个字`}>
        <Input
          id={`${uid}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如 丝袜"
          maxLength={CUSTOM_THEME_LIMITS.name}
          autoFocus
        />
      </FormField>

      <FormField label="标签" hint={`${tags.length} / ${CUSTOM_THEME_LIMITS.tags}`}>
        <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md bg-sunken p-1.5">
          {tags.length === 0 && <span className="px-1.5 text-[12.5px] text-fg-subtle">从下面挑，至少一个</span>}
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-raised pr-1 pl-2.5 text-xs shadow-[0_0_0_1px_var(--c-line)]"
              title={tag}
            >
              {nameOf(tag)}
              <button
                type="button"
                aria-label={`去掉 ${nameOf(tag)}`}
                onClick={() => setTags(tags.filter((t) => t !== tag))}
                className="flex size-5 items-center justify-center rounded-full text-fg-subtle hover:bg-hover hover:text-fg"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      </FormField>

      <div>
        <SearchInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onSearchKey}
          onClear={() => setQ('')}
          placeholder="搜标签：中文或英文，如 白发、glasses"
          aria-label="搜索标签"
          spellCheck={false}
          trailing={suggestions.isFetching ? <Spinner className="size-3.5 text-fg-subtle" /> : undefined}
        />
        <div
          className={cn(
            'mt-2 h-[232px] overflow-y-auto rounded-md ring-1 ring-line scrollbar-thin',
            suggestions.isPlaceholderData && 'opacity-60',
          )}
          role="listbox"
          aria-label="标签候选"
          aria-multiselectable
        >
          {list.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[12.5px] text-fg-subtle">
              {suggestions.isPending ? '加载中…' : suggestions.isError ? '标签加载失败' : '没有找到这个标签'}
            </div>
          ) : (
            list.map((s) => {
              const on = tags.includes(s.tag);
              return (
                <button
                  key={s.tag}
                  type="button"
                  role="option"
                  aria-selected={on}
                  disabled={!on && full}
                  onClick={() => toggle(s.tag, s.name)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent',
                    on && 'bg-hover',
                  )}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center text-shu">{on && <Check className="size-3.5" />}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {s.name}
                    {s.name !== plain(s.tag) && <span className="ml-2 font-mono text-[11.5px] text-fg-subtle">{s.tag}</span>}
                  </span>
                  <span className="shrink-0 text-[11.5px] text-fg-subtle tabular">{formatCount(s.count)} 张</span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <DialogFooter className="mt-1">
        {theme && (
          <Button type="button" variant="ghost" className="mr-auto text-danger! hover:bg-danger-soft" onClick={remove}>
            删除
          </Button>
        )}
        {tooMany && <span className="mr-auto text-[12px] text-fg-subtle">最多 {CUSTOM_THEME_LIMITS.themes} 个画面</span>}
        <Button type="button" variant="ghost" onClick={onDone}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={!valid || !dirty || tooMany}>
          保存
        </Button>
      </DialogFooter>
    </form>
  );
}

function newId(): string {
  return `t${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

function FormField({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-fg">
          {label}
        </label>
        {hint && <span className="truncate text-[11.5px] text-fg-subtle tabular">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
