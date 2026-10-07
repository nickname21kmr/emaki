import { CUSTOM_THEME_LIMITS, type CustomTheme } from '@emaki/shared';
import { useQueries } from '@tanstack/react-query';
import { Ban, Check, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Dialog, DialogFooter, Input, SearchInput, Segmented, Spinner } from '@/components/ui';
import { useSaveSettings } from '@/features/settings/hooks';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { plainTag, TAG_MODE_LABEL, themeItems, themeQuery, themeSentence, type TagMode } from '@/lib/customTheme';
import { formatCount } from '@/lib/format';
import { SPRING } from '@/lib/motion';
import { useCustomThemes, useImageCount, useTagSuggestions } from '@/lib/queries';
import { useDebounced } from '../useDebounced';

/**
 * 新建 / 编辑自定义「画面」：起个名字，再从识别标签里挑几个，分到三组里：
 * 必含（交集）、任一（并集）、不含（排除）。点已挑的标签在三组之间轮换。
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
      description="必含的每个都要有，任一的有一个就行，不含的一个都不能有。"
      width={540}
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

type Item = { tag: string; mode: TagMode };

const MODES: TagMode[] = ['all', 'any', 'none'];
/** 点标签时的轮换顺序 */
const NEXT: Record<TagMode, TagMode> = { any: 'all', all: 'none', none: 'any' };

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
  const [items, setItems] = useState<Item[]>(() => (theme ? themeItems(theme) : []));
  /** 新挑的标签放进哪一组 */
  const [addMode, setAddMode] = useState<TagMode>('any');
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 200);
  const suggestions = useTagSuggestions(debounced);
  // 挑过的标签记下中文名（编辑已有画面时，下面再按标签名查一次）
  const [names, setNames] = useState<Record<string, string>>({});
  const known = useQueries({
    queries: (theme ? themeItems(theme) : []).map(({ tag }) => ({
      queryKey: ['tag-name', tag],
      queryFn: () => api.tags(tag, 1),
      staleTime: Infinity,
    })),
  });
  const nameOf = (tag: string) =>
    names[tag] ?? known.map((k) => k.data?.[0]).find((s) => s?.tag === tag)?.name ?? plainTag(tag);

  const modeOf = (tag: string) => items.find((i) => i.tag === tag)?.mode;
  const full = items.length >= CUSTOM_THEME_LIMITS.tags;
  /** 列表里点一下：放进当前组；已经在这一组的再点 = 去掉 */
  const pick = (tag: string, label: string) => {
    const cur = modeOf(tag);
    if (cur === addMode) {
      setItems(items.filter((i) => i.tag !== tag));
      return;
    }
    if (cur) {
      setItems(items.map((i) => (i.tag === tag ? { tag, mode: addMode } : i)));
      return;
    }
    if (full) return;
    setItems([...items, { tag, mode: addMode }]);
    setNames((m) => ({ ...m, [tag]: label }));
    // 名字还空着：先用第一个必含 / 任一标签的中文名（不含的标签当名字意思正好反了）
    if (!name.trim() && addMode !== 'none') setName(label.slice(0, CUSTOM_THEME_LIMITS.name));
  };
  const cycle = (tag: string) => setItems(items.map((i) => (i.tag === tag ? { tag, mode: NEXT[i.mode] } : i)));
  const removeTag = (tag: string) => setItems(items.filter((i) => i.tag !== tag));

  const of = (m: TagMode) => items.filter((i) => i.mode === m).map((i) => i.tag);
  const next: Omit<CustomTheme, 'id'> = {
    name: name.trim(),
    tags: of('any'),
    ...(of('all').length ? { all: of('all') } : {}),
    ...(of('none').length ? { none: of('none') } : {}),
  };
  const positive = next.tags.length + (next.all?.length ?? 0) > 0;
  const valid = next.name.length > 0 && positive;
  const key = (t: Omit<CustomTheme, 'id'>) => JSON.stringify([t.name, t.tags, t.all ?? [], t.none ?? []]);
  const dirty = !theme || key(next) !== key(theme);
  const tooMany = !theme && themes.length >= CUSTOM_THEME_LIMITS.themes;
  // 预览张数：和图库默认一样只数插画
  const count = useImageCount({ ...themeQuery({ id: '', ...next }), kind: ['illustration'] }, positive);

  const submit = () => {
    if (!valid || !dirty || tooMany) return;
    const saved: CustomTheme = { id: theme?.id ?? newId(), ...next };
    save({ browse: { customThemes: theme ? themes.map((t) => (t.id === theme.id ? saved : t)) : [...themes, saved] } });
    onSaved?.(saved);
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
    // 回车 = 把第一条（没挑过的）放进当前组。列表还是上一次搜索的结果（防抖、加载中）时不动，免得加错标签
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (debounced !== q || suggestions.isPlaceholderData) return;
    const first = list.find((s) => !modeOf(s.tag));
    if (first && q.trim()) {
      pick(first.tag, first.name);
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

      <FormField label="标签" hint={`${items.length ? '点标签换组 · ' : ''}${items.length} / ${CUSTOM_THEME_LIMITS.tags}`}>
        <div className="rounded-md bg-sunken p-1.5">
          {items.length === 0 ? (
            <div className="flex h-7 items-center px-1.5 text-[12.5px] text-fg-subtle">从下面挑，至少一个</div>
          ) : (
            <div className="flex flex-col gap-1">
              {MODES.filter((m) => items.some((i) => i.mode === m)).map((m) => (
                <div key={m} className="flex items-start gap-2">
                  <span className={cn('w-8 shrink-0 pt-[7px] pl-1 text-[11px]', LANE_TEXT[m])}>{TAG_MODE_LABEL[m]}</span>
                  <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    {items
                      .filter((i) => i.mode === m)
                      .map((i) => (
                        <TagChip
                          key={i.tag}
                          layoutId={`${uid}-${i.tag}`}
                          tag={i.tag}
                          label={nameOf(i.tag)}
                          mode={i.mode}
                          onCycle={() => cycle(i.tag)}
                          onRemove={() => removeTag(i.tag)}
                        />
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {items.length > 0 && (
          <div className="mt-1.5 flex items-baseline gap-3 px-0.5 text-[11.5px]">
            <span className={cn('min-w-0 flex-1', positive ? 'text-fg-muted' : 'text-danger')}>
              {positive ? themeSentence(items, nameOf) : '只有「不含」筛不出图，至少要有一个「必含」或「任一」'}
            </span>
            {positive && (
              <span className={cn('shrink-0 text-fg-subtle tabular', count.isPlaceholderData && 'opacity-60')}>
                {count.data === undefined ? '…' : `插画 ${formatCount(count.data)} 张`}
              </span>
            )}
          </div>
        )}
      </FormField>

      <div>
        <div className="flex items-center gap-2">
          <SearchInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onSearchKey}
            onClear={() => setQ('')}
            placeholder="搜标签：中文或英文，如 白发"
            aria-label="搜索标签"
            spellCheck={false}
            className="min-w-0 flex-1"
            trailing={suggestions.isFetching ? <Spinner className="size-3.5 text-fg-subtle" /> : undefined}
          />
          <div className="flex shrink-0 items-center gap-1.5" title="从列表里挑的标签放进哪一组">
            <span className="text-[11.5px] text-fg-subtle">加到</span>
            <Segmented
              size="sm"
              value={addMode}
              onChange={setAddMode}
              options={MODES.map((m) => ({ value: m, label: TAG_MODE_LABEL[m] }))}
            />
          </div>
        </div>
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
              const mode = modeOf(s.tag);
              return (
                <button
                  key={s.tag}
                  type="button"
                  role="option"
                  aria-selected={!!mode}
                  disabled={!mode && full}
                  onClick={() => pick(s.tag, s.name)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent',
                    mode && 'bg-hover',
                  )}
                >
                  <span className={cn('flex size-4 shrink-0 items-center justify-center', mode && LANE_TEXT[mode])}>
                    {mode === 'none' ? <Ban className="size-3.5" /> : mode ? <Check className="size-3.5" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {s.name}
                    {s.name !== plainTag(s.tag) && <span className="ml-2 font-mono text-[11.5px] text-fg-subtle">{s.tag}</span>}
                  </span>
                  {mode && <span className={cn('shrink-0 text-[11px]', LANE_TEXT[mode])}>{TAG_MODE_LABEL[mode]}</span>}
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

/** 三组的颜色：必含 = 墨色实心（和选中的 chip 一样），任一 = 普通，不含 = 红、划掉 */
const LANE_TEXT: Record<TagMode, string> = { all: 'text-fg', any: 'text-fg-subtle', none: 'text-danger' };
const CHIP: Record<TagMode, string> = {
  all: 'bg-ink text-fg-inverse',
  any: 'bg-raised text-fg shadow-[0_0_0_1px_var(--c-line)]',
  none: 'bg-danger-soft text-danger',
};
const CHIP_X: Record<TagMode, string> = {
  all: 'text-fg-inverse/60 hover:bg-fg-inverse/15 hover:text-fg-inverse',
  any: 'text-fg-subtle hover:bg-hover hover:text-fg',
  none: 'text-danger/60 hover:bg-danger/10 hover:text-danger',
};

function TagChip({
  layoutId,
  tag,
  label,
  mode,
  onCycle,
  onRemove,
}: {
  layoutId: string;
  tag: string;
  label: string;
  mode: TagMode;
  onCycle: () => void;
  onRemove: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.span
      layoutId={layoutId}
      transition={reduce ? { duration: 0 } : SPRING}
      className={cn('inline-flex h-7 items-center rounded-full pr-1 text-xs transition-colors duration-150', CHIP[mode])}
    >
      <button
        type="button"
        onClick={onCycle}
        title={`${tag}\n点一下换到「${TAG_MODE_LABEL[NEXT[mode]]}」`}
        aria-label={`${label}：${TAG_MODE_LABEL[mode]}，点一下换到「${TAG_MODE_LABEL[NEXT[mode]]}」`}
        className="inline-flex h-full items-center gap-1 rounded-l-full pr-0.5 pl-2.5 outline-none focus-visible:underline"
      >
        {mode === 'all' && <Check className="size-3" />}
        {mode === 'none' && <Ban className="size-3" />}
        <span className={cn(mode === 'none' && 'line-through decoration-danger/50')}>{label}</span>
      </button>
      <button
        type="button"
        aria-label={`去掉 ${label}`}
        onClick={onRemove}
        className={cn('flex size-5 items-center justify-center rounded-full', CHIP_X[mode])}
      >
        <X className="size-3" />
      </button>
    </motion.span>
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
