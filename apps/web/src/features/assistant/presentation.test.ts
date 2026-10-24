import { describe, expect, it } from 'vitest';
import type { AssistantMessage, AssistantSession } from '@emaki/shared';
import {
  capsuleStatus, clampPosition, composerContext, currentActivity, erratumOf, formatClock, formatDuration, groupMessages, layoutTranscript,
  leafWidth, messageSignature, modelLabel, noteSummary, parseAnswerText, prettyInput, quote, reconcileModelSelection, rowPreview, runningLabel,
  selectionLabel, sheetForm, sheetWidthRange, splitQuestionTitle, suggestions, toggleResultImage, toolLabel, turnTime, unionMs, EFFORT_LABEL,
} from './presentation';

describe('assistant presentation', () => {
  it('recovers removed models and reasoning levels while preserving available user choices', () => {
    const models = [{ id: 'new', name: 'New', vision: true, efforts: ['low', 'high'], defaultEffort: 'low' }];
    const saved = { model: 'removed', effort: 'max' };
    expect(reconcileModelSelection(models, saved, saved)).toEqual({ model: 'new', effort: 'low' });
    expect(reconcileModelSelection(models, { model: 'new', effort: 'max' }, saved)).toEqual({ model: 'new', effort: 'low' });
    expect(reconcileModelSelection(models, { model: 'new', effort: '' }, saved)).toEqual({ model: 'new', effort: '' });
    expect(reconcileModelSelection(models, { model: '', effort: '' }, { model: 'new', effort: 'high' })).toEqual({ model: 'new', effort: 'high' });
    expect(reconcileModelSelection([], saved, saved)).toEqual({ model: '', effort: '' });
    expect(reconcileModelSelection([{ ...models[0]!, efforts: [], defaultEffort: '' }], { model: 'new', effort: 'high' }, saved)).toEqual({ model: 'new', effort: '' });
  });
  it('uses the result selection for both the composer count and outgoing context, including clearing it', () => {
    const pageSelection = new Set(['page-1', 'page-2', 'page-3', 'page-4', 'page-5']);
    const card = { id: 'result', title: '识别结果' };
    const selected = toggleResultImage(null, card, '17329', true);
    const context = composerContext('/unrecognized', 'unrecognized', pageSelection, undefined, selected);
    expect(context.imageIds).toEqual(['17329']);
    expect(context.selectionScope).toBe('assistant-result:result');
    const cleared = toggleResultImage(selected, card, '17329', false);
    expect(composerContext('/unrecognized', 'unrecognized', pageSelection, undefined, cleared).imageIds).toEqual([]);
    expect(composerContext('/unrecognized', 'unrecognized', pageSelection, undefined, null).imageIds).toHaveLength(5);
    expect(composerContext('/unrecognized', 'unrecognized', pageSelection, 'preview', selected).imageIds).toEqual(['preview']);
    const mixed = toggleResultImage(selected, { id: 'other-result', title: '其他图片' }, '18042', true);
    expect(mixed.ids).toEqual(['17329', '18042']);
    expect(toggleResultImage(mixed, card, '17329', false).ids).toEqual(['18042']);
  });
  it('keeps undo records out of side notes: they follow the process as errata and are not counted as steps', () => {
    const tool = (id: string, status: 'running' | 'succeeded' = 'succeeded'): AssistantMessage => ({ id, role: 'tool', text: 'emaki · update_images', tool: { status, startedAt: 1, finishedAt: 2 } });
    const messages: AssistantMessage[] = [
      { id: '1', role: 'user', text: 'apply' },
      tool('2'),
      { id: '3', role: 'tool', text: '图库已更新', undoToken: 'undo' },
      tool('3b'),
      { id: '4', role: 'tool', text: '结果', cards: [{ id: 'card', title: '图片', imageIds: ['1'] }] },
      { id: '5', role: 'assistant', text: 'done' },
      tool('6'),
    ];
    expect(groupMessages(messages).map(g => g.map(m => m.id))).toEqual([['1'], ['2'], ['3'], ['3b'], ['4'], ['5'], ['6']]);
    const [turn] = layoutTranscript(messages, 'idle');
    expect(turn!.items.map(item => item.kind)).toEqual(['note', 'erratum', 'figure', 'prose', 'note']);
    const note = turn!.items[0]!;
    expect(note.kind === 'note' && note.messages.map(m => m.id)).toEqual(['2', '3b']);
    expect(noteSummary(note.kind === 'note' ? note.messages : [], 10).label).toBe('修改图片 ×2');
    expect(messages).toHaveLength(7);
  });
  it('keeps dragged surfaces in view after resize or maximize', () => {
    expect(clampPosition({ x: 1200, y: 850 }, 440, 600, 1280, 720)).toEqual({ x: 832, y: 112 });
    expect(clampPosition({ x: -400, y: -500 }, 440, 600, 1280, 720)).toEqual({ x: 8, y: 8 });
    expect(clampPosition({ x: 832, y: 112 }, 880, 634, 1280, 720)).toEqual({ x: 392, y: 78 });
  });
  it('groups alternating reasoning and tools without crossing replies, cards or user turns', () => {
    const thought = (id: string): AssistantMessage => ({ id, role: 'assistant', text: '', reasoning: { text: 'checking', status: 'completed', startedAt: 1 } });
    const tool = (id: string): AssistantMessage => ({ id, role: 'tool', text: 'search' });
    const messages: AssistantMessage[] = [
      thought('1'), tool('2'), thought('3'), tool('4'), thought('5'),
      { id: '6', role: 'tool', text: '结果', cards: [{ id: 'card', title: '图片', imageIds: ['1'] }] },
      { id: '7', role: 'assistant', text: 'Found it' },
      thought('8'),
      { id: '9', role: 'user', text: 'Next' },
      tool('10'), thought('11'),
      { id: '12', role: 'system', text: 'Interrupted' },
    ];
    expect(groupMessages(messages).map(g => g.map(m => m.id))).toEqual([
      ['1', '2', '3', '4', '5'], ['6'], ['7'], ['8'], ['9'], ['10', '11'], ['12'],
    ]);
  });
});

const tool = (id: string, text: string, status: NonNullable<AssistantMessage['tool']>['status'], extra: Partial<NonNullable<AssistantMessage['tool']>> = {}): AssistantMessage =>
  ({ id, role: 'tool', text, tool: { status, startedAt: 1000, ...(status === 'running' ? {} : { finishedAt: 2000 }), ...extra } });
const thought = (id: string, status: NonNullable<AssistantMessage['reasoning']>['status'] = 'completed', ms = 7000): AssistantMessage =>
  ({ id, role: 'assistant', text: '', model: 'gpt', reasoning: { text: 'Compare the source image', status, startedAt: 0, ...(status === 'running' ? {} : { finishedAt: ms }) } });

describe('layoutTranscript', () => {
  it('splits turns at user messages, keeps earlier messages in a request-less turn and signs finished turns', () => {
    const messages: AssistantMessage[] = [
      { id: 's0', role: 'system', text: '处理已中断。' },
      { id: 'u1', role: 'user', text: 'one', createdAt: 1 },
      thought('r1'),
      { id: 'a1', role: 'assistant', text: 'answer', model: 'gpt' },
      { id: 'u2', role: 'user', text: 'two' },
      tool('t2', 'emaki · query_database', 'succeeded'),
      { id: 'a2', role: 'assistant', text: 'partial', model: 'gpt' },
    ];
    const turns = layoutTranscript(messages, 'running');
    expect(turns.map(t => [t.id, t.request?.id ?? null, t.items.map(i => i.kind)])).toEqual([
      ['turn:start', null, ['system']], ['turn:u1', 'u1', ['note', 'prose']], ['turn:u2', 'u2', ['note', 'prose']],
    ]);
    // 后面已有提问才算结束；还在跑的最后一轮不落款，没有正文的轮也不落款
    expect(turns.map(t => t.colophon)).toEqual([undefined, { model: 'gpt' }, undefined]);
    expect(layoutTranscript(messages, 'idle').at(-1)!.colophon).toEqual({ model: 'gpt' });
    expect(layoutTranscript(messages, 'error').at(-1)!.colophon).toEqual({ model: 'gpt' });
    expect(layoutTranscript(messages, 'waiting').at(-1)!.colophon).toBeUndefined();
  });
  it('recognises resumed requests and answers to emaki questions', () => {
    const turns = layoutTranscript([
      { id: 'u1', role: 'user', text: '这 3 张查一下出处' },
      { id: 'u2', role: 'user', text: '继续处理', resumeOf: 'u1' },
      { id: 'u3', role: 'user', text: '关于「要不要上传这 3 张图去搜图？」\n可以' },
      { id: 'u4', role: 'user', text: '继续处理', resumeOf: 'gone' },
    ], 'idle');
    expect(turns.map(t => t.variant)).toEqual(['ask', 'resume', 'answer', 'resume']);
    expect(turns[1]!.resumeText).toBe('这 3 张查一下出处');
    expect(turns[2]!.answerTo).toBe('要不要上传这 3 张图去搜图？');
    expect(turns[3]!.resumeText).toBeUndefined();
  });
  it('numbers figures and tables separately within each turn, image before table on the same card', () => {
    const card = (id: string, imageIds: string[], columns?: string[]) => ({ id, title: id, imageIds, ...(columns ? { columns, rows: [] } : {}) });
    const turns = layoutTranscript([
      { id: 'u1', role: 'user', text: 'a' },
      { id: 'c1', role: 'tool', text: 'x', cards: [card('both', ['1'], ['a']), card('table', [], ['a', 'b'])] },
      { id: 'u2', role: 'user', text: 'b' },
      { id: 'c2', role: 'tool', text: 'y', cards: [card('images', ['2', '3']), card('empty', [])] },
    ], 'idle');
    const numbers = turns.flatMap(t => t.items).map(i => (i.kind === 'figure' ? [i.card.id, i.figureNo, i.tableNo] : null));
    expect(numbers).toEqual([['both', 1, 1], ['table', undefined, 2], ['images', 1, undefined], ['empty', undefined, undefined]]);
  });
  it('shows tool messages without metadata as plain lines and skips empty replies', () => {
    const [turn] = layoutTranscript([
      { id: 'u1', role: 'user', text: 'a' },
      { id: 'p', role: 'tool', text: '已连接' },
      { id: 'e', role: 'assistant', text: '  ' },
    ], 'running');
    expect(turn!.items.map(i => i.kind)).toEqual(['plain']);
  });
});

describe('erratumOf', () => {
  const undoAt = (messages: AssistantMessage[]) => erratumOf(messages, messages.findIndex(m => m.undoToken));
  it('reads the sentence from escaped JSON output, including truncated output', () => {
    const wrapped = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ ok: true, message: '已把 2 张图归到 圣园未花', undoToken: 'u1' }) }] });
    expect(undoAt([
      tool('t', 'emaki · update_images', 'succeeded', { input: '{"ids":["a","b"],"action":{"type":"assign","characterId":"c"}}', output: wrapped }),
      { id: 'm', role: 'tool', text: '图库已更新', undoToken: 'u1' },
    ])).toEqual({ sentence: '已把 2 张图归到 圣园未花', field: '人物', imageIds: ['a', 'b'] });
    const truncated = '{"content":[{"type":"text","text":"{\\"ok\\":true,\\"message\\":\\"已排除 3 张\\",\\"undoToken\\":\\"u2\\"}"}],"structuredC…';
    expect(undoAt([
      tool('t', 'mcp__emaki__update_images', 'succeeded', { input: '{"imageIds":["x"],"action":{"type":"exclude"}}', output: truncated }),
      { id: 'm', role: 'tool', text: '图库已更新', undoToken: 'u2' },
    ])).toEqual({ sentence: '已排除 3 张', field: '排除', imageIds: ['x'] });
  });
  it('falls back to the latest successful mutation of the turn and to 图库已更新', () => {
    expect(undoAt([
      tool('old', 'update_images', 'succeeded', { input: '{"ids":["z"]}', output: '{"message":"上一轮"}' }),
      { id: 'u', role: 'user', text: 'again' },
      tool('src', 'emaki · edit_source', 'succeeded', { input: '{"imageId":"i7","source":{"url":"https://x"}}', output: 'ok' }),
      tool('q', 'emaki · query_database', 'succeeded', { output: 'rows' }),
      { id: 'm', role: 'tool', text: '图库已更新', undoToken: 'u3' },
    ])).toEqual({ sentence: '图库已更新', field: '来源', imageIds: ['i7'] });
    expect(undoAt([
      { id: 'u', role: 'user', text: 'again' },
      tool('bad', 'emaki · update_images', 'running', { input: 'not json' }),
      { id: 'm', role: 'tool', text: '图库已更新', undoToken: 'u4' },
    ])).toEqual({ sentence: '图库已更新', imageIds: [] });
    expect(undoAt([
      tool('k', 'emaki · update_images', 'succeeded', { input: '{"ids":[1,"2"],"action":{"type":"kind","value":"photo"}}', output: '{"message":"已改成照片","undoToken":"u5"}' }),
      { id: 'm', role: 'tool', text: '图库已更新', undoToken: 'u5' },
    ])).toEqual({ sentence: '已改成照片', field: '类型', imageIds: ['1', '2'] });
  });
});

describe('tool labels', () => {
  it('strips the emaki prefixes and translates known tools', () => {
    for (const raw of ['emaki · query_database', 'emaki·query_database', 'mcp__emaki__query_database', 'emaki_query_database', 'emaki.query_database', 'emaki:query_database', 'emaki/query_database']) {
      expect(toolLabel(raw)).toEqual({ label: '查询图库', known: true });
    }
    expect(runningLabel('emaki · read_media')).toBe('正在看图');
  });
  it('knows Pi tools and Codex names, and keeps unknown names as they are', () => {
    expect(toolLabel('bash')).toEqual({ label: '执行命令', known: true });
    expect(toolLabel('grep').label).toBe('查找文件');
    expect(runningLabel('bash')).toBe('正在执行命令');
    expect(toolLabel('联网搜索')).toEqual({ label: '联网搜索', known: true });
    expect(runningLabel('子任务 · spawn_agent')).toBe('正在子任务 · spawn_agent');
    expect(toolLabel('search_images')).toEqual({ label: 'search_images', known: false });
    expect(runningLabel('github · list_issues')).toBe('正在运行 github · list_issues');
  });
  it('previews a row by progress, first JSON string or first line', () => {
    expect(rowPreview(tool('a', 'x', 'running', { input: '{"a":1}', progress: '已扫描 1200 / 4000' }))).toBe('已扫描 1200 / 4000');
    expect(rowPreview(tool('b', 'x', 'succeeded', { input: '{"command":"python search.py","cwd":"F:/"}', progress: 'old' }))).toBe('python search.py');
    expect(rowPreview(tool('c', 'x', 'succeeded', { input: '\nSELECT 1\nFROM images' }))).toBe('SELECT 1');
    expect(rowPreview(thought('r'))).toBe('Compare the source image');
    expect(prettyInput('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyInput('plain')).toBe('plain');
  });
});

describe('formatting', () => {
  it('formats durations without ever showing 0 秒', () => {
    expect([0, 400, 999, 3200, 9950, 42000, 59000, 60000, 125000, 3600000].map(formatDuration)).toEqual([
      '0.1 秒', '0.4 秒', '1.0 秒', '3.2 秒', '10 秒', '42 秒', '59 秒', '1 分 00 秒', '2 分 05 秒', '60 分 00 秒',
    ]);
  });
  it('formats clocks', () => {
    expect([0, 42000, 725000, 3723000].map(formatClock)).toEqual(['0:00', '0:42', '12:05', '1:02:03']);
  });
  it('formats turn times by distance', () => {
    const now = new Date(2026, 9, 24, 18, 0).getTime();
    expect(turnTime(new Date(2026, 9, 24, 9, 5).getTime(), now)).toBe('09:05');
    expect(turnTime(new Date(2026, 9, 23, 14, 30).getTime(), now)).toBe('10月23日 14:30');
    expect(turnTime(new Date(2025, 9, 23, 14, 30).getTime(), now)).toBe('2025年10月23日');
  });
  it('parses answers to emaki questions and splits question titles', () => {
    expect(parseAnswerText('关于「要不要上传？」\n可以\n但只传一张')).toEqual({ title: '要不要上传？', value: '可以\n但只传一张' });
    expect(parseAnswerText('关于这件事')).toBeNull();
    expect(splitQuestionTitle('运行命令\npython a.py\n{\n  "cwd": "x"\n}\n')).toEqual({ lead: '运行命令', body: 'python a.py\n{\n  "cwd": "x"\n}' });
    expect(splitQuestionTitle('合集叫什么名字？')).toEqual({ lead: '合集叫什么名字？', body: '' });
  });
  it('quotes a clipped sentence without nesting the same brackets', () => {
    expect(quote('把重复里「完全相同」的\n留一张', 24)).toBe('「把重复里『完全相同』的 留一张」');
    expect(quote('一二三四五', 3)).toBe('「一二三…」');
  });
  it('labels selections and models', () => {
    expect(selectionLabel(3)).toBe('已选 3 张');
    expect(selectionLabel(0)).toBe('未选图片');
    expect(modelLabel('gpt-5.5-codex', [{ id: 'gpt-5.5-codex', name: 'GPT-5.5 Codex', efforts: [], vision: true }])).toBe('GPT-5.5 Codex');
    expect(modelLabel('gone')).toBe('gone');
    // DSH 的 JSON 数组 id：模型列表还没读到时取最后一段
    expect(modelLabel('["fake","sonnet"]')).toBe('sonnet');
    expect(modelLabel('[1,2]')).toBe('[1,2]');
    expect([EFFORT_LABEL.max, EFFORT_LABEL.ultra]).toEqual(['最高', '极高']);
  });
});

describe('sheet form', () => {
  it('picks darkroom, bottom sheet, float, bound or overlay', () => {
    expect(sheetForm(1440, 'leaf', 400, true, true)).toBe('darkroom');
    expect(sheetForm(1440, 'leaf', 400, true, false)).toBe('bound');
    // 窄窗里看图器开着也用底页，图不被挤没
    expect(sheetForm(600, 'leaf', 400, true, true)).toBe('sheet');
    expect(sheetForm(899, 'leaf', 400, true, true)).toBe('sheet');
    expect(sheetForm(900, 'leaf', 400, true, true)).toBe('darkroom');
    expect(sheetForm(600, 'float', 400, false, false)).toBe('sheet');
    expect(sheetForm(900, 'float', 400, false, false)).toBe('float');
    expect(sheetForm(899, 'float', 400, false, false)).toBe('overlay');
    expect(sheetForm(1212, 'leaf', 400, false, false)).toBe('bound');
    expect(sheetForm(1211, 'leaf', 400, false, false)).toBe('overlay');
    expect(sheetForm(1280, 'leaf', 600, false, false)).toBe('overlay');
  });
  it('limits the width handle and reports the width taken', () => {
    expect(sheetWidthRange('bound', 1280)).toEqual({ min: 340, max: 468 });
    expect(sheetWidthRange('bound', 2000)).toEqual({ min: 340, max: 600 });
    expect(sheetWidthRange('overlay', 1000)).toEqual({ min: 340, max: 560 });
    expect(sheetWidthRange('overlay', 420)).toEqual({ min: 340, max: 340 });
    // 覆盖时不超过手柄的上限（min(560, vw − 100)），显示的宽、aria-valuenow 和键盘范围一致
    expect(leafWidth('overlay', 600, 700)).toBe(560);
    expect(leafWidth('overlay', 600, 600)).toBe(500);
    expect(leafWidth('overlay', 400, 450)).toBe(350);
    expect(leafWidth('darkroom', 600, 1440)).toBe(400);
    expect(leafWidth('float', 400, 1440)).toBe(0);
  });
});

describe('side notes and status', () => {
  it('merges repeated tools, lists at most two kinds and marks failures and interruptions', () => {
    const summary = noteSummary([
      thought('r1', 'completed', 7000),
      tool('a', 'emaki · query_database', 'succeeded'),
      tool('b', 'emaki · query_database', 'failed'),
      tool('c', 'emaki · read_media', 'succeeded', { finishedAt: 5000 }),
      tool('d', 'emaki · query_database', 'succeeded'),
    ], 99999);
    expect(summary).toEqual({ label: '思考 7.0 秒，查询图库 ×3、看图', parts: [{ text: '1 项失败', tone: 'danger' }], totalMs: 7000, running: false });
    expect(noteSummary([tool('a', 'bash', 'succeeded'), tool('b', 'read', 'interrupted'), tool('c', 'grep', 'succeeded'), tool('d', 'bash', 'succeeded')], 0))
      .toMatchObject({ label: '执行命令 ×2、读取文件等 4 步', parts: [{ text: '已中断' }] });
    // 前文以「×3」结尾时，「等」前隔一个空格
    expect(noteSummary([tool('a', 'read_media', 'succeeded'), tool('b', 'read_media', 'succeeded'), tool('c', 'read_media', 'succeeded'), tool('d', 'bash', 'succeeded'), tool('e', 'ls', 'succeeded')], 0).label)
      .toBe('看图 ×3、执行命令等 5 步');
    expect(noteSummary([tool('a', 'read_media', 'succeeded'), tool('b', 'bash', 'succeeded'), tool('c', 'bash', 'succeeded'), tool('d', 'ls', 'succeeded')], 0).label)
      .toBe('看图、执行命令 ×2 等 4 步');
    expect(noteSummary([thought('r', 'interrupted')], 0).parts).toEqual([{ text: '已中断' }]);
  });
  it('describes running notes and measures them up to now', () => {
    expect(noteSummary([tool('a', 'emaki · query_database', 'running'), tool('b', 'bash', 'running')], 43000))
      .toEqual({ label: '正在执行命令等 2 项', parts: [], totalMs: 42000, running: true });
    expect(noteSummary([tool('a', 'emaki · query_database', 'succeeded'), thought('r', 'running')], 5000)).toMatchObject({ label: '正在思考', running: true, totalMs: 5000 });
  });
  it('labels a step that waits for approval', () => {
    expect(noteSummary([thought('r'), tool('a', 'bash', 'running')], 9000, true).label).toBe('等你批准：执行命令');
  });
  it('counts overlapping thinking once', () => {
    expect(unionMs([[0, 4000], [1000, 3000], [5000, 6000]])).toBe(5000);
    expect(unionMs([])).toBe(0);
    const think = (id: string, startedAt: number, finishedAt: number): AssistantMessage => ({ id, role: 'assistant', text: '', reasoning: { text: 'x', status: 'completed', startedAt, finishedAt } });
    expect(noteSummary([think('a', 0, 3000), think('b', 1000, 3000), think('c', 2000, 3000)], 0)).toMatchObject({ label: '思考 3.0 秒', totalMs: 3000 });
  });
  it('uses only the current turn for activity and tells waiting apart', () => {
    const running = tool('tool', 'bash', 'running', { input: 'python search.py', output: 'uploading' });
    const user: AssistantMessage = { id: 'user', role: 'user', text: 'Search', createdAt: 2000 };
    const session = { status: 'running', messages: [running, user] } as AssistantSession;
    expect(currentActivity(session)).toMatchObject({ label: '等模型回应', startedAt: 2000 });
    session.messages.push({ ...running, id: 'new-tool' });
    // 计时从这一步开始算，和旁注里那一行一致
    expect(currentActivity(session)).toMatchObject({ label: '正在执行命令', detail: 'python search.py', startedAt: 1000 });
    // JSON 参数取第一个字符串值，不显示原始 JSON
    session.messages.at(-1)!.tool = { ...running.tool!, input: '{"sql":"SELECT count(*) FROM images","limit":5}' };
    expect(currentActivity(session).detail).toBe('SELECT count(*) FROM images');
    session.messages.at(-1)!.tool = { ...running.tool!, progress: '已读取 3 张图片' };
    expect(currentActivity(session).detail).toBe('已读取 3 张图片');
    session.messages = [user, thought('think', 'running')];
    expect(currentActivity(session)).toMatchObject({ label: '正在思考', detail: 'Compare the source image' });
    session.messages = [user, { id: 'a', role: 'assistant', text: '找到', model: 'gpt' }];
    expect(currentActivity(session).label).toBe('正在回复');
    expect(currentActivity({ ...session, status: 'waiting' })).toMatchObject({ label: '等你回应', detail: '' });
  });
  it('shows capsule states and message signatures', () => {
    expect([capsuleStatus('running', 'reply'), capsuleStatus('waiting', null), capsuleStatus('idle', 'reply'), capsuleStatus('error', 'incomplete'), capsuleStatus(null, null)])
      .toEqual(['running', 'waiting', 'reply', 'incomplete', 'idle']);
    const a = tool('t', 'bash', 'running', { output: 'a' });
    expect(messageSignature(a)).toBe(messageSignature({ ...a }));
    expect(messageSignature(a)).not.toBe(messageSignature({ ...a, tool: { ...a.tool!, output: 'ab' } }));
    expect(messageSignature(a)).not.toBe(messageSignature({ ...a, tool: { ...a.tool!, status: 'succeeded' } }));
  });
});

describe('suggestions', () => {
  it('suggests by what the user is looking at', () => {
    const keys = (ctx: Parameters<typeof suggestions>[0]) => suggestions(ctx).map(s => s.key);
    expect(keys({ imageCount: 1, viewing: true, page: '/gallery' })).toEqual(['viewWho', 'viewSource']);
    expect(keys({ imageCount: 3, viewing: false, page: '/gallery' })).toEqual(['who', 'source', 'tags']);
    expect(keys({ imageCount: 0, viewing: false, page: '/unrecognized?bucket=unsure' })).toEqual(['pickKnown']);
    expect(keys({ imageCount: 0, viewing: false, page: '/' })).toEqual(['recent', 'unknown', 'artists']);
  });
});
