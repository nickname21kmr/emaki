import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantMessage, AssistantSession } from '@emaki/shared';
import { currentActivity, toolGroupLabel, ToolActivity, ReasoningActivity } from './AssistantActivity';

const tool: AssistantMessage = { id: 'tool', role: 'tool', text: 'bash', tool: { status: 'running', startedAt: 1000, input: 'python search.py', output: 'uploading' } };
it('shows current tool even when the group is collapsed, and distinguishes errors', () => {
  const failed: AssistantMessage = { id: 'error', role: 'tool', text: 'fetch', tool: { status: 'failed', startedAt: 1, output: 'HTTP 403' } };
  expect(toolGroupLabel([failed, tool])).toContain('正在运行 bash');
  expect(toolGroupLabel([failed, tool])).toContain('1 失败');
  const html = renderToStaticMarkup(<ToolActivity message={failed} />);
  expect(html).toContain('HTTP 403'); expect(html).toContain('返回结果'); expect(html).toContain('失败'); expect(html).not.toContain(' open=');
});
it('uses only the current turn for activity and provides thinking content separately', () => {
  const user: AssistantMessage = { id: 'user', role: 'user', text: 'Search', createdAt: 2000 };
  const session = { status: 'running', messages: [tool, user] } as AssistantSession;
  expect(currentActivity(session)).toMatchObject({ label: '等待模型回应', startedAt: 2000 });
  session.messages.push({ ...tool, id: 'new-tool' });
  expect(currentActivity(session)).toMatchObject({ label: '正在运行 bash', detail: 'python search.py' });
  const thought: AssistantMessage = { id: 'think', role: 'assistant', text: '', reasoning: { text: 'Compare the source image', startedAt: 2000, status: 'running' } };
  session.messages = [user, thought];
  expect(currentActivity(session)).toMatchObject({ label: '正在思考', detail: 'Compare the source image' });
  const html = renderToStaticMarkup(<ReasoningActivity message={thought} />);
  expect(html).toContain('正在思考'); expect(html).toContain('Compare the source image'); expect(html).not.toContain(' open=');
});
