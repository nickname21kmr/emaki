import type { AssistantBackend, AssistantCard, AssistantContext, AssistantMessage, AssistantModel, AssistantSession } from '@emaki/shared';
import { KIND_LABEL } from '../../lib/kinds';
import { THEME_META } from '../unrecognized/themes';
import type { Unseen } from './dock';

// 形态的纯函数放在主包的 dock.ts 里，这里转出去，测试和视图都从 presentation 取
export { sheetForm, sheetWidthRange, leafWidth, type SheetForm, type Layout } from './dock';

/** Keep user choices when available; recover when API configuration changes. */
export function reconcileModelSelection(models: AssistantModel[], current: { model: string; effort: string }, saved: { model: string; effort: string }) {
  const selected = models.find(m => m.id === current.model);
  const remembered = models.find(m => m.id === saved.model);
  const chosen = selected ?? remembered ?? models[0];
  if (!chosen) return { model: '', effort: '' };
  const effort = selected ? current.effort : remembered ? saved.effort : chosen.defaultEffort ?? '';
  return { model: chosen.id, effort: !effort || chosen.efforts.includes(effort) ? effort : chosen.defaultEffort ?? '' };
}

/** Translate saved URLs too, so older messages use the same readable labels. */
export function contextPageLabel(page: string): string {
  let url: URL;
  try { url = new URL(page, 'http://emaki.local'); } catch { return '图库页面'; }
  const parts = url.pathname.split('/').filter(Boolean), section = parts[0] ?? '';
  const p = url.searchParams;
  const names: Record<string, string> = { '': '首页', welcome: '首次设置', gallery: '图库', characters: '角色', works: '作品', unrecognized: '未识别', duplicates: '重复', collections: '合集', annex: '别册', excluded: '已排除', settings: '设置', dev: '界面预览' };
  const labels = [names[section] ?? '图库页面'];
  const kind = (value: string | null | undefined) => value && Object.hasOwn(KIND_LABEL, value) ? KIND_LABEL[value as keyof typeof KIND_LABEL] : undefined;
  if (section === 'characters') {
    if (parts[1]) labels[0] = '角色详情';
    else {
      if (p.get('source') === 'custom') labels.push('自建角色');
      if (p.get('work') === 'recent') labels.push('最近在收');
      else if (p.has('work')) labels.push('按作品筛选');
    }
  } else if (section === 'works' && parts[1]) labels[0] = '作品详情';
  else if (section === 'collections' && parts[1]) labels[0] = parts[2] === 'read' ? '合集阅读' : '合集详情';
  else if (section === 'annex') { const name = kind(parts[1]); if (name) labels.push(name); }
  else if (section === 'unrecognized') {
    if (p.get('area') === 'annex') labels.push('照片 · 文字等', ...(kind(p.get('kind')) ? [kind(p.get('kind'))!] : []));
    else {
      const buckets: Record<string, string> = { suggested: '有建议', unsure: '没认出', untagged: '待识别', shelved: '放下的', books: '成册待整理' };
      const bucket = p.get('bucket') ?? '';
      if (Object.hasOwn(buckets, bucket)) labels.push(buckets[bucket]!);
    }
  }
  const theme = p.get('theme');
  if ((section === 'gallery' || (section === 'unrecognized' && p.get('area') !== 'annex' && p.get('bucket') === 'unsure')) && theme && Object.hasOwn(THEME_META, theme)) labels.push(THEME_META[theme as keyof typeof THEME_META].label);
  if (section === 'gallery') {
    if (p.get('fav') === '1') labels.push('已收藏');
    if (p.has('custom')) labels.push('自定义画面');
    if (p.get('artist')) labels.push(`画师：${p.get('artist')}`);
  }
  if (p.get('q')) labels.push(`搜索：${p.get('q')}`);
  return labels.join(' · ');
}

export const selectionLabel = (count: number) => count ? `已选 ${count} 张` : '未选图片';

export interface ResultSelection { cardId: string; title: string; ids: string[] }
export function composerContext(page: string, scope: string, selected: ReadonlySet<string>, viewedId: string | undefined, result: ResultSelection | null): AssistantContext {
  return { page, imageIds: viewedId ? [viewedId] : result ? result.ids : [...selected], selectionScope: viewedId ? 'lightbox' : result ? `assistant-result:${result.cardId}` : scope };
}
export function toggleResultImage(current: ResultSelection | null, card: { id: string; title: string }, id: string, checked: boolean): ResultSelection {
  const ids = new Set(current?.ids ?? []);
  if (checked) ids.add(id); else ids.delete(id);
  return { cardId: card.id, title: current && current.cardId !== card.id && current.ids.length ? '助手选择' : card.title, ids: [...ids] };
}

/** 思考和工具记录；带撤销的「图库已更新」不算，它要露在外面 */
export const isProcessMessage = (message: AssistantMessage) =>
  !message.cards?.length && !message.undoToken && (message.role === 'tool' || Boolean(message.reasoning));

export function groupMessages(messages: AssistantMessage[]): AssistantMessage[][] {
  const groups: AssistantMessage[][] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (isProcessMessage(message) && previous && isProcessMessage(previous[0]!)) previous.push(message);
    else groups.push([message]);
  }
  return groups;
}

export interface Position { x: number; y: number }
export function clampPosition(position: Position, width: number, height: number, viewportWidth: number, viewportHeight: number): Position {
  return {
    x: Math.max(8, Math.min(position.x, viewportWidth - width - 8)),
    y: Math.max(8, Math.min(position.y, viewportHeight - height - 8)),
  };
}

// ------------------------------------------------------------------ 文案

export const EFFORT_LABEL: Record<string, string> = { minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', off: '关闭' };
export const BACKEND_LABEL: Record<AssistantBackend, string> = { codex: 'Codex', pi: 'Pi', dsh: 'DSH' };

/** 按 id 查模型名，查不到原样返回 */
export const modelLabel = (id: string, models?: readonly AssistantModel[]) => models?.find(m => m.id === id)?.name ?? id;

/** 压成一行，截到 n 个字，超出加省略号 */
export function clip(text: string, n: number) {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');
}

/** 引一句话：截到 n 个字，套「」；里面原有的「」改成『』，不套两层同样的括号 */
export const quote = (text: string, n: number) => `「${clip(text, n).replace(/「/g, '『').replace(/」/g, '』')}」`;

/** 「等 n 步」接在前文后面：前文以字母数字结尾（「×3」「foo_bar」）时隔一个空格 */
const andMore = (text: string, more: string) => `${text}${/[\x21-\x7e]$/.test(text) ? ' ' : ''}${more}`;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 用时：不到 10 秒带一位小数（最少 0.1 秒，不会出现「0 秒」），不到一分钟写整秒，再长写「2 分 05 秒」 */
export function formatDuration(ms: number) {
  const s = Math.max(0, ms) / 1000;
  const tenth = Math.round(s * 10) / 10;
  if (tenth < 10) return `${Math.max(0.1, tenth).toFixed(1)} 秒`;
  const whole = Math.round(s);
  if (whole < 60) return `${whole} 秒`;
  return `${Math.floor(whole / 60)} 分 ${pad2(whole % 60)} 秒`;
}

/** 计时：「0:42」「12:05」「1:02:03」 */
export function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** 问句下的时间：当天「14:05」，今年「10月23日 14:05」，更早「2025年10月23日」 */
export function turnTime(ms: number, now = Date.now()) {
  const d = new Date(ms), n = new Date(now);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.getFullYear() !== n.getFullYear()) return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  if (d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 回答 emaki 提问时服务端写的格式（service.ts answer）：「关于「标题」\n回答」 */
export function parseAnswerText(text: string): { title: string; value: string } | null {
  const m = /^关于「([\s\S]*?)」\n([\s\S]*)$/.exec(text);
  return m ? { title: m[1]!, value: m[2]! } : null;
}

/** 提问标题：第一行是问题，其余是命令和 JSON（用等宽排） */
export function splitQuestionTitle(title: string): { lead: string; body: string } {
  const [lead = '', ...rest] = title.split('\n');
  return { lead: lead.trim(), body: rest.join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd() };
}

// ------------------------------------------------------------------ 工具名

const TOOL_LABEL: Record<string, string> = {
  describe_database: '查看表结构', query_database: '查询图库', read_library: '读取图库', read_media: '看图',
  get_page_context: '读取当前页面', ask_user: '向你提问', present_result: '整理结果', update_images: '修改图片',
  edit_source: '修改来源', accept_suggestion: '采纳建议', edit_character: '编辑角色', manage_job: '管理后台任务',
  // Pi 自带的工具
  bash: '执行命令', read: '读取文件', write: '修改文件', edit: '修改文件', grep: '查找文件', find: '查找文件', ls: '查找文件',
};
// Codex 自己起的中文名（codexActivity.ts），原样显示
const CODEX_NAMES = new Set(['执行命令', '联网搜索', '打开网页', '查找网页内容', '修改文件', '查看图片', '等待', 'MCP 工具']);

/** 去掉 emaki 前缀：Codex 的 MCP 工具名是「emaki · query_database」 */
export const toolName = (raw: string) => raw.trim().replace(/^(?:emaki\s*·\s*|mcp__emaki__|emaki[_.:/])/, '');

export function toolLabel(raw: string): { label: string; known: boolean } {
  const name = toolName(raw);
  if (Object.hasOwn(TOOL_LABEL, name)) return { label: TOOL_LABEL[name]!, known: true };
  if (CODEX_NAMES.has(name) || name.startsWith('子任务')) return { label: name, known: true };
  return { label: name || raw, known: false };
}

/** 进行时：「正在查询图库」；不认识的写「正在运行 xxx」 */
export function runningLabel(raw: string) {
  const { label, known } = toolLabel(raw);
  return known ? `正在${label}` : `正在运行 ${label}`;
}

/** 参数能解析成 JSON 就缩进排好，否则原样 */
export function prettyInput(input: string) {
  try { return JSON.stringify(JSON.parse(input), null, 2); } catch { return input; }
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (value && typeof value === 'object') for (const v of Object.values(value)) { const s = firstString(v); if (s) return s; }
  return undefined;
}

/** 旁注条目行的预览：运行中先看进度；参数取第一行，JSON 取第一个字符串值；思考取开头 40 字 */
export function rowPreview(message: AssistantMessage) {
  if (message.reasoning) return clip(message.reasoning.text, 40);
  const tool = message.tool;
  if (!tool) return '';
  if (tool.status === 'running' && tool.progress) return clip(tool.progress, 80);
  const input = tool.input?.trim() ?? '';
  try { const s = firstString(JSON.parse(input)); if (s) return clip(s, 80); } catch { /* 不是 JSON */ }
  return clip(input.split('\n').find(line => line.trim()) ?? '', 80);
}

// ------------------------------------------------------------------ 旁注

export interface NoteSummary { label: string; parts: { text: string; tone?: 'danger' }[]; totalMs: number; running: boolean }

/** 旁注组头：运行中写正在做什么；结束后写「思考 7.0 秒，查询图库 ×3、看图」，后面接失败和中断 */
export function noteSummary(messages: readonly AssistantMessage[], now: number): NoteSummary {
  const thoughts = messages.filter(m => m.reasoning);
  const tools = messages.filter(m => !m.reasoning && m.role === 'tool');
  const runningTools = tools.filter(m => m.tool?.status === 'running');
  const thinking = thoughts.some(m => m.reasoning!.status === 'running');
  let label: string;
  if (runningTools.length) {
    const doing = runningLabel(runningTools.at(-1)!.text);
    label = runningTools.length > 1 ? andMore(doing, `等 ${runningTools.length} 项`) : doing;
  }
  else if (thinking) label = '正在思考';
  else {
    const segments: string[] = [];
    if (thoughts.length) {
      const ms = thoughts.reduce((sum, m) => sum + Math.max(0, (m.reasoning!.finishedAt ?? m.reasoning!.startedAt) - m.reasoning!.startedAt), 0);
      segments.push(`思考 ${formatDuration(ms)}`);
    }
    if (tools.length) {
      const counts = new Map<string, number>();
      for (const m of tools) { const name = toolLabel(m.text).label; counts.set(name, (counts.get(name) ?? 0) + 1); }
      const kinds = [...counts].slice(0, 2).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join('、');
      segments.push(counts.size > 2 ? andMore(kinds, `等 ${tools.length} 步`) : kinds);
    }
    label = segments.join('，');
  }
  const parts: NoteSummary['parts'] = [];
  const failed = tools.filter(m => m.tool?.status === 'failed').length;
  if (failed) parts.push({ text: `${failed} 项失败`, tone: 'danger' });
  if (tools.some(m => m.tool?.status === 'interrupted') || thoughts.some(m => m.reasoning!.status === 'interrupted')) parts.push({ text: '已中断' });
  const running = runningTools.length > 0 || thinking;
  const spans = messages.map(m => m.tool ?? m.reasoning).filter(s => s != null);
  const start = Math.min(...spans.map(s => s.startedAt));
  const end = running ? now : Math.max(...spans.map(s => s.finishedAt ?? s.startedAt));
  return { label, parts, totalMs: spans.length ? Math.max(0, end - start) : 0, running };
}

// ------------------------------------------------------------------ 运行状态

/**
 * 页脚状态行：只看最后一条提问之后的消息。
 * 计时从正在跑的那一步算起（和旁注里那一行的用时一致）；没有在跑的步骤时从提问算起
 */
export function currentActivity(session: Pick<AssistantSession, 'status' | 'messages'>) {
  const index = session.messages.findLastIndex(m => m.role === 'user');
  const messages = session.messages.slice(index + 1);
  const tool = messages.findLast(m => m.tool?.status === 'running');
  const thinking = messages.findLast(m => m.reasoning?.status === 'running');
  const last = messages.at(-1);
  const writing = last?.role === 'assistant' && !last.reasoning && Boolean(last.text);
  return {
    label: session.status === 'waiting' ? '等你回应' : tool ? runningLabel(tool.text) : thinking ? '正在思考' : writing ? '正在回复' : '等模型回应',
    detail: session.status === 'waiting' ? '' : tool?.tool?.progress || tool?.tool?.input?.split('\n').filter(Boolean).slice(0, 3).join(' ') || thinking?.reasoning?.text.slice(-160) || '',
    startedAt: tool?.tool?.startedAt ?? thinking?.reasoning?.startedAt ?? session.messages[index]?.createdAt,
  };
}

export type CapsuleStatus = 'idle' | 'running' | 'waiting' | 'reply' | 'incomplete';
/** 胶囊上的状态：在跑、等你，或者收起期间有了结果 */
export function capsuleStatus(status: AssistantSession['status'] | null, unseen: Unseen): CapsuleStatus {
  if (status === 'running') return 'running';
  if (status === 'waiting') return 'waiting';
  return unseen ?? 'idle';
}

/** SSE 每次推整份快照；签名没变的消息不重渲染 */
export function messageSignature(m: AssistantMessage) {
  return [m.id, m.text.length, m.tool?.status, m.tool?.input?.length, m.tool?.output?.length, m.tool?.progress, m.reasoning?.status, m.reasoning?.text.length, m.cards?.length].join('|');
}

// ------------------------------------------------------------------ 空白页

export type SuggestionKey = 'who' | 'source' | 'tags' | 'viewWho' | 'viewSource' | 'pickKnown' | 'recent' | 'unknown' | 'artists';
export interface Suggestion { key: SuggestionKey; title: string; sub: string; prompt: string }

/** 「可以这样问」：看图器 > 有选图 > 未识别页 > 默认。点了只填进输入框，不直接发 */
export function suggestions(ctx: { imageCount: number; viewing: boolean; page: string }): Suggestion[] {
  if (ctx.viewing) return [
    { key: 'viewWho', title: '这张图里是谁', sub: '', prompt: '这张图里是谁？' },
    { key: 'viewSource', title: '查这张图的出处', sub: '', prompt: '帮我查这张图的出处。' },
  ];
  if (ctx.imageCount > 0) return [
    { key: 'who', title: '这几张是谁', sub: '核对角色，认不出的给建议', prompt: '帮我看看选中的这几张图分别是谁，认不出的给出建议。' },
    { key: 'source', title: '查出处', sub: '上传搜图前会先问你', prompt: '帮我找这几张图的出处。' },
    { key: 'tags', title: '补标签', sub: '看看还缺哪些标签', prompt: '看看选中的这些图还缺哪些标签。' },
  ];
  let path = '';
  try { path = new URL(ctx.page, 'http://emaki.local').pathname; } catch { /* 当默认页 */ }
  if (path.startsWith('/unrecognized')) return [
    { key: 'pickKnown', title: '挑能认出的', sub: '从没认出的图里找', prompt: '看看「没认出」里哪些你能确认是谁，先列出来给我看。' },
  ];
  return [
    { key: 'recent', title: '最近收了什么', sub: '按角色和画师看最近一个月', prompt: '最近一个月我收了哪些角色和画师的图？' },
    { key: 'unknown', title: '找没认出的角色', sub: '按作品分一下', prompt: '找出还没认出角色的图，按作品分一下。' },
    { key: 'artists', title: '收得最多的画师', sub: '按收藏统计', prompt: '我收得最多的是哪些画师？' },
  ];
}

// ------------------------------------------------------------------ 排版：轮、旁注、图表、勘误

export interface Erratum { sentence: string; field?: string; imageIds: string[] }
/** 一轮里的条目。key：prose / erratum / system / plain 用 message.id，note 用 id，figure 用 `${message.id}:${card.id}` */
export type TurnItem =
  | { kind: 'prose'; message: AssistantMessage }
  | { kind: 'note'; id: string; messages: AssistantMessage[] }
  | { kind: 'figure'; message: AssistantMessage; card: AssistantCard; figureNo?: number; tableNo?: number }
  | { kind: 'erratum'; message: AssistantMessage; erratum: Erratum }
  | { kind: 'system'; message: AssistantMessage }
  | { kind: 'plain'; message: AssistantMessage };
/** 条目的 React key（SSE 快照更新时不变） */
export const turnItemKey = (item: TurnItem) => (item.kind === 'note' ? item.id : item.kind === 'figure' ? `${item.message.id}:${item.card.id}` : item.message.id);
export interface Turn {
  id: string;
  /** 第一条 user 之前的消息归入 request=null 的轮 */
  request: AssistantMessage | null;
  variant: 'ask' | 'answer' | 'resume';
  /** 回答型：parseAnswerText 拿到的提问标题 */
  answerTo?: string;
  /** 续跑型：按 resumeOf 找到的原请求文本 */
  resumeText?: string;
  items: TurnItem[];
  /** 本轮已结束且有正文时的落款 */
  colophon?: { model: string };
}

/**
 * 把消息排成一轮一轮（§6.1）。
 * 连续的思考和工具并成一条旁注；夹在里面的勘误条先缓存，等这段过程结束再按原顺序接在旁注后面。
 * 图 n 只数有图的卡、表 n 只数有列的卡，在整个会话里各自连续编号。
 */
export function layoutTranscript(messages: readonly AssistantMessage[], status: AssistantSession['status']): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | null = null, note: Extract<TurnItem, { kind: 'note' }> | null = null, held: TurnItem[] = [];
  let figures = 0, tables = 0;
  const open = (request: AssistantMessage | null): Turn => {
    const answer = request && !request.resumeOf ? parseAnswerText(request.text) : null;
    const t: Turn = { id: `turn:${request?.id ?? 'start'}`, request, variant: request?.resumeOf ? 'resume' : answer ? 'answer' : 'ask', items: [] };
    if (answer) t.answerTo = answer.title;
    if (request?.resumeOf) { const original = messages.find(m => m.id === request.resumeOf); if (original) t.resumeText = original.text; }
    turns.push(t);
    return t;
  };
  const settle = () => { if (turn && held.length) turn.items.push(...held); held = []; note = null; };
  messages.forEach((m, index) => {
    if (m.role === 'user') { settle(); turn = open(m); return; }
    const t: Turn = turn ?? (turn = open(null));
    if (isProcessMessage(m) && (m.tool || m.reasoning)) {
      if (!note) t.items.push(note = { kind: 'note', id: `note:${m.id}`, messages: [] });
      note.messages.push(m);
      return;
    }
    const erratum: TurnItem | null = m.undoToken ? { kind: 'erratum', message: m, erratum: erratumOf(messages, index) } : null;
    // 勘误不切碎旁注：过程还没结束就先存着
    if (erratum && note && !m.cards?.length) { held.push(erratum); return; }
    settle();
    for (const card of m.cards ?? []) {
      const item: Extract<TurnItem, { kind: 'figure' }> = { kind: 'figure', message: m, card };
      if (card.imageIds.length) item.figureNo = ++figures;
      if (card.columns?.length) item.tableNo = ++tables;
      t.items.push(item);
    }
    if (erratum) t.items.push(erratum);
    else if (m.cards?.length) { /* 只有图表 */ }
    else if (m.role === 'system') t.items.push({ kind: 'system', message: m });
    else if (m.role === 'assistant') { if (m.text.trim()) t.items.push({ kind: 'prose', message: m }); }
    // 没有 tool 元数据、也没有卡片和撤销的工具消息：一行小字
    else t.items.push({ kind: 'plain', message: m });
  });
  settle();
  turns.forEach((t, i) => {
    const ended = i < turns.length - 1 || status === 'idle' || status === 'error';
    const prose = t.items.findLast(item => item.kind === 'prose');
    if (ended && prose?.message.model) t.colophon = { model: prose.message.model };
  });
  return turns;
}

const MUTATING = ['update_images', 'edit_source', 'accept_suggestion'];
const ACTION_FIELD: Record<string, string> = { assign: '人物', unassign: '人物', kind: '类型', favorite: '收藏', rating: '分级', exclude: '排除', restore: '排除', artist: '画师' };
const TOOL_FIELD: Record<string, string> = { edit_source: '来源', accept_suggestion: '人物', edit_character: '角色' };

/** 从工具输出里取 MutationResult.message；输出可能是 MCP 包了一层的转义 JSON */
function mutationMessage(output: string): string {
  const fromJson = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const v = value as { message?: unknown; content?: { text?: unknown }[] };
    if (typeof v.message === 'string') return v.message;
    for (const part of Array.isArray(v.content) ? v.content : []) {
      if (typeof part?.text === 'string') { try { const s = fromJson(JSON.parse(part.text)); if (s) return s; } catch { /* 不是 JSON */ } }
    }
    return undefined;
  };
  try { const s = fromJson(JSON.parse(output)); if (s) return s.trim(); } catch { /* 截断了或不是 JSON，用正则 */ }
  const m = /\\?"message\\?"\s*:\s*\\?"((?:[^"\\]|\\.)*?)\\?"/.exec(output);
  if (!m) return '';
  let s = m[1]!;
  for (let i = 0; i < 2 && s.includes('\\'); i++) { try { s = JSON.parse(`"${s}"`) as string; } catch { break; } }
  return s.trim();
}

function parseInput(input?: string): Record<string, unknown> | null {
  try { const v: unknown = JSON.parse(input ?? ''); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}

/**
 * 勘误条（§9）：找改了图库的那次工具调用，取它返回的那句话、改了哪类字段、哪些图。
 * 先找输出里含这个 undoToken 的工具；找不到就取本轮里最近一次成功的 update_images / edit_source / accept_suggestion。
 * 契约里没有改前的值，不编造。
 */
export function erratumOf(messages: readonly AssistantMessage[], index: number): Erratum {
  const token = messages[index]?.undoToken;
  let source: AssistantMessage | undefined;
  if (token) for (let i = index - 1; i >= 0 && !source; i--) if (messages[i]!.tool?.output?.includes(token)) source = messages[i];
  if (!source) for (let i = index - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') break;
    if (m.tool?.status === 'succeeded' && MUTATING.includes(toolName(m.text))) { source = m; break; }
  }
  const sentence = (source?.tool?.output && mutationMessage(source.tool.output)) || '图库已更新';
  if (!source) return { sentence, imageIds: [] };
  const input = parseInput(source.tool?.input);
  const raw = input?.ids ?? input?.imageIds ?? (input?.imageId != null ? [input.imageId] : []);
  const imageIds = Array.isArray(raw) ? raw.filter(id => typeof id === 'string' || typeof id === 'number').map(String) : [];
  const name = toolName(source.text);
  const action = (input?.action as { type?: unknown } | undefined)?.type;
  const field = name === 'update_images' ? (typeof action === 'string' && ACTION_FIELD[action]) || '图片' : TOOL_FIELD[name];
  return { sentence, imageIds, ...(field ? { field } : {}) };
}
