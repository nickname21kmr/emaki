import { describe, expect, it } from 'vitest';
import { VIEW_CONTEXT_MAX, viewContextText } from './viewContext';

describe('插件页面给 AI 助手的上下文（ui/update-model-context，docs/plugins.md 12.8）', () => {
  it('文本块原样、structuredContent 写成 JSON，别的块不要；太长截掉', () => {
    expect(viewContextText({ content: [{ type: 'text', text: '作品排行' }, { type: 'image' }, { type: 'text', text: '1. A' }], structuredContent: { top: ['A'] } })).toBe(
      '作品排行\n\n1. A\n\n{"top":["A"]}',
    );
    expect(viewContextText({})).toBe('');
    const long = viewContextText({ content: [{ type: 'text', text: 'x'.repeat(VIEW_CONTEXT_MAX + 50) }] });
    expect(long).toHaveLength(VIEW_CONTEXT_MAX + 1);
    expect(long.endsWith('…')).toBe(true);
  });
});
