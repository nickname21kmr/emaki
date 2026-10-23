import { create } from 'zustand';

/**
 * 助手的视图状态。附页在 body 和暗房插槽之间切换时会重新挂载，组件 state 会丢，所以放这里。
 * 键：expanded / revealed 用条目 id（旁注组 id、卡片 id、`${messageId}:full` 这类），scroll 用会话 id。
 */
export type UndoState = 'undoing' | 'undone' | { failed: string };
export interface ScrollState { top: number; follow: boolean }

const UNDONE_KEY = 'emaki.assistant.undone';

function readUndone(): Record<string, UndoState> {
  try {
    const list: unknown = JSON.parse(sessionStorage.getItem(UNDONE_KEY) ?? '[]');
    return Array.isArray(list) ? Object.fromEntries(list.filter((t): t is string => typeof t === 'string').map((t) => [t, 'undone'])) : {};
  } catch { return {}; }
}
function writeUndone(undo: Record<string, UndoState>) {
  try {
    sessionStorage.setItem(UNDONE_KEY, JSON.stringify(Object.keys(undo).filter((t) => undo[t] === 'undone')));
  } catch { /* 存不了就只在这次生效 */ }
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
  /** 提问便笺里还没发出去的回答 */
  questionDraft: Record<string, string>;
  setQuestionDraft: (questionId: string, v: string) => void;
  /** 勘误条的撤销状态；undone 同步写进 sessionStorage，刷新后不丢 */
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
  questionDraft: {},
  setQuestionDraft: (questionId, v) => set((s) => ({ questionDraft: { ...s.questionDraft, [questionId]: v } })),
  undo: readUndone(),
  setUndo: (token, v) =>
    set((s) => {
      const undo = { ...s.undo };
      if (v === null) delete undo[token];
      else undo[token] = v;
      if (v === 'undone' || s.undo[token] === 'undone') writeUndone(undo);
      return { undo };
    }),
}));

/** 勘误条点「撤销」：撤销中 → 已撤销，失败时留下原因（具体原因由 toast 报），按钮还能再点 */
export async function runUndo(token: string, undo: (token: string) => Promise<boolean>) {
  const { setUndo } = useAssistantView.getState();
  setUndo(token, 'undoing');
  let ok = false;
  try { ok = await undo(token); } catch { ok = false; }
  setUndo(token, ok ? 'undone' : { failed: '可以再试一次' });
  return ok;
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
