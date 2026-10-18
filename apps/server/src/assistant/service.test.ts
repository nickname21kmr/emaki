import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantService } from './service.ts';
import { AssistantStore } from './store.ts';
const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'emaki-session-test-')); dirs.push(dir);
  return new AssistantService(dir, '', () => 'http://localhost/api/assistant/mcp');
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('assistant ownership and replay', () => {
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
    const restored = new AssistantStore(s.dir).get(session.id);
    expect(restored.status).toBe('idle'); expect(restored.nativeId).toBe('private-native');
    expect(s.store.publicSession(session)).not.toHaveProperty('nativeId');
    expect(s.store.publicSession(session)).not.toHaveProperty('token');
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
