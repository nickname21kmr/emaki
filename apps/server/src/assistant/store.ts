import { randomUUID, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
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
const defaults = (): PrivateSettings => ({ enabled: false, accessMode: 'ask', backend: null, codexPath: '', dshPath: '', apiKey: '', externalToken: randomBytes(32).toString('hex'),
  pi: { provider: '', baseUrl: '', model: '', api: 'openai-completions', apiKeyConfigured: false, vision: true, reasoning: false } });

/** 放在图库数据库之外：SQL 工具查不到这些密钥和其他对话（query-worker 还另外拦了 settings 表里的 Danbooru key）。 */
export class AssistantStore {
  settings: PrivateSettings;
  readonly sessions = new Map<string, StoredSession>();
  /** settings.json 启动时读不出来：第一次保存前先另存为 .bad，免得里面的 API Key 被覆盖 */
  private unreadable = false;
  // 助手默认关闭，启动时不能因为它的状态文件起不来：缺了用默认值，坏了警告后跳过；启动时也不写文件（关着时不碰 data）
  constructor(readonly dir: string) {
    const saved = this.tryRead('settings.json');
    const valid = typeof saved === 'object' && saved !== null && !Array.isArray(saved);
    this.unreadable = !valid && existsSync(path.join(dir, 'settings.json'));
    this.settings = valid ? saved as PrivateSettings : defaults();
    this.settings.pi = { ...defaults().pi, ...this.settings.pi };
    this.settings.accessMode ??= 'ask';
    // Only our index is authoritative. Never discover harness sessions from their global stores.
    const ids = this.tryRead('index.json');
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
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
        this.sessions.set(id, s);
        // 助手关着时修正只留在内存，下次保存会话时落盘
        if (changed && this.settings.enabled) this.write(`sessions/${id}.json`, s);
      } catch (e) { console.warn(`[assistant] 会话 ${id} 读取或更新失败：${(e as Error).message}`); }
    }
  }
  private read(file: string) { return JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')); }
  /** 文件不存在返回 undefined；读不出来记一条警告，同样返回 undefined */
  private tryRead(file: string): unknown {
    if (!existsSync(path.join(this.dir, file))) return undefined;
    try { return this.read(file); } catch (e) { console.warn(`[assistant] 跳过无法读取的 ${file}：${(e as Error).message}`); return undefined; }
  }
  private write(file: string, value: unknown) {
    const target = path.join(this.dir, file), temp = `${target}.tmp`;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, target);
  }
  saveSettings() {
    if (this.unreadable) {
      try { copyFileSync(path.join(this.dir, 'settings.json'), path.join(this.dir, 'settings.json.bad')); } catch {}
      this.unreadable = false;
    }
    this.write('settings.json', this.settings);
  }
  publicSettings(): AssistantSettings {
    const { apiKey: _key, externalToken: _token, ...settings } = this.settings;
    return { ...settings, pi: { ...settings.pi, apiKeyConfigured: Boolean(this.settings.apiKey) } };
  }
  create(): StoredSession {
    if (!this.settings.backend) throw new Error('请先在设置中选择 Agent 应用');
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
