import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui';
import { SHORTCUT_GROUPS } from '@/components/overlays/shortcuts';
import { digitIndex } from './hooks';
import { SuggestionRow } from './components/PanelParts';

describe('数字键对应第几条建议', () => {
  it('普通数字按 key 认，Shift+数字时 key 是符号，按 code 认', () => {
    expect(digitIndex({ key: '1', code: 'Digit1' })).toBe(0);
    expect(digitIndex({ key: '9', code: 'Numpad9' })).toBe(8);
    expect(digitIndex({ key: '@', code: 'Digit2' })).toBe(1);
    expect(digitIndex({ key: '"', code: 'Digit2' })).toBe(1); // 日文键盘的 Shift+2
    expect(digitIndex({ key: '0', code: 'Digit0' })).toBe(-1);
    expect(digitIndex({ key: 'Enter', code: 'Enter' })).toBe(-1);
  });
});

describe('建议行的勾选框', () => {
  const row = (extra: Partial<Parameters<typeof SuggestionRow>[0]>) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <SuggestionRow n={2} name="镜音铃" workName="VOCALOID" value={0.6} valueLabel={60} onPick={() => {}} {...extra} />
      </TooltipProvider>,
    );

  it('不传 onToggleCheck 时没有勾选框（只有一条建议）', () => {
    expect(row({})).not.toContain('role="checkbox"');
  });

  it('勾选框是行外的独立按钮，带名字和状态', () => {
    const html = row({ checked: true, onToggleCheck: () => {} });
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('aria-label="勾选：镜音铃"');
    expect(html).toContain('aria-checked="true"');
    // 不能把按钮套在按钮里
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<button/s);
    expect(row({ checked: false, onToggleCheck: () => {} })).toContain('aria-checked="false"');
  });
});

describe('帮助面板', () => {
  it('列出勾选和采纳勾选的快捷键', () => {
    const labels = SHORTCUT_GROUPS.unrecognized.items.map((i) => i.label);
    expect(labels).toContain('勾选第 N 条建议（可勾多位）');
    expect(labels).toContain('采纳勾选的建议');
  });
});
