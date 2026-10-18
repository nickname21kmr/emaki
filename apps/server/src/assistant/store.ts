import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AssistantSession, AssistantSettings } from '@emaki/shared';
import { NotFoundError } from '../http/errors.ts';

export interface StoredSession extends AssistantSession {
  nativeId?: string;
  token: string;
  requestIds: string[];
}
export interface PrivateSettings extends AssistantSettings { apiKey: string; externalToken: string }
const defaults = (): PrivateSettings => ({ enabled: false, backend: null, codexPath: '', apiKey: '', externalToken: randomBytes(32).toString('hex'),
  pi: { provider: '', baseUrl: '', model: '', api: 'openai-completions', apiKeyConfigured: false, vision: true, reasoning: false } });

/** Kept outside the library DB, so SQL tools never expose credentials or unrelated chats. */
export class AssistantStore {
  settings: PrivateSettings;
  readonly sessions = new Map<string, StoredSession>();
  constructor(readonly dir: string) {
    mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    this.settings = existsSync(path.join(dir, 'settings.json')) ? this.read('settings.json') : defaults();
    this.settings.pi = { ...defaults().pi, ...this.settings.pi };
    // Only our index is authoritative. Never discover harness sessions from their global stores.
    const ids: string[] = existsSync(path.join(dir, 'index.json')) ? this.read('index.json') : [];
    for (const id of ids) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const s: StoredSession = this.read(`sessions/${id}.json`);
      if (s.status === 'running' || s.status === 'waiting') {
        s.status = 'idle'; s.questions = [];
        s.messages.push({ id: randomUUID(), role: 'system', text: '服务已重启，上次运行已停止；不会自动重复执行。' });
      }
      this.sessions.set(id, s);
    }
    this.saveSettings();
  }
  private read(file: string) { return JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')); }
  private write(file: string, value: unknown) {
    const target = path.join(this.dir, file), temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, target);
  }
  saveSettings() { this.write('settings.json', this.settings); }
  publicSettings(): AssistantSettings {
    const { apiKey: _key, externalToken: _token, ...settings } = this.settings;
    return { ...settings, pi: { ...settings.pi, apiKeyConfigured: Boolean(this.settings.apiKey) } };
  }
  create(): StoredSession {
    if (!this.settings.backend) throw new Error('请先在设置中选择助手后端');
    const session: StoredSession = { id: randomUUID(), title: '新对话', backend: this.settings.backend, model: '', effort: '', status: 'idle',
      messages: [], questions: [], updatedAt: new Date().toISOString(), token: randomBytes(32).toString('hex'), requestIds: [] };
    this.sessions.set(session.id, session); this.save(session);
    this.write('index.json', [...this.sessions.keys()]);
    return session;
  }
  get(id: string) { const s = this.sessions.get(id); if (!s) throw new NotFoundError('Emaki 会话'); return s; }
  publicSession(s: StoredSession): AssistantSession { const { nativeId: _id, token: _token, requestIds: _requests, ...view } = s; return view; }
  save(s: StoredSession) { s.updatedAt = new Date().toISOString(); this.write(`sessions/${s.id}.json`, s); }
}
