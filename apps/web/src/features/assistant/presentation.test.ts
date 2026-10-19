import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@emaki/shared';
import { clampPosition, composerContext, groupMessages, toggleResultImage, reconcileModelSelection } from './presentation';

describe('assistant presentation', () => {
  it('recovers removed models and reasoning levels while preserving available user choices', () => {
    const models = [{ id: 'new', name: 'New', vision: true, efforts: ['low', 'high'], defaultEffort: 'low' }];
    const saved = { model: 'removed', effort: 'max' };
    expect(reconcileModelSelection(models, saved, saved)).toEqual({ model: 'new', effort: 'low' });
    expect(reconcileModelSelection(models, { model: 'new', effort: 'max' }, saved)).toEqual({ model: 'new', effort: 'low' });
    expect(reconcileModelSelection(models, { model: 'new', effort: '' }, saved)).toEqual({ model: 'new', effort: '' });
    expect(reconcileModelSelection(models, { model: '', effort: '' }, { model: 'new', effort: 'high' })).toEqual({ model: 'new', effort: 'high' });
    expect(reconcileModelSelection([], saved, saved)).toEqual({ model: '', effort: '' });
    expect(reconcileModelSelection([{ ...models[0]!, efforts: [], defaultEffort: '' }], { model: 'new', effort: 'high' }, saved)).toEqual({ model: 'new', effort: '' });
  });
  it('uses the result selection for both the composer count and outgoing context, including clearing it', () => {
    const pageSelection = new Set(['page-1', 'page-2', 'page-3', 'page-4', 'page-5']);
    const card = { id: 'result', title: '识别结果' };
    const selected = toggleResultImage(null, card, '17329', true);
    const context = composerContext('/unrecognized', 'unrecognized', pageSelection, undefined, selected);
    expect(context.imageIds).toEqual(['17329']);
    expect(context.selectionScope).toBe('assistant-result:result');
    const cleared = toggleResultImage(selected, card, '17329', false);
    expect(composerContext('/unrecognized', 'unrecognized', pageSelection, undefined, cleared).imageIds).toEqual([]);
    expect(composerContext('/unrecognized', 'unrecognized', pageSelection, undefined, null).imageIds).toHaveLength(5);
    expect(composerContext('/unrecognized', 'unrecognized', pageSelection, 'preview', selected).imageIds).toEqual(['preview']);
    const mixed = toggleResultImage(selected, { id: 'other-result', title: '其他图片' }, '18042', true);
    expect(mixed.ids).toEqual(['17329', '18042']);
    expect(toggleResultImage(mixed, card, '17329', false).ids).toEqual(['18042']);
  });
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
  it('groups alternating reasoning and tools without crossing replies, cards or user turns', () => {
    const thought = (id: string): AssistantMessage => ({ id, role: 'assistant', text: '', reasoning: { text: 'checking', status: 'completed', startedAt: 1 } });
    const tool = (id: string): AssistantMessage => ({ id, role: 'tool', text: 'search' });
    const messages: AssistantMessage[] = [
      thought('1'), tool('2'), thought('3'), tool('4'), thought('5'),
      { id: '6', role: 'tool', text: '结果', cards: [{ id: 'card', title: '图片', imageIds: ['1'] }] },
      { id: '7', role: 'assistant', text: 'Found it' },
      thought('8'),
      { id: '9', role: 'user', text: 'Next' },
      tool('10'), thought('11'),
      { id: '12', role: 'system', text: 'Interrupted' },
    ];
    expect(groupMessages(messages).map(g => g.map(m => m.id))).toEqual([
      ['1', '2', '3', '4', '5'], ['6'], ['7'], ['8'], ['9'], ['10', '11'], ['12'],
    ]);
  });
});
