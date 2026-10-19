import type { AssistantContext, AssistantMessage } from '@emaki/shared';

export interface ResultSelection { cardId: string; title: string; ids: string[] }
export function composerContext(page: string, scope: string, selected: ReadonlySet<string>, viewedId: string | undefined, result: ResultSelection | null): AssistantContext {
  return { page, imageIds: viewedId ? [viewedId] : result ? result.ids : [...selected], selectionScope: viewedId ? 'lightbox' : result ? `assistant-result:${result.cardId}` : scope };
}
export function toggleResultImage(current: ResultSelection | null, card: { id: string; title: string }, id: string, checked: boolean): ResultSelection {
  const ids = new Set(current?.ids ?? []);
  if (checked) ids.add(id); else ids.delete(id);
  return { cardId: card.id, title: current && current.cardId !== card.id && current.ids.length ? '助手选择' : card.title, ids: [...ids] };
}

export function groupMessages(messages: AssistantMessage[]): AssistantMessage[][] {
  const groups: AssistantMessage[][] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    const isLog = (m: AssistantMessage) => m.role === 'tool' && !m.cards?.length;
    if (isLog(message) && previous && isLog(previous[0]!)) previous.push(message);
    else groups.push([message]);
  }
  return groups;
}

export interface Position { x: number; y: number }
export function clampPosition(position: Position, width: number, height: number, viewportWidth: number, viewportHeight: number): Position {
  return {
    x: Math.max(8, Math.min(position.x, viewportWidth - width - 8)),
    y: Math.max(8, Math.min(position.y, viewportHeight - height - 8)),
  };
}
