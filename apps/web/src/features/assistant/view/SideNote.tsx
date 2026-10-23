import { memo, useId, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, ChevronRight, Pause, X } from 'lucide-react';
import type { AssistantMessage } from '@emaki/shared';
import { Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatClock, formatDuration, messageSignature, noteSummary, prettyInput, rowPreview, toolLabel } from '../presentation';
import { useAssistantView } from '../viewState';
import { COLLAPSE, CopyButton, TextToggle, useClamped } from './parts';
import { useClock } from './useClock';

export interface SideNoteProps {
  /** 组 id（layoutTranscript 给的 `note:${首条 id}`），展开状态按它存在 viewState.expanded */
  id: string;
  messages: AssistantMessage[];
  className?: string;
}

type RowStatus = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'done';
const STATUS_TEXT: Record<RowStatus, string> = { running: '进行中', succeeded: '成功', failed: '失败', interrupted: '已中断', done: '完成' };

const live = (m: AssistantMessage) => m.tool?.status === 'running' || m.reasoning?.status === 'running';
const rowStatus = (m: AssistantMessage): RowStatus =>
  m.tool ? m.tool.status : m.reasoning?.status === 'running' ? 'running' : m.reasoning?.status === 'interrupted' ? 'interrupted' : 'done';

// 收起的内容要能画出焦点框和行的悬停底座：左右上下各留一点再用负边距抵掉
const BODY = '-mx-2 -my-1 overflow-hidden px-2 py-1';

/**
 * 旁注（§7）：左侧细竖线里的思考和工具。
 * 运行中组头下面露出最后 3 条，更早的折成「前面还有 n 步」；结束后只剩组头，除非手动展开过。
 * 只有一条记录时不加组头。
 */
export const SideNote = memo(
  function SideNote({ id, messages, className }: SideNoteProps) {
    const running = messages.some(live);
    const now = useClock(running);
    const expanded = useAssistantView(s => s.expanded[id]);
    const earlier = useAssistantView(s => s.expanded[`${id}:earlier`] ?? false);
    const bodyId = useId();
    if (messages.length === 1) {
      return (
        <div className={cn('border-l border-rule pl-3', className)}>
          <ul><Row message={messages[0]!} now={now} /></ul>
        </div>
      );
    }
    const open = expanded ?? running;
    const summary = noteSummary(messages, now);
    const summaryText = [summary.label, ...summary.parts.map(p => p.text)].join(' · ');
    const hidden = running && !earlier ? Math.max(0, messages.length - 3) : 0;
    const rows = hidden ? messages.slice(-3) : messages;
    const { setExpanded } = useAssistantView.getState();
    return (
      <div role="group" aria-label={`处理过程：${summaryText}`} className={cn('border-l border-rule pl-3', className)}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setExpanded(id, !open)}
          // 列和条目行一样：记号 w-3.5、gap-2.5，末尾留出行尾 chevron 的位置，组头总用时和各行用时右边对齐
          className="group -mx-1.5 flex h-7 w-[calc(100%+12px)] items-center gap-2.5 rounded-[8px] px-1.5 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
        >
          <span className="flex w-3.5 shrink-0 justify-center">
            {summary.running ? (
              <Spinner className="size-3 text-fg-subtle" />
            ) : (
              <ChevronRight strokeWidth={1.8} className={cn('size-3.5 text-fg-subtle transition-[rotate] duration-200', open && 'rotate-90')} />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {summary.label}
            {summary.parts.map(p => (
              <span key={p.text}>
                <span className="px-1 text-fg-subtle">·</span>
                <span className={p.tone === 'danger' ? 'text-danger' : undefined}>{p.text}</span>
              </span>
            ))}
          </span>
          <span aria-hidden={summary.running} className="shrink-0 text-[11px] text-fg-subtle tabular">
            {summary.running ? formatClock(summary.totalMs) : formatDuration(summary.totalMs)}
          </span>
          <span aria-hidden className="w-3 shrink-0" />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div key="body" id={bodyId} {...COLLAPSE} className={BODY}>
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => { setExpanded(`${id}:earlier`, true); setExpanded(id, true); }}
                  className="flex h-7 items-center text-[11.5px] text-fg-subtle hover:text-fg"
                >
                  前面还有 {hidden} 步
                </button>
              )}
              <ul>{rows.map(m => <Row key={m.id} message={m} now={now} />)}</ul>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  },
  (a, b) => a.id === b.id && a.className === b.className && a.messages.length === b.messages.length && a.messages.every((m, i) => messageSignature(m) === messageSignature(b.messages[i]!)),
);

function Mark({ status, thought }: { status: RowStatus; thought: boolean }) {
  if (status === 'running') return <Spinner className="size-3 text-fg-subtle" />;
  if (status === 'failed') return <X strokeWidth={1.8} className="size-3.5 text-danger" />;
  if (status === 'interrupted') return <Pause strokeWidth={1.8} className="size-3.5 text-fg-subtle" />;
  if (thought || status === 'done') return <span className="size-1 rounded-full bg-fg-subtle" />;
  return <Check strokeWidth={1.8} className="size-3.5 text-fg-subtle" />;
}

/** 条目行（§7.3）：记号、名称、预览、失败、用时；点开看参数和输出，或思考全文 */
function Row({ message: m, now }: { message: AssistantMessage; now: number }) {
  const open = useAssistantView(s => s.expanded[m.id] ?? false);
  const detailId = useId();
  const thought = Boolean(m.reasoning);
  const status = rowStatus(m);
  const span = m.tool ?? m.reasoning;
  const end = span?.finishedAt ?? (status === 'running' ? now : undefined);
  const duration = span && end != null ? formatDuration(end - span.startedAt) : '';
  const { label, known } = thought ? { label: '思考', known: true } : toolLabel(m.text);
  const preview = rowPreview(m);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={[label, STATUS_TEXT[status], duration].filter(Boolean).join('，')}
        onClick={() => useAssistantView.getState().setExpanded(m.id, !open)}
        className="group/row -mx-1.5 flex min-h-7 w-[calc(100%+12px)] items-center gap-2.5 rounded-[8px] px-1.5 text-left text-[12px] hover:bg-hover pointer-coarse:min-h-10"
      >
        <span className="flex w-3.5 shrink-0 justify-center"><Mark status={status} thought={thought} /></span>
        <span className={cn('shrink-0 text-fg', !known && 'font-mono text-[11.5px]')}>{label}</span>
        <span className={cn('min-w-0 flex-1 truncate text-fg-subtle @max-[340px]:hidden', thought ? 'text-[11.5px]' : 'font-mono text-[11px]')}>{preview}</span>
        {status === 'failed' && <span className="shrink-0 text-danger">失败</span>}
        <span aria-hidden={status === 'running'} className="w-14 shrink-0 text-right text-[11px] text-fg-subtle tabular">{duration}</span>
        <ChevronDown
          strokeWidth={1.8}
          className={cn('size-3 shrink-0 text-fg-subtle opacity-0 transition-[opacity,rotate] duration-200 group-hover/row:opacity-100 group-focus-visible/row:opacity-100', open && 'rotate-180 opacity-100')}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="detail" id={detailId} {...COLLAPSE} className={BODY}>
            <div className="space-y-2.5 pt-1 pb-2.5 pl-6">{m.reasoning ? <ThoughtDetail message={m} /> : <ToolDetail message={m} />}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function Block({ title, meta, text }: { title: string; meta?: ReactNode; text: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h4 className="text-[11px] font-semibold tracking-[0.08em] text-fg-subtle">{title}</h4>
        {meta && <span className="min-w-0 truncate text-[11px] text-fg-subtle tabular">{meta}</span>}
      </div>
      <div className="group/pre relative">
        <pre className="max-h-60 overflow-auto overscroll-contain rounded-[10px] bg-sunken p-3 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-fg-muted scrollbar-thin">{text}</pre>
        <CopyButton text={() => text} />
      </div>
    </div>
  );
}

function ToolDetail({ message }: { message: AssistantMessage }) {
  const tool = message.tool;
  if (!tool) return <p className="text-[12px] text-fg-subtle">工具没有返回文字</p>;
  const running = tool.status === 'running';
  const exit = tool.exitCode;
  const output = tool.output?.trim() ? tool.output : '';
  return (
    <>
      {tool.progress && <p className="text-[12px] leading-relaxed text-fg-muted">{tool.progress}</p>}
      {tool.input?.trim() && <Block title="参数" meta={<span className="font-mono">{message.text}</span>} text={prettyInput(tool.input)} />}
      {output ? (
        <Block title={running ? '实时输出' : '输出'} meta={exit != null && <span className={exit !== 0 ? 'text-danger' : undefined}>退出码 {exit}</span>} text={output} />
      ) : (
        <div>
          {exit != null && (
            <p className="mb-1 text-[11px] text-fg-subtle tabular"><span className={exit !== 0 ? 'text-danger' : undefined}>退出码 {exit}</span></p>
          )}
          <p className="text-[12px] text-fg-subtle">{running ? '等工具返回…' : '工具没有返回文字'}</p>
        </div>
      )}
    </>
  );
}

const THOUGHT = 'text-[12.5px] leading-[1.7] break-words whitespace-pre-wrap text-fg-muted';

/** 思考全文：结束后截 8 行，可展开；运行中只露末尾约 400 字，顶部渐隐 */
function ThoughtDetail({ message }: { message: AssistantMessage }) {
  const r = message.reasoning!;
  const key = `${message.id}:full`;
  const running = r.status === 'running';
  const full = useAssistantView(s => s.expanded[key] ?? false);
  const [ref, over] = useClamped<HTMLParagraphElement>(!running && !full, r.text);
  if (running) {
    const tail = r.text.length > 400 ? r.text.slice(-400) : r.text;
    return <p className={cn(THOUGHT, r.text.length > 400 && '[mask-image:linear-gradient(to_bottom,transparent,black_24px)]')}>{tail}</p>;
  }
  return (
    <div>
      <p ref={ref} className={cn(THOUGHT, !full && 'line-clamp-[8]')}>{r.text}</p>
      {(over || full) && (
        <TextToggle open={full} className="mt-1" onClick={() => useAssistantView.getState().setExpanded(key, !full)}>{full ? '收起' : '展开全文'}</TextToggle>
      )}
    </div>
  );
}
