import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssistantModel, AssistantQuestion } from '@emaki/shared';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { JsonProcess } from './rpc.ts';
import type { PrivateSettings, StoredSession } from './store.ts';

export interface AgentSink {
  text(id: string, delta: string): void;
  tool(id: string, text: string): void;
  question(question: AssistantQuestion): void;
  done(error?: string): void;
  disconnected?(): void;
}
export interface AgentBackend {
  models(): Promise<AssistantModel[]>;
  prompt(text: string, model: string, effort: string): Promise<void>;
  answer(id: string, value: string): void;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export function findCodex(manual = ''): string | null {
  if (manual) return existsSync(manual) ? manual : null;
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) for (const name of names) {
    const file = path.join(dir, name); if (existsSync(file)) return file;
  }
  const root = path.join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  if (existsSync(root)) for (const dir of readdirSync(root).reverse()) {
    const file = path.join(root, dir, 'codex.exe'); if (existsSync(file)) return file;
  }
  return null;
}

function launch(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  // npm Windows shims are batch files: use the installed JS entry via node, not cmd /c.
  if (/\.cmd$/i.test(command)) {
    const entry = path.join(path.dirname(command), 'node_modules/@openai/codex/bin/codex.js');
    if (!existsSync(entry)) throw new Error('请指定 Codex 可执行文件或标准 npm 安装位置');
    return new JsonProcess(process.execPath, [entry, ...args], cwd, env);
  }
  return new JsonProcess(command, args, cwd, env);
}

export class CodexBackend implements AgentBackend {
  private constructor(private rpc: JsonProcess, private session: StoredSession, private sink: AgentSink, private cwd: string, private instructions: string) {
    rpc.onEvent = (message) => this.event(message);
    rpc.onExit = (error) => { sink.disconnected?.(); sink.done(error); };
  }
  private pending = new Map<string, { id: string | number; method: string; params: any; questionId?: string; answers?: Record<string, { answers: string[] }> }>();
  private turnId?: string;
  static async open(settings: PrivateSettings, session: StoredSession, cwd: string, endpoint: string, instructions: string, sink: AgentSink) {
    const binary = findCodex(settings.codexPath); if (!binary) throw new Error('未找到 Codex，请在设置中指定路径');
    const rpc = launch(binary, ['app-server', '-c', `mcp_servers.emaki.url=${JSON.stringify(endpoint)}`,
      '-c', 'mcp_servers.emaki.bearer_token_env_var="EMAKI_ASSISTANT_TOKEN"', '-c', 'web_search="live"'], cwd,
      { ...process.env, EMAKI_ASSISTANT_TOKEN: session.token });
    const backend = new CodexBackend(rpc, session, sink, cwd, instructions);
    try { await rpc.request({ method: 'initialize', params: { clientInfo: { name: 'emaki', version: '0.1.0' } } }); rpc.send({ method: 'initialized' }); }
    catch (error) { await backend.close(); throw error; }
    return backend;
  }
  async models(): Promise<AssistantModel[]> {
    const models: AssistantModel[] = []; let cursor: string | undefined;
    do {
      const result = await this.rpc.request({ method: 'model/list', params: { limit: 100, ...(cursor ? { cursor } : {}) } });
      for (const m of result.data ?? []) models.push({ id: m.model ?? m.id, name: m.displayName ?? m.id, efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort, vision: m.inputModalities?.includes('image') ?? true });
      cursor = result.nextCursor;
    } while (cursor);
    return models;
  }
  async checkAccount(): Promise<boolean> { const result = await this.rpc.request({ method: 'account/read', params: { refreshToken: false } }); return Boolean(result.account) || result.requiresOpenaiAuth === false; }
  async prompt(text: string, model: string, effort: string) {
    if (!this.session.nativeId) {
      const result = await this.rpc.request({ method: 'thread/start', params: { model, cwd: this.cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', developerInstructions: this.instructions } });
      this.session.nativeId = result.thread.id;
    } else {
      await this.rpc.request({ method: 'thread/resume', params: { threadId: this.session.nativeId, model, cwd: this.cwd, approvalPolicy: 'on-request', developerInstructions: this.instructions } });
    }
    const result = await this.rpc.request({ method: 'turn/start', params: { threadId: this.session.nativeId, model, ...(effort ? { effort } : {}), input: [{ type: 'text', text }] } });
    this.turnId = result.turn.id;
  }
  private event(msg: any) {
    const p = msg.params ?? {};
    if (msg.id != null && msg.method) {
      const id = String(msg.id);
      this.pending.set(id, { id: msg.id, method: msg.method, params: p });
      if (msg.method === 'mcpServer/elicitation/request' && p.mode === 'form' && Object.keys(p.requestedSchema?.properties ?? {}).length === 0) {
        this.sink.question({ id, kind: 'approval', title: [p.message, p._meta?.tool_description, p._meta?.tool_params ? JSON.stringify(p._meta.tool_params, null, 2) : ''].filter(Boolean).join('\n') });
      } else if (msg.method === 'item/tool/requestUserInput') {
        this.pending.delete(id);
        const answers: Record<string, { answers: string[] }> = {};
        for (const [i, q] of (p.questions ?? []).entries()) {
          const questionKey = `${id}:${i}`;
          this.pending.set(questionKey, { id: msg.id, method: msg.method, params: p, questionId: q.id, answers });
          this.sink.question({ id: questionKey, kind: 'input', title: q.question, options: q.options?.map((o: any) => o.label) });
        }
      } else if (msg.method.includes('requestApproval')) {
        this.sink.question({ id, kind: 'approval', title: p.reason ?? p.command ?? 'Agent 请求执行操作' });
      } else {
        this.rpc.send({ id: msg.id, error: { code: -32601, message: 'Emaki does not support this interaction yet' } }); this.pending.delete(id);
      }
      return;
    }
    if (p.threadId && this.session.nativeId && p.threadId !== this.session.nativeId) return;
    if (msg.method === 'item/agentMessage/delta') this.sink.text(p.itemId, p.delta);
    if (msg.method === 'item/started' && ['mcpToolCall', 'commandExecution', 'fileChange', 'webSearch', 'dynamicToolCall'].includes(p.item?.type)) this.sink.tool(p.item.id, p.item.tool ?? p.item.type ?? '工具运行中');
    if (msg.method === 'turn/completed') { this.turnId = undefined; this.sink.done(p.turn?.error?.message); }
  }
  answer(id: string, value: string) {
    const pending = this.pending.get(id); if (!pending) throw new Error('请求已结束');
    let result: any;
    if (pending.method === 'mcpServer/elicitation/request') result = { action: value === 'approve' ? 'accept' : 'decline', ...(value === 'approve' ? { content: {} } : {}) };
    else if (pending.method === 'item/tool/requestUserInput') {
      pending.answers![pending.questionId!] = { answers: [value] }; this.pending.delete(id);
      if (Object.keys(pending.answers!).length < pending.params.questions.length) return;
      result = { answers: pending.answers };
    }
    else if (pending.method === 'item/permissions/requestApproval') result = { permissions: value === 'approve' ? pending.params.permissions : {}, scope: 'turn' };
    else result = { decision: value === 'approve' ? 'accept' : 'decline' };
    this.rpc.send({ id: pending.id, result }); this.pending.delete(id);
  }
  async stop() { if (this.turnId && this.session.nativeId) await this.rpc.request({ method: 'turn/interrupt', params: { threadId: this.session.nativeId, turnId: this.turnId } }, 5000); }
  close() { return this.rpc.close(); }
}

export class PiBackend implements AgentBackend {
  private pending = new Map<string, any>();
  private constructor(private rpc: JsonProcess, private session: StoredSession, private sink: AgentSink) {
    rpc.onEvent = (event) => this.event(event); rpc.onExit = (error) => { sink.disconnected?.(); sink.done(error); };
  }
  static async open(settings: PrivateSettings, session: StoredSession, cwd: string, endpoint: string, instructions: string, skillPath: string, sink: AgentSink) {
    const agentDir = path.join(cwd, 'pi-config'); mkdirSync(agentDir, { recursive: true });
    // Reuse model/auth configuration only; never read another application's sessions.
    const existing = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), '.pi/agent');
    // Do not clone refreshable OAuth tokens: separate copies can invalidate each other's refresh tokens.
    const authFile = path.join(existing, 'auth.json');
    const auth = existsSync(authFile) ? JSON.parse(readFileSync(authFile, 'utf8')) : {};
    writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify(Object.fromEntries(Object.entries(auth).filter(([, value]: [string, any]) => value?.type === 'api_key'))), { mode: 0o600 });
    const modelFile = path.join(existing, 'models.json');
    const models: any = existsSync(modelFile) ? JSON.parse(readFileSync(modelFile, 'utf8')) : { providers: {} };
    if (settings.pi.model && settings.pi.baseUrl) {
      models.providers ??= {};
      models.providers.emaki = { baseUrl: settings.pi.baseUrl, api: settings.pi.api, apiKey: '${EMAKI_PI_API_KEY}', models: settings.pi.model.split(',').map((id) => ({ id: id.trim(), name: id.trim(), input: settings.pi.vision ? ['text', 'image'] : ['text'], reasoning: settings.pi.reasoning })) };
    }
    writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(models), { mode: 0o600 });
    writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { emaki: { url: endpoint, headers: { Authorization: 'Bearer ${EMAKI_ASSISTANT_TOKEN}' }, exposure: 'direct' } } }), { mode: 0o600 });
    const instructionFile = path.join(cwd, 'instructions.md'); writeFileSync(instructionFile, instructions);
    const gate = path.join(cwd, 'permissions.ts');
    writeFileSync(gate, `export default function(pi) { pi.on('tool_call', async (event, ctx) => {
      if (['bash','powershell','edit','write'].includes(event.toolName)) {
        const ok = await ctx.ui.confirm('允许执行 '+event.toolName+'？', JSON.stringify(event.input).slice(0,3000));
        if (!ok) return { block: true, reason: '用户未批准此操作' };
      }
    }); }`);
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
    const cli = path.join(path.dirname(entry), 'cli.js');
    const args = [cli, '--mode', 'rpc', '--tools', '+codemode', '--no-extensions', '-e', 'builtin:mcp', '-e', 'builtin:codemode', '-e', gate, '--no-context-files', '--no-skills', '--skill', skillPath,
      '--no-prompt-templates', '--append-system-prompt', instructionFile, '--session-dir', path.join(cwd, 'history')];
    if (session.nativeId) args.push('--session', session.nativeId);
    const rpc = new JsonProcess(process.execPath, args, cwd, { ...process.env, PI_CODING_AGENT_DIR: agentDir, EMAKI_ASSISTANT_TOKEN: session.token, EMAKI_PI_API_KEY: settings.apiKey || 'local' });
    const backend = new PiBackend(rpc, session, sink);
    try { const state = await rpc.request({ type: 'get_state' }); session.nativeId = state.sessionFile; }
    catch (error) { await backend.close(); throw error; }
    return backend;
  }
  async models(): Promise<AssistantModel[]> {
    const { models } = await this.rpc.request({ type: 'get_available_models' });
    return models.map((m: any) => ({ id: `${m.provider}/${m.id}`, provider: m.provider, name: `${m.name ?? m.id} · ${m.provider}`, vision: m.input?.includes('image') ?? false,
      efforts: m.reasoning ? getSupportedThinkingLevels(m) : [], defaultEffort: m.reasoning ? getSupportedThinkingLevels(m).find(l => l === 'medium') ?? getSupportedThinkingLevels(m)[0] : '' }));
  }
  async prompt(text: string, model: string, effort: string) {
    const slash = model.indexOf('/');
    await this.rpc.request({ type: 'set_model', provider: model.slice(0, slash), modelId: model.slice(slash + 1) });
    if (effort) await this.rpc.request({ type: 'set_thinking_level', level: effort });
    await this.rpc.request({ type: 'prompt', message: text });
    const state = await this.rpc.request({ type: 'get_state' }); this.session.nativeId = state.sessionFile;
  }
  private messageId = 'pi-0'; private sequence = 0; private error?: string;
  private event(e: any) {
    if (e.type === 'message_start' && e.message?.role === 'assistant') this.messageId = `pi-${Date.now()}-${++this.sequence}`;
    if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') this.sink.text(this.messageId, e.assistantMessageEvent.delta);
    if (e.type === 'message_end' && e.message?.errorMessage) this.error = e.message.errorMessage;
    if (e.type === 'tool_execution_start') this.sink.tool(e.toolCallId, e.toolName);
    if (e.type === 'agent_settled') { this.sink.done(this.error); this.error = undefined; }
    if (e.type === 'extension_ui_request' && ['confirm', 'input', 'select', 'editor'].includes(e.method)) {
      this.pending.set(e.id, e); this.sink.question({ id: e.id, kind: e.method === 'confirm' ? 'approval' : 'input', title: [e.title, e.message].filter(Boolean).join('\n'), options: e.options });
    }
  }
  answer(id: string, value: string) {
    const pending = this.pending.get(id); if (!pending) throw new Error('请求已结束');
    this.rpc.send({ type: 'extension_ui_response', id, ...(pending.method === 'confirm' ? { confirmed: value === 'approve' } : { value }) }); this.pending.delete(id);
  }
  async stop() { await this.rpc.request({ type: 'abort' }, 5000); }
  close() { return this.rpc.close(); }
}
