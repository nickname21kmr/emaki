import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowDown } from 'lucide-react';
import type { AssistantQuestion, AssistantSession } from '@emaki/shared';
import { Skeleton } from '@/components/ui';
import { DURATION, EASE_OUT } from '@/lib/motion';
import { layoutTranscript, turnItemKey, type Turn as TurnData } from '../presentation';
import type { ConversationView } from '../useConversation';
import { seedEntrances, useAssistantView } from '../viewState';
import { BlankPage } from './BlankPage';
import { InterruptionNote } from './InterruptionNote';
import { QuestionNote } from './QuestionNote';
import { Turn } from './Turn';
import { COLLAPSE, useEntrance } from './parts';

export interface TranscriptProps {
  conv: ConversationView;
}

/** 离底部这么近就算「在底部」，跟着新内容走 */
const NEAR_BOTTOM = 70;

const live = (s: AssistantSession | null) => s?.status === 'running' || s?.status === 'waiting';

/** 用户离开底部那一刻看到的内容；之后有变化就亮「回到最新」 */
interface Seen { count: number; questions: Set<string>; live: boolean }
const snapshot = (s: AssistantSession | null): Seen => ({ count: s?.messages.length ?? 0, questions: new Set(s?.questions.map(q => q.id)), live: live(s) });

/**
 * 正文（§6）：全文唯一的长滚动区。在底部时跟随新内容；滚开以后来了新内容，底部浮出「回到最新」。
 * 滚动位置按会话存在 viewState，进出暗房重新挂载后照旧。
 */
export function Transcript({ conv }: TranscriptProps) {
  const { session, sessionId, backend } = conv;
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useAssistantView(s => s.scroll[sessionId]?.follow ?? true);
  const followRef = useRef(follow);
  followRef.current = follow;
  const reduce = useReducedMotion();
  const seen = useRef<Seen | null>(null);
  // 点了「回到最新」后的平滑滚动期间，不把中途的位置当成用户滚开
  const smoothUntil = useRef(0);

  const turns = session ? layoutTranscript(session.messages, session.status) : [];
  const questions = [...(session?.questions ?? [])].sort((a, b) => Number(b.kind === 'approval') - Number(a.kind === 'approval'));
  const interrupted = Boolean(session?.interruption) && !live(session);
  // 切会话后的第一份快照：里面已有的条目都不播入场动画
  if (session && sessionId) seedEntrances(sessionId, entranceKeys(turns, questions));

  const toBottom = (smooth: boolean) => {
    const el = scroll.current;
    if (!el) return;
    if (smooth && !reduce) {
      smoothUntil.current = Date.now() + 800;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else el.scrollTop = el.scrollHeight;
  };

  // 挂上（或换会话、会话读到）时恢复位置：跟随就到底，否则回到上次的位置
  const ready = Boolean(session);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el || !ready) return;
    const saved = useAssistantView.getState().scroll[sessionId];
    if (!saved || saved.follow) el.scrollTop = el.scrollHeight;
    else el.scrollTop = saved.top;
    seen.current = saved && !saved.follow ? snapshot(session) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换会话、会话第一次读到时恢复
  }, [sessionId, ready]);

  // 跟随：每份新快照贴着底；运行中旁注展开、图片加载这类高度变化也贴着底。
  // 空闲时不管高度变化，免得用户点开中间的旁注时整页往上跳
  const liveRef = useRef(false);
  liveRef.current = live(session);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && followRef.current && Date.now() > smoothUntil.current) el.scrollTop = el.scrollHeight;
  }, [session, follow]);
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (liveRef.current && followRef.current && Date.now() > smoothUntil.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(el);
    // 页脚状态行出现时正文区变矮，也要贴回底部
    if (scroll.current) observer.observe(scroll.current);
    return () => observer.disconnect();
  }, [sessionId]);

  const onScroll = () => {
    const el = scroll.current;
    if (!el || !sessionId) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    if (!atBottom && Date.now() < smoothUntil.current) return;
    if (atBottom) smoothUntil.current = 0;
    if (!atBottom && followRef.current) seen.current = snapshot(session);
    useAssistantView.getState().setScroll(sessionId, { top: el.scrollTop, follow: atBottom });
  };

  const base = seen.current;
  const newQuestion = Boolean(base && questions.some(q => !base.questions.has(q.id)));
  const fresh = !follow && base !== null && (newQuestion || base.count !== (session?.messages.length ?? 0) || (base.live && !live(session)));
  const back = () => {
    useAssistantView.getState().followLatest(sessionId);
    toBottom(true);
  };

  // 书签线只给第一张能回答的便笺（状态朱同一时刻只出现一处）
  const marked = questions.findIndex(q => !(q.source === 'emaki' && live(session)));
  const tail = session && (interrupted || questions.length > 0) && (
    <AnimatePresence initial={false}>
      {interrupted && (
        <motion.div key="interruption" {...COLLAPSE} initial={false} className="overflow-hidden">
          <InterruptionNote conv={conv} />
        </motion.div>
      )}
      {questions.map((q, i) => (
        <motion.div key={q.id} data-question={q.id} {...COLLAPSE} initial={false} className="overflow-hidden">
          <QuestionSlot question={q} conv={conv} bookmark={i === marked} />
        </motion.div>
      ))}
    </AnimatePresence>
  );

  return (
    <div ref={scroll} onScroll={onScroll} role="log" aria-label="对话记录" aria-live="off" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin">
      <div ref={content} key={sessionId} className="mx-auto w-full max-w-[600px] animate-fade-in px-5 pt-5 pb-6">
        {!backend || (session && session.messages.length === 0 && !questions.length && !session.interruption) ? (
          <BlankPage conv={conv} />
        ) : !session ? (
          <div aria-hidden className="animate-fade-in space-y-2" style={{ animationDelay: '140ms' }}>
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-1/3" />
            <div className="mt-5 space-y-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-[92%]" />
              <Skeleton className="h-3 w-[70%]" />
            </div>
          </div>
        ) : turns.length ? (
          turns.map((turn, i) => <Turn key={turn.id} turn={turn} conv={conv} tail={i === turns.length - 1 ? tail : undefined} />)
        ) : (
          <div className="space-y-3">{tail}</div>
        )}
      </div>
      <AnimatePresence>
        {fresh && (
          <div key="latest" className="pointer-events-none sticky bottom-3 flex h-0 justify-center">
            <motion.button
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: DURATION.fast, ease: EASE_OUT }}
              onClick={back}
              className="pointer-events-auto flex h-7 -translate-y-full items-center gap-1.5 rounded-full bg-ink px-3 text-[12px] font-medium text-fg-inverse shadow-pop transition-[background-color,scale] hover:bg-ink-hover active:scale-[0.97]"
            >
              <ArrowDown strokeWidth={1.8} className="size-3.5" />
              {newQuestion ? '有提问待回应' : '回到最新'}
            </motion.button>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** 提问便笺第一次出现时书签线从 0 画出来 */
function QuestionSlot({ question, conv, bookmark }: { question: AssistantQuestion; conv: ConversationView; bookmark: boolean }) {
  const isNew = useEntrance(conv.sessionId, `q:${question.id}`);
  return <QuestionNote question={question} conv={conv} isNew={isNew} bookmark={bookmark} className={isNew ? 'animate-fade-in' : undefined} />;
}

function entranceKeys(turns: TurnData[], questions: AssistantQuestion[]) {
  return [...turns.flatMap(t => [t.id, ...t.items.map(turnItemKey)]), ...questions.map(q => `q:${q.id}`)];
}
