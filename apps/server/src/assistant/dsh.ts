import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { resolveProxy } from '../net/proxy.ts';
import type { AssistantModel } from '@emaki/shared';
import { JsonProcess } from './rpc.ts';
import type { AgentBackend, AgentSink } from './backends.ts';
import type { PrivateSettings, StoredSession } from './store.ts';
import { toolPreview } from './activity.ts';

export interface DshInstallation { command: string; args: string[]; cli: string; home: string }

/** Preserve explicit DSH routing; otherwise share Emaki's detected outbound proxy. */
export async function dshProxyEnvironment(home: string, inherited: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const env = { ...inherited };
  const keys = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const file = path.join(home, '.env');
  if (existsSync(file)) {
    const local = parseEnv(readFileSync(file, 'utf8'));
    for (const key of keys) {
      if (!env[key]?.trim() && !env[key.toUpperCase()]?.trim()) {
        const value = local[key]?.trim() || local[key.toUpperCase()]?.trim();
        if (value) env[key.toUpperCase()] = value;
      }
    }
  }
  const explicit = keys.slice(0, 3).some(key => env[key]?.trim() || env[key.toUpperCase()]?.trim());
  if (!explicit) {
    const proxy = await resolveProxy();
    if (proxy.url) { env.HTTP_PROXY = proxy.url; env.HTTPS_PROXY = proxy.url; }
  }
  // DSH itself bypasses loopback; Python and other child tools also need that policy.
  const bypass = env.no_proxy?.trim() || env.NO_PROXY?.trim();
  env.NO_PROXY = [...new Set([...(bypass?.split(',') ?? []), 'localhost', '127.0.0.1', '::1'])].join(',');
  if (env.no_proxy !== undefined) env.no_proxy = env.NO_PROXY;
  return env;
}

/** Resolve installed entry points without running a shell or changing PATH. */
export function findDsh(manual = ''): DshInstallation | null {
  const roots = [process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean) as string[];
  const candidates = manual ? [manual] : [
    ...(process.env.PATH ?? '').split(path.delimiter).flatMap(dir => ['dsh.exe', 'dsh.cmd', 'dsh'].map(name => path.join(dir, name))),
    ...roots.flatMap(root => ['DeepSeek Harness', 'DSH Desktop', 'DSH Desktop Beta'].map(name => path.join(root, name, `${name}.exe`))),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const directory = path.dirname(candidate);
    const cliCandidates = candidate.endsWith('.js') ? [candidate] : [
      path.join(directory, 'resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js'),
      path.join(directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    ];
    const cli = cliCandidates.find(p => existsSync(p));
    const home = process.env.DSH_HOME || path.join(homedir(), /beta/i.test(candidate) && existsSync(path.join(homedir(), '.dsh-beta')) ? '.dsh-beta' : '.dsh');
    if (cli) return { command: process.execPath, args: [cli], cli, home };
    const desktopArchive = path.join(directory, 'resources/app.asar');
    if (/\.exe$/i.test(candidate) && existsSync(desktopArchive)) return {
      command: candidate, args: ['--expose-internals', path.join(desktopArchive, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')],
      cli: path.join(desktopArchive, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), home,
    };
    // Official Desktop's self-contained CLI carrier, including asar installations.
    const archive = path.resolve(directory, '../../../app.asar');
    const carrier = path.join(archive, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
    if (/\.cmd$/i.test(candidate) && existsSync(archive)) {
      const exe = readdirSync(path.resolve(directory, '../../../../')).find(name => /\.exe$/i.test(name) && !/uninstall|elevate/i.test(name));
      if (exe) return { command: path.resolve(directory, '../../../../', exe), args: ['--expose-internals', carrier], cli: carrier, home };
    }
    if (!/\.(cmd|bat)$/i.test(candidate) && /^dsh(?:\.exe)?$/i.test(path.basename(candidate))) return { command: candidate, args: [], cli: candidate, home };
  }
  return null;
}

type Option = { id: string; currentValue: string; options: Choice[] };
type Choice = { value?: string; name: string; options?: Choice[] };
const choices = (options: Choice[]): Choice[] => options.flatMap(o => o.options ? choices(o.options) : [o]);

/** Each process owns one Emaki session, its profile, and its entire durable session store. */
export class DshBackend implements AgentBackend {
  private config: Option[] = [];
  private pending = new Map<string, { id: string | number; options: any[] }>();
  private tools = new Map<string, { title: string; input?: string }>();
  private sequence = 0;
  private turn = 0;
  private readonly instance = randomUUID();
  private running?: Promise<void>;
  private cancelled = false;
  private closing = false;
  private reasoning = new Set<string>();
  private modelList?: Promise<AssistantModel[]>;
  private constructor(private rpc: JsonProcess, private session: StoredSession, private sink: AgentSink, private fullAccess: boolean, private metadata: string) {
    rpc.onEvent = msg => this.event(msg);
    rpc.onExit = error => { if (!this.closing) { sink.disconnected?.(); sink.done(error); } };
  }
  static async open(settings: PrivateSettings, session: StoredSession, cwd: string, endpoint: string, instructions: string, sink: AgentSink) {
    const install = findDsh(settings.dshPath); if (!install) throw new Error('未找到 DSH，请在设置中指定已安装的 DSH 路径');
    const home = path.join(cwd, 'dsh-home'); mkdirSync(home, { recursive: true });
    const patch: any[] = [];
    // Only model configuration is reused. Other profiles, plugins and session histories are never imported.
    if (install.cli.endsWith('.js') && existsSync(install.cli)) {
      const source = path.join(install.home, 'profiles/desktop/cordis.patch.yml');
      if (existsSync(source)) {
        const yaml = createRequire(install.cli)('yaml');
        const entries = yaml.parse(readFileSync(source, 'utf8'));
        if (Array.isArray(entries)) for (const entry of entries) {
          if (['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'deepseek-account', 'agent-default-model'].includes(entry.id) && entry.config) {
            patch.push({ id: entry.id, config: entry.config });
            if (entry.id === 'agent-default-model') patch.push({ id: 'acp', config: { provider: entry.config.provider, model: entry.config.model } });
          }
        }
      }
    }
    patch.push(
      // Share the credential provider's authoritative file instead of copying refreshable credentials.
      { id: 'credentials', config: { path: path.join(install.home, '.credentials.yaml') } },
      { id: 'system-prompt', config: { personaPrefix: instructions } },
      { id: 'permission', config: { defaultPreset: settings.accessMode === 'full' ? 'danger-full-access' : 'workspace-write' } },
    );
    // Restored DSH sessions retain their previous permissions. Apply Emaki's current setting
    // through the public permission service before publishing only this process's agents.
    const permissionPlugin = path.join(cwd, 'dsh-integration.mjs'), metadata = path.join(cwd, 'dsh-models.json');
    writeFileSync(permissionPlugin, `import {writeFileSync, renameSync} from 'node:fs';
export const inject = ['permissionPresets', 'approval', 'llm', 'deepseekAccount'];
export function apply(ctx) { ctx.on('agent/created', async ({agent}) => {
  ctx.permissionPresets.set(agent.session, ${JSON.stringify(settings.accessMode === 'full' ? 'danger-full-access' : 'workspace-write')});
  const models = {};
  for (const provider of ctx.llm.listProviders()) {
    try { for (const model of await ctx.llm.listModels(provider.id)) {
      const info = await ctx.llm.resolveModelInfo(provider.id, model.id);
      models[JSON.stringify([provider.id, model.id])] = {vision: info.inputModalities?.includes('image') === true};
    } } catch { /* Unavailable routes are omitted; ACP remains authoritative for selectable options. */ }
  }
  writeFileSync(${JSON.stringify(metadata + '.tmp')}, JSON.stringify(models));
  renameSync(${JSON.stringify(metadata + '.tmp')}, ${JSON.stringify(metadata)});
}); ctx.provide('emakiIntegration', {}); }`);
    patch.push({ insert: [{ id: 'emaki-permissions', name: pathToFileURL(permissionPlugin).href }] });
    patch.push({ id: 'acp', inject: ['acpAppStartup', 'emakiIntegration'] });
    const overlay = path.join(cwd, 'dsh.patch.json'); writeFileSync(overlay, JSON.stringify(patch), { mode: 0o600 });
    // ACP intentionally omits elicitation; user choices are handled by Emaki's ask_user MCP tool.
    const rpc = new JsonProcess(install.command, [...install.args, '--profile', 'acp', '--patch', overlay], cwd,
      { ...await dshProxyEnvironment(install.home), DSH_HOME: home, DSH_AGENTS_HOME: path.join(cwd, '.agents'), DSH_PERMISSION_MODE: settings.accessMode === 'full' ? 'danger-full-access' : 'workspace-write', ...(install.args.includes('--expose-internals') ? { ELECTRON_RUN_AS_NODE: '1' } : {}) });
    const backend = new DshBackend(rpc, session, sink, settings.accessMode === 'full', metadata);
    try {
      await backend.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'emaki', version: '0.1.0' } }, 60000);
      const result = await backend.request(session.nativeId ? 'session/resume' : 'session/new', {
        ...(session.nativeId ? { sessionId: session.nativeId } : {}), cwd,
        mcpServers: session.token ? [{ type: 'http', name: 'emaki', url: endpoint, headers: [{ name: 'Authorization', value: `Bearer ${session.token}` }] }] : [],
      }, 60000);
      session.nativeId = result.sessionId ?? session.nativeId;
      backend.config = result.configOptions ?? [];
      if (!session.nativeId) throw new Error('DSH 未返回会话 ID');
    } catch (error) { await backend.close(); throw error; }
    return backend;
  }
  private request(method: string, params: any, timeout?: number) { return this.rpc.request({ jsonrpc: '2.0', method, params }, timeout); }
  private async select(id: string, value: string) {
    const result = await this.request('session/set_config_option', { sessionId: this.session.nativeId, configId: id, value });
    this.config = result.configOptions ?? this.config;
  }
  models(): Promise<AssistantModel[]> {
    // UI refresh and send validation may overlap; enumerate once per connection so
    // catalog reads cannot race a prompt's selected model or reasoning effort.
    return this.modelList ??= this.readModels().catch(error => { this.modelList = undefined; throw error; });
  }
  async checkAccount() {
    const models = await this.models();
    try {
      const metadata = JSON.parse(readFileSync(this.metadata, 'utf8'));
      return models.some(model => Object.hasOwn(metadata, model.id));
    } catch { return false; }
  }
  private async readModels(): Promise<AssistantModel[]> {
    const model = this.config.find(o => o.id === 'model'); if (!model) return [];
    const original = model.currentValue;
    const originalEffort = this.config.find(o => o.id === 'reasoning_effort')?.currentValue;
    let metadata: Record<string, { vision?: boolean }> = {};
    try { if (existsSync(this.metadata)) metadata = JSON.parse(readFileSync(this.metadata, 'utf8')); } catch { /* Missing metadata never advertises unverified image support. */ }
    const result: AssistantModel[] = [];
    // Reasoning options depend on the exact model; ask the runtime for each route, without inference.
    try {
      for (const option of choices(model.options)) {
        if (!option.value) continue;
        if (this.config.find(o => o.id === 'model')?.currentValue !== option.value) await this.select('model', option.value);
        const effort = this.config.find(o => o.id === 'reasoning_effort');
        result.push({ id: option.value, name: option.name, provider: 'dsh', efforts: effort ? choices(effort.options).flatMap(o => o.value ? [o.value] : []) : [], defaultEffort: effort?.currentValue, vision: metadata[option.value]?.vision === true });
      }
    } finally {
      if (this.config.find(o => o.id === 'model')?.currentValue !== original) await this.select('model', original);
      if (originalEffort && this.config.find(o => o.id === 'reasoning_effort')?.currentValue !== originalEffort) await this.select('reasoning_effort', originalEffort);
    }
    return result;
  }
  async prompt(text: string, model: string, effort: string) {
    if (this.running) throw new Error('DSH 会话正在运行');
    await this.select('model', model);
    if (effort) await this.select('reasoning_effort', effort);
    this.turn++; this.cancelled = false;
    this.running = this.request('session/prompt', { sessionId: this.session.nativeId, prompt: [{ type: 'text', text }] }, 0)
      .then(result => { this.finishReasoning(); this.sink.done(undefined, this.cancelled || result.stopReason === 'cancelled'); })
      .catch(error => { if (!this.closing) { this.finishReasoning(); this.sink.done((error as Error).message, this.cancelled); } })
      .finally(() => { this.running = undefined; this.pending.clear(); this.tools.clear(); });
    // ACP resolves prompt only at quiescence; acceptance must not hold up Emaki's request or cancellation.
  }
  private finishReasoning() { for (const id of this.reasoning) this.sink.reasoning?.(id, '', true); this.reasoning.clear(); }
  private event(msg: any) {
    const p = msg.params ?? {};
    if (p.sessionId && p.sessionId !== this.session.nativeId) return;
    if (msg.id != null && msg.method) {
      if (msg.method !== 'session/request_permission') { this.rpc.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unsupported Emaki interaction' } }); return; }
      const id = String(msg.id); this.pending.set(id, { id: msg.id, options: p.options ?? [] });
      if (this.fullAccess) { this.answer(id, 'approve'); return; }
      const tool = this.tools.get(p.toolCall?.toolCallId);
      this.sink.question({ id, kind: 'approval', title: [p.toolCall?.title ?? tool?.title ?? 'DSH 请求执行操作', tool?.input].filter(Boolean).join('\n') }); return;
    }
    if (msg.method !== 'session/update') return;
    const u = p.update ?? {};
    if (u.sessionUpdate === 'config_option_update') this.config = u.configOptions ?? this.config;
    const id = `dsh-${this.instance}-${this.turn}-${u.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'message'}-${u.messageId ?? this.sequence}`;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') this.sink.text(id, u.content.text);
    if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text') { this.reasoning.add(id); this.sink.reasoning?.(id, u.content.text); }
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      this.finishReasoning(); this.sequence++;
      const previous = this.tools.get(u.toolCallId);
      const title = u.title ?? previous?.title ?? 'DSH 工具';
      const input = u.rawInput !== undefined ? toolPreview(u.rawInput) : previous?.input;
      this.tools.set(u.toolCallId, { title, input });
      this.sink.tool(`dsh-${this.instance}-${this.turn}-tool-${u.toolCallId}`, title, {
        status: u.status === 'completed' ? 'succeeded' : u.status === 'failed' ? 'failed' : 'running', input,
        ...(u.rawOutput !== undefined || u.content ? { output: toolPreview(u.rawOutput ?? u.content?.map((c: any) => c.content ?? c)) } : {}),
      });
    }
  }
  answer(id: string, value: string) {
    const pending = this.pending.get(id); if (!pending) throw new Error('请求已结束');
    const option = pending.options.find(o => o.kind === (value === 'approve' ? 'allow_once' : 'reject_once'));
    this.rpc.send({ jsonrpc: '2.0', id: pending.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } }); this.pending.delete(id);
  }
  async stop() {
    if (!this.running) return;
    this.cancelled = true;
    this.rpc.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.session.nativeId } });
    await Promise.race([this.running, new Promise<void>(resolve => setTimeout(resolve, 5000))]);
  }
  async close() {
    this.closing = true;
    try { if (this.session.nativeId) await this.request('session/close', { sessionId: this.session.nativeId }, 5000); } catch { /* Process disposal is the final cancellation boundary. */ }
    await this.rpc.close();
  }
}


