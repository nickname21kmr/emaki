import { expect, it } from 'vitest';
import { codexToolActivity } from './codexActivity.ts';

it('preserves commands without a final output snapshot and reports exit code and duration', () => {
  const result = codexToolActivity({ type: 'commandExecution', id: 'cmd', command: 'query', cwd: 'C:/test', status: 'completed', aggregatedOutput: null, exitCode: 0, durationMs: 1500 }, true)!;
  expect(result.update).toMatchObject({ status: 'succeeded', exitCode: 0, durationMs: 1500 });
  expect(result.update.input).toContain('C:/test'); expect(result.update).not.toHaveProperty('output');
});
it('includes MCP structured content, errors and provider-qualified names', () => {
  const item = { id: 'mcp', type: 'mcpToolCall', server: 'emaki', tool: 'query_database', arguments: { sql: 'SELECT 1' }, status: 'completed', result: { content: [], structuredContent: { rows: [{ n: 1 }] } } };
  expect(codexToolActivity(item, false)).toMatchObject({ name: 'emaki · query_database', update: { status: 'running', input: expect.stringContaining('SELECT 1') } });
  expect(codexToolActivity(item, true)?.update.output).toContain('rows');
  expect(codexToolActivity({ ...item, status: 'failed', error: { message: 'network timeout' } }, true)?.update).toMatchObject({ status: 'failed', output: expect.stringContaining('network timeout') });
});
it('distinguishes search, open and find and exposes actual search results', () => {
  for (const [action, name] of [
    [{ type: 'search', queries: ['official source'] }, '联网搜索'],
    [{ type: 'openPage', url: 'https://example.org/source' }, '打开网页'],
    [{ type: 'findInPage', url: 'https://example.org/source', pattern: 'artist' }, '查找网页内容'],
  ] as const) {
    const result = codexToolActivity({ id: 'search', type: 'webSearch', query: '', action, results: [{ title: 'Original post', url: 'https://example.org/source' }] }, true)!;
    expect(result.name).toBe(name); expect(result.update.input).toContain(action.type); expect(result.update.output).toContain('Original post');
  }
});
it('handles files, image views, dynamic tools and collaboration without exposing media bytes', () => {
  const changes = [{ path: 'notes.txt', kind: { type: 'update' }, diff: '+ source verified' }];
  expect(codexToolActivity({ type: 'fileChange', id: 'patch', changes, status: 'declined' }, true)?.update).toMatchObject({ status: 'failed', output: expect.stringContaining('source verified') });
  expect(codexToolActivity({ type: 'imageView', id: 'image', path: 'query.jpg' }, true)).toMatchObject({ name: '查看图片', update: { input: 'query.jpg', status: 'succeeded' } });
  const result = codexToolActivity({ type: 'dynamicToolCall', id: 'dynamic', tool: 'read', namespace: 'media', arguments: {}, success: false, contentItems: [{ type: 'inputText', text: 'failed' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,secret-binary' }] }, true)!;
  expect(result).toMatchObject({ name: 'media · read', update: { status: 'failed' } }); expect(result.update.output).not.toContain('secret-binary');
  expect(codexToolActivity({ type: 'collabAgentToolCall', id: 'child', tool: 'wait', prompt: 'Check source', agentsStates: { child: { status: 'completed', message: 'Found original post' } } }, true)?.update.output).toContain('Found original post');
  expect(codexToolActivity({ type: 'agentMessage', id: 'reply', text: 'hello' }, true)).toBeNull();
});
