import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AssistantSession, AssistantSettings } from '@emaki/shared';
import { NotFoundError } from '../http/errors.ts';
import { interruptActivities } from './activity.ts';

export interface StoredSession extends AssistantSession {
  nativeId?: string;
  token: string;
  requestIds: string[];
}
export interface PrivateSettings extends AssistantSettings { apiKey: string; externalToken: string }
const defaults = (): PrivateSettings => ({ enabled: false, accessMode: 'ask', backend: null, codexPath: '', apiKey: '', externalToken: randomBytes(32).toString('hex'),
  pi: { provider: '', baseUrl: '', model: '', api: 'openai-completions', apiKeyConfigured: false, vision: true, reasoning: false } });

/** Kept outside the library DB, so SQL tools never expose credentials or unrelated chats. */
export class AssistantStore {
  settings: PrivateSettings;
  readonly sessions = new Map<string, StoredSession>();
  constructor(readonly dir: string) {
    mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    this.settings = existsSync(path.join(dir, 'settings.json')) ? this.read('settings.json') : defaults();
    this.settings.pi = { ...defaults().pi, ...this.settings.pi };
    this.settings.accessMode ??= 'ask';
    // Only our index is authoritative. Never discover harness sessions from their global stores.
    const ids: string[] = existsSync(path.join(dir, 'index.json')) ? this.read('index.json') : [];
    for (const id of ids) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const s: StoredSession = this.read(`sessions/${id}.json`);
      const lastRequest = [...s.messages].reverse().find(m => m.role === 'user');
      let changed = false;
      if (s.status === 'running' || s.status === 'waiting') {
        interruptActivities(s);
        s.status = 'idle'; s.questions = s.questions.filter(q => q.source === 'emaki');
        if (lastRequest) s.interruption = { messageId: lastRequest.resumeOf ?? lastRequest.id, reason: 'restart' };
        s.messages.push({ id: randomUUID(), role: 'system', text: '处理已中断。' });
        changed = true;
      }
      // Upgrade existing interrupted conversations as well as newly interrupted turns.
      for (const message of s.messages) {
        if (message.role !== 'system' || message.text !== '服务已重启，上次运行已停止；不会自动重复执行。') continue;
        if (message === s.messages.at(-1) && lastRequest && s.status === 'idle') {
          s.interruption = { messageId: lastRequest.resumeOf ?? lastRequest.id, reason: 'restart' };
        }
        message.text = '处理已中断。'; changed = true;
      }
      if (s.status === 'error' && !s.interruption && lastRequest) {
        s.interruption = { messageId: lastRequest.resumeOf ?? lastRequest.id, reason: 'error' }; changed = true;
      }
      if (changed) this.write(`sessions/${id}.json`, s);
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
