import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, CornerDownLeft } from 'lucide-react';
import type { AssistantQuestion } from '@emaki/shared';
import { Dotted } from '@/components/overlays/palette/items';
import { Button, IconButton, Input, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { DURATION, EASE_OUT } from '@/lib/motion';
import { contextPageLabel, splitQuestionTitle } from '../presentation';
import type { ConversationView } from '../useConversation';
import { useAssistantView } from '../viewState';

export interface QuestionNoteProps {
  question: AssistantQuestion;
  conv: ConversationView;
  /** 刚出现的提问：书签线从 0 画出来（快照里本来就有的不播） */
  isNew?: boolean;
  /** 这张便笺带朱色书签线；同时有几张可回答的便笺时只给第一张（默认带） */
  bookmark?: boolean;
  className?: string;
}

/**
 * 提问便笺（§10.1）：approval 是允许 / 拒绝；input 是编号选项（1–9 直选）加自由输入，Enter 提交。
 * 不能回答时写出原因，不再静默变灰。
 */
export function QuestionNote({ question: q, conv, isNew = false, bookmark = true, className }: QuestionNoteProps) {
  const qid = useId();
  const draft = useAssistantView(s => s.questionDraft[q.id] ?? '');
  const [pending, setPending] = useState<string | null>(null);
  // 请求结束（成功的话这张便笺会消失，失败就恢复可点）
  useEffect(() => { if (!conv.busy) setPending(null); }, [conv.busy]);
  const status = conv.session?.status;
  const blockedByRun = q.source === 'emaki' && (status === 'running' || status === 'waiting');
  const dis = conv.busy || !conv.connected || blockedByRun || pending !== null;
  const blockedReason = !conv.connected ? '连上之后再回答。' : blockedByRun ? '这一轮结束后再回答。' : '';
  // 写了原因的那两种情况：整块回答区一起变灰，输入框也不能写
  const locked = Boolean(blockedReason);
  const answerable = !blockedByRun && bookmark;
  const { lead, body } = splitQuestionTitle(q.title);
  const options = q.kind === 'input' ? q.options ?? [] : [];
  const answer = (value: string) => {
    if (dis || !value.trim()) return;
    setPending(value);
    conv.actions.answer(q.id, value);
  };
  // 焦点在便笺里（不在输入框）时按 1–9 选对应选项
  const digitPick = (e: KeyboardEvent<HTMLElement>) => {
    if (!options.length || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea')) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > Math.min(9, options.length)) return;
    e.preventDefault();
    answer(options[n - 1]!);
  };
  return (
    <section role="group" aria-labelledby={qid} onKeyDown={digitPick} className={cn('relative rounded-[14px] bg-sunken/70 py-3.5 pr-3.5 pl-4', className)}>
      {answerable && (
        <motion.span
          aria-hidden
          className="absolute top-4 left-0 h-5 w-[2.5px] rounded-full bg-shu"
          style={{ originY: 0 }}
          initial={isNew ? { scaleY: 0 } : false}
          animate={{ scaleY: 1 }}
          transition={{ duration: DURATION.base, ease: EASE_OUT }}
        />
      )}
      <h4 className="text-[11px] font-semibold tracking-[0.08em] text-fg-subtle">{q.kind === 'approval' ? '需要你的许可' : '助手在问'}</h4>
      <p id={qid} className="mt-1.5 text-[13.5px] leading-relaxed font-medium break-words whitespace-pre-wrap">{lead}</p>
      {body && (
        <pre className="mt-2 max-h-48 overflow-auto rounded-[10px] bg-raised p-3 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-fg-muted scrollbar-thin [@media(max-height:599px)]:max-h-32">
          {body}
        </pre>
      )}
      {q.context && (
        <p className="mt-1.5 text-[11.5px] text-fg-muted">
          提问时：<Dotted parts={[contextPageLabel(q.context.page), q.context.imageIds.length ? `${q.context.imageIds.length} 张图` : null]} />
        </p>
      )}
      {q.kind === 'approval' ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="primary" loading={pending === 'approve'} disabled={dis} onClick={() => answer('approve')}>允许这次操作</Button>
          <Button size="sm" variant="outline" loading={pending === 'deny'} disabled={dis} onClick={() => answer('deny')}>拒绝</Button>
        </div>
      ) : (
        <>
          {options.length > 0 && (
            <ol className="-mx-2 mt-2.5">
              {options.map((o, i) => (
                <li key={o}>
                  <button
                    type="button"
                    disabled={dis}
                    onClick={() => answer(o)}
                    // 顶对齐：长选项折行时编号挂在第一行，像编号列表
                    className="group flex min-h-9 w-full items-start gap-3 rounded-[11px] px-2 py-2 text-left text-[13px] leading-5 hover:bg-hover disabled:opacity-45 pointer-coarse:min-h-10 pointer-coarse:py-2.5"
                  >
                    <span aria-hidden className="numeral w-4 shrink-0 text-[15px] !leading-5 text-fg-subtle tabular">{i + 1}</span>
                    <span className="min-w-0 flex-1 break-words">{o}</span>
                    {pending === o ? (
                      <Spinner className="mt-[3px] size-3.5 shrink-0 text-fg-subtle" />
                    ) : (
                      <ArrowRight strokeWidth={1.8} className="mt-[3px] size-3.5 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                    )}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <form className="mt-2" onSubmit={e => { e.preventDefault(); answer(draft); }}>
            <Input
              size="sm"
              className={cn('!bg-raised', locked && 'opacity-45')}
              disabled={locked}
              aria-label="回答助手"
              placeholder={options.length ? '或者写下你的回答' : '写下你的回答'}
              value={draft}
              onChange={e => useAssistantView.getState().setQuestionDraft(q.id, e.target.value)}
              trailing={
                <IconButton type="submit" size="sm" variant="ghost" label="回复" className="-mr-2" disabled={dis || !draft.trim()}>
                  {pending !== null && pending === draft ? <Spinner className="size-3.5" /> : <CornerDownLeft strokeWidth={1.8} />}
                </IconButton>
              }
            />
          </form>
        </>
      )}
      {blockedReason && <p className="mt-2 text-[11.5px] text-fg-muted">{blockedReason}</p>}
    </section>
  );
}
