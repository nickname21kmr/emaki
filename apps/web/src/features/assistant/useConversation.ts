import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssistantBackend, AssistantCard, AssistantContext, AssistantModel, AssistantSession } from '@emaki/shared';
import { useLightbox, useSelection } from '@/lib/stores';
import { undo as undoMutation } from '@/lib/queries';
import { assistantApi } from './client';
import { openSessionEvents } from './sessionEvents';
import { composerContext, reconcileModelSelection, toggleResultImage, type ResultSelection } from './presentation';
import { focusComposer, useAssistantDock } from './dock';
import { useAssistantView } from './viewState';

export type SessionSummary = Pick<AssistantSession, 'id' | 'title' | 'backend' | 'updatedAt'>;

/** 视图只吃这个接口；useConversation 连服务端，fixtures 的 useFixtureConversation 在本地假装（§21.2） */
export interface ConversationView {
  backend: AssistantBackend | null;
  sessions: { data?: SessionSummary[]; isLoading: boolean; error: unknown };
  sessionId: string;
  session: AssistantSession | null;
  models: { data?: AssistantModel[]; isFetching: boolean; error: Error | null; refetch(): void };
  model: string;
  effort: string;
  connected: boolean;
  busy: boolean;
  error: string;
  draft: string;
  setDraft(v: string): void;
  context: AssistantContext;
  viewedId?: string;
  resultSelection: ResultSelection | null;
  actions: {
    send(): void;
    stop(): void;
    resume(): void;
    answer(questionId: string, value: string): void;
    chooseSession(id: string): void;
    newSession(): void;
    pickModel(id: string): void;
    /** 'default' 或 '' 表示默认强度 */
    pickEffort(e: string): void;
    reconnect(): void;
    dismissError(): void;
    selectResult(card: AssistantCard, id: string, checked: boolean): void;
    clearResultSelection(): void;
    /** 撤销图库改动，返回成没成功（toast 照常弹） */
    undo(token: string): Promise<boolean>;
  };
}

const storageKey = (backend: AssistantBackend) => `emaki.assistant.${backend}`;

/** 这个标签页里上次用的会话 */
export function storedSessionId(backend: AssistantBackend | null): string {
  if (!backend) return '';
  try { return sessionStorage.getItem(storageKey(backend)) ?? ''; } catch { return ''; }
}

/**
 * 助手的全部对话状态：会话、SSE + 补拉、模型、发送 / 继续 / 停止 / 回答、两个 requestId 去重、结果图勾选。
 * 挂在 AssistantRoot 上，视图在 body 和暗房之间重新挂载也不受影响。按 backend 换 key 重建。
 */
export function useConversation(backend: AssistantBackend | null): ConversationView {
  const client = useQueryClient(), location = useLocation();
  const open = useAssistantDock(s => s.open);
  const [sessionId, setSessionId] = useState(() => storedSessionId(backend));
  const [session, setSession] = useState<AssistantSession | null>(null);
  const [draft, setDraft] = useState(''), [model, setModel] = useState(''), [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [connected, setConnected] = useState(true);
  const [resultSelection, setResultSelection] = useState<ResultSelection | null>(null), [connectionAttempt, setConnectionAttempt] = useState(0);
  const selected = useSelection(s => s.ids), scope = useSelection(s => s.scope);
  const viewedId = useLightbox(s => (s.open ? s.ids[s.index] : undefined));
  const submission = useRef<{ signature: string; requestId: string } | null>(null);
  const resumption = useRef<{ signature: string; requestId: string } | null>(null);
  const creating = useRef(false);
  // 收起时不读会话列表；存着会话 id 的话页面加载时就连上，胶囊才能显示运行状态
  const sessions = useQuery({ queryKey: ['assistant-sessions'], queryFn: assistantApi.sessions, enabled: Boolean(backend) && (open || Boolean(sessionId)) });
  // 读模型列表会临时拉起 Agent 进程，只在打开后读
  const models = useQuery({ queryKey: ['assistant-models', sessionId], queryFn: () => assistantApi.models(sessionId), enabled: open && Boolean(sessionId), staleTime: 60000, retry: false });
  const running = session?.status === 'running' || session?.status === 'waiting';
  const context = composerContext(location.pathname + location.search, scope, selected, viewedId, resultSelection);
  const interruptedRequest = session?.messages.find(m => m.id === session.interruption?.messageId);

  useEffect(() => { setResultSelection(null); }, [sessionId, location.pathname, location.search, selected, scope]);

  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const chooseSession = (id: string) => {
    if (backend) try { sessionStorage.setItem(storageKey(backend), id); } catch { /* 存不了就只在这次生效 */ }
    focusComposer();
    if (id === sessionId) return;
    setSession(null); setSessionId(id); setModel(''); setEffort(''); setError('');
  };
  const create = () => perform(async () => {
    const s = await assistantApi.create();
    chooseSession(s.id);
    await sessions.refetch();
  });

  // 打开时选会话：这个标签页上次用的 → 这个 backend 最新的一条 → 一条都没有就建一个
  useEffect(() => {
    if (!open || !backend || sessionId || creating.current || !sessions.data) return;
    const latest = sessions.data.filter(s => s.backend === backend).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (latest) return chooseSession(latest.id);
    creating.current = true;
    void create().finally(() => { creating.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chooseSession / create 每次渲染都是新的
  }, [open, backend, sessionId, sessions.data]);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    const closeEvents = openSessionEvents(sessionId, {
      open: () => setConnected(true),
      message: data => { const snapshot: AssistantSession = JSON.parse(data); setSession(snapshot); setConnected(true); },
      error: () => setConnected(false),
      disabled: () => { void client.invalidateQueries({ queryKey: ['assistant-settings'] }); },
    });
    // A temporary HTTP failure must not stop the stream's reconnection loop.
    void assistantApi.session(sessionId).then(s => { if (!disposed) setSession(previous => previous ?? s); }).catch(() => {});
    return () => { disposed = true; closeEvents(); };
  }, [sessionId, client, connectionAttempt]);

  useEffect(() => {
    if (!session || !models.data) return;
    const chosen = reconcileModelSelection(models.data, { model, effort }, session);
    setModel(chosen.model); setEffort(chosen.effort);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在模型列表或会话里存的选择变化时重算
  }, [models.data, session?.model, session?.effort, model, effort]);

  useEffect(() => {
    // A snapshot can confirm acceptance even when the HTTP response was lost.
    if (session?.messages.some(m => m.id === submission.current?.requestId)) submission.current = null;
    if (session?.messages.some(m => m.id === resumption.current?.requestId)) resumption.current = null;
  }, [session]);

  // 胶囊状态：在跑、等你；收起期间跑完了记「有新回复」或「没有完成」
  const status = session?.status ?? null;
  const runStartedAt = running ? session?.messages.findLast(m => m.role === 'user')?.createdAt ?? null : null;
  const previousStatus = useRef(status);
  useEffect(() => {
    const dock = useAssistantDock.getState(), was = previousStatus.current;
    previousStatus.current = status;
    dock.setStatus(status, runStartedAt);
    if (!session || dock.open || (was !== 'running' && was !== 'waiting') || status === 'running' || status === 'waiting') return;
    const last = session.messages.at(-1);
    if (status === 'error' || session.interruption) dock.setUnseen('incomplete');
    else if (last?.role === 'assistant' && !last.reasoning && last.text.trim()) dock.setUnseen('reply');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只看状态切换
  }, [status, runStartedAt]);
  useEffect(() => () => useAssistantDock.getState().setStatus(null, null), []);

  const send = () => {
    if (busy) return;
    const value = draft;
    if (!value.trim() || !sessionId || !model || running) return;
    void perform(async () => {
      // Preserve the id after a lost response, including a manual retry of the same submission.
      const signature = JSON.stringify({ sessionId, text: value, model, effort, context });
      if (submission.current?.signature !== signature) submission.current = { signature, requestId: crypto.randomUUID() };
      await assistantApi.send(sessionId, { requestId: submission.current.requestId, text: value, model, effort, context });
      submission.current = null;
      // 等待期间又写了新内容就留着
      setDraft(current => (current === value ? '' : current));
      useAssistantView.getState().followLatest(sessionId);
      void sessions.refetch();
    });
  };
  const resume = () => {
    if (busy || !session?.interruption || !model || running) return;
    void perform(async () => {
      const messageId = session.interruption!.messageId;
      const signature = JSON.stringify({ sessionId, messageId, model, effort });
      if (resumption.current?.signature !== signature) resumption.current = { signature, requestId: crypto.randomUUID() };
      setResultSelection({ cardId: `resume:${messageId}`, title: '上次任务', ids: interruptedRequest?.context?.imageIds ?? [] });
      const updated = await assistantApi.resume(sessionId, { requestId: resumption.current.requestId, messageId, model, effort });
      setSession(previous => (previous && previous.updatedAt > updated.updatedAt ? previous : updated));
      resumption.current = null;
      useAssistantView.getState().followLatest(sessionId);
    });
  };

  return {
    backend,
    sessions: { data: sessions.data, isLoading: sessions.isLoading, error: sessions.error },
    sessionId,
    session,
    models: { data: models.data, isFetching: models.isFetching, error: models.error, refetch: () => void models.refetch() },
    model,
    effort,
    connected,
    busy,
    error,
    draft,
    setDraft,
    context,
    viewedId,
    resultSelection,
    actions: {
      send,
      stop: () => { if (sessionId) void perform(() => assistantApi.stop(sessionId)); },
      resume,
      answer: (questionId, value) => {
        if (!sessionId) return;
        void perform(async () => {
          await assistantApi.answer(sessionId, questionId, value);
          useAssistantView.getState().setQuestionDraft(questionId, '');
          focusComposer();
        });
      },
      chooseSession,
      newSession: () => {
        if (!backend || busy) return;
        // 当前会话还是空的就不再建，直接去写
        if (session && session.messages.length === 0) { focusComposer(); return; }
        void create();
      },
      pickModel: id => { setModel(id); setEffort(models.data?.find(m => m.id === id)?.defaultEffort ?? ''); },
      pickEffort: e => setEffort(e === 'default' ? '' : e),
      reconnect: () => setConnectionAttempt(n => n + 1),
      dismissError: () => setError(''),
      selectResult: (card, id, checked) => {
        setResultSelection(previous => toggleResultImage(previous ?? { cardId: card.id, title: card.title, ids: context.imageIds }, card, id, checked));
        focusComposer();
      },
      clearResultSelection: () => setResultSelection(null),
      undo: token => undoMutation(token, client),
    },
  };
}
