import { useRef, useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { Button, Dialog, DialogFooter, Menu, MenuIconItem, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { focusComposer } from '../dock';
import type { ConversationView, SessionSummary } from '../useConversation';

export interface SessionMenuProps {
  conv: ConversationView;
  /** 触发器的 id，外壳用它做 aria-labelledby */
  titleId: string;
}

/**
 * 页眉标题就是会话菜单（§5.2）：只列当前 backend 的会话，按更新时间倒序，最后是「新对话」和「清空全部对话」。
 * 每行右边有删除；删除和清空都先确认。没有重命名的接口，所以不做重命名。
 */
export function SessionMenu({ conv, titleId }: SessionMenuProps) {
  const { session, sessions, sessionId, backend } = conv;
  const list = (sessions.data ?? []).filter(s => s.backend === backend).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const others = list.filter(s => s.id !== sessionId).length;
  // 菜单关上时 Radix 会把焦点还给触发器；选了会话或新对话之后要的是输入框
  const toComposer = useRef(0);
  const choose = (id: string) => { toComposer.current = Date.now(); conv.actions.chooseSession(id); };
  const create = () => { toComposer.current = Date.now(); conv.actions.newSession(); };
  // 要确认的删除：等菜单关完再开弹窗，弹窗的焦点才不会被菜单抢回去
  const [asking, setAsking] = useState<SessionSummary | 'all' | null>(null);
  const afterClose = useRef<SessionSummary | 'all' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const confirm = async () => {
    if (!asking) return;
    setDeleting(true);
    const ok = await (asking === 'all' ? conv.actions.clearSessions() : conv.actions.deleteSession(asking.id));
    setDeleting(false);
    // 失败的原因由附页的报错条说
    setAsking(null);
    if (ok) focusComposer();
  };
  return (
    <>
      <Menu
        align="start"
        width={300}
        maxWidth={300}
        onCloseAutoFocus={e => {
          const next = afterClose.current;
          if (!next) return;
          afterClose.current = null;
          e.preventDefault();
          setAsking(next);
        }}
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
                  // 删除按钮平时藏着，鼠标移到这一行或方向键走到它时才出现
                  <div key={s.id} className="group flex items-center gap-0.5">
                    <div className="min-w-0 flex-1">
                      <MenuRadioItem value={s.id}>
                        <span className="flex w-full min-w-0 items-baseline gap-3">
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                          <span className="shrink-0 text-[11.5px] text-fg-subtle tabular">{formatRelative(s.updatedAt)}</span>
                        </span>
                      </MenuRadioItem>
                    </div>
                    <MenuIconItem
                      label="删除这段对话"
                      disabled={conv.busy}
                      onSelect={() => { afterClose.current = s; }}
                      className="opacity-0 group-hover:opacity-100 data-[highlighted]:opacity-100"
                    >
                      <Trash2 strokeWidth={1.8} />
                    </MenuIconItem>
                  </div>
                ))}
              </MenuRadioGroup>
            )}
            {others === 0 && <MenuItem disabled>还没有别的对话</MenuItem>}
          </>
        )}
        <MenuSeparator />
        <MenuItem icon={<Plus strokeWidth={1.8} />} disabled={!backend || conv.busy} onSelect={create}>新对话</MenuItem>
        {list.length > 0 && (
          <MenuItem icon={<Trash2 strokeWidth={1.8} />} danger disabled={conv.busy} onSelect={() => { afterClose.current = 'all'; }}>
            清空全部对话…
          </MenuItem>
        )}
      </Menu>
      <Dialog
        open={asking !== null}
        onOpenChange={o => { if (!o && !deleting) setAsking(null); }}
        title={asking === 'all' ? '清空全部对话？' : '删除这段对话？'}
        description={asking && asking !== 'all' ? asking.title : undefined}
        width={420}
      >
        <p className="text-[13px] leading-relaxed text-fg-muted">
          {asking === 'all' ? '所有 Agent 应用的对话都会删掉，' : ''}
          删除后不能恢复。对话里做过的图库修改不受影响。
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">Codex 等应用在自己的目录里（比如 ~/.codex）另存了一份记录，这里不会删。</p>
        <DialogFooter>
          <Button variant="ghost" disabled={deleting} onClick={() => setAsking(null)}>取消</Button>
          <Button variant="danger" loading={deleting} onClick={() => void confirm()}>{asking === 'all' ? '全部删除' : '删除'}</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
