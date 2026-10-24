import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrivateSettings, StoredSession } from './store.ts';
const state = vi.hoisted(() => ({ rpc: null as any, config: [] as any[], promptResolve: null as any }));
vi.mock('../net/proxy.ts', () => ({ resolveProxy: vi.fn(async () => ({ url: 'http://127.0.0.1:7897', source: 'system' })) }));
vi.mock('./rpc.ts', () => ({ JsonProcess: class {
  onEvent = (_: any) => {}; onExit = (_: any) => {};
  send = vi.fn(); close = vi.fn(async () => {});
  request = vi.fn(async (m: any) => {
    if (m.method === 'session/new' || m.method === 'session/resume') return { sessionId: 'owned', configOptions: structuredClone(state.config) };
    if (m.method === 'session/set_config_option') {
      const option = state.config.find(o => o.id === m.params.configId); option.currentValue = m.params.value;
      if (option.id === 'model') state.config[1].currentValue = 'high';
      return { configOptions: structuredClone(state.config) };
    }
    if (m.method === 'session/prompt') return new Promise(resolve => { state.promptResolve = resolve; });
    return {};
  });
  constructor() { state.rpc = this; }
} }));
import { DshBackend, findDsh, dshProxyEnvironment } from './dsh.ts';
let cwd: string, backend: DshBackend, session: StoredSession;
const sink = { text: vi.fn(), reasoning: vi.fn(), tool: vi.fn(), question: vi.fn(), done: vi.fn() };
beforeEach(async () => {
  vi.clearAllMocks(); cwd = mkdtempSync(path.join(tmpdir(), 'emaki-dsh-unit-'));
  const cli = path.join(cwd, 'bin.js'); writeFileSync(cli, '');
  vi.stubEnv('DSH_HOME', path.join(cwd, 'user-home'));
  state.config = [{ id: 'model', currentValue: 'a', options: [{ name: 'Provider', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }] }, { id: 'reasoning_effort', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }];
  session = { token: 'session-secret' } as StoredSession;
  backend = await DshBackend.open({ dshPath: cli, accessMode: 'ask' } as PrivateSettings, session, cwd, 'http://localhost/mcp', 'Canonical skill instructions', sink);
});
afterEach(async () => { await backend.close(); vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); });

describe('DSH ACP adapter', () => {
  it('inherits system proxy with loopback bypass without mutating parent environment', async () => {
    const parent = { NO_PROXY: 'example.test' };
    const env = await dshProxyEnvironment(cwd, parent);
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7897');
    expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY);
    expect(env.NO_PROXY).toBe('example.test,localhost,127.0.0.1,::1');
    expect(parent).toEqual({ NO_PROXY: 'example.test' });
  });
  it('preserves explicit proxy routing and reads only proxy values from the original DSH home', async () => {
    writeFileSync(path.join(cwd, '.env'), 'HTTPS_PROXY=http://proxy.test:8080\nNO_PROXY=custom.test\nSECRET=not-imported\n');
    const local = await dshProxyEnvironment(cwd, {});
    expect(local.HTTPS_PROXY).toBe('http://proxy.test:8080');
    expect(local.HTTP_PROXY).toBeUndefined(); expect(local.SECRET).toBeUndefined();
    expect(local.NO_PROXY).toContain('custom.test');
    const explicit = await dshProxyEnvironment(cwd, { https_proxy: 'http://explicit.test:8081', no_proxy: '*' });
    expect(explicit.https_proxy).toBe('http://explicit.test:8081');
    expect(explicit.HTTPS_PROXY).toBeUndefined();
    expect(explicit.no_proxy).toContain('*');
  });
  it('creates only an owned session and passes its scoped MCP credentials', () => {
    expect(session.nativeId).toBe('owned');
    expect(state.rpc.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'session/new', params: expect.objectContaining({ cwd, mcpServers: [{ type: 'http', name: 'emaki', url: 'http://localhost/mcp', headers: [{ name: 'Authorization', value: 'Bearer session-secret' }] }] }) }), 60000);
    expect(state.rpc.request.mock.calls.some(([m]: any) => m.method === 'session/list')).toBe(false);
    const overlay = JSON.parse(readFileSync(path.join(cwd, 'dsh.patch.json'), 'utf8'));
    expect(overlay.find((p: any) => p.id === 'system-prompt').config.personaPrefix).toBe('Canonical skill instructions');
    expect(readFileSync(path.join(cwd, 'dsh-integration.mjs'), 'utf8')).toContain('permissionPresets.set');
  });
  it('reads exact reasoning and vision metadata and restores the original selection', async () => {
    writeFileSync(path.join(cwd, 'dsh-models.json'), JSON.stringify({ a: { vision: true }, b: { vision: false } }));
    const models = await backend.models();
    expect(models.map(m => [m.id, m.vision, m.efforts])).toEqual([['a', true, ['low', 'high']], ['b', false, ['low', 'high']]]);
    expect(state.config[0].currentValue).toBe('a'); expect(state.config[1].currentValue).toBe('low');
    expect(await backend.checkAccount()).toBe(true);
  });
  it('does not treat a fallback route or partial metadata as a signed-in model catalog', async () => {
    writeFileSync(path.join(cwd, 'dsh-models.json'), '{');
    expect((await backend.models()).every(model => !model.vision)).toBe(true);
    expect(await backend.checkAccount()).toBe(false);
  });
  it('returns after prompt acceptance, has no generation timeout, and settles on completion', async () => {
    await backend.prompt('read library', 'a', 'low');
    expect(state.rpc.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'session/prompt' }), 0);
    expect(sink.done).not.toHaveBeenCalled();
    state.promptResolve({ stopReason: 'end_turn' }); await new Promise(resolve => setTimeout(resolve, 0));
    expect(sink.done).toHaveBeenCalledWith(undefined, false);
  });
  it('separates committed messages, thoughts and tool lifecycle with stable unique IDs', async () => {
    await backend.prompt('test', 'a', 'low');
    const event = (update: any, sessionId = 'owned') => state.rpc.onEvent({ method: 'session/update', params: { sessionId, update } });
    event({ sessionUpdate: 'agent_message_chunk', messageId: 'same', content: { type: 'text', text: 'unrelated' } }, 'another');
    event({ sessionUpdate: 'agent_thought_chunk', messageId: 'same', content: { type: 'text', text: 'inspect first' } });
    event({ sessionUpdate: 'agent_message_chunk', messageId: 'same', content: { type: 'text', text: 'result' } });
    event({ sessionUpdate: 'tool_call', toolCallId: 'call', title: 'query_database', status: 'in_progress', rawInput: { sql: 'SELECT id FROM images' } });
    event({ sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'SQL error' } }] });
    expect(sink.text).toHaveBeenCalledTimes(1); expect(sink.text.mock.calls[0]![1]).toBe('result');
    expect(sink.reasoning.mock.calls[0]![1]).toBe('inspect first');
    expect(sink.reasoning.mock.calls[0]![0]).not.toBe(sink.text.mock.calls[0]![0]);
    expect(sink.tool.mock.calls.map(c => c[2].status)).toEqual(['running', 'failed']);
    expect(sink.tool.mock.calls[1]![2].output).toContain('SQL error');
    const firstId = sink.text.mock.calls[0]![0];
    state.promptResolve({ stopReason: 'end_turn' }); await new Promise(resolve => setTimeout(resolve, 0));
    await backend.prompt('next', 'a', 'low'); event({ sessionUpdate: 'agent_message_chunk', messageId: 'same', content: { type: 'text', text: 'next' } });
    expect(sink.text.mock.calls[1]![0]).not.toBe(firstId);
    state.promptResolve({ stopReason: 'end_turn' });
  });
  it('completes reasoning as soon as the answer starts streaming', async () => {
    await backend.prompt('test', 'a', 'low');
    const event = (update: any) => state.rpc.onEvent({ method: 'session/update', params: { sessionId: 'owned', update } });
    event({ sessionUpdate: 'agent_thought_chunk', messageId: 'm', content: { type: 'text', text: 'thinking' } });
    expect(sink.reasoning).toHaveBeenCalledTimes(1);
    event({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'answer' } });
    expect(sink.reasoning).toHaveBeenLastCalledWith(sink.reasoning.mock.calls[0]![0], '', true);
    expect(sink.reasoning.mock.invocationCallOrder[1]!).toBeLessThan(sink.text.mock.invocationCallOrder[0]!);
    expect(sink.done).not.toHaveBeenCalled();
    state.promptResolve({ stopReason: 'end_turn' }); await new Promise(resolve => setTimeout(resolve, 0));
    expect(sink.reasoning).toHaveBeenCalledTimes(2);
  });
  it('requests approval using tool input and returns one-shot selected or cancelled outcomes', () => {
    state.rpc.onEvent({ method: 'session/update', params: { sessionId: 'owned', update: { sessionUpdate: 'tool_call', toolCallId: 'call', title: 'pwsh', rawInput: { command: 'write outside workspace' } } } });
    const permission = { sessionId: 'owned', toolCall: { toolCallId: 'call' }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] };
    state.rpc.onEvent({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: permission });
    expect(sink.question).toHaveBeenCalledWith(expect.objectContaining({ id: '7', kind: 'approval', title: expect.stringContaining('write outside workspace') }));
    backend.answer('7', 'approve');
    expect(state.rpc.send).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'selected', optionId: 'yes' } } });
  });
  it('uses only the indexed owned native ID for resume and skips MCP on detection', async () => {
    await backend.close();
    const cli = path.join(cwd, 'bin.js');
    backend = await DshBackend.open({ dshPath: cli, accessMode: 'full' } as PrivateSettings, { nativeId: 'owned', token: '' } as StoredSession, cwd, 'http://localhost/mcp', '', sink);
    expect(state.rpc.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'session/resume', params: expect.objectContaining({ sessionId: 'owned', mcpServers: [] }) }), 60000);
    state.rpc.onEvent({ id: 9, method: 'session/request_permission', params: { sessionId: 'owned', options: [{ optionId: 'allow', kind: 'allow_once' }] } });
    expect(sink.question).not.toHaveBeenCalled();
    expect(state.rpc.send).toHaveBeenCalledWith(expect.objectContaining({ id: 9, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }));
    expect(readFileSync(path.join(cwd, 'dsh-integration.mjs'), 'utf8')).toContain('danger-full-access');
  });
  it('cancels the owned prompt and closes that session without listing any others', async () => {
    await backend.prompt('test', 'a', 'low');
    const stopping = backend.stop(); state.promptResolve({ stopReason: 'cancelled' }); await stopping;
    expect(state.rpc.send).toHaveBeenCalledWith({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'owned' } });
    expect(sink.done).toHaveBeenCalledWith(undefined, true);
    await backend.close(); expect(state.rpc.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'session/close', params: { sessionId: 'owned' } }), 5000);
  });
  it('resolves the official Electron carrier without traversing the asar archive', () => {
    const install = path.join(cwd, 'official'); const bin = path.join(install, 'resources/runtime/cli/bin'); mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, 'dsh.cmd'); writeFileSync(shim, ''); writeFileSync(path.join(install, 'resources/app.asar'), ''); writeFileSync(path.join(install, 'DeepSeek Harness.exe'), '');
    const found = findDsh(shim)!; expect(found.command).toBe(path.join(install, 'DeepSeek Harness.exe'));
    expect(found.args).toEqual(['--expose-internals', path.join(install, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')]);
    expect(findDsh(path.join(install, 'DeepSeek Harness.exe'))?.args).toEqual(found.args);
  });
});
