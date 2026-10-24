import { useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import type { AssistantMessage } from '@emaki/shared';
import { Dotted } from '@/components/overlays/palette/items';
import { Thumb } from '@/components/media/Thumb';
import { Button, Skeleton, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useUndoStatus } from '@/lib/queries';
import type { Erratum as ErratumData } from '../presentation';
import type { ConversationView } from '../useConversation';
import { runUndo, useAssistantView, type UndoState } from '../viewState';
import { showInLightbox, useAssistantImage } from './parts';

export interface ErratumProps {
  /** 带 undoToken 的「图库已更新」消息 */
  message: AssistantMessage;
  erratum: ErratumData;
  conv: ConversationView;
  /** 只展示（DevUiPage）：覆盖 viewState 里的撤销状态 */
  state?: 'idle' | UndoState;
  className?: string;
}

// 勾只在第一次挂上时描（进出暗房重新挂载不重画）
const drawn = new Set<string>();

/** Toast 同款的勾：圆环 + 描出来的勾 */
function DrawnCheck({ draw }: { draw: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-ok" aria-hidden>
      <circle cx="8" cy="8" r="7.2" fill="none" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.4" />
      <path
        d="M4.6 8.3 L7 10.6 L11.4 5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        className={draw ? 'motion-safe:animate-[draw_320ms_80ms_var(--ease-out-soft)_both]' : undefined}
      />
    </svg>
  );
}

/**
 * 勘误条（§9）：上下两道细线夹住改动的那句话，撤销直接露在外面，始终可见。
 * 下面一行是改到的图和字段。契约里没有改前的值，不编造。
 */
export function Erratum({ message, erratum, conv, state: forced, className }: ErratumProps) {
  const token = message.undoToken ?? '';
  const stored = useAssistantView(s => s.undo[token]);
  const local = forced ?? stored;
  // 本页没有定论时问后端：重启过、被挤出撤销栈、在别处撤销过的，不用先点一次失败
  const remote = useUndoStatus(token, forced === undefined && (local === undefined || typeof local === 'object')).data;
  const state = typeof local === 'string' ? local : remote === 'undone' || remote === 'expired' ? remote : local ?? 'idle';
  const failed = typeof state === 'object' ? state.failed : null;
  const [draw] = useState(() => {
    if (drawn.has(message.id)) return false;
    drawn.add(message.id);
    return true;
  });
  const ids = erratum.imageIds;
  // 撤销按钮按下后换成「撤销中」：焦点先放到这一条上，不掉到 body
  const row = useRef<HTMLDivElement>(null);
  const doUndo = () => {
    row.current?.focus({ preventScroll: true });
    void runUndo(token, conv.actions.undo);
  };
  return (
    <div ref={row} tabIndex={-1} className={cn('border-y border-line py-2 outline-none [&+&]:border-t-0', className)}>
      <div className="flex min-h-7 items-center gap-2.5 text-[12.5px]">
        {state === 'undone' ? <Undo2 strokeWidth={1.8} className="size-3.5 shrink-0 text-fg-subtle" /> : <DrawnCheck draw={draw} />}
        <p className={cn('min-w-0 flex-1 break-words', state === 'undone' && 'text-fg-subtle line-through decoration-fg-subtle')}>{erratum.sentence}</p>
        {state === 'idle' || failed !== null ? (
          // -mr-2.5 抵掉按钮内边距：「撤销」和「撤销中」「已撤销」都收在细线右端
          <Button size="sm" variant="ghost" icon={<Undo2 strokeWidth={1.8} />} className="-mr-2.5" disabled={!token} onClick={doUndo}>撤销</Button>
        ) : state === 'undoing' ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-fg-subtle"><Spinner className="size-3" />撤销中</span>
        ) : state === 'expired' ? (
          <span className="shrink-0 text-[12px] text-fg-subtle">已失效，不能再撤销</span>
        ) : (
          <span className="shrink-0 text-[12px] text-fg-subtle">已撤销</span>
        )}
      </div>
      {(erratum.field || ids.length > 0) && state !== 'undone' && (
        <div className="mt-1 flex items-center gap-1 pl-6 text-[11.5px] text-fg-subtle">
          {ids.slice(0, 6).map((id, i) => (
            <button
              key={id}
              type="button"
              aria-label="看大图"
              onClick={() => showInLightbox(ids, i)}
              className="focus-frame size-7 shrink-0 cursor-zoom-in rounded-[var(--radius-xs)]"
            >
              <ErratumThumb id={id} />
            </button>
          ))}
          <span className={cn('tabular', ids.length > 0 && 'ml-1.5')}><Dotted parts={[erratum.field, ids.length ? `${ids.length} 张` : null]} /></span>
        </div>
      )}
      {failed !== null && <p role="alert" className="mt-1 pl-6 text-[12px] text-danger">撤销失败：{failed}</p>}
    </div>
  );
}

function ErratumThumb({ id }: { id: string }) {
  const image = useAssistantImage(id);
  if (image.data) return <Thumb image={image.data} width={240} blurBadge="none" className="size-full rounded-[var(--radius-xs)]" />;
  if (image.isError) return <span className="block size-full rounded-[var(--radius-xs)] bg-sunken" />;
  return <Skeleton className="size-full !rounded-[var(--radius-xs)]" />;
}
