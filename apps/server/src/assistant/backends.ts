import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssistantModel, AssistantQuestion } from '@emaki/shared';
import { JsonProcess } from './rpc.ts';
import type { PrivateSettings, StoredSession } from './store.ts';
import { toolPreview } from './activity.ts';
import { codexToolActivity } from './codexActivity.ts';

export interface ToolUpdate { status: 'running' | 'succeeded' | 'failed' | 'interrupted'; input?: string; output?: string; append?: boolean; progress?: string; durationMs?: number; exitCode?: number }

export interface AgentSink {
  text(id: string, delta: string): void;
  tool(id: string, text: string, update?: ToolUpdate): void;
  reasoning?(id: string, delta: string, done?: boolean): void;
  question(question: AssistantQuestion): void;
  done(error?: string, interrupted?: boolean): void;
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
  private constructor(private rpc: JsonProcess, private session: StoredSession, private sink: AgentSink, private cwd: string, private instructions: string, private fullAccess: boolean) {
    rpc.onEvent = (message) => this.event(message);
    rpc.onExit = (error) => { sink.disconnected?.(); sink.done(error); };
  }
  private pending = new Map<string, { id: string | number; method: string; params: any; questionId?: string; answers?: Record<string, { answers: string[] }> }>();
  private turnId?: string;
  private toolNames = new Map<string, string>();
  static async open(settings: PrivateSettings, session: StoredSession, cwd: string, endpoint: string, instructions: string, sink: AgentSink) {
    const binary = findCodex(settings.codexPath); if (!binary) throw new Error('未找到 Codex，请在设置中指定路径');
    // 实时打开网页不经审批，只在完全访问下开启；按需审批沿用 Codex 默认值
    const rpc = launch(binary, ['app-server', '-c', `mcp_servers.emaki.url=${JSON.stringify(endpoint)}`,
      '-c', 'mcp_servers.emaki.bearer_token_env_var="EMAKI_ASSISTANT_TOKEN"', ...(settings.accessMode === 'full' ? ['-c', 'web_search="live"'] : [])], cwd,
      { ...process.env, EMAKI_ASSISTANT_TOKEN: session.token });
    const backend = new CodexBackend(rpc, session, sink, cwd, instructions, settings.accessMode === 'full');
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
    const permissions = this.fullAccess ? { sandbox: 'danger-full-access', approvalPolicy: 'never' } : { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
    if (!this.session.nativeId) {
      const result = await this.rpc.request({ method: 'thread/start', params: { model, cwd: this.cwd, ...permissions, developerInstructions: this.instructions } });
      this.session.nativeId = result.thread.id;
    } else {
      await this.rpc.request({ method: 'thread/resume', params: { threadId: this.session.nativeId, model, cwd: this.cwd, ...permissions, developerInstructions: this.instructions } });
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
        if (this.fullAccess && p._meta?.codex_approval_kind === 'mcp_tool_call') { this.answer(id, 'approve'); return; }
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
        if (this.fullAccess) { this.answer(id, 'approve'); return; }
        this.sink.question({ id, kind: 'approval', title: p.reason ?? p.command ?? 'Agent 请求执行操作' });
      } else {
        this.rpc.send({ id: msg.id, error: { code: -32601, message: 'Emaki does not support this interaction yet' } }); this.pending.delete(id);
      }
      return;
    }
    if (p.threadId && this.session.nativeId && p.threadId !== this.session.nativeId) return;
    if (msg.method === 'item/agentMessage/delta') this.sink.text(p.itemId, p.delta);
    if (msg.method === 'item/reasoning/summaryTextDelta') this.sink.reasoning?.(p.itemId, p.delta);
    if (msg.method === 'item/completed' && p.item?.type === 'reasoning') this.sink.reasoning?.(p.item.id, '', true);
    if (['item/started', 'item/completed'].includes(msg.method)) {
      const activity = codexToolActivity(p.item, msg.method === 'item/completed');
      if (activity) {
        this.toolNames.set(activity.id, activity.name);
        this.sink.tool(activity.id, activity.name, activity.update);
      }
    }
    if (['item/commandExecution/outputDelta', 'item/fileChange/outputDelta'].includes(msg.method)) {
      this.sink.tool(p.itemId, this.toolNames.get(p.itemId) ?? (msg.method.includes('fileChange') ? '修改文件' : '执行命令'), { status: 'running', output: p.delta, append: true });
    }
    if (msg.method === 'item/fileChange/patchUpdated') this.sink.tool(p.itemId, '修改文件', { status: 'running', input: toolPreview(p.changes) });
    if (msg.method === 'item/mcpToolCall/progress') this.sink.tool(p.itemId, this.toolNames.get(p.itemId) ?? 'MCP 工具', { status: 'running', progress: p.message });
    if (msg.method === 'turn/completed') {
      this.turnId = undefined; this.toolNames.clear();
      const error = p.turn?.error?.message ?? (p.turn?.status === 'failed' ? 'Codex 本轮运行失败' : undefined);
      if (p.turn?.status === 'interrupted') this.sink.done(error, true);
      else this.sink.done(error);
    }
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

/**
 * 在 Pi 进程里运行的审批扩展，前面会拼上 `const config = {...}`。
 * 按需审批下命令和改文件逐次确认；读文件只放行会话目录、技能和 readable 目录，
 * 读写 deny 和 hidden（除 readable 外）都直接拒绝，其余路径先确认。路径解析与 Pi 的 resolveToCwd 一致，
 * Windows 设备路径（\\?\、\\.\）先还原成盘符，指向本机的 UNC 和管理共享直接拒绝。
 */
const piGate = String.raw`import path from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
const win = process.platform === 'win32';
const BLOCK = Symbol();
// 按最近的已存在上级解析链接
const real = p => { try { return realpathSync.native(p); } catch { const d = path.dirname(p); return d === p ? p : path.join(real(d), path.basename(p)); } };
const key = p => win ? p.toLowerCase() : p;
const within = (p, dirs) => dirs.some(d => { const r = path.relative(key(d), key(p)); return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r)); });
const deny = config.deny.map(real), readable = config.readable.map(real), hidden = config.hidden.map(real);
function target(raw, cwd) {
  let p = (raw == null || raw === '' ? '.' : String(raw)).replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  if (p.startsWith('@')) p = p.slice(1);
  if (win && p.startsWith('/') && !p.startsWith('//') && !p.includes('\\')) {
    const m = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(p);
    if (m) p = m[1].toUpperCase() + ':\\' + (m[2] ?? '').replaceAll('/', '\\');
  }
  if (p === '~') p = homedir();
  else if (p.startsWith('~/') || (win && p.startsWith('~\\'))) p = path.join(homedir(), p.slice(2));
  else if (/^file:\/\//.test(p)) p = fileURLToPath(p);
  let full = path.resolve(cwd, p);
  if (win && full.startsWith('\\\\')) {
    // \\?\X:\ 和 \\.\X:\ 还是本机盘符，\\?\UNC\ 就是 UNC；GLOBALROOT、Volume{…} 等认不出的设备路径不放
    const dev = /^\\\\[?.]\\(.*)$/.exec(full);
    if (dev) {
      const drive = /^([a-z]:)(\\.*)?$/i.exec(dev[1]);
      if (drive) full = drive[1] + (drive[2] || '\\');
      else if (/^unc\\/i.test(dev[1])) full = '\\\\' + dev[1].slice(4);
      else return BLOCK;
    }
    // 管理共享（X$）和指向本机的 UNC 会绕过盘符判断，不放
    const unc = /^\\\\([^\\]+)\\([^\\]*)/.exec(full);
    if (unc) {
      const host = unc[1].toLowerCase().replace(/^\[|\]$/g, ''), me = hostname().toLowerCase();
      if (/^[a-z]\$$/i.test(unc[2]) || ['localhost', '.', '?', '::1', '0--1.ipv6-literal.net', me].includes(host) || /^127\./.test(host) || host.startsWith(me + '.')) return BLOCK;
      return full; // 远程网络路径不做 realpath，免得确认前就去连对方主机
    }
  }
  return real(full);
}
export default function (pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (!config.ask) return;
    let title = '允许执行 ' + event.toolName + '？';
    const reads = ['read', 'grep', 'find', 'ls'].includes(event.toolName);
    // edit/write 也先过 deny/hidden，和读取一致
    if (reads || ['edit', 'write'].includes(event.toolName)) {
      let file = null;
      try { file = target(event.input?.path, ctx?.cwd || config.cwd); } catch {}
      if (file === BLOCK || (file && (within(file, deny) || (!within(file, readable) && within(file, hidden))))) return { block: true, reason: '助手配置和其他会话不对 agent 开放' };
      if (reads && file && within(file, readable)) return;
      if (reads) title = '允许读取会话目录以外的文件？';
    } else if (!['bash', 'powershell'].includes(event.toolName)) return;
    const ok = await ctx.ui.confirm(title, JSON.stringify(event.input).slice(0, 3000));
    if (!ok) return { block: true, reason: '用户未批准此操作' };
  });
}
`;

/** 按需审批下 Pi 读文件的范围：readable 直接放行，hidden 里的其他位置一律拒绝。 */
export interface PiFileAccess { readable: string[]; hidden: string[] }

export class PiBackend implements AgentBackend {
  private pending = new Map<string, any>();
  private constructor(private rpc: JsonProcess, private session: StoredSession, private sink: AgentSink) {
    rpc.onEvent = (event) => this.event(event); rpc.onExit = (error) => { sink.disconnected?.(); sink.done(error); };
  }
  static async open(settings: PrivateSettings, session: StoredSession, cwd: string, endpoint: string, instructions: string, skillPaths: string[], sink: AgentSink, files: PiFileAccess = { readable: [], hidden: [] }) {
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
      const ids = [...new Set(settings.pi.model.split(',').map(id => id.trim()).filter(Boolean))];
      models.providers.emaki = { baseUrl: settings.pi.baseUrl, api: settings.pi.api, apiKey: '${EMAKI_PI_API_KEY}', models: ids.map(id => ({ id, name: id, input: settings.pi.vision ? ['text', 'image'] : ['text'], reasoning: settings.pi.reasoning })) };
    }
    writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(models), { mode: 0o600 });
    writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { emaki: { url: endpoint, headers: { Authorization: 'Bearer ${EMAKI_ASSISTANT_TOKEN}' }, exposure: 'direct' } } }), { mode: 0o600 });
    const instructionFile = path.join(cwd, 'instructions.md'); writeFileSync(instructionFile, instructions);
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
    const cli = path.join(path.dirname(entry), 'cli.js'), piPackage = path.resolve(path.dirname(entry), '../..');
    const gate = path.join(cwd, 'permissions.ts');
    // pi-config 里有复制来的 API Key，批准了也不给读；Pi 自带文档可以直接读
    const access = { ask: settings.accessMode !== 'full', cwd, deny: [agentDir],
      readable: [cwd, ...skillPaths.map(p => path.dirname(p)), ...files.readable, ...['docs', 'examples', 'README.md'].map(p => path.join(piPackage, p))],
      hidden: files.hidden };
    writeFileSync(gate, `const config = ${JSON.stringify(access)};\n${piGate}`);
    const args = [cli, '--mode', 'rpc', '--tools', '+codemode', '--no-extensions', '-e', 'builtin:mcp', '-e', 'builtin:codemode', '-e', gate, '--no-context-files', '--no-skills', ...skillPaths.flatMap(p => ['--skill', p]),
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
    // pi-ai 只在列模型时用到：用到时再加载，助手没开时启动不付这份开销
    const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai/models');
    return models.map((m: any) => ({ id: `${m.provider}/${m.id}`, provider: m.provider, name: m.provider === 'emaki' ? (m.name ?? m.id) : `${m.name ?? m.id} · ${m.provider}`, vision: m.input?.includes('image') ?? false,
      efforts: m.reasoning ? getSupportedThinkingLevels(m) : [], defaultEffort: m.reasoning ? getSupportedThinkingLevels(m).find(l => l === 'medium') ?? getSupportedThinkingLevels(m)[0] : '' }));
  }
  async prompt(text: string, model: string, effort: string) {
    const slash = model.indexOf('/');
    await this.rpc.request({ type: 'set_model', provider: model.slice(0, slash), modelId: model.slice(slash + 1) });
    if (effort) await this.rpc.request({ type: 'set_thinking_level', level: effort });
    // Pi 要先做完上下文压缩（一次模型调用）才回应 prompt，不设超时；取消靠停止按钮
    await this.rpc.request({ type: 'prompt', message: text }, 0);
    const state = await this.rpc.request({ type: 'get_state' }); this.session.nativeId = state.sessionFile;
  }
  private messageId = 'pi-0'; private sequence = 0; private error?: string;
  private event(e: any) {
    if (e.type === 'message_start' && e.message?.role === 'assistant') this.messageId = `pi-${Date.now()}-${++this.sequence}`;
    if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') this.sink.text(this.messageId, e.assistantMessageEvent.delta);
    if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'thinking_delta') this.sink.reasoning?.(this.messageId, e.assistantMessageEvent.delta);
    if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'thinking_end') this.sink.reasoning?.(this.messageId, '', true);
    if (e.type === 'message_end' && e.message?.role === 'assistant') this.sink.reasoning?.(this.messageId, '', true);
    if (e.type === 'message_end' && e.message?.errorMessage) this.error = e.message.errorMessage;
    if (e.type === 'tool_execution_start') this.sink.tool(e.toolCallId, e.toolName, { status: 'running', input: toolPreview(e.args) });
    if (e.type === 'tool_execution_update') this.sink.tool(e.toolCallId, e.toolName, { status: 'running', output: toolPreview(e.partialResult) });
    if (e.type === 'tool_execution_end') this.sink.tool(e.toolCallId, e.toolName, { status: e.isError || e.result?.isError ? 'failed' : 'succeeded', output: toolPreview(e.result) });
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
