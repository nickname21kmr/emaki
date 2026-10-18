import type { AssistantMessage } from '@emaki/shared';

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
