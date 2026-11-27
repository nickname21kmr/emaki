import { create } from 'zustand';

/** 插件页面给 AI 助手的上下文最长多少字（超了截掉） */
export const VIEW_CONTEXT_MAX = 8000;

/**
 * 插件页面报的「现在显示的是什么」（MCP Apps 的 ui/update-model-context，docs/plugins.md 12.8）：每次覆盖上一次，
 * 你在这一页问 AI 助手时随问题一起发（useConversation 的 context.view），离开这一页就清掉
 */
export const useViewContext = create<{ current: { plugin: string; page: string; text: string } | null }>(() => ({ current: null }));

/** 页面给的内容 → 一段文字：文本块原样，structuredContent 写成 JSON；超长截掉 */
export function viewContextText(params: { content?: { type: string; text?: string }[]; structuredContent?: unknown }): string {
  const parts = (params.content ?? []).filter((c) => c.type === 'text' && c.text).map((c) => c.text!);
  if (params.structuredContent !== undefined) parts.push(JSON.stringify(params.structuredContent));
  const text = parts.join('\n\n');
  return text.length > VIEW_CONTEXT_MAX ? `${text.slice(0, VIEW_CONTEXT_MAX)}…` : text;
}
