import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantService } from './service.ts';
import { AssistantStore } from './store.ts';
import { CodexBackend, type AgentSink } from './backends.ts';
const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'emaki-session-test-')); dirs.push(dir);
  return new AssistantService(dir, path.resolve(import.meta.dirname, '../../../..'), () => 'http://localhost/api/assistant/mcp');
}
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('assistant ownership and replay', () => {
  it('does not launch a cancelled prompt when its model lookup finishes late', async () => {
    const s = setup(); s.store.settings.backend = 'codex'; s.store.settings.enabled = true;
    const session = s.store.create();
    let finishModels!: () => void;
    const pendingModels = new Promise<void>(resolve => { finishModels = resolve; });
    const models = vi.fn(async () => { await pendingModels; return [{ id: 'fixture', efforts: [], vision: true }]; });
    const oldPrompt = vi.fn(async () => {}), newPrompt = vi.fn(async () => {});
    vi.spyOn(CodexBackend, 'open')
      .mockResolvedValueOnce({ models, prompt: oldPrompt, close: async () => {}, stop: async () => {} } as unknown as CodexBackend)
      .mockResolvedValueOnce({ models, prompt: newPrompt, close: async () => {}, stop: async () => {} } as unknown as CodexBackend);
    const input = { requestId: 'first', text: 'Search', model: 'fixture', effort: '', context: { page: '/', imageIds: [] } };
    await s.send(session.id, input);
    await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(1));
    await s.stop(session.id);
    await s.send(session.id, { ...input, requestId: 'next' });
    finishModels();
    await vi.waitFor(() => expect(newPrompt).toHaveBeenCalledTimes(1));
    expect(oldPrompt).not.toHaveBeenCalled();
    await s.close();
  });
  it('waits for stop before continuing and ignores events from the old connection', async () => {
    const s = setup(); s.store.settings.backend = 'codex'; s.store.settings.enabled = true;
    const session = s.store.create(), sinks: AgentSink[] = [];
    let finishStop!: () => void;
    const pendingStop = new Promise<void>(resolve => { finishStop = resolve; });
    const prompt = vi.fn(async () => {}), stop = vi.fn(() => pendingStop), close = vi.fn(async () => {});
    const open = vi.spyOn(CodexBackend, 'open').mockImplementation(async (_a, _b, _c, _d, _e, sink) => {
      sinks.push(sink);
      return { models: async () => [{ id: 'fixture', efforts: [], vision: true }], prompt, stop, close } as unknown as CodexBackend;
    });
    const input = { requestId: 'first', text: 'Search', model: 'fixture', effort: '', context: { page: '/', imageIds: [] } };
    await s.send(session.id, input);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    const stopping = s.stop(session.id);
    expect(s.stop(session.id)).toBe(stopping);
    const continuing = s.send(session.id, { ...input, requestId: 'next' });
    await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(1);
    expect(session.messages.filter(m => m.role === 'user')).toHaveLength(1);
    finishStop(); await stopping; await continuing;
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    sinks[0]!.text('late', 'old reply');
    sinks[0]!.tool('late-tool', 'old tool', { status: 'running' });
    sinks[0]!.question({ id: 'late-question', title: 'old question', kind: 'input' });
    sinks[0]!.disconnected?.(); sinks[0]!.done('old process exit');
    expect(session.status).toBe('running');
    expect(session.questions).toHaveLength(0);
    expect(session.messages.some(m => m.id.startsWith('late'))).toBe(false);
    await s.models(session.id); expect(open).toHaveBeenCalledTimes(2);
    sinks[1]!.text('new', 'new reply'); sinks[1]!.done();
    expect(session.messages.at(-1)?.text).toBe('new reply');
    expect(stop).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
    await s.close();
  });
  it('cancels a starting connection before it can prompt and opens a fresh one on continue', async () => {
    const s = setup(); s.store.settings.backend = 'codex'; s.store.settings.enabled = true;
    const session = s.store.create();
    let finishOpen!: () => void;
    const pendingOpen = new Promise<void>(resolve => { finishOpen = resolve; });
    const prompt = vi.fn(async () => {}), close = vi.fn(async () => {});
    const open = vi.spyOn(CodexBackend, 'open').mockImplementation(async () => {
      await pendingOpen;
      return { models: async () => [{ id: 'fixture', efforts: [], vision: true }], prompt, close, stop: async () => {} } as unknown as CodexBackend;
    });
    const input = { requestId: 'first', text: 'Search', model: 'fixture', effort: '', context: { page: '/', imageIds: [] } };
    await s.send(session.id, input);
    const stopping = s.stop(session.id);
    const continuing = s.send(session.id, { ...input, requestId: 'next' });
    finishOpen(); await stopping; await continuing;
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(1);
    expect(session.status).toBe('running');
    await s.close();
  });
  it('updates one tool record, persists reasoning and marks pending activities interrupted on stop/restart', async () => {
    const s = setup(); s.store.settings.backend = 'codex'; s.store.settings.enabled = true;
    const session = s.store.create(); let sink!: AgentSink;
    vi.spyOn(CodexBackend, 'open').mockImplementation(async (_a, _b, _c, _d, _e, events) => {
      sink = events;
      return { models: async () => [{ id: 'fixture', efforts: [], vision: true }], prompt: async () => {}, stop: async () => {}, close: async () => {} } as unknown as CodexBackend;
    });
    await s.send(session.id, { requestId: 'request', text: 'Search', model: 'fixture', effort: '', context: { page: '/', imageIds: [] } });
    await vi.waitFor(() => expect(sink).toBeDefined());
    sink.tool('call', 'bash', { status: 'running', input: 'search' });
    sink.tool('call', 'bash', { status: 'running', output: `token=${session.token}` });
    expect(session.messages.find(m => m.id === 'call')!.tool!.output).not.toContain(session.token);
    sink.tool('call', 'bash', { status: 'succeeded', output: 'found source' });
    sink.tool('call', 'bash', { status: 'running', output: 'late delta', append: true });
    expect(session.messages.find(m => m.id === 'call')!.tool).toMatchObject({ status: 'succeeded', output: 'found source' });
    expect(session.messages.filter(m => m.id === 'call')).toHaveLength(1);
    sink.reasoning!('think', 'checking '); sink.reasoning!('think', 'sources', true);
    expect(session.messages.find(m => m.reasoning)?.reasoning).toMatchObject({ text: 'checking sources', status: 'completed' });
    sink.tool('pending', 'fetch', { status: 'running' }); s.flush(session);
    sink.tool('delta', 'MCP 工具', { status: 'running', output: 'first\n', append: true });
    sink.tool('delta', 'emaki · query', { status: 'running', output: 'second', append: true, progress: '查询完成' });
    sink.tool('delta', 'emaki · query', { status: 'succeeded', exitCode: 0, durationMs: 1200 });
    const delta = session.messages.find(m => m.id === 'delta')!;
    expect(delta.text).toBe('emaki · query');
    expect(delta.tool).toMatchObject({ output: 'first\nsecond', progress: '查询完成', exitCode: 0 });
    expect(delta.tool!.finishedAt! - delta.tool!.startedAt).toBe(1200);
    expect(new AssistantStore(s.dir).get(session.id).messages.find(m => m.id === 'pending')?.tool?.status).toBe('interrupted');
    await s.stop(session.id);
    sink.tool('pending', 'fetch', { status: 'succeeded', output: 'late completion' });
    expect(session.messages.find(m => m.id === 'pending')?.tool?.status).toBe('interrupted');
    expect(new AssistantStore(s.dir).get(session.id).messages.find(m => m.id === 'call')?.tool?.output).toBe('found source');
    await s.close();
  });
  it('migrates existing settings to ask and preserves an explicit full-access choice', () => {
    const s = setup();
    delete (s.store.settings as Partial<typeof s.store.settings>).accessMode;
    s.store.saveSettings();
    const migrated = new AssistantStore(s.dir);
    expect(migrated.settings.accessMode).toBe('ask');
    migrated.settings.accessMode = 'full'; migrated.saveSettings();
    expect(new AssistantStore(s.dir).publicSettings().accessMode).toBe('full');
  });
  it('defaults off and never accepts an arbitrary harness session ID', () => {
    const s = setup(); expect(s.store.publicSettings().enabled).toBe(false);
    expect(() => s.authorize(s.store.settings.externalToken)).toThrow('尚未开启');
    expect(() => s.store.get('another-codex-thread')).toThrow('Emaki 会话');
    expect(s.store.publicSettings()).not.toHaveProperty('externalToken');
    expect(s.store.publicSettings()).not.toHaveProperty('apiKey');
  });
  it('persists only owned sessions, clears stale runs on restart', () => {
    // 助手开着时重启修正才落盘（关着时启动不写文件）
    const s = setup(); s.store.settings.backend = 'codex'; s.store.settings.enabled = true; s.store.saveSettings();
    const session = s.store.create(); session.status = 'running'; session.nativeId = 'private-native'; s.flush(session);
    session.messages.push({ id: 'request', role: 'user', text: '修改选中图片', context: { page: '/unrecognized', imageIds: ['17329'] } }); s.flush(session);
    const restored = new AssistantStore(s.dir).get(session.id);
    expect(restored.status).toBe('idle'); expect(restored.nativeId).toBe('private-native');
    expect(restored.interruption).toEqual({ messageId: 'request', reason: 'restart' });
    expect(new AssistantStore(s.dir).get(session.id).messages).toEqual(restored.messages);
    expect(s.store.publicSession(session)).not.toHaveProperty('nativeId');
    expect(s.store.publicSession(session)).not.toHaveProperty('token');
  });
  it('makes legacy restart notices resumable without adding another notice', () => {
    const s = setup(); s.store.settings.backend = 'codex';
    const session = s.store.create();
    session.messages.push({ id: 'request', role: 'user', text: '关联角色', context: { page: '/unrecognized', imageIds: ['17329'] } },
      { id: 'notice', role: 'system', text: '服务已重启，上次运行已停止；不会自动重复执行。' });
    s.flush(session);
    const restored = new AssistantStore(s.dir).get(session.id);
    expect(restored.interruption?.messageId).toBe('request');
    expect(new AssistantStore(s.dir).get(session.id).messages).toHaveLength(2);
  });
  it('continues the original request once with its original image context and retained history', async () => {
    const s = setup(); s.store.settings.backend = 'codex'; s.store.settings.enabled = true;
    const session = s.store.create(); session.nativeId = 'owned-history';
    const context = { page: '/unrecognized', imageIds: ['17329'], selectionScope: 'unrecognized' };
    session.messages.push({ id: 'original', role: 'user', text: '关联森亜るるか', context });
    session.interruption = { messageId: 'original', reason: 'restart' }; s.flush(session);
    let sink!: AgentSink;
    const prompt = vi.fn(async (_text: string, _model: string, _effort: string) => {}), close = vi.fn(async () => {});
    vi.spyOn(CodexBackend, 'open').mockImplementation(async (_settings, stored, _cwd, _endpoint, _instructions, events) => {
      expect(stored.nativeId).toBe('owned-history'); sink = events;
      return { models: async () => [{ id: 'fixture', name: 'Fixture', efforts: [], vision: true }], prompt, close, stop: async () => {} } as unknown as CodexBackend;
    });
    const input = { requestId: 'resume', messageId: 'original', model: 'fixture', effort: '' };
    await Promise.all([s.resume(session.id, input), s.resume(session.id, input)]);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(prompt.mock.calls[0]![0]).toContain('关联森亜るるか');
    expect(s.context(session.id)).toEqual(context);
    expect(session.messages.filter(m => m.resumeOf)).toHaveLength(1);
    // A failed continuation still points to the original task rather than nesting "continue" requests.
    sink.done('connection lost');
    expect(session.interruption).toEqual({ messageId: 'original', reason: 'error' });
    await s.resume(session.id, { ...input, requestId: 'resume-again' });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    sink.done(); expect(session.interruption).toBeUndefined();
    await expect(s.resume(session.id, { ...input, requestId: 'stale-button' })).rejects.toThrow('状态已更新');
    await s.close();
  });
  it('deduplicates concurrent mutations and retains results after restart', async () => {
    const s = setup(); s.store.settings.enabled = true; s.store.saveSettings();
    const run = vi.fn(async () => ({ undoToken: 'once' }));
    const results = await Promise.all([s.operation('scope', 'op', 'body', run), s.operation('scope', 'op', 'body', run)]);
    expect(run).toHaveBeenCalledTimes(1); expect(results[0]).toEqual(results[1]);
    const restored = new AssistantService(s.dir, '', () => '');
    expect(await restored.operation('scope', 'op', 'body', run)).toEqual({ undoToken: 'once' });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(s.operation('scope', 'op', 'changed-body', run)).rejects.toThrow('不同操作');
  });
  it('retains app questions after completion and resumes once with the answer and original context', async () => {
    const s = setup(); s.store.settings.backend = 'codex'; s.store.settings.enabled = true;
    const session = s.store.create(), other = s.store.create();
    let sink!: AgentSink;
    const prompt = vi.fn(async () => {});
    vi.spyOn(CodexBackend, 'open').mockImplementation(async (_settings, _stored, _cwd, _endpoint, _instructions, events) => {
      sink = events;
      return { models: async () => [{ id: 'fixture', name: 'Fixture', efforts: [], vision: true }], prompt, close: async () => {}, stop: async () => {} } as unknown as CodexBackend;
    });
    const context = { page: '/unrecognized', imageIds: ['17329'] };
    await s.send(session.id, { requestId: 'identify', text: '这个角色是谁', model: 'fixture', effort: '', context });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    const question = s.askUser(session.id, '将 17329 关联到已确认的角色吗？', ['关联角色', '暂不关联']);
    expect(s.askUser(session.id, session.questions[0]!.title, session.questions[0]!.options)).toEqual(question);
      await expect(s.answer(other.id, question.questionId, '关联角色')).rejects.toThrow('这条提问已结束');
      await expect(s.answer(session.id, question.questionId, '关联角色')).rejects.toThrow('助手正在处理');
    sink.done();
    expect(session.questions).toHaveLength(1);
    expect(new AssistantStore(s.dir).get(session.id).questions).toEqual(session.questions);
    await Promise.all([s.answer(session.id, question.questionId, '关联角色，但保留现有来源'), s.answer(session.id, question.questionId, '关联角色，但保留现有来源')]);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(session.questions).toHaveLength(0);
    expect(session.messages.at(-1)).toMatchObject({ role: 'user', context, text: '关于「将 17329 关联到已确认的角色吗？」\n关联角色，但保留现有来源' });
    sink.done(); await s.close();
  });
  it('restores app questions after a server restart without requiring a live harness request', async () => {
    const s = setup(); s.store.settings.backend = 'codex'; s.store.settings.enabled = true; s.store.saveSettings();
    const session = s.store.create(); session.status = 'running'; session.model = 'fixture';
    session.messages.push({ id: 'identify', role: 'user', text: '认出角色', context: { page: '/gallery', imageIds: ['42'] } });
    const { questionId } = s.askUser(session.id, '关联角色吗？', ['关联角色', '暂不关联']);
    const restored = new AssistantService(s.dir, s.repoRoot, s.endpoint);
    expect(restored.store.get(session.id)).toMatchObject({ status: 'idle', questions: [{ id: questionId, source: 'emaki' }] });
    const prompt = vi.fn(async () => {});
    vi.spyOn(CodexBackend, 'open').mockResolvedValue({ models: async () => [{ id: 'fixture', name: 'Fixture', efforts: [], vision: true }], prompt, stop: async () => {}, close: async () => {} } as unknown as CodexBackend);
    await restored.answer(session.id, questionId, '暂不关联');
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(restored.store.get(session.id).messages.at(-1)?.text).toContain('暂不关联');
    await restored.close();
  });
  it('does not replay an uncertain mutation after an interruption', async () => {
    const s = setup(); s.store.settings.enabled = true; s.store.saveSettings();
    await expect(s.operation('scope', 'op', 'body', async () => { throw new Error('connection lost after write'); })).rejects.toThrow();
    const restored = new AssistantService(s.dir, '', () => '');
    const run = vi.fn(); await expect(restored.operation('scope', 'op', 'body', run)).rejects.toThrow('待核对'); expect(run).not.toHaveBeenCalled();
  });
});

describe('agent process lifecycle', () => {
  it('lists models through one cached temporary connection instead of a process per viewed session', async () => {
    const s = setup(); s.store.settings.backend = 'codex'; s.store.settings.enabled = true;
    const a = s.store.create(), b = s.store.create(); a.updatedAt = '2000-01-01T00:00:00.000Z';
    const close = vi.fn(async () => {});
    const open = vi.spyOn(CodexBackend, 'open').mockRejectedValueOnce(new Error('未找到 Codex')).mockImplementation(async (_settings, stored) => {
      expect([a.id, b.id]).not.toContain(stored.id); expect(stored.token).toBe('');
      return { models: async () => [{ id: 'fixture', efforts: [], vision: true }], prompt: async () => {}, stop: async () => {}, close } as unknown as CodexBackend;
    });
    await expect(s.models(a.id)).rejects.toThrow('未找到 Codex');
    expect(await s.models(a.id)).toEqual([{ id: 'fixture', efforts: [], vision: true }]);
    expect(await s.models(b.id)).toHaveLength(1);
    expect(open).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(1);
    expect(readdirSync(path.join(s.dir, 'workspaces'))).toEqual([]);
    expect(a.updatedAt).toBe('2000-01-01T00:00:00.000Z');
    // 改设置会走 close()，之后重新读取
    await s.close(); await s.models(b.id);
    expect(open).toHaveBeenCalledTimes(3); expect(close).toHaveBeenCalledTimes(2);
  });
  it('closes an idle agent after its turn and reopens it on the next message', async () => {
    const s = setup(); s.store.settings.backend = 'codex'; s.store.settings.enabled = true; s.idleMs = 20;
    const session = s.store.create(); let sink!: AgentSink;
    const prompt = vi.fn(async () => {}), close = vi.fn(async () => {});
    const open = vi.spyOn(CodexBackend, 'open').mockImplementation(async (_a, _b, _c, _d, _e, events) => {
      sink = events;
      return { models: async () => [{ id: 'fixture', efforts: [], vision: true }], prompt, stop: async () => {}, close } as unknown as CodexBackend;
    });
    const input = { requestId: 'first', text: 'Search', model: 'fixture', effort: '', context: { page: '/', imageIds: [] } };
    await s.send(session.id, input);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    sink.done();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await s.send(session.id, { ...input, requestId: 'next' });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(open).toHaveBeenCalledTimes(2);
    // 还在运行的不回收
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(close).toHaveBeenCalledTimes(1);
    await s.close();
  });
});
describe('agent approvals', () => {
  it('answering an approval leaves a line in the transcript', async () => {
    const s = setup(); s.store.settings.backend = 'codex'; s.store.settings.enabled = true;
    const session = s.store.create();
    let sink!: AgentSink;
    const prompt = vi.fn(async () => {}), answer = vi.fn();
    vi.spyOn(CodexBackend, 'open').mockImplementation(async (_a, _b, _c, _d, _e, next) => {
      sink = next;
      return { models: async () => [{ id: 'fixture', efforts: [], vision: true }], prompt, answer, stop: async () => {}, close: async () => {} } as unknown as CodexBackend;
    });
    await s.send(session.id, { requestId: 'first', text: '数一下文件', model: 'fixture', effort: '', context: { page: '/', imageIds: [] } });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    sink.question({ id: 'perm', title: 'pwsh\n{"command":"ls"}', kind: 'approval' });
    await s.answer(session.id, 'perm', 'deny');
    expect(answer).toHaveBeenCalledWith('perm', 'deny');
    const last = session.messages.at(-1)!;
    expect(last).toMatchObject({ role: 'tool', text: '已拒绝：pwsh' });
    expect(last.undoToken).toBeUndefined();
    await s.close();
  });
});
