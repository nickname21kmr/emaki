import { useState } from 'react';
import type { AssistantCard, AssistantDetection, AssistantMessage, AssistantModel, AssistantSession } from '@emaki/shared';
import { composerContext, toggleResultImage, type ResultSelection } from './presentation';
import type { ConversationView, SessionSummary } from './useConversation';
import { useAssistantView } from './viewState';

/**
 * 只给 /dev/ui 用的假会话（§21）：不连模型也能看全部状态。不发任何请求。
 * 对应审计的 S1–S6，再补上 emaki 提问、续跑、压测这几种。
 */
export type FixtureKey = 'complete' | 'running' | 'streaming' | 'waiting' | 'emakiQuestion' | 'emakiBlocked' | 'error' | 'interrupted' | 'resumed' | 'empty' | 'long';
export const FIXTURE_KEYS: readonly FixtureKey[] = ['complete', 'running', 'streaming', 'waiting', 'emakiQuestion', 'emakiBlocked', 'error', 'interrupted', 'resumed', 'empty', 'long'];

export type FixtureFlag = 'noBackend' | 'loading' | 'disconnected' | 'modelsLoading' | 'modelsError' | 'nonVision' | 'resultSelected' | 'viewing' | 'busy' | 'opError';
export const FIXTURE_FLAGS: readonly FixtureFlag[] = ['noBackend', 'loading', 'disconnected', 'modelsLoading', 'modelsError', 'nonVision', 'resultSelected', 'viewing', 'busy', 'opError'];

export type Fixtures = ReturnType<typeof assistantFixtures>;

const M = 'gpt-5.5-codex';

const MARKDOWN = [
  '找到 **14 张**圣园未花的泳装插画，其中 3 张是这周新收的。',
  '',
  '### 还没认出角色的',
  '未识别里有 2 张画风和构图都很接近，建议分数偏低：',
  '',
  '1. `i8751`：建议「圣园未花」0.62，低于自动采纳阈值 0.85',
  '2. `i4443`：没有建议，主色和 i5377 几乎一致',
  '',
  '- 两张都来自同一位画师 [ask_(askzy)](https://www.pixiv.net/users/1)',
  '- 在图库里搜 [同一位画师的图](/gallery?q=x)',
  '- 文件都在 `E:/下载/pixiv/2026-10/`',
  '',
  '| 图片 | 建议角色 | 分数 |',
  '| --- | --- | --- |',
  '| i8751 | 圣园未花 | 0.62 |',
  '| i4443 | — | — |',
  '',
  '> 要我把这两张归到「圣园未花」吗？可以撤销。',
  '',
  '![未花的泳装立绘](https://example.com/a.png)',
  '',
  '```sql',
  "SELECT id, file_name FROM images WHERE character_id = 'c12' AND theme = 'swim' ORDER BY added_at DESC LIMIT 40;",
  '```',
  '',
  '---',
  '',
  '以上按添加时间倒序。',
].join('\n');

const STACK = [
  'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
  '    at Codex.turn (codex-rs/core/src/client.rs:812)',
  '    at Session.run (codex-rs/core/src/codex.rs:1544)',
  '    retry 5/5',
].join('\n');

/** 假数据。imageIds 用 DevUiPage 已经加载的图；不够时补上不存在的 id（显示「已移除」） */
export function assistantFixtures(imageIds: readonly string[], now = Date.now()) {
  const pool = [...new Set(imageIds)];
  let missing = 0;
  const pick = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => pool[offset + i] ?? `missing-${++missing}`);
  const at = (secondsAgo: number) => now - secondsAgo * 1000;
  const iso = (secondsAgo: number) => new Date(at(secondsAgo)).toISOString();

  const tool = (id: string, text: string, status: NonNullable<AssistantMessage['tool']>['status'], extra: Partial<NonNullable<AssistantMessage['tool']>> = {}, ago = 60, duration = 1.4): AssistantMessage => ({
    id, role: 'tool', text,
    tool: { status, startedAt: at(ago), ...(status === 'running' ? {} : { finishedAt: at(ago - duration) }), ...extra },
  });
  const think = (id: string, text: string, status: NonNullable<AssistantMessage['reasoning']>['status'], ago = 70, duration = 6): AssistantMessage => ({
    id: `${id}:reasoning`, role: 'assistant', text: '', model: M,
    reasoning: { text, status, startedAt: at(ago), ...(status === 'running' ? {} : { finishedAt: at(ago - duration) }) },
  });
  const user = (id: string, text: string, ago: number, page: string, ids: string[] = [], extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
    id, role: 'user', text, createdAt: at(ago), context: { page, imageIds: ids, selectionScope: 'gallery' }, ...extra,
  });
  const reply = (id: string, text: string): AssistantMessage => ({ id, role: 'assistant', model: M, text });
  const cards = (id: string, card: AssistantCard): AssistantMessage => ({ id, role: 'tool', text: card.title, cards: [card] });
  const session = (key: FixtureKey, title: string, status: AssistantSession['status'], ago: number, messages: AssistantMessage[], extra: Partial<AssistantSession> = {}): AssistantSession => ({
    id: `fx-${key}`, title, backend: 'codex', model: M, effort: 'high', status, messages, questions: [], updatedAt: iso(ago), ...extra,
  });

  const models: AssistantModel[] = [
    { id: M, name: 'GPT-5.5 Codex', provider: 'openai', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', vision: true },
    { id: 'gpt-5.5-mini', name: 'GPT-5.5 mini', provider: 'openai', efforts: ['low', 'medium', 'high'], defaultEffort: 'low', vision: true },
    { id: 'deepseek-v4', name: 'DeepSeek V4', provider: 'deepseek', efforts: [], vision: false },
  ];

  // 第 1 轮的图卡：14 张（前 12 张之外还有 2 张，触发「展开其余」），混一个不存在的
  const card1: AssistantCard = { id: 'fx-card-1', title: '圣园未花 · 泳装', imageIds: [...pick(13), 'missing-0'] };
  const assigned = pick(2, 2);
  const complete = session('complete', '找最近收的未花泳装图，顺便看看哪些还没认出角色', 'idle', 10, [
    user('fx-c-u1', '帮我找最近收的未花泳装图，顺便看看哪些还没认出角色。', 180, '/gallery?theme=swim', pick(2)),
    think('fx-c-r1', '用户要找圣园未花的泳装插画。先按角色和画面主题查图库，再去未识别里找主色和构图相近、建议分数偏低的图。', 'completed', 176, 7),
    tool('fx-c-t1', 'emaki · query_database', 'succeeded', { input: '{\n  "sql": "SELECT id FROM images WHERE character_id = \'c12\' AND theme = \'swim\' ORDER BY added_at DESC LIMIT 40"\n}', output: '14 rows\ni5377, i4502, i2903, i4443 …' }, 168, 1.2),
    tool('fx-c-t2', 'emaki · query_database', 'failed', { input: '{\n  "sql": "SELECT id FROM images WHERE status = \'untagged\' AND theme2 = \'swim\'"\n}', output: 'Error: no such column: theme2', exitCode: 1 }, 166, 0.3),
    tool('fx-c-t3', 'emaki · read_media', 'succeeded', { input: JSON.stringify({ ids: pick(3) }), output: '已查看 3 张缩略图（480px）' }, 163, 3.1),
    reply('fx-c-a1', MARKDOWN),
    cards('fx-c-c1', card1),
    cards('fx-c-c2', { id: 'fx-card-2', title: '未识别里的候选', imageIds: [], columns: ['图片', '建议角色', '分数', '文件夹'], rows: [['i8751', '圣园未花', 0.62, 'E:/下载/pixiv/2026-10'], ['i4443', null, null, 'E:/下载/pixiv/2026-10'], ['i4502', '圣园未花', 0.91, { root: 'E:/图库', depth: 2 }]] }),
    cards('fx-c-c3', { id: 'fx-card-3', title: '本周新收', imageIds: [], columns: ['类型', '张数'], rows: [['插画', 42], ['别册', 7], ['未识别', null], ['已收藏', true]] }),
    user('fx-c-u2', '好，把那两张归到圣园未花', 60, '/unrecognized?bucket=suggested'),
    tool('fx-c-t4', 'emaki · update_images', 'succeeded', {
      input: JSON.stringify({ operationId: 'fx-op-1', ids: assigned, action: { type: 'assign', characterId: 'c12' } }),
      output: '{"ok":true,"message":"已把 2 张图归到 圣园未花","undoToken":"undo-fx-1"}',
    }, 50, 0.4),
    { id: 'fx-c-m1', role: 'tool', text: '图库已更新', undoToken: 'undo-fx-1' },
    reply('fx-c-a2', '已把 2 张图归到 **圣园未花**。放错了的话，点上面的撤销。'),
  ]);

  const running = session('running', '这三张图里是谁？顺便查一下出处', 'running', 5, [
    user('fx-r-u1', '这三张图里是谁？顺便查一下出处', 42, '/characters/c12', pick(3)),
    think('fx-r-r1', '先看图：金发、蓝色铠甲裙、旗帜。', 'completed', 40, 4),
    tool('fx-r-t1', 'emaki · read_media', 'succeeded', { input: JSON.stringify({ ids: pick(3) }), output: '已查看 3 张（960px）' }, 35, 2.2),
    tool('fx-r-t2', 'emaki · query_database', 'succeeded', { input: '{"sql":"SELECT name FROM characters WHERE name LIKE \'%贞德%\'"}', output: '2 rows' }, 32, 0.6),
    tool('fx-r-t3', '执行命令', 'failed', { input: JSON.stringify({ command: 'python scripts/hash.py --ids i9031', cwd: 'F:/Emaki/data/assistant/workspaces/3f2c' }), output: 'Traceback (most recent call last):\n  File "hash.py", line 3\nModuleNotFoundError: No module named PIL', exitCode: 1 }, 30, 1.1),
    tool('fx-r-t4', 'emaki · describe_database', 'succeeded', { input: '{}', output: 'images, characters, works, sources …' }, 26, 0.2),
    tool('fx-r-t5', '联网搜索', 'running', { input: '{\n  "query": "jeanne d\'arc fgo swimsuit pixiv",\n  "engines": ["saucenao", "yandex"],\n  "limit": 20\n}', progress: '已扫描 1200 / 4000' }, 12),
    think('fx-r-r2', '画面里应该是贞德（Fate/Grand Order），服装是第三再临。等搜图返回作品号后再去 Pixiv 核对画师和标签……', 'running', 6),
  ]);

  const streaming = session('streaming', '最近收得最多的作品', 'running', 1, [
    user('fx-s-u1', '这个月我收得最多的是哪几部作品？', 15, '/'),
    tool('fx-s-t1', 'emaki · query_database', 'succeeded', { input: '{"sql":"SELECT work, COUNT(*) FROM images GROUP BY work"}', output: '5 rows' }, 12, 0.5),
    reply('fx-s-a1', '这个月新收 312 张，按作品排前几的是：\n\n| 作品 | 张数 | 占比 |\n| --- | --- | --- |\n\n查询用的是：\n\n```sql\nSELECT work, COUNT(*) FROM images\nWHERE added_at > '),
  ]);

  const waiting = session('waiting', '这三张找出处，同一画师就建合集', 'waiting', 3, [
    user('fx-w-u1', '把这 3 张找出处，确认是同一个画师的话就建个合集', 30, '/gallery?artist=ask_(askzy)', pick(3)),
    think('fx-w-r1', '三张的笔触和签名位置一致。建合集要运行一条命令，先征求同意。', 'completed', 28, 5),
    tool('fx-w-t1', 'emaki · read_media', 'succeeded', { input: JSON.stringify({ ids: pick(3) }), output: '已查看 3 张' }, 22, 2),
    reply('fx-w-a1', '这三张看起来是同一位画师。建合集前要运行一条命令，先问一下你。'),
  ], {
    questions: [
      { id: 'fx-q-approval', kind: 'approval', title: '运行命令\npython scripts/make_collection.py --name "ask 画集" --ids i9013,i9014,i9017\n{\n  "cwd": "F:/Emaki/data/assistant/workspaces/3f2c",\n  "sandbox": "workspace-write"\n}' },
      { id: 'fx-q-input', kind: 'input', title: '合集叫什么名字？', options: ['ask 画集', 'ask 的泳装', '按投稿日期命名，比如「ask 2026 年 10 月投稿合集（Pixiv 上的三张连作，含两张差分）」', '先不建'] },
    ],
  });

  const emakiQuestion = { id: 'fx-q-emaki', kind: 'input' as const, source: 'emaki' as const, title: '要把这 3 张图（去掉元数据、缩小后的副本）上传到 SauceNAO 和 Yandex 查出处吗？', options: ['上传并查找', '只用 SauceNAO', '先不要'], context: { page: '/unrecognized?bucket=unsure', imageIds: pick(3, 3) } };
  const askTurn = [
    user('fx-e-u1', '这 3 张是哪来的？', 40, '/unrecognized?bucket=unsure', pick(3, 3)),
    tool('fx-e-t1', 'emaki · read_media', 'succeeded', { input: JSON.stringify({ ids: pick(3, 3) }), output: '已查看 3 张' }, 35, 1.8),
    tool('fx-e-t2', 'emaki · ask_user', 'succeeded', { input: JSON.stringify({ title: emakiQuestion.title, options: emakiQuestion.options }), output: '已提问' }, 30, 0.1),
    reply('fx-e-a1', '查出处要把图片上传到搜图网站，我先问一下你。'),
  ];
  const emakiIdle = session('emakiQuestion', '这 3 张是哪来的', 'idle', 4, askTurn, { questions: [emakiQuestion] });
  const emakiBlocked = session('emakiBlocked', '这 3 张是哪来的（还在跑）', 'running', 4, [
    ...askTurn,
    tool('fx-e-t3', 'emaki · query_database', 'running', { input: '{"sql":"SELECT * FROM sources WHERE image_id IN (…)"}' }, 4),
  ], { questions: [emakiQuestion] });

  const error = session('error', '整理重复图', 'error', 2, [
    user('fx-x-u1', '把重复里「完全相同」的都按推荐处理掉', 300, '/duplicates'),
    think('fx-x-r1', '先列出完全相同的组……', 'interrupted', 298, 3),
    tool('fx-x-t1', 'emaki · query_database', 'succeeded', { input: '{"sql":"SELECT group_id FROM duplicates WHERE kind = \'exact\'"}', output: '12 组' }, 290, 0.6),
    tool('fx-x-t2', 'emaki · manage_job', 'interrupted', { input: '{"action":"start","kind":"dedupe"}' }, 285, 20),
    { id: 'fx-x-s1', role: 'system', text: '这次处理遇到问题。', details: STACK },
  ], { interruption: { messageId: 'fx-x-u1', reason: 'error' } });

  const interrupted = session('interrupted', '核对这 4 张的角色', 'idle', 20, [
    user('fx-i-u1', '把这 4 张的角色都核对一遍，认错的改掉', 900, '/gallery', pick(4)),
    think('fx-i-r1', '先逐张看图，再和已关联的角色比对。', 'completed', 895, 4),
    tool('fx-i-t1', 'emaki · read_media', 'interrupted', { input: JSON.stringify({ ids: pick(4) }) }, 890, 12),
    { id: 'fx-i-s1', role: 'system', text: '处理已中断。' },
  ], { interruption: { messageId: 'fx-i-u1', reason: 'restart' } });

  const resumed = session('resumed', '这 3 张查一下出处', 'idle', 30, [
    user('fx-u-u1', '这 3 张查一下出处，查到了就填上来源', 900, '/gallery', pick(3, 1)),
    tool('fx-u-t1', 'emaki · read_media', 'succeeded', { input: JSON.stringify({ ids: pick(3, 1) }), output: '已查看 3 张' }, 890, 1.5),
    { id: 'fx-u-s1', role: 'system', text: '处理已中断。' },
    user('fx-u-u2', '继续处理', 600, '/gallery', pick(3, 1), { resumeOf: 'fx-u-u1' }),
    tool('fx-u-t2', 'emaki · ask_user', 'succeeded', { input: '{"title":"要不要上传这 3 张图去搜图？"}', output: '已提问' }, 590, 0.1),
    reply('fx-u-a1', '查出处需要上传这 3 张图，我先问了你。'),
    user('fx-u-u3', '关于「要不要上传这 3 张图去搜图？」\n可以', 300, '/gallery', pick(3, 1)),
    tool('fx-u-t3', '联网搜索', 'succeeded', { input: '{"query":"saucenao i9013"}', output: '3 条结果' }, 290, 8.4),
    reply('fx-u-a2', '三张都来自 Pixiv 上的同一位画师，作品号已经填进来源。'),
  ]);

  const empty = session('empty', '新对话', 'idle', 0, []);

  // 压测：3 轮共 40 次工具调用，一张 30 图的卡，一张 20 行的表
  const many = (prefix: string, n: number, ago: number) => Array.from({ length: n }, (_, i) => {
    const names = ['emaki · query_database', 'emaki · query_database', 'emaki · read_media', 'emaki · describe_database', '执行命令'];
    return tool(`${prefix}-${i}`, names[i % names.length]!, i % 9 === 8 ? 'failed' : 'succeeded', { input: `{"sql":"SELECT * FROM images LIMIT ${i + 1}"}`, output: `${i + 1} rows`, ...(i % 9 === 8 ? { exitCode: 1 } : {}) }, ago - i * 2, 0.4 + (i % 5) * 0.7);
  });
  const long = session('long', '把图库按作品整理一遍（压测）', 'idle', 60, [
    user('fx-l-u1', '把图库按作品整理一遍，先看看现在的分布。', 1800, '/gallery'),
    ...many('fx-l-a', 15, 1790),
    reply('fx-l-a1', '分布如下，下一步按作品逐个核对。'),
    cards('fx-l-c1', { id: 'fx-card-long', title: '作品分布', imageIds: [], columns: ['作品', '张数', '已认出', '未认出'], rows: Array.from({ length: 20 }, (_, i) => [`作品 ${i + 1}`, 400 - i * 17, 300 - i * 13, 100 - i * 4]) }),
    user('fx-l-u2', '先看蔚蓝档案的', 1200, '/works/w1'),
    ...many('fx-l-b', 15, 1190),
    cards('fx-l-c2', { id: 'fx-card-many', title: '蔚蓝档案 · 未认出', imageIds: pick(30, 4) }),
    user('fx-l-u3', '好，继续', 600, '/works/w1'),
    ...many('fx-l-c', 10, 590),
    reply('fx-l-a3', '这一批核对完了。'),
  ]);

  const sessions: Record<FixtureKey, AssistantSession> = {
    complete, running, streaming, waiting, emakiQuestion: emakiIdle, emakiBlocked, error, interrupted, resumed, empty, long,
  };

  const summary = (s: AssistantSession): SessionSummary => ({ id: s.id, title: s.title, backend: s.backend, updatedAt: s.updatedAt });
  const sessionList: SessionSummary[] = [
    ...[empty, streaming, waiting, running, error, complete, emakiIdle, resumed, long].map(summary),
    { id: 'fx-pi-1', title: '用 Pi 查一下本周新收', backend: 'pi', updatedAt: iso(3600) },
    { id: 'fx-pi-2', title: '整理别册里的截图', backend: 'pi', updatedAt: iso(86400 * 3) },
    { id: 'fx-dsh-1', title: 'DSH：核对角色别名', backend: 'dsh', updatedAt: iso(86400 * 40) },
  ];

  const detection = (backend: AssistantDetection['backend'], n: number): AssistantDetection => ({
    backend, available: true, detail: `可用 · ${n} 个模型`,
    models: Array.from({ length: n }, (_, i) => ({ id: `${backend}-model-${i + 1}`, name: `${backend.toUpperCase()} 模型 ${i + 1}`, efforts: [], vision: i % 2 === 0 })),
  });
  const detections = {
    allOk: [detection('codex', 7), detection('pi', 3), detection('dsh', 5)],
    mixed: [detection('codex', 7), detection('pi', 3), { backend: 'dsh', available: false, detail: '未找到 DSH', models: [] } as AssistantDetection],
    none: [] as AssistantDetection[],
  };

  return { models, sessions, sessionList, detections, imageIds: pool, card1 };
}

interface FixtureState {
  session: AssistantSession | null;
  draft: string;
  model: string;
  effort: string;
  connected: boolean;
  error: string;
  resultSelection: ResultSelection | null;
}

const withoutInterruption = ({ interruption: _ignored, ...s }: AssistantSession): AssistantSession => s;

/**
 * 夹具版的 ConversationView：在本地实现全部 actions，不发请求。
 * key、flags 或 fx 变了就重置。flags 可以叠加（见 FixtureFlag）。
 */
export function useFixtureConversation(key: FixtureKey, flags: readonly FixtureFlag[], fx: Fixtures): ConversationView {
  const has = (flag: FixtureFlag) => flags.includes(flag);
  const init = (): FixtureState => ({
    session: has('loading') ? null : structuredClone(fx.sessions[key]),
    draft: '',
    model: has('nonVision') ? 'deepseek-v4' : has('modelsLoading') || has('modelsError') ? '' : M,
    effort: has('nonVision') || has('modelsLoading') || has('modelsError') ? '' : 'high',
    connected: !has('disconnected'),
    error: has('opError') ? '发送失败：请求超时' : '',
    resultSelection: has('resultSelected') ? { cardId: fx.card1.id, title: fx.card1.title, ids: fx.card1.imageIds.slice(0, 3) } : null,
  });
  const signature = `${key}|${[...flags].sort().join(',')}`;
  const [state, setState] = useState(init);
  const [basis, setBasis] = useState({ signature, fx });
  if (basis.signature !== signature || basis.fx !== fx) {
    setBasis({ signature, fx });
    setState(init());
  }
  const patch = (next: Partial<FixtureState>) => setState(s => ({ ...s, ...next }));
  const update = (fn: (s: AssistantSession) => AssistantSession) => setState(s => (s.session ? { ...s, session: fn(s.session) } : s));

  const viewedId = has('viewing') ? fx.imageIds[0] ?? 'missing-0' : undefined;
  const selected = new Set(has('nonVision') ? fx.imageIds.slice(0, 2) : []);
  const context = composerContext('/gallery', 'gallery', selected, viewedId, state.resultSelection);
  const refetch = () => {};
  const models: ConversationView['models'] = has('modelsLoading') ? { isFetching: true, error: null, refetch }
    : has('modelsError') ? { isFetching: false, error: new Error('Codex 未登录：请先运行 codex login'), refetch }
    : { data: fx.models, isFetching: false, error: null, refetch };
  const lastUser = (s: AssistantSession) => s.messages.findLast(m => m.role === 'user');

  return {
    backend: has('noBackend') ? null : 'codex',
    sessions: { data: fx.sessionList, isLoading: false, error: null, refetch: () => {} },
    sessionId: state.session?.id ?? fx.sessions[key].id,
    session: state.session,
    models,
    model: state.model,
    effort: state.effort,
    connected: state.connected,
    busy: has('busy'),
    error: state.error,
    draft: state.draft,
    setDraft: draft => patch({ draft }),
    context,
    viewedId,
    resultSelection: state.resultSelection,
    actions: {
      send: () => {
        const text = state.draft;
        if (!text.trim()) return;
        update(s => ({ ...withoutInterruption(s), status: 'running', questions: [], messages: [...s.messages, { id: `fx-send-${Date.now()}`, role: 'user', text, createdAt: Date.now(), context }] }));
        patch({ draft: '' });
      },
      stop: () => update(s => {
        const request = lastUser(s);
        return { ...s, status: 'idle', ...(request ? { interruption: { messageId: request.resumeOf ?? request.id, reason: 'stopped' as const } } : {}) };
      }),
      resume: () => update(s => {
        const original = s.messages.find(m => m.id === s.interruption?.messageId);
        if (!original) return s;
        const message: AssistantMessage = { id: `fx-resume-${Date.now()}`, role: 'user', text: '继续处理', createdAt: Date.now(), resumeOf: original.id, ...(original.context ? { context: original.context } : {}) };
        return { ...withoutInterruption(s), status: 'running', messages: [...s.messages, message] };
      }),
      answer: questionId => {
        update(s => {
          const questions = s.questions.filter(q => q.id !== questionId);
          return { ...s, questions, status: s.status === 'waiting' && !questions.length ? 'running' : s.status };
        });
        useAssistantView.getState().setQuestionDraft(questionId, '');
      },
      chooseSession: id => {
        const found = Object.values(fx.sessions).find(s => s.id === id);
        if (found) patch({ session: structuredClone(found) });
      },
      newSession: () => patch({ session: structuredClone(fx.sessions.empty) }),
      pickModel: id => patch({ model: id, effort: fx.models.find(m => m.id === id)?.defaultEffort ?? '' }),
      pickEffort: e => patch({ effort: e === 'default' ? '' : e }),
      reconnect: () => patch({ connected: true }),
      dismissError: () => patch({ error: '' }),
      selectResult: (card, id, checked) => setState(s => ({ ...s, resultSelection: toggleResultImage(s.resultSelection ?? { cardId: card.id, title: card.title, ids: context.imageIds }, card, id, checked) })),
      clearResultSelection: () => patch({ resultSelection: null }),
      // 600ms 后成功；token 里有 fail 的算连不上，有 gone 的算已失效
      undo: token => new Promise(resolve => setTimeout(() => resolve(token.includes('fail') ? 'failed' : token.includes('gone') ? 'gone' : 'ok'), 600)),
    },
  };
}
