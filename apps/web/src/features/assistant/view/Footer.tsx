import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowUp, CircleAlert, X } from 'lucide-react';
import type { AssistantSession } from '@emaki/shared';
import { Button, IconButton, Kbd, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { SPRING } from '@/lib/motion';
import { bindComposer } from '../dock';
import { currentActivity, formatClock, parseAnswerText } from '../presentation';
import type { ConversationView } from '../useConversation';
import { ContextLine } from './ContextLine';
import { ModelMenu } from './ModelMenu';
import { COLLAPSE } from './parts';
import { useClock } from './useClock';

export interface FooterProps {
  conv: ConversationView;
  /** overlay / float / sheet 这三种 raised 外壳：页脚是暗一档的次级带（bg-sheet） */
  floating?: boolean;
  /** 把输入框登记给 focusComposer。只有真正的附页（Sheet frame=fixed）登记，DevUiPage 里摆出来的不登记 */
  register?: boolean;
  /** 底页贴着屏幕下沿：底边让出 iOS 的 home 条 */
  safeBottom?: boolean;
}

const SWAP = { initial: { scale: 0.6, opacity: 0 }, animate: { scale: 1, opacity: 1 }, exit: { scale: 0.6, opacity: 0 }, transition: SPRING } as const;
const DOT = 'size-1.5 rounded-full';

interface StatusRow { key: string; mark: ReactNode; label: string; detail?: string; elapsed?: number; action?: ReactNode }

/**
 * 页脚（§11）：从上到下是状态行、错误行、输入面。
 * 运行中 textarea 照样能写（先写下一条），Enter 不发送；输入框为空时按 ↑ 取回上一条自己发的话。
 */
export function Footer({ conv, floating = false, register = false, safeBottom = false }: FooterProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const footer = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const reduce = useReducedMotion();
  const { session, draft, model, busy, connected, sessionId, context, viewedId, models, error } = conv;
  const status = session?.status;
  const running = status === 'running' || status === 'waiting';
  const now = useClock(status === 'running' && connected);
  const questionVisible = useQuestionVisible(footer, status === 'waiting' && connected, session?.questions.map(q => q.id).join(',') ?? '');

  const bind = useCallback((el: HTMLTextAreaElement | null) => {
    input.current = el;
    const unbind = register && el ? bindComposer(el) : undefined;
    return () => { input.current = null; unbind?.(); };
  }, [register]);

  // 随内容长高，最高 192px（之后在框里滚）
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [draft]);

  const caretToEnd = () => requestAnimationFrame(() => {
    const el = input.current;
    if (el) { el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length); }
  });
  const submit = (e?: FormEvent) => { e?.preventDefault(); if (!running) conv.actions.send(); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'ArrowUp' && !draft && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const last = session?.messages.findLast(m => m.role === 'user' && !m.resumeOf && !parseAnswerText(m.text));
      if (!last) return;
      e.preventDefault();
      conv.setDraft(last.text);
      caretToEnd();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  };
  // 点在输入面的空白处（不是按钮）也把焦点放进输入框
  const focusIfBare = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('button, a, input, textarea')) return;
    e.preventDefault();
    input.current?.focus({ preventScroll: true });
  };
  const scrollToQuestion = () => {
    const sheet = footer.current?.closest('[data-assistant-sheet]');
    sheet?.querySelector('[data-question]')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
  };

  const n = context.imageIds.length;
  const placeholder = running ? '可以先写下一条，这一轮结束后再发'
    : viewedId ? '问问这张图'
    : n ? `问问这 ${n} 张图`
    : '问问图库，或者说说想整理什么';

  // 状态行：按优先级只显示一种
  let row: StatusRow | null = null;
  if (!connected) {
    row = { key: 'offline', mark: <span className={cn(DOT, 'bg-warn')} />, label: '连接断了，正在重连', action: <Button size="sm" variant="outline" onClick={conv.actions.reconnect}>立即重连</Button> };
  } else if (status === 'waiting') {
    row = {
      key: 'waiting',
      mark: <span className={cn(DOT, 'bg-fg-muted')} />,
      label: '等你回应',
      action: !questionVisible && <button type="button" onClick={scrollToQuestion} className="h-7 shrink-0 text-[12px] font-medium text-fg-muted hover:text-fg">查看 ↓</button>,
    };
  } else if (status === 'running' && session) {
    const activity = currentActivity(session);
    row = { key: 'running', mark: <Spinner className="size-3.5 text-fg-muted" />, label: activity.label, detail: activity.detail, ...(activity.startedAt != null ? { elapsed: now - activity.startedAt } : {}) };
  } else if (status === 'error' && session && !errorInTranscript(session)) {
    // 正文里已经有系统注或中断便笺说明出错时，这里不再重复一处红点
    row = { key: 'error', mark: <span className={cn(DOT, 'bg-danger')} />, label: '出错了' };
  }

  const errorText = error || (models.error ? `模型列表没读出来：${models.error.message}` : '');

  return (
    <footer ref={footer} className={cn('shrink-0 border-t border-line px-3 pt-2.5', safeBottom ? 'pb-[max(12px,env(safe-area-inset-bottom))]' : 'pb-3', floating && 'bg-sheet')}>
      <AnimatePresence initial={false}>
        {row && (
          <motion.div key="status" {...COLLAPSE} className="-mx-1 overflow-hidden px-1">
            <div className="mb-2 flex min-h-7 items-start gap-2 px-1.5 text-[12.5px]">
              <span className="flex h-7 w-3.5 shrink-0 items-center justify-center">{row.mark}</span>
              <div className="min-w-0 flex-1 py-1">
                {/* 不做 live region：状态转换由 AssistantRoot 的播报区说一次，运行中每换一步不再各播一遍 */}
                <p className="truncate leading-5 font-medium">{row.label}</p>
                {row.detail && (
                  <p className="truncate font-mono text-[11px] leading-4 text-fg-subtle @min-[480px]:line-clamp-2 @min-[480px]:whitespace-normal">{row.detail}</p>
                )}
              </div>
              {/* 按整秒四舍五入，和旁注那一行的用时读数一致 */}
              {row.elapsed != null && <span aria-hidden className="shrink-0 py-1 text-[11.5px] leading-5 text-fg-subtle tabular">{formatClock(Math.round(row.elapsed / 1000) * 1000)}</span>}
              {row.action}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {errorText && (
        <div role="alert" className="mb-2 flex items-start gap-2 px-1.5 text-[12.5px] leading-snug text-danger">
          <CircleAlert strokeWidth={1.8} className="mt-[7px] size-3.5 shrink-0" />
          <p className="line-clamp-3 min-w-0 flex-1 py-1 break-words" title={errorText}>{errorText}</p>
          {models.error && !error && <Button size="sm" variant="outline" loading={models.isFetching} onClick={models.refetch}>重新读取</Button>}
          {error && <IconButton size="sm" label="知道了" onClick={conv.actions.dismissError}><X strokeWidth={1.8} /></IconButton>}
        </div>
      )}
      <form onSubmit={submit}>
        <div
          onPointerDown={focusIfBare}
          className="group/surface rounded-[14px] bg-sunken px-3.5 pt-2 pb-2 transition-[box-shadow,background-color] duration-150 has-[textarea:focus]:bg-raised has-[textarea:focus]:shadow-[0_0_0_1px_var(--c-line-strong),0_0_0_4px_var(--c-shu-soft)]"
        >
          <ContextLine conv={conv} onSwitchModel={() => setMenuOpen(true)} />
          <textarea
            ref={bind}
            rows={1}
            aria-label="给助手的消息"
            aria-keyshortcuts="Enter"
            placeholder={placeholder}
            value={draft}
            onChange={e => conv.setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            className="mt-1 block max-h-48 min-h-11 w-full resize-none bg-transparent py-1 text-[13.5px] leading-relaxed outline-none placeholder:text-fg-subtle scrollbar-thin"
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <ModelMenu conv={conv} open={menuOpen} onOpenChange={setMenuOpen} />
            <span className="flex-1" />
            {/* 运行中 Enter 不发送，提示也收起；触屏上没有 Enter 键 */}
            {!running && <span className="flex items-center gap-1 text-[11px] text-fg-subtle pointer-coarse:hidden @max-[380px]:hidden"><Kbd>↵</Kbd>发送</span>}
            <AnimatePresence initial={false} mode="popLayout">
              {running ? (
                <motion.span key="stop" {...SWAP} className="flex">
                  <Button type="button" size="sm" variant="outline" className="!rounded-full" onClick={conv.actions.stop}>
                    <span aria-hidden className="size-2 rounded-[2px] bg-current" />停止
                  </Button>
                </motion.span>
              ) : (
                <motion.span key="send" {...SWAP} className="flex">
                  <IconButton
                    type="submit"
                    size="sm"
                    variant="primary"
                    label="发送"
                    shortcut="↵"
                    className="!size-8 !rounded-full"
                    disabled={!draft.trim() || !model || busy || !connected || !sessionId}
                  >
                    <ArrowUp strokeWidth={2} />
                  </IconButton>
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>
      </form>
    </footer>
  );
}

/** 出错的说明已经写在正文里：挂着中断便笺，或者最后一轮里有系统注 */
function errorInTranscript(session: AssistantSession) {
  if (session.interruption) return true;
  const index = session.messages.findLastIndex(m => m.role === 'user');
  return session.messages.slice(index + 1).some(m => m.role === 'system');
}

/** 等你回应时，提问便笺在不在正文的可见区里（不在就给状态行一个「查看 ↓」） */
function useQuestionVisible(footer: RefObject<HTMLElement | null>, active: boolean, questions: string) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!active) return;
    const sheet = footer.current?.closest('[data-assistant-sheet]');
    const log = sheet?.querySelector('[role="log"]');
    const nodes = sheet ? [...sheet.querySelectorAll('[data-question]')] : [];
    if (!log || !nodes.length) { setVisible(true); return; }
    const seen = new Map<Element, boolean>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) seen.set(entry.target, entry.isIntersecting);
      setVisible([...seen.values()].some(Boolean));
    }, { root: log, threshold: 0.25 });
    nodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [footer, active, questions]);
  return visible;
}
