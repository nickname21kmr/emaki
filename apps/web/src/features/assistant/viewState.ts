import { create } from 'zustand';

/**
 * 助手的视图状态。附页在 body 和暗房插槽之间切换时会重新挂载，组件 state 会丢，所以放这里。
 * 键：expanded / revealed 用条目 id（旁注组 id、卡片 id、`${messageId}:full` 这类），scroll 用会话 id。
 */
/** expired：后端已经没有这个 token（撤销过、过期、重启过），再点也没用 */
export type UndoState = 'undoing' | 'undone' | 'expired' | { failed: string };
export interface ScrollState { top: number; follow: boolean }

// 撤销结果写进 localStorage：同一个浏览器的其他标签页也能看到，刷新后不丢。只留最近 300 条
const UNDONE_KEY = 'emaki.assistant.undone';
const UNDONE_MAX = 300;
const settled = (v: unknown): v is 'undone' | 'expired' => v === 'undone' || v === 'expired';

function parseUndone(raw: string | null): Record<string, UndoState> {
  const value: unknown = JSON.parse(raw ?? '{}');
  // 旧格式是 sessionStorage 里的 token 数组
  if (Array.isArray(value)) return Object.fromEntries(value.filter((t): t is string => typeof t === 'string').map((t) => [t, 'undone']));
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => settled(v)));
}
function readUndone(): Record<string, UndoState> {
  try {
    return { ...parseUndone(sessionStorage.getItem(UNDONE_KEY)), ...parseUndone(localStorage.getItem(UNDONE_KEY)) };
  } catch { return {}; }
}
function writeUndone(undo: Record<string, UndoState>) {
  try {
    const entries = Object.entries(undo).filter(([, v]) => settled(v)).slice(-UNDONE_MAX);
    localStorage.setItem(UNDONE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* 存不了就只在这次生效 */ }
}

const DRAFT_KEY = 'emaki.assistant.drafts';
const QUESTION_DRAFT_KEY = 'emaki.assistant.question-drafts';
function readDrafts(key: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) : {};
  } catch { return {}; }
}
/** 改一条草稿；空的直接删掉，存进 sessionStorage（刷新后还在） */
function putDraft(key: string, drafts: Record<string, string>, id: string, v: string) {
  const next = { ...drafts };
  if (v) next[id] = v; else delete next[id];
  try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* 存不了就只在这次生效 */ }
  return next;
}

interface ViewState {
  /** 用户手动展开 / 收起过的旁注、条目、思考全文、问句全文 */
  expanded: Record<string, boolean>;
  setExpanded: (id: string, v: boolean) => void;
  /** 图版和表已经展开的数量 */
  revealed: Record<string, number>;
  setRevealed: (id: string, n: number) => void;
  /** 每个会话的滚动位置，以及是不是跟着最新内容 */
  scroll: Record<string, ScrollState>;
  setScroll: (sessionId: string, v: ScrollState) => void;
  /** 发出去以后回到最新（useConversation 在发送、继续处理后调用） */
  followLatest: (sessionId: string) => void;
  /** 提问便笺里还没发出去的回答（sessionStorage，刷新后还在） */
  questionDraft: Record<string, string>;
  setQuestionDraft: (questionId: string, v: string) => void;
  /** 输入框草稿，按会话分开（sessionStorage，刷新后还在） */
  drafts: Record<string, string>;
  setDraft: (sessionId: string, v: string | ((current: string) => string)) => void;
  /** 勘误条的撤销状态；undone / expired 写进 localStorage，刷新和别的标签页都能看到 */
  undo: Record<string, UndoState>;
  setUndo: (token: string, v: UndoState | null) => void;
}

export const useAssistantView = create<ViewState>((set) => ({
  expanded: {},
  setExpanded: (id, v) => set((s) => ({ expanded: { ...s.expanded, [id]: v } })),
  revealed: {},
  setRevealed: (id, n) => set((s) => ({ revealed: { ...s.revealed, [id]: n } })),
  scroll: {},
  setScroll: (sessionId, v) =>
    set((s) => {
      const old = s.scroll[sessionId];
      return old && old.top === v.top && old.follow === v.follow ? s : { scroll: { ...s.scroll, [sessionId]: v } };
    }),
  followLatest: (sessionId) => set((s) => ({ scroll: { ...s.scroll, [sessionId]: { top: s.scroll[sessionId]?.top ?? 0, follow: true } } })),
  questionDraft: readDrafts(QUESTION_DRAFT_KEY),
  setQuestionDraft: (questionId, v) => set((s) => ({ questionDraft: putDraft(QUESTION_DRAFT_KEY, s.questionDraft, questionId, v) })),
  drafts: readDrafts(DRAFT_KEY),
  setDraft: (sessionId, v) =>
    set((s) => {
      const current = s.drafts[sessionId] ?? '';
      const next = typeof v === 'function' ? v(current) : v;
      return next === current ? s : { drafts: putDraft(DRAFT_KEY, s.drafts, sessionId, next) };
    }),
  undo: readUndone(),
  setUndo: (token, v) =>
    set((s) => {
      const undo = { ...s.undo };
      if (v === null) delete undo[token];
      else undo[token] = v;
      if (settled(v) || settled(s.undo[token])) writeUndone(undo);
      return { undo };
    }),
}));

// 别的标签页撤销了：把结果并进来
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== UNDONE_KEY) return;
    try {
      const theirs = parseUndone(e.newValue);
      useAssistantView.setState((s) => ({ undo: { ...s.undo, ...theirs } }));
    } catch { /* 坏数据不管 */ }
  });
}

/** 撤销的结果：ok 成功；gone 后端已经没有这个 token；failed 连不上，可以再试 */
export type UndoResult = 'ok' | 'gone' | 'failed';

/** 勘误条点「撤销」：撤销中 → 已撤销；token 没了记「已失效」；连不上时留下原因（具体原因由 toast 报），按钮还能再点 */
export async function runUndo(token: string, undo: (token: string) => Promise<UndoResult>) {
  const { setUndo } = useAssistantView.getState();
  setUndo(token, 'undoing');
  let result: UndoResult = 'failed';
  try { result = await undo(token); } catch { result = 'failed'; }
  setUndo(token, result === 'ok' ? 'undone' : result === 'gone' ? 'expired' : { failed: '可以再试一次' });
  return result;
}

// ------------------------------------------------------------------ 入场动画

/**
 * 新消息只在第一次出现时淡入（SEL-13）：切会话后的第一份快照全部算「已见」，
 * 之后新来的条目挂载时 claimEntrance 返回 true 一次；重新挂载（进出暗房）不重播。
 */
const seen = new Map<string, Set<string>>();

/** 每次拿到快照都可以调；只有这个会话第一次调用时把 ids 记为已见 */
export function seedEntrances(sessionId: string, ids: readonly string[]) {
  if (!seen.has(sessionId)) seen.set(sessionId, new Set(ids));
}

/** 这个条目要不要播入场动画（第一次见到返回 true，之后都是 false） */
export function claimEntrance(sessionId: string, id: string) {
  let ids = seen.get(sessionId);
  if (!ids) seen.set(sessionId, (ids = new Set()));
  if (ids.has(id)) return false;
  ids.add(id);
  return true;
}
