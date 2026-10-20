import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StoredSession, PrivateSettings } from './store.ts';
const state = vi.hoisted(() => ({ rpc: null as any, args: [] as any[] }));
vi.mock('./rpc.ts', () => ({ JsonProcess: class {
  onEvent = (_: any) => {}; onExit = (_: any) => {};
  send = vi.fn(); close = vi.fn(async () => {});
  request = vi.fn(async (m: any) => m.method === 'thread/start' ? { thread: { id: 'owned' } } : m.method === 'turn/start' ? { turn: { id: 'turn' } } : {});
  constructor(...args: any[]) { state.rpc = this; state.args = args; }
} }));
import { CodexBackend, PiBackend } from './backends.ts';

let backend: CodexBackend;
const sink = { text: vi.fn(), tool: vi.fn(), reasoning: vi.fn(), question: vi.fn(), done: vi.fn() };
beforeEach(async () => {
  vi.clearAllMocks();
  backend = await CodexBackend.open({ codexPath: process.execPath } as PrivateSettings, { token: 'private' } as StoredSession, '.', 'http://localhost/mcp', 'Instructions', sink);
});
describe('Codex app-server adapter', () => {
  it('routes MCP progress and file patch updates onto the original tool records', async () => {
    await backend.prompt('test', 'model', '');
    state.rpc.onEvent({ method: 'item/started', params: { threadId: 'owned', item: { type: 'mcpToolCall', id: 'lookup', server: 'emaki', tool: 'read_media', arguments: { imageId: '42' } } } });
    state.rpc.onEvent({ method: 'item/mcpToolCall/progress', params: { threadId: 'other', itemId: 'lookup', message: 'unrelated progress' } });
    state.rpc.onEvent({ method: 'item/mcpToolCall/progress', params: { threadId: 'owned', itemId: 'lookup', message: '读取缩略图' } });
    expect(sink.tool.mock.calls).toHaveLength(2);
    expect(sink.tool.mock.calls[1]).toEqual(['lookup', 'emaki · read_media', { status: 'running', progress: '读取缩略图' }]);
    const changes = [{ path: 'notes.txt', diff: '+ found source' }];
    state.rpc.onEvent({ method: 'item/fileChange/patchUpdated', params: { threadId: 'owned', itemId: 'patch', changes } });
    state.rpc.onEvent({ method: 'item/fileChange/outputDelta', params: { threadId: 'owned', itemId: 'patch', delta: 'applying' } });
    state.rpc.onEvent({ method: 'item/completed', params: { threadId: 'owned', item: { type: 'fileChange', id: 'patch', changes, status: 'completed' } } });
    expect(sink.tool.mock.calls.at(-3)![2].input).toContain('found source');
    expect(sink.tool.mock.calls.at(-2)).toEqual(['patch', '修改文件', { status: 'running', append: true, output: 'applying' }]);
    expect(sink.tool.mock.calls.at(-1)![2].status).toBe('succeeded');
  });
  it('reports unsuccessful turns even if Codex omits an error object', () => {
    state.rpc.onEvent({ method: 'turn/completed', params: { turn: { status: 'failed', error: null } } });
    expect(sink.done).toHaveBeenLastCalledWith('Codex 本轮运行失败');
    state.rpc.onEvent({ method: 'turn/completed', params: { turn: { status: 'interrupted', error: null } } });
    expect(sink.done).toHaveBeenLastCalledWith(undefined, true);
  });
  it('forwards tool arguments, streaming output, completion errors and reasoning summaries', () => {
    state.rpc.onEvent({ method: 'item/started', params: { item: { id: 'cmd', type: 'commandExecution', command: 'python search.py' } } });
    state.rpc.onEvent({ method: 'item/commandExecution/outputDelta', params: { itemId: 'cmd', delta: 'connecting' } });
    state.rpc.onEvent({ method: 'item/completed', params: { item: { id: 'cmd', type: 'commandExecution', command: 'python search.py', exitCode: 1, aggregatedOutput: 'timeout' } } });
    expect(sink.tool.mock.calls).toEqual([
      ['cmd', '执行命令', { status: 'running', input: 'python search.py' }],
      ['cmd', '执行命令', { status: 'running', output: 'connecting', append: true }],
      ['cmd', '执行命令', { status: 'failed', input: 'python search.py', output: 'timeout', exitCode: 1 }],
    ]);
    state.rpc.onEvent({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r', delta: 'Checking sources' } });
    state.rpc.onEvent({ method: 'item/completed', params: { item: { id: 'r', type: 'reasoning' } } });
    expect(sink.reasoning.mock.calls).toEqual([['r', 'Checking sources'], ['r', '', true]]);
  });
  it('uses full access for both new and resumed threads without converting questions into approval', async () => {
    backend = await CodexBackend.open({ codexPath: process.execPath, accessMode: 'full' } as PrivateSettings, { token: 'private' } as StoredSession, '.', 'http://localhost/mcp', '', sink);
    await backend.prompt('first', 'model', ''); await backend.prompt('second', 'model', '');
    for (const method of ['thread/start', 'thread/resume']) expect(state.rpc.request).toHaveBeenCalledWith(expect.objectContaining({ method, params: expect.objectContaining({ sandbox: 'danger-full-access', approvalPolicy: 'never' }) }));
    state.rpc.onEvent({ id: 1, method: 'mcpServer/elicitation/request', params: { mode: 'form', requestedSchema: { properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call' } } });
    state.rpc.onEvent({ id: 2, method: 'item/commandExecution/requestApproval', params: { command: 'test' } });
    expect(state.rpc.send).toHaveBeenCalledWith({ id: 1, result: { action: 'accept', content: {} } });
    expect(state.rpc.send).toHaveBeenCalledWith({ id: 2, result: { decision: 'accept' } });
    expect(sink.question).not.toHaveBeenCalled();
    state.rpc.onEvent({ id: 3, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', question: 'Which images?' }] } });
    expect(sink.question).toHaveBeenCalledWith(expect.objectContaining({ kind: 'input', title: 'Which images?' }));
    state.rpc.onEvent({ id: 4, method: 'mcpServer/elicitation/request', params: { mode: 'form', requestedSchema: { properties: {} }, message: 'Unclassified confirmation' } });
    expect(sink.question).toHaveBeenCalledWith(expect.objectContaining({ id: '4' }));
  });
  it('creates a native thread once, then resumes only that thread', async () => {
    await backend.prompt('first', 'model', 'low'); await backend.prompt('next', 'model', 'medium');
    expect(state.rpc.request.mock.calls.filter(([m]: any) => m.method === 'thread/start')).toHaveLength(1);
    for (const method of ['thread/start', 'thread/resume']) expect(state.rpc.request).toHaveBeenCalledWith(expect.objectContaining({ method, params: expect.objectContaining({ sandbox: 'workspace-write', approvalPolicy: 'on-request' }) }));
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
  it('turns on live web search only with full access', async () => {
    expect(state.args[1].join(' ')).not.toContain('web_search');
    await CodexBackend.open({ codexPath: process.execPath, accessMode: 'full' } as PrivateSettings, { token: 'private' } as StoredSession, '.', 'http://localhost/mcp', '', sink);
    expect(state.args[1]).toContain('web_search="live"');
  });
});

it('Pi forwards streamed thinking and the full tool lifecycle without duplicating final text', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'emaki-pi-events-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', path.join(cwd, 'empty-config'));
  try {
    const pi = await PiBackend.open({ pi: {}, accessMode: 'full' } as PrivateSettings, { token: 'private' } as StoredSession, cwd, 'http://localhost/mcp', 'Instructions', [], sink);
    state.rpc.onEvent({ type: 'message_start', message: { role: 'assistant' } });
    state.rpc.onEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Compare source images' } });
    state.rpc.onEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'Compare source images' } });
    state.rpc.onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Searching' } });
    state.rpc.onEvent({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'bash', args: { command: 'python search.py' } });
    state.rpc.onEvent({ type: 'tool_execution_update', toolCallId: 'call', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'uploading' }] } });
    state.rpc.onEvent({ type: 'tool_execution_end', toolCallId: 'call', toolName: 'bash', result: { content: [{ type: 'text', text: 'timeout' }] }, isError: true });
    expect(sink.reasoning.mock.calls[0]![1]).toBe('Compare source images');
    expect(sink.reasoning.mock.calls[1]).toEqual([sink.reasoning.mock.calls[0]![0], '', true]);
    expect(sink.text).toHaveBeenCalledTimes(1);
    expect(sink.tool.mock.calls.map(c => c[2].status)).toEqual(['running', 'running', 'failed']);
    expect(sink.tool.mock.calls[0]![2].input).toContain('python search.py');
    expect(sink.tool.mock.calls[1]![2].output).toContain('uploading');
    expect(sink.tool.mock.calls[2]![2].output).toContain('timeout');
    await pi.close();
  } finally { vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); }
});

it('Pi waits for prompt preflight without a client timeout but keeps it for control requests', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'emaki-pi-prompt-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', path.join(cwd, 'empty-config'));
  try {
    const pi = await PiBackend.open({ pi: {}, accessMode: 'ask' } as PrivateSettings, { token: 'private' } as StoredSession, cwd, 'http://localhost/mcp', '', [], sink);
    await pi.prompt('hello', 'emaki/model', 'high');
    expect(state.rpc.request).toHaveBeenCalledWith({ type: 'prompt', message: 'hello' }, 0);
    for (const type of ['set_model', 'set_thinking_level', 'get_state']) expect(state.rpc.request.mock.calls.find(([m]: any) => m.type === type)).toHaveLength(1);
  } finally { vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); }
});

describe('Pi file access gate', () => {
  // 目录结构与 service.ts 一致：<数据目录>/assistant/workspaces/<会话>，喜好分析输出在 <数据目录>/profile/assistant
  async function setup(accessMode: 'ask' | 'full') {
    const root = mkdtempSync(path.join(tmpdir(), 'emaki-pi-gate-'));
    const assistant = path.join(root, 'assistant'), cwd = path.join(assistant, 'workspaces', 'session'), profile = path.join(root, 'profile', 'assistant');
    const skill = path.join(cwd, '.agents/skills/emaki-library/SKILL.md');
    for (const dir of [path.dirname(skill), path.join(assistant, 'workspaces', 'other'), profile]) mkdirSync(dir, { recursive: true });
    for (const file of [skill, path.join(cwd, 'notes.md'), path.join(assistant, 'settings.json'), path.join(assistant, 'workspaces', 'other', 'notes.md'), path.join(profile, 'data.json'), path.join(root, 'outside.txt')]) writeFileSync(file, 'x');
    vi.stubEnv('PI_CODING_AGENT_DIR', path.join(root, 'empty-config'));
    await PiBackend.open({ pi: {}, accessMode } as PrivateSettings, { token: 'private' } as StoredSession, cwd, 'http://localhost/mcp', '', [skill], sink, { readable: [profile], hidden: [assistant] });
    vi.unstubAllEnvs();
    const gate = await import(pathToFileURL(path.join(cwd, 'permissions.ts')).href);
    let handler!: (event: any, ctx: any) => Promise<any>;
    gate.default({ on: (_: string, fn: typeof handler) => { handler = fn; } });
    const confirm = vi.fn(async (_title: string, _body: string) => false);
    const call = (toolName: string, input: any) => handler({ toolName, input }, { cwd, ui: { confirm } });
    return { root, assistant, cwd, profile, skill, confirm, call };
  }
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('reads the session, skills and profile output freely, never assistant settings or other sessions, and asks for the rest', async () => {
    const { root, assistant, cwd, profile, skill, confirm, call } = await setup('ask'); roots.push(root);
    for (const file of ['notes.md', '@notes.md', 'sub/../notes.md', path.join(cwd, 'notes.md'), skill, path.join(profile, 'data.json')]) expect(await call('read', { path: file })).toBeUndefined();
    expect(await call('ls', {})).toBeUndefined();
    expect(await call('emaki_query', { sql: 'select 1' })).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    const settings = path.join(assistant, 'settings.json');
    for (const file of ['../../settings.json', settings, pathToFileURL(settings).href, 'pi-config/auth.json', '../other/notes.md']) {
      expect(await call('read', { path: file })).toEqual({ block: true, reason: expect.stringContaining('不对 agent 开放') });
    }
    expect(await call('grep', { pattern: 'apiKey', path: '..' })).toMatchObject({ block: true });
    // 改文件同样不能碰助手配置和 pi-config
    expect(await call('write', { path: '../../settings.json', content: '{"accessMode":"full"}' })).toEqual({ block: true, reason: expect.stringContaining('不对 agent 开放') });
    expect(await call('edit', { path: 'pi-config/auth.json' })).toEqual({ block: true, reason: expect.stringContaining('不对 agent 开放') });
    expect(confirm).not.toHaveBeenCalled();
    expect(await call('read', { path: path.join(root, 'outside.txt') })).toEqual({ block: true, reason: '用户未批准此操作' });
    expect(await call('read', { path: '~/.ssh/id_rsa' })).toMatchObject({ block: true });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0]![0]).toContain('读取');
    confirm.mockResolvedValueOnce(true);
    expect(await call('read', { path: path.join(root, 'outside.txt') })).toBeUndefined();
    await call('bash', { command: 'dir' });
    expect(confirm).toHaveBeenLastCalledWith('允许执行 bash？', expect.stringContaining('dir'));
    // 会话目录里写文件照常确认
    await call('write', { path: 'notes.md', content: 'y' });
    expect(confirm).toHaveBeenLastCalledWith('允许执行 write？', expect.stringContaining('notes.md'));
    if (process.platform === 'win32') {
      expect(await call('read', { path: path.join(cwd, 'notes.md').toUpperCase() })).toBeUndefined();
      // Git Bash 写法 /c/... 同样认得出来
      const gitBash = `/${settings[0]!.toLowerCase()}${settings.slice(2).replaceAll('\\', '/')}`;
      expect(await call('read', { path: gitBash })).toMatchObject({ block: true, reason: expect.stringContaining('不对 agent 开放') });
      // 设备路径、本机 UNC、管理共享不能绕过拦截，也不弹确认
      const auth = path.join(cwd, 'pi-config', 'auth.json'), other = path.join(assistant, 'workspaces', 'other', 'notes.md');
      const asked = confirm.mock.calls.length;
      for (const file of ['//?/' + settings.replaceAll('\\', '/'), '\\\\?\\' + settings, '\\\\.\\' + auth, `\\\\${hostname()}\\${other[0]}$\\${other.slice(3)}`,
        `\\\\localhost\\${other[0]}$\\${other.slice(3)}`, `\\\\?\\UNC\\127.0.0.1\\${other[0]}$\\${other.slice(3)}`, '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x']) {
        expect(await call('read', { path: file })).toEqual({ block: true, reason: expect.stringContaining('不对 agent 开放') });
      }
      expect(await call('write', { path: '\\\\.\\' + settings, content: '{}' })).toMatchObject({ block: true, reason: expect.stringContaining('不对 agent 开放') });
      expect(confirm).toHaveBeenCalledTimes(asked);
      // 设备路径写法的会话文件仍然放行，远程网络路径照常确认
      expect(await call('read', { path: '\\\\?\\' + path.join(cwd, 'notes.md') })).toBeUndefined();
      expect(await call('read', { path: '\\\\nas\\share\\x' })).toEqual({ block: true, reason: '用户未批准此操作' });
      expect(confirm).toHaveBeenCalledTimes(asked + 1);
    }
  });
  it('does not ask anything with full access', async () => {
    const { root, assistant, confirm, call } = await setup('full'); roots.push(root);
    expect(await call('read', { path: path.join(root, 'outside.txt') })).toBeUndefined();
    expect(await call('read', { path: path.join(assistant, 'settings.json') })).toBeUndefined();
    expect(await call('bash', { command: 'dir' })).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });
});
