import { mkdtempSync, rmSync } from 'node:fs';
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
    const s = setup(); s.store.settings.backend = 'codex';
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
  it('does not replay an uncertain mutation after an interruption', async () => {
    const s = setup(); s.store.settings.enabled = true; s.store.saveSettings();
    await expect(s.operation('scope', 'op', 'body', async () => { throw new Error('connection lost after write'); })).rejects.toThrow();
    const restored = new AssistantService(s.dir, '', () => '');
    const run = vi.fn(); await expect(restored.operation('scope', 'op', 'body', run)).rejects.toThrow('待核对'); expect(run).not.toHaveBeenCalled();
  });
});
