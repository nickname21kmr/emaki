import { useId } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CircleAlert } from 'lucide-react';
import type { AssistantMessage } from '@emaki/shared';
import { cn } from '@/lib/cn';
import { useAssistantView } from '../viewState';
import { COLLAPSE, TextToggle } from './parts';

export interface SystemNoteProps {
  /** role 为 system 的消息：「处理已中断。」或「这次处理遇到问题。」（可带 details） */
  message: AssistantMessage;
  className?: string;
}

/** 系统注（§10.3）：「处理已中断」是一道分隔线；其余是一行错误加可展开的详情（展开状态存在 viewState） */
export function SystemNote({ message, className }: SystemNoteProps) {
  const key = `${message.id}:details`;
  const open = useAssistantView(s => s.expanded[key] ?? false);
  const detailId = useId();
  if (message.text.trim() === '处理已中断。') {
    return (
      <div className={cn('flex items-center gap-3 text-[11.5px] text-fg-subtle', className)}>
        <span aria-hidden className="h-px flex-1 bg-line" />处理已中断<span aria-hidden className="h-px flex-1 bg-line" />
      </div>
    );
  }
  return (
    <div className={cn('flex gap-2.5 text-[12.5px] leading-relaxed', className)}>
      <CircleAlert strokeWidth={1.8} className="mt-[3px] size-3.5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="break-words">{message.text}</p>
        {message.details && (
          <TextToggle open={open} controls={detailId} className="mt-1" onClick={() => useAssistantView.getState().setExpanded(key, !open)}>
            {open ? '收起详情' : '查看详情'}
          </TextToggle>
        )}
        <AnimatePresence initial={false}>
          {open && message.details && (
            <motion.div key="details" id={detailId} {...COLLAPSE} className="overflow-hidden">
              <pre className="mt-2 max-h-60 overflow-auto rounded-[10px] bg-sunken p-3 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-fg-muted scrollbar-thin">{message.details}</pre>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
