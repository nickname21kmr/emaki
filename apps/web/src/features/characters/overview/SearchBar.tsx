import { LayoutGrid, Rows3 } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Kbd, SearchInput, Segmented, Tooltip } from '@/components/ui';
import { modKeyLabel } from '@/lib/hotkeys';
import type { CharactersView } from '@/lib/stores';

const VIEW_OPTIONS = [
  { value: 'shelf' as const, label: '书架', icon: <LayoutGrid /> },
  { value: 'list' as const, label: '列表', icon: <Rows3 /> },
];

/**
 * 搜索框 + 书架/列表切换。
 * 输入先存本地，防抖 250ms 再写进 URL（?q=），避免每敲一个字就改一次历史记录和发一次请求。
 */
export function SearchBar({
  q,
  onCommit,
  view,
  onViewChange,
  inputRef,
}: {
  q: string;
  onCommit: (q: string) => void;
  view: CharactersView;
  onViewChange: (v: CharactersView) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [draft, setDraft] = useState(q);
  // 最近一次写进 URL 的值：用来区分「URL 是我们自己改的」还是「外部改的（后退、清除筛选）」
  const pushed = useRef(q);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    if (q !== pushed.current) {
      pushed.current = q;
      setDraft(q);
    }
  }, [q]);

  useEffect(() => {
    if (draft === pushed.current) return;
    const t = window.setTimeout(() => {
      pushed.current = draft;
      commitRef.current(draft);
    }, 250);
    return () => window.clearTimeout(t);
  }, [draft]);

  const commitNow = (v: string) => {
    setDraft(v);
    pushed.current = v;
    commitRef.current(v);
  };

  return (
    <div className="flex items-center gap-4">
      <SearchInput
        ref={inputRef}
        // 用 text 而不是 search：Chromium 会给 search 输入框再画一个原生清除按钮，和我们自己的重复
        type="text"
        role="searchbox"
        enterKeyHint="search"
        size="lg"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClear={() => commitNow('')}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') commitNow(draft);
          if (e.key === 'Escape') {
            if (draft) commitNow('');
            else e.currentTarget.blur();
          }
        }}
        placeholder="搜索角色或作品（未花、ミカ、mika、蔚蓝档案都可以）"
        aria-label="搜索角色或作品"
        className="w-[500px] max-w-full shadow-[0_0_0_1px_var(--c-line)] [&:hover:not(:focus-within)]:shadow-[0_0_0_1px_var(--c-line-strong)]"
        trailing={
          draft ? null : (
            <Kbd className="pointer-events-none opacity-80">{modKeyLabel === '⌘' ? '⌘F' : 'Ctrl F'}</Kbd>
          )
        }
      />
      <div className="flex-1" />
      <Tooltip content="切换视图" shortcut="V">
        <div>
          <Segmented value={view} onChange={onViewChange} options={VIEW_OPTIONS} />
        </div>
      </Tooltip>
    </div>
  );
}
