import { useRef } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { focusComposer } from '../dock';
import type { ConversationView } from '../useConversation';

export interface SessionMenuProps {
  conv: ConversationView;
  /** 触发器的 id，外壳用它做 aria-labelledby */
  titleId: string;
}

/**
 * 页眉标题就是会话菜单（§5.2）：只列当前 backend 的会话，按更新时间倒序，最后是「新对话」。
 * 没有删除和重命名的接口，所以不做这两项。
 */
export function SessionMenu({ conv, titleId }: SessionMenuProps) {
  const { session, sessions, sessionId, backend } = conv;
  const list = (sessions.data ?? []).filter(s => s.backend === backend).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const others = list.filter(s => s.id !== sessionId).length;
  // 菜单关上时 Radix 会把焦点还给触发器；选了会话或新对话之后要的是输入框
  const toComposer = useRef(0);
  const choose = (id: string) => { toComposer.current = Date.now(); conv.actions.chooseSession(id); };
  const create = () => { toComposer.current = Date.now(); conv.actions.newSession(); };
  return (
    <Menu
      align="start"
      width={300}
      maxWidth={300}
      trigger={
        <button
          id={titleId}
          type="button"
          data-autofocus={backend ? undefined : true}
          onFocus={() => { if (Date.now() - toComposer.current < 500) { toComposer.current = 0; focusComposer(); } }}
          className="mt-0.5 -ml-1.5 flex h-6 max-w-full items-center gap-1 rounded-[8px] px-1.5 text-[14px] font-semibold tracking-tight hover:bg-hover"
        >
          {session?.status === 'error' && (
            <>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-danger" />
              <span className="sr-only">出错</span>
            </>
          )}
          <span className="truncate">{session?.title ?? '新对话'}</span>
          <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" strokeWidth={1.8} />
        </button>
      }
    >
      <MenuLabel>最近的对话</MenuLabel>
      {sessions.isLoading ? (
        <MenuItem disabled>读取中…</MenuItem>
      ) : sessions.error ? (
        <MenuItem disabled>对话记录没读出来</MenuItem>
      ) : (
        <>
          {list.length > 0 && (
            <MenuRadioGroup value={sessionId} onValueChange={choose}>
              {list.map(s => (
                <MenuRadioItem key={s.id} value={s.id}>
                  <span className="flex w-full min-w-0 items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    <span className="shrink-0 text-[11.5px] text-fg-subtle tabular">{formatRelative(s.updatedAt)}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
          {others === 0 && <MenuItem disabled>还没有别的对话</MenuItem>}
        </>
      )}
      <MenuSeparator />
      <MenuItem icon={<Plus strokeWidth={1.8} />} disabled={!backend || conv.busy} onSelect={create}>新对话</MenuItem>
    </Menu>
  );
}
