import type { ListImagesQuery, TagSuggestion } from '@emaki/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CornerDownLeft, Plus, Search, Tags } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Kbd, SearchInput, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useImageCount, useTagPhrase, useTagSuggestions } from '@/lib/queries';
import { useDebounced, useDebouncedCommit } from '@/lib/useDebounced';
import { mergeTags } from '../useGalleryParams';

type Row = { kind: 'exact' } | { kind: 'phrase' } | { kind: 'tag'; s: TagSuggestion };

/** 下拉里单个标签候选最多几条 */
const MAX_SUGGESTIONS = 6;

/** 最后一个词：按空格和标点切开取最后一段（「白发, 过膝」→「过膝」） */
const lastWord = (s: string) => s.split(/[\s,，、;；]+/).filter(Boolean).at(-1) ?? '';

/**
 * 图库搜索框：本地即时回显，停顿 250ms 后才写进 URL（?q=），避免每个字都触发请求。
 * URL 从外部变化（比如在看图器里点了标签）时同步回输入框。
 *
 * 打字时下面展开一个下拉：
 *   精确搜索「…」—— 就是上面这个 ?q=，整句当一个词去匹配文件名、标签、角色、作品；
 *   按标签：两个女孩 · 黑发 · 长发 —— 服务端把这句话拆成标签，选它 = 加进「必含」并清掉 ?q=；
 *   再往下是最后一个词的单个标签候选，点一下加进「必含」。
 * 拆出两个以上标签、或者精确搜索没有图时，默认高亮「按标签」，否则高亮精确。↑↓ 换、回车选、Esc 收起。
 */
export function GallerySearch({
  value,
  onCommit,
  onAddTags,
  baseQuery,
  className,
}: {
  value: string;
  onCommit: (q: string) => void;
  /** 把标签加进必含，同时把文字搜索换成 q（一般是空串） */
  onAddTags: (tags: string[], q: string) => void;
  /** 图库当前的查询（下拉里的张数按它数，和点下去之后看到的一致） */
  baseQuery: Omit<ListImagesQuery, 'cursor'>;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const qc = useQueryClient();
  // 父组件每次渲染都会给新的 onCommit，放 ref 里，免得防抖计时被无关的重渲染打断
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  // 自己刚提交的值回流到 URL 时不要覆盖输入框（用户可能已经接着打了几个字）
  const lastCommitted = useRef(value);
  const commit = (q: string) => {
    lastCommitted.current = q;
    commitRef.current(q);
  };

  useEffect(() => {
    if (value === lastCommitted.current) return;
    lastCommitted.current = value;
    setText(value);
  }, [value]);

  // 停顿 250ms 写进 URL。拼音还没上屏时不写（不然网址里是拼音，网格先换成「没有找到」再换回来），上屏后马上写
  useDebouncedCommit(text, 250, text.trim() !== value, (t) => commit(t.trim()));

  // ---------------------------------------------------------------- 下拉

  const [open, setOpen] = useState(false);
  /** 用户用 ↑↓ 选过的行；null = 用默认那一行 */
  const [active, setActive] = useState<number | null>(null);
  const term = text.trim();
  const debounced = useDebounced(term, 200);
  const showList = open && term.length > 0;

  const phrase = useTagPhrase(showList ? debounced : '');
  const parsed = phrase.data;
  const phraseTags = useMemo(() => parsed?.tags ?? [], [parsed]);
  /** 拆标签的结果还是上一句话的（防抖、请求中） */
  const stale = debounced !== term || phrase.isPlaceholderData || (phrase.isFetching && !parsed);

  const word = lastWord(debounced);
  const suggest = useTagSuggestions(word, showList && word.length > 0);
  const singles = useMemo(() => {
    const taken = new Set([...phraseTags.map((t) => t.tag), ...(baseQuery.tagsAll ?? [])]);
    return (word ? (suggest.data ?? []) : []).filter((s) => !taken.has(s.tag)).slice(0, MAX_SUGGESTIONS);
  }, [suggest.data, phraseTags, baseQuery.tagsAll, word]);

  // 张数按图库当前的其他筛选数；排序不影响张数，去掉免得多一份缓存
  const { sort: _s, order: _o, ...filters } = baseQuery;
  const tagCount = useImageCount(
    { ...filters, q: undefined, tagsAll: mergeTags(filters.tagsAll, phraseTags.map((t) => t.tag)) },
    showList && phraseTags.length > 0,
  );
  const exactCount = useImageCount({ ...filters, q: debounced || undefined }, showList && debounced.length > 0);

  const rows: Row[] = [{ kind: 'exact' }, ...(phraseTags.length ? [{ kind: 'phrase' as const }] : []), ...singles.map((s) => ({ kind: 'tag' as const, s }))];
  const defaultIndex = phraseTags.length && (phraseTags.length >= 2 || exactCount.data === 0) ? 1 : 0;
  const activeIndex = Math.min(active ?? defaultIndex, rows.length - 1);

  // 换了字就回到默认行
  useEffect(() => setActive(null), [term]);

  // 回车时拆标签的结果还没回来：等这句话的结果回来再按默认行选（用户没用 ↑↓ 选过的话）
  const pendingEnter = useRef<string | null>(null);
  const close = () => {
    setOpen(false);
    pendingEnter.current = null;
  };

  const addTags = (tags: TagSuggestion[], q: string) => {
    // 先记下中文名，筛选条里的 chip 不用再查一次
    for (const t of tags) qc.setQueryData(['tag-name', t.tag], [t]);
    lastCommitted.current = q;
    setText(q);
    close();
    onAddTags(
      tags.map((t) => t.tag),
      q,
    );
  };

  const pick = (row: Row | undefined, keepRest = false) => {
    if (!row) return;
    if (row.kind === 'exact') {
      commit(term);
      close();
    } else if (row.kind === 'phrase') addTags(phraseTags, keepRest ? (parsed?.rest ?? '') : '');
    else addTags([row.s], '');
  };

  useEffect(() => {
    if (pendingEnter.current === null || stale) return;
    if (pendingEnter.current === term) pick(rows[defaultIndex]);
    pendingEnter.current = null;
  });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 输入法选字时的回车 / 方向键不算
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!term) return;
      e.preventDefault();
      if (!showList) {
        setOpen(true);
        return;
      }
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + d + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!showList) commit(term);
      else if (active === null && stale) pendingEnter.current = term;
      else pick(rows[activeIndex], e.shiftKey);
    } else if (e.key === 'Escape') {
      // 下拉开着先收下拉；再按一次清空，第三次失焦。别让它冒泡去清空多选
      e.stopPropagation();
      if (showList) close();
      else if (text) {
        setText('');
        commit('');
      } else {
        inputRef.current?.blur();
      }
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <Popover.Root open={showList} onOpenChange={(o) => !o && close()}>
      <Popover.Anchor asChild>
        <div ref={boxRef} className={className}>
          <SearchInput
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={close}
            onClear={() => {
              setText('');
              commit('');
              inputRef.current?.focus();
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={showList}
            aria-controls={showList ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={showList ? optionId(activeIndex) : undefined}
            placeholder="搜索角色、作品、标签或文件名"
            aria-label="搜索角色、作品、标签或文件名"
            // 隐藏浏览器自带的清除叉，只留 Input 自己的
            className="w-full rounded-full! [&_input::-webkit-search-cancel-button]:appearance-none"
          />
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={16}
          // 焦点一直留在输入框里：打开时不抢焦点，点选项时不失焦
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Esc 交给输入框自己处理（先收下拉、再清空）；Radix 在 document 上先收到，不挡的话输入框看到的已经是收起之后，会直接清空
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (boxRef.current?.contains(e.target as Node)) e.preventDefault();
          }}
          onMouseDown={(e) => e.preventDefault()}
          className="z-[60] w-[min(420px,calc(100vw-32px))] origin-[var(--radix-popover-content-transform-origin)] overflow-hidden rounded-lg bg-raised p-1.5 shadow-pop ring-1 ring-line data-[state=open]:animate-rise"
        >
          <div id={listId} role="listbox" aria-label="搜索方式">
            <Option id={optionId(0)} active={activeIndex === 0} onHover={() => setActive(0)} onPick={() => pick(rows[0])} icon={<Search />}>
              <span className="min-w-0 flex-1 truncate">
                精确搜索<span className="text-fg">「{term}」</span>
              </span>
              <CountText loading={debounced !== term || exactCount.isFetching} count={exactCount.data} />
            </Option>

            {phraseTags.length > 0 && (
              <Option
                id={optionId(1)}
                active={activeIndex === 1}
                onHover={() => setActive(1)}
                onPick={() => pick(rows[1])}
                icon={<Tags />}
                className={cn('h-auto min-h-9 py-1.5', stale && 'opacity-60')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    按标签：<span className="text-fg">{phraseTags.map((t) => t.name).join(' · ')}</span>
                  </span>
                  {parsed?.rest && (
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
                      <span className="truncate">没认出：{parsed.rest}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          pick(rows[1], true);
                        }}
                        title="没认出的字留在搜索框里，当文字一起搜（Shift + 回车）"
                        className="shrink-0 rounded-xs px-1 text-fg-muted underline decoration-line-strong underline-offset-2 hover:text-fg"
                      >
                        也当文字搜
                      </button>
                    </span>
                  )}
                </span>
                <CountText loading={stale || tagCount.isFetching} count={tagCount.data} />
              </Option>
            )}

            {singles.length > 0 && (
              <>
                <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-fg-subtle">
                  「{word}」相关标签 · 点一下加进必含
                </div>
                {singles.map((s, k) => {
                  const i = rows.length - singles.length + k;
                  return (
                    <Option
                      key={s.tag}
                      id={optionId(i)}
                      active={activeIndex === i}
                      onHover={() => setActive(i)}
                      onPick={() => pick(rows[i])}
                      icon={<Plus />}
                      className={cn(suggest.isPlaceholderData && 'opacity-60')}
                    >
                      <span className="min-w-0 flex-1 truncate text-fg">
                        {s.name}
                        {s.name !== s.tag.replace(/_/g, ' ') && <span className="ml-2 font-mono text-[11.5px] text-fg-subtle">{s.tag}</span>}
                      </span>
                      <span className="shrink-0 text-[11.5px] text-fg-subtle tabular">{formatCount(s.count)} 张</span>
                    </Option>
                  );
                })}
              </>
            )}
          </div>
          {/* 键盘提示：触屏上整行不显示（A1） */}
          <div className="mt-1 flex items-center gap-3 border-t border-line px-2.5 pt-1.5 text-[11px] text-fg-subtle touch:hidden">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> 选择
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>↵</Kbd> 确定
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd> 收起
            </span>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Option({
  id,
  active,
  onHover,
  onPick,
  icon,
  className,
  children,
}: {
  id: string;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
  icon: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={onPick}
      className={cn(
        'flex h-9 cursor-default items-center gap-2.5 rounded-sm px-2.5 text-[13px] text-fg-muted select-none',
        '[&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-fg-subtle',
        active && 'bg-hover',
        className,
      )}
    >
      {icon}
      {children}
      <CornerDownLeft className={cn('size-3.5! text-fg-subtle', !active && 'invisible')} />
    </div>
  );
}

function CountText({ loading, count }: { loading: boolean; count: number | undefined }) {
  if (count === undefined) return loading ? <Spinner className="size-3.5 shrink-0 text-fg-subtle" /> : null;
  return <span className={cn('shrink-0 text-[11.5px] text-fg-subtle tabular', loading && 'opacity-60')}>{formatCount(count)} 张</span>;
}
