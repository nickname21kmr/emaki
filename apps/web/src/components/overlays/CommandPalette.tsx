import { useIsFetching } from '@tanstack/react-query';
import { Command, useCommandState } from 'cmdk';
import { Search, X } from 'lucide-react';
import { motion } from 'motion/react';
import { Dialog as D } from 'radix-ui';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Kbd } from '@/components/ui';
import { cn } from '@/lib/cn';
import { qk } from '@/lib/queries';
import { useOverlays } from '@/lib/stores';
import { usePaletteCommands } from './palette/commands';
import { EmptyQuery } from './palette/EmptyQuery';
import { toRecent, useRecentCharacters, useTrackRecentCharacters } from './palette/recent';
import { SearchResults, type SearchActions } from './palette/SearchResults';
import { useDebouncedValue } from './palette/useDebouncedValue';

/**
 * ⌘K 命令面板：跳到角色 / 作品 / 标签，以及常用命令。
 * 打开状态在 useOverlays；快捷键在 useGlobalHotkeys 里注册。
 * 搜索由服务端完成，所以 cmdk 的内置过滤关掉（shouldFilter={false}）。
 */
export function CommandPalette() {
  const open = useOverlays((s) => s.commandOpen);
  const setOpen = useOverlays((s) => s.setCommandOpen);
  // 面板关着也要记录「最近访问」，所以放在外层
  useTrackRecentCharacters();

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-scrim/40 backdrop-blur-[2px]',
            'data-[state=open]:animate-fade-in data-[state=closed]:animate-[fade-in_140ms_ease-in_reverse_both]',
          )}
        />
        <D.Content
          className={cn(
            'fixed top-[18vh] left-1/2 z-50 w-[min(600px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden',
            'rounded-[18px] bg-raised shadow-pop ring-1 ring-line outline-none',
            'data-[state=open]:animate-rise data-[state=closed]:animate-[fade-in_120ms_ease-in_reverse_both]',
          )}
          // 页面级单键快捷键（数字、E、F…）不应该穿透面板；带 Ctrl/⌘ 的放行，⌘K 要能关掉面板
          onKeyDown={(e) => {
            if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
          }}
          // 从面板跳去帮助时，别把焦点还给触发按钮，免得和帮助弹窗抢焦点
          onCloseAutoFocus={(e) => {
            if (useOverlays.getState().helpOpen) e.preventDefault();
          }}
        >
          <D.Title className="sr-only">命令面板</D.Title>
          <D.Description className="sr-only">搜索角色、作品、标签，或执行命令。上下方向键选择，回车打开。</D.Description>
          <PaletteBody />
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** 面板内容。每次打开都重新挂载，输入和选中项自然清空。 */
function PaletteBody() {
  const navigate = useNavigate();
  const setOpen = useOverlays((s) => s.setCommandOpen);
  const [input, setInput] = useState('');
  const query = input.trim();
  const debounced = useDebouncedValue(query, 120);

  const close = useCallback(() => setOpen(false), [setOpen]);
  const commands = usePaletteCommands(close);

  const actions = useMemo<SearchActions>(
    () => ({
      openCharacter: (character, workName) => {
        useRecentCharacters.getState().push(toRecent(character, workName));
        close();
        navigate(`/characters/${character.id}`);
      },
      openWork: (work) => {
        close();
        navigate(`/works/${work.id}`);
      },
      openTag: (tag) => {
        close();
        navigate(`/gallery?${new URLSearchParams({ q: tag, kind: 'all' })}`);
      },
      go: (to) => {
        close();
        navigate(to);
      },
    }),
    [close, navigate],
  );

  const typing = query !== debounced;
  // 只看状态不取数据：结果还在路上时给输入框一道进度光
  const fetching = useIsFetching({ queryKey: qk.search(debounced) }) > 0;

  return (
    <Command label="命令面板" shouldFilter={false} vimBindings={false} loop className="flex flex-col">
      <div className="relative flex h-[60px] items-center gap-3 px-5">
        <Search className="size-[18px] shrink-0 text-fg-subtle" strokeWidth={2} />
        <Command.Input
          value={input}
          onValueChange={setInput}
          placeholder="跳到角色、作品、标签…"
          className="h-full min-w-0 flex-1 bg-transparent text-[17px] tracking-tight text-fg outline-none placeholder:text-fg-subtle"
        />
        {input ? (
          <button
            type="button"
            aria-label="清空"
            // 焦点留在输入框里，清空后可以直接接着打字
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setInput('')}
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <X className="size-3.5" />
          </button>
        ) : (
          <Kbd>Esc</Kbd>
        )}
        <SearchProgress active={!!query && (typing || fetching)} />
      </div>

      <div className="h-px bg-line" />

      {/* layoutScroll：列表滚动时，选中底座的滑动动画仍然对得上位置 */}
      <motion.div
        layoutScroll
        className="max-h-[min(440px,56vh)] overflow-y-auto overscroll-contain px-2 pb-2 scrollbar-thin"
      >
        <Command.List label="结果">
          {query ? (
            <SearchResults query={debounced} typing={typing} commands={commands} actions={actions} />
          ) : (
            <EmptyQuery commands={commands} actions={actions} />
          )}
        </Command.List>
      </motion.div>

      <PaletteFooter
        onHelp={() => {
          close();
          useOverlays.getState().setHelpOpen(true);
        }}
      />
    </Command>
  );
}

/** 输入框底边一道朱色细光，表示「还在找」 */
function SearchProgress({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-x-0 -bottom-px h-px animate-shimmer transition-opacity duration-300',
        active ? 'opacity-100' : 'opacity-0',
      )}
      style={{
        backgroundImage: 'linear-gradient(90deg, transparent, var(--c-shu), transparent)',
        backgroundSize: '40% 100%',
        backgroundRepeat: 'no-repeat',
      }}
    />
  );
}

/** 回车会做什么，随选中项变化 */
const VERB: Record<string, string> = {
  char: '打开角色',
  work: '打开作品',
  tag: '按标签筛选',
  go: '前往',
  act: '执行',
  find: '搜索',
  more: '查看全部',
};

function PaletteFooter({ onHelp }: { onHelp: () => void }) {
  const selected = useCommandState((s) => s.value);
  const verb = VERB[selected?.split(':')[0] ?? ''] ?? '打开';
  return (
    <div className="flex h-10 items-center justify-between gap-4 border-t border-line bg-sheet px-4 text-[11.5px] text-fg-subtle">
      <div className="flex items-center gap-3.5">
        <span className="flex items-center gap-1.5">
          <span className="flex gap-0.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </span>
          选择
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          <span key={verb} className="animate-fade-in">
            {verb}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>Esc</Kbd>
          关闭
        </span>
      </div>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onHelp}
        className="flex items-center gap-1.5 rounded-full py-1 pr-1 pl-2 transition-colors hover:bg-hover hover:text-fg-muted"
      >
        全部快捷键
        <Kbd>?</Kbd>
      </button>
    </div>
  );
}
