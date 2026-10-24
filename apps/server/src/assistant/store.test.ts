import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantStore } from './store.ts';
import { AssistantService } from './service.ts';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), 'emaki-store-test-')); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const files = (dir: string) => Object.fromEntries((readdirSync(dir, { recursive: true }) as string[])
  .filter(f => statSync(path.join(dir, f)).isFile()).map(f => [f, readFileSync(path.join(dir, f), 'utf8')]));
const session = (id: string, status: string) => ({ id, title: 't', backend: 'codex', model: '', effort: '', status, token: 'x', requestIds: [], questions: [],
  messages: [{ id: 'u', role: 'user', text: 'hi' }], updatedAt: '2026-01-01T00:00:00.000Z' });

describe('AssistantStore startup', () => {
  it('does not create or write anything on boot while the assistant is off', () => {
    const dir = path.join(temp(), 'assistant');
    const store = new AssistantStore(dir);
    expect(store.publicSettings().enabled).toBe(false);
    expect(existsSync(dir)).toBe(false);
    // 开启时第一次保存才落盘，目录按需创建
    store.settings.enabled = true; store.settings.backend = 'codex'; store.saveSettings();
    expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')).externalToken).toBe(store.settings.externalToken);
    const created = store.create();
    expect(existsSync(path.join(dir, 'sessions', `${created.id}.json`))).toBe(true);
  });

  it('starts with broken or missing state files instead of failing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = temp(), good = randomUUID(), missing = randomUUID(), broken = randomUUID();
    mkdirSync(path.join(dir, 'sessions'));
    writeFileSync(path.join(dir, 'settings.json'), '{"enabled":false,"apiKey":"sk-keep');
    writeFileSync(path.join(dir, 'index.json'), JSON.stringify([missing, broken, good]));
    writeFileSync(path.join(dir, 'sessions', `${broken}.json`), '{');
    writeFileSync(path.join(dir, 'sessions', `${good}.json`), JSON.stringify(session(good, 'running')));
    const before = files(dir);
    const store = new AssistantStore(dir);
    expect(store.publicSettings().enabled).toBe(false);
    expect([...store.sessions.keys()]).toEqual([good]);
    expect(store.get(good).status).toBe('idle');
    expect(warn).toHaveBeenCalled();
    // 关着时启动不改任何文件
    expect(files(dir)).toEqual(before);
    // 坏掉的 settings.json 在第一次保存前另存一份
    store.saveSettings();
    expect(readFileSync(path.join(dir, 'settings.json.bad'), 'utf8')).toContain('sk-keep');
    expect(new AssistantStore(dir).settings.externalToken).toBe(store.settings.externalToken);
  });

  it('builds the service when settings and the operation ledger are both corrupt', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = temp();
    writeFileSync(path.join(dir, 'settings.json'), '');
    writeFileSync(path.join(dir, 'operations.json'), '{');
    const service = new AssistantService(dir, '.', () => 'http://localhost/api/assistant/mcp');
    expect(service.store.publicSettings().enabled).toBe(false);
  });

  it('persists the restart fix-up when the assistant is on', () => {
    const dir = temp(), id = randomUUID();
    mkdirSync(path.join(dir, 'sessions'));
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ enabled: true }));
    writeFileSync(path.join(dir, 'index.json'), JSON.stringify([id]));
    writeFileSync(path.join(dir, 'sessions', `${id}.json`), JSON.stringify(session(id, 'running')));
    new AssistantStore(dir);
    expect(JSON.parse(readFileSync(path.join(dir, 'sessions', `${id}.json`), 'utf8')).status).toBe('idle');
  });
});

describe('AssistantStore remove', () => {
  it('drops the session from index, memory and disk, and never writes it back', () => {
    const dir = temp(), store = new AssistantStore(dir);
    store.settings.enabled = true; store.settings.backend = 'codex';
    const gone = store.create(), kept = store.create();
    expect(store.remove(gone.id)).toBe(true);
    expect(store.remove(gone.id)).toBe(false);
    expect(existsSync(path.join(dir, 'sessions', `${gone.id}.json`))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'))).toEqual([kept.id]);
    expect(() => store.get(gone.id)).toThrow('找不到');
    // 进程晚到的事件会再存一次：不能把文件建回来
    store.save(gone);
    expect(existsSync(path.join(dir, 'sessions', `${gone.id}.json`))).toBe(false);
    expect([...new AssistantStore(dir).sessions.keys()]).toEqual([kept.id]);
  });
});
