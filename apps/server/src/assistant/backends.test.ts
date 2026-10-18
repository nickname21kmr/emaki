import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredSession, PrivateSettings } from './store.ts';
const state = vi.hoisted(() => ({ rpc: null as any }));
vi.mock('./rpc.ts', () => ({ JsonProcess: class {
  onEvent = (_: any) => {}; onExit = (_: any) => {};
  send = vi.fn(); close = vi.fn(async () => {});
  request = vi.fn(async (m: any) => m.method === 'thread/start' ? { thread: { id: 'owned' } } : m.method === 'turn/start' ? { turn: { id: 'turn' } } : {});
  constructor() { state.rpc = this; }
} }));
import { CodexBackend } from './backends.ts';

let backend: CodexBackend;
const sink = { text: vi.fn(), tool: vi.fn(), question: vi.fn(), done: vi.fn() };
beforeEach(async () => {
  vi.clearAllMocks();
  backend = await CodexBackend.open({ codexPath: process.execPath } as PrivateSettings, { token: 'private' } as StoredSession, '.', 'http://localhost/mcp', 'Instructions', sink);
});
describe('Codex app-server adapter', () => {
  it('creates a native thread once, then resumes only that thread', async () => {
    await backend.prompt('first', 'model', 'low'); await backend.prompt('next', 'model', 'medium');
    expect(state.rpc.request.mock.calls.filter(([m]: any) => m.method === 'thread/start')).toHaveLength(1);
    expect(state.rpc.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'thread/resume', params: expect.objectContaining({ threadId: 'owned' }) }));
    expect(state.rpc.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'turn/start', params: expect.objectContaining({ effort: 'medium' }) }));
  });
  it('renders MCP confirmations and forwards the explicit decision', () => {
    state.rpc.onEvent({ id: 42, method: 'mcpServer/elicitation/request', params: { mode: 'form', requestedSchema: { properties: {} }, message: 'Display images?', _meta: { tool_params: { imageIds: ['1'] } } } });
    expect(sink.question).toHaveBeenCalledWith(expect.objectContaining({ id: '42', kind: 'approval', title: expect.stringContaining('Display images?') }));
    backend.answer('42', 'approve');
    expect(state.rpc.send).toHaveBeenCalledWith({ id: 42, result: { action: 'accept', content: {} } });
  });
  it('collects distinct answers for multi-question requests', () => {
    state.rpc.onEvent({ id: 7, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'a', question: 'First?' }, { id: 'b', question: 'Second?' }] } });
    state.rpc.send.mockClear(); backend.answer('7:0', 'one'); expect(state.rpc.send).not.toHaveBeenCalled();
    backend.answer('7:1', 'two');
    expect(state.rpc.send).toHaveBeenCalledWith({ id: 7, result: { answers: { a: { answers: ['one'] }, b: { answers: ['two'] } } } });
  });
  it('streams owned output, suppresses user-message tool noise and unrelated thread events', async () => {
    await backend.prompt('test', 'model', '');
    state.rpc.onEvent({ method: 'item/agentMessage/delta', params: { threadId: 'other', itemId: 'x', delta: 'unrelated' } });
    state.rpc.onEvent({ method: 'item/started', params: { threadId: 'owned', item: { type: 'userMessage', id: 'user' } } });
    state.rpc.onEvent({ method: 'item/agentMessage/delta', params: { threadId: 'owned', itemId: 'm', delta: 'hello' } });
    state.rpc.onEvent({ method: 'turn/completed', params: { threadId: 'owned', turn: {} } });
    expect(sink.text).toHaveBeenCalledExactlyOnceWith('m', 'hello'); expect(sink.tool).not.toHaveBeenCalled(); expect(sink.done).toHaveBeenCalled();
  });
});
