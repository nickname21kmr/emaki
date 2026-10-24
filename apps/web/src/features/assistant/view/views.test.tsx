import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui';
import type { SheetForm } from '../dock';
import { assistantFixtures, FIXTURE_KEYS, useFixtureConversation, type FixtureFlag, type FixtureKey } from '../fixtures';
import { Capsule } from './Capsule';
import { Footer } from './Footer';
import { Sheet } from './Sheet';

const fx = assistantFixtures(Array.from({ length: 40 }, (_, i) => `i${i + 1}`), Date.UTC(2026, 9, 24, 6));

function Stage({ fixture, flags = [], form = 'bound' }: { fixture: FixtureKey; flags?: FixtureFlag[]; form?: SheetForm }) {
  const conv = useFixtureConversation(fixture, flags, fx);
  return <Sheet frame="static" form={form} conv={conv} />;
}

/** 出错了，但正文里没有中断便笺和系统注 */
function BareError() {
  const conv = useFixtureConversation('error', [], fx);
  const { interruption: _, ...session } = conv.session!;
  return <Footer conv={{ ...conv, session: { ...session, messages: session.messages.filter(m => m.role !== 'system') } }} />;
}

const render = (node: React.ReactNode) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>
      <TooltipProvider>{node}</TooltipProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);

// 只做静态渲染：每种夹具、每种形态都能排出来，关键文案在
describe('附页静态渲染', () => {
  it.each(FIXTURE_KEYS)('%s 能排出来', key => {
    const html = render(<Stage fixture={key} />);
    expect(html).toContain('data-assistant-sheet');
    expect(html).toContain('role="log"');
  });

  it.each<SheetForm>(['bound', 'overlay', 'float', 'darkroom', 'sheet'])('形态 %s', form => {
    const html = render(<Stage fixture="complete" form={form} />);
    expect(html).toContain(form === 'bound' ? 'aria-labelledby' : 'role="dialog"');
  });

  it('完成的会话：图表编号、勘误条写出改动的那句话、落款', () => {
    const html = render(<Stage fixture="complete" />);
    for (const text of ['图 1', '表 1', '表 2', '已把 2 张图归到 圣园未花', '撤销', '—— GPT-5.5 Codex', '展开其余 2 张', '逐张看 →', '人物']) expect(html).toContain(text);
  });

  it('运行中：旁注露出最后几步，状态行写正在做什么，停止按钮', () => {
    const html = render(<Stage fixture="running" />);
    for (const text of ['前面还有 4 步', '正在联网搜索', '已扫描 1200 / 4000', '停止', '可以先写下一条，这一轮结束后再发']) expect(html).toContain(text);
  });

  it('等你回应：许可、编号选项、自由输入，状态行不转圈', () => {
    const html = render(<Stage fixture="waiting" />);
    for (const text of ['需要你的许可', '允许这次操作', '拒绝', '助手在问', '或者写下你的回答', '等你回应']) expect(html).toContain(text);
    expect(html.match(/bg-shu/g)?.length).toBe(1);
  });

  it('emaki 提问在这一轮跑完前不能答，写出原因', () => {
    expect(render(<Stage fixture="emakiBlocked" />)).toContain('这一轮结束后再回答。');
    expect(render(<Stage fixture="emakiQuestion" flags={['disconnected']} />)).toContain('连上之后再回答。');
  });

  it('中断、出错、续跑、回答型问句', () => {
    expect(render(<Stage fixture="interrupted" />)).toContain('Emaki 重启过，上次请求停在了一半。');
    const error = render(<Stage fixture="error" />);
    for (const text of ['处理出错，上次请求停在了一半。', '重试并继续', '查看详情']) expect(error).toContain(text);
    // 正文里已经有中断便笺和系统注，页脚不再多一处「出错了」；正文没写时才由状态行说
    expect(error).not.toContain('出错了');
    expect(render(<BareError />)).toContain('出错了');
    const resumed = render(<Stage fixture="resumed" />);
    for (const text of ['继续处理上次的请求', '接着「', '回应「要不要上传这 3 张图去搜图？」', '处理已中断']) expect(resumed).toContain(text);
  });

  it('空会话给「可以这样问」，没有 backend 时没有输入区', () => {
    expect(render(<Stage fixture="empty" />)).toContain('可以这样问');
    const none = render(<Stage fixture="empty" flags={['noBackend']} />);
    expect(none).toContain('还没选 Agent 应用');
    expect(none).not.toContain('给助手的消息');
  });

  it('页脚：断线、模型错误、不识图、结果图选择、看图器', () => {
    expect(render(<Stage fixture="complete" flags={['disconnected']} />)).toContain('连接断了，正在重连');
    expect(render(<Stage fixture="complete" flags={['modelsError']} />)).toContain('模型列表没读出来：Codex 未登录：请先运行 codex login');
    expect(render(<Stage fixture="complete" flags={['nonVision']} />)).toContain('这个模型看不到图片');
    expect(render(<Stage fixture="complete" flags={['resultSelected']} />)).toContain('改用页面选择');
    expect(render(<Stage fixture="complete" flags={['viewing']} />)).toContain('问问这张图');
    expect(render(<Stage fixture="complete" flags={['loading']} />)).toContain('skeleton');
  });

  it('胶囊的几种状态', () => {
    expect(render(<Capsule static status="running" startedAt={Date.now() - 42_000} />)).toContain('处理中');
    expect(render(<Capsule static status="waiting" />)).toContain('等你回应');
    expect(render(<Capsule static status="reply" />)).toContain('有新回复');
    expect(render(<Capsule static status="incomplete" />)).toContain('没有完成');
  });

  it('不用禁用清单里的写法', () => {
    const html = FIXTURE_KEYS.map(key => render(<Stage fixture={key} />)).join('');
    for (const bad of ['shadow-lg', 'shadow-2xl', 'rounded-2xl', '<select', 'type="checkbox"', '<details', 'focus:ring', 'text-shu']) expect(html).not.toContain(bad);
    expect(html).not.toMatch(/class="[^"]*\brounded\b(?!-)/);
  });
});
