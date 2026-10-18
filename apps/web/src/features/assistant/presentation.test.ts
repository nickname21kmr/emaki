import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@emaki/shared';
import { clampPosition, groupMessages } from './presentation';

describe('assistant presentation', () => {
  it('groups consecutive tool records while keeping answers and result cards outside', () => {
    const messages: AssistantMessage[] = [
      { id: '1', role: 'user', text: 'apply' },
      { id: '2', role: 'tool', text: 'update_images' },
      { id: '3', role: 'tool', text: '图库已更新', undoToken: 'undo' },
      { id: '4', role: 'tool', text: '结果', cards: [{ id: 'card', title: '图片', imageIds: ['1'] }] },
      { id: '5', role: 'assistant', text: 'done' },
      { id: '6', role: 'tool', text: 'another tool' },
    ];
    const groups = groupMessages(messages);
    expect(groups.map(g => g.map(m => m.id))).toEqual([['1'], ['2', '3'], ['4'], ['5'], ['6']]);
    expect(groups[1]![1]!.undoToken).toBe('undo');
    expect(messages).toHaveLength(6);
  });
  it('keeps dragged surfaces in view after resize or maximize', () => {
    expect(clampPosition({ x: 1200, y: 850 }, 440, 600, 1280, 720)).toEqual({ x: 832, y: 112 });
    expect(clampPosition({ x: -400, y: -500 }, 440, 600, 1280, 720)).toEqual({ x: 8, y: 8 });
    expect(clampPosition({ x: 832, y: 112 }, 880, 634, 1280, 720)).toEqual({ x: 392, y: 78 });
  });
});
