import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AssistantBackend, AssistantCard, AssistantContext, AssistantModel, AssistantSession } from '@emaki/shared';
import { ApiRequestError } from '@/lib/api';
import { useLightbox, useSelection, useUndoStore } from '@/lib/stores';
import { undo as undoMutation } from '@/lib/queries';
import { assistantApi } from './client';
import { openSessionEvents } from './sessionEvents';
import { composerContext, erratumOf, reconcileModelSelection, toggleResultImage, type ResultSelection } from './presentation';
import { focusComposer, useAssistantDock } from './dock';
import { useAssistantView, type UndoResult } from './viewState';

export type SessionSummary = Pick<AssistantSession, 'id' | 'title' | 'backend' | 'updatedAt'>;

/** 视图只吃这个接口；useConversation 连服务端，fixtures 的 useFixtureConversation 在本地假装（§21.2） */
export interface ConversationView {
  backend: AssistantBackend | null;
  sessions: { data?: SessionSummary[]; isLoading: boolean; error: unknown; refetch(): void };
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
    /** 撤销图库改动，返回结果（toast 照常弹）：ok / gone（token 没了）/ failed（连不上） */
    undo(token: string): Promise<UndoResult>;
  };
}

const storageKey = (backend: AssistantBackend) => `emaki.assistant.${backend}`;

/** 这个标签页里上次用的会话 */
export function storedSessionId(backend: AssistantBackend | null): string {
  if (!backend) return '';
  try { return sessionStorage.getItem(storageKey(backend)) ?? ''; } catch { return ''; }
}

/** 发送成功后输入框里该留下什么：等待期间在后面接着写的留下，已经发出去的那段去掉 */
export function draftAfterSend(current: string, sent: string): string {
  if (current === sent) return '';
  if (current.startsWith(sent)) return current.slice(sent.length).replace(/^\s+/, '');
  return current;
}

/** 后端明确说没有这个会话（不是连不上） */
const isMissing = (e: unknown) => e instanceof ApiRequestError && e.code !== 'network' && (e.status === 404 || e.code === 'not_found');

/**
 * 助手的全部对话状态：会话、SSE + 补拉、模型、发送 / 继续 / 停止 / 回答、两个 requestId 去重、结果图勾选。
 * 挂在 AssistantRoot 上，视图在 body 和暗房之间重新挂载也不受影响。按 backend 换 key 重建。
 */
export function useConversation(backend: AssistantBackend | null): ConversationView {
  const client = useQueryClient(), location = useLocation();
  const open = useAssistantDock(s => s.open);
  const [sessionId, setSessionId] = useState(() => storedSessionId(backend));
  const [session, setSession] = useState<AssistantSession | null>(null);
  // 草稿按会话存在 viewState（sessionStorage），刷新、换会话都不串
  const draft = useAssistantView(s => s.drafts[sessionId] ?? '');
  const setDraft = (v: string) => useAssistantView.getState().setDraft(sessionId, v);
  const [model, setModel] = useState(''), [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [connected, setConnected] = useState(true);
  const [resultSelection, setResultSelection] = useState<ResultSelection | null>(null), [connectionAttempt, setConnectionAttempt] = useState(0);
  const selected = useSelection(s => s.ids), scope = useSelection(s => s.scope);
  const viewedId = useLightbox(s => (s.open ? s.ids[s.index] : undefined));
  const submission = useRef<{ signature: string; requestId: string } | null>(null);
  const resumption = useRef<{ signature: string; requestId: string } | null>(null);
  const creating = useRef(false);
  // 最近一次报错是不是「连不上」：重新收到快照时自动清掉
  const networkError = useRef(false);
  // 模型列表还在读时按了发送：读到模型后补发一次
  const pendingSend = useRef(false);
  // 当前会话 id，异步回来的结果对不上就丢掉
  const currentId = useRef(sessionId);
  currentId.current = sessionId;
  // 已经见过的撤销 token：只把之后新来的记进顶栏撤销栈，不回放历史
  const seenUndo = useRef<Set<string> | null>(null);
  // 收起时不读会话列表；存着会话 id 的话页面加载时就连上，胶囊才能显示运行状态
  const sessions = useQuery({ queryKey: ['assistant-sessions'], queryFn: assistantApi.sessions, enabled: Boolean(backend) && (open || Boolean(sessionId)) });
  // 读模型列表会临时拉起 Agent 进程，只在打开后读
  const models = useQuery({ queryKey: ['assistant-models', sessionId], queryFn: () => assistantApi.models(sessionId), enabled: open && Boolean(sessionId), staleTime: 60000, retry: false });
  const running = session?.status === 'running' || session?.status === 'waiting';
  const context = composerContext(location.pathname + location.search, scope, selected, viewedId, resultSelection);
  const interruptedRequest = session?.messages.find(m => m.id === session.interruption?.messageId);

  useEffect(() => { setResultSelection(null); }, [sessionId, location.pathname, location.search, selected, scope]);

  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(''); networkError.current = false;
    try { await fn(); } catch (e) {
      networkError.current = e instanceof ApiRequestError && e.code === 'network';
      setError((e as Error).message);
    } finally { setBusy(false); }
  };
  const chooseSession = (id: string) => {
    if (backend) try { sessionStorage.setItem(storageKey(backend), id); } catch { /* 存不了就只在这次生效 */ }
    focusComposer();
    if (id === sessionId) return;
    setSession(null); setSessionId(id); setModel(''); setEffort(''); setError('');
    seenUndo.current = null; pendingSend.current = false;
  };
  /** 存着的会话在后端已经没了：忘掉它，交给下面的 effect 重新选或新建 */
  const forgetSession = () => {
    if (backend) try { sessionStorage.removeItem(storageKey(backend)); } catch { /* 没有 sessionStorage */ }
    setSession(null); setSessionId(''); setModel(''); setEffort('');
    seenUndo.current = null; pendingSend.current = false;
    void sessions.refetch();
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
    // 又连上了：之前「后端暂时连不上」那类报错不再成立
    const reconnected = () => {
      setConnected(true);
      if (networkError.current) { networkError.current = false; setError(''); }
    };
    const closeEvents = openSessionEvents(sessionId, {
      open: reconnected,
      message: data => { const snapshot: AssistantSession = JSON.parse(data); setSession(snapshot); reconnected(); },
      error: () => setConnected(false),
      disabled: () => {
        // 别的标签页关掉了助手：附页随后卸载，草稿已经按会话存着
        toast('助手已在别处关闭');
        void client.invalidateQueries({ queryKey: ['assistant-settings'] });
      },
    });
    // A temporary HTTP failure must not stop the stream's reconnection loop.
    void assistantApi.session(sessionId).then(s => { if (!disposed) setSession(previous => previous ?? s); }).catch(e => {
      // 存着的会话在后端没了（删掉了、换了数据目录）：不要一直转圈和重连
      if (!disposed && isMissing(e)) forgetSession();
    });
    return () => { disposed = true; closeEvents(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- forgetSession 每次渲染都是新的
  }, [sessionId, client, connectionAttempt]);

  // 助手在这次会话里新改的图库也进顶栏撤销栈（Ctrl+Z / ↶）；第一份快照里的算历史，不记
  useEffect(() => {
    if (!session || session.id !== sessionId) return;
    const tokens = session.messages.map((m, i) => [m.undoToken, i] as const).filter((t): t is readonly [string, number] => Boolean(t[0]));
    if (!seenUndo.current) { seenUndo.current = new Set(tokens.map(([t]) => t)); return; }
    for (const [token, index] of tokens) {
      if (seenUndo.current.has(token)) continue;
      seenUndo.current.add(token);
      useUndoStore.getState().push({ token, label: erratumOf(session.messages, index).sentence });
    }
  }, [session, sessionId]);

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
  // 本轮结束后还留着 emaki 的提问（刷新后也一样）：胶囊显示「等你回应」
  const capsule = status === 'idle' && session?.questions.length ? 'waiting' : status;
  const previousStatus = useRef(status);
  useEffect(() => {
    const dock = useAssistantDock.getState(), was = previousStatus.current;
    previousStatus.current = status;
    dock.setStatus(capsule, runStartedAt);
    const ended = (was === 'running' || was === 'waiting') && status !== 'running' && status !== 'waiting';
    // 续跑时借用的「上次任务」选图只管这一轮，跑完就放掉
    if (ended) setResultSelection(previous => (previous?.cardId.startsWith('resume:') ? null : previous));
    if (!session || dock.open || !ended) return;
    const last = session.messages.at(-1);
    if (status === 'error' || session.interruption) dock.setUnseen('incomplete');
    else if (last && ((last.role === 'assistant' && !last.reasoning && last.text.trim()) || last.cards?.length || last.undoToken)) dock.setUnseen('reply');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只看状态切换
  }, [status, capsule, runStartedAt]);
  useEffect(() => () => useAssistantDock.getState().setStatus(null, null), []);
  useEffect(() => {
    useAssistantDock.getState().setConnected(connected);
    return () => useAssistantDock.getState().setConnected(true);
  }, [connected]);

  const send = () => {
    if (busy) return;
    const value = draft;
    if (!value.trim() || !sessionId || running) return;
    // 模型列表还在读：先记着，读到模型后自动发
    if (!model) { pendingSend.current = models.isFetching; return; }
    pendingSend.current = false;
    const sid = sessionId;
    void perform(async () => {
      // Preserve the id after a lost response, including a manual retry of the same submission.
      const signature = JSON.stringify({ sessionId: sid, text: value, model, effort, context });
      if (submission.current?.signature !== signature) submission.current = { signature, requestId: crypto.randomUUID() };
      await assistantApi.send(sid, { requestId: submission.current.requestId, text: value, model, effort, context });
      submission.current = null;
      // 等待期间接着写的留下，已经发出去的那段去掉；清的是发出去的那个会话的草稿
      useAssistantView.getState().setDraft(sid, current => draftAfterSend(current, value));
      useAssistantView.getState().followLatest(sid);
      void sessions.refetch();
    });
  };
  useEffect(() => {
    if (!pendingSend.current) return;
    if (model) send();
    else if (!models.isFetching) pendingSend.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send 每次渲染都是新的
  }, [model, models.isFetching]);
  const resume = () => {
    if (busy || !session?.interruption || !model || running) return;
    const sid = sessionId;
    void perform(async () => {
      const messageId = session.interruption!.messageId;
      const signature = JSON.stringify({ sessionId: sid, messageId, model, effort });
      if (resumption.current?.signature !== signature) resumption.current = { signature, requestId: crypto.randomUUID() };
      const ids = interruptedRequest?.context?.imageIds ?? [];
      if (ids.length) setResultSelection({ cardId: `resume:${messageId}`, title: '上次任务', ids });
      const updated = await assistantApi.resume(sid, { requestId: resumption.current.requestId, messageId, model, effort });
      resumption.current = null;
      // 等回应期间切到了别的会话：不把这份快照放进来
      if (updated.id !== currentId.current) return;
      setSession(previous => (previous && previous.updatedAt > updated.updatedAt ? previous : updated));
      useAssistantView.getState().followLatest(sid);
    });
  };

  return {
    backend,
    sessions: { data: sessions.data, isLoading: sessions.isLoading, error: sessions.error, refetch: () => void sessions.refetch() },
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
        // 还在切换（快照没到）或正在建：连点不多建
        if (!backend || busy || creating.current || !session) return;
        // 当前会话还是空的就不再建，直接去写
        if (session.messages.length === 0) { focusComposer(); return; }
        // 这个 backend 已经有一条空的（标题还是「新对话」，说明一条消息都没发过）就回到那条
        const empty = sessions.data?.filter(s => s.backend === backend && s.title === '新对话' && s.id !== sessionId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (empty) { chooseSession(empty.id); return; }
        creating.current = true;
        void create().finally(() => { creating.current = false; });
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
