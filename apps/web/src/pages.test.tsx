/**
 * 页面、导航、设置分区、命令面板都声明了需要的能力（docs/mobile.md 4.4）：漏了这里失败。
 * - 每个路由都由 src/pages.ts 的一项生成（router.tsx 的 page()），每一页都有 need；
 * - 侧栏的每一项都对应一页（不是落到「不认识的地址」），手机上按那一页的 need 隐藏；
 * - 设置的每一节都有 need，编号按看得到的那些排；
 * - 命令面板的命令按 need 过滤；
 * - 说明页：没权限的路由显示「这台设备没有『…』的权限」，有权限的照常，还不知道是谁时先不渲染。
 */
import { DEVICE_DEFAULT_SCOPES, SCOPES, type LibrarySummary, type Me, type Scope, builtinPluginsState } from '@emaki/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, type RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { moreAlert, sidebarItems, tabBarItems } from '@/components/layout/Sidebar';
import { ScrollContainerContext } from '@/components/layout/ScrollContainer';
import { usePaletteCommands } from '@/components/overlays/palette/commands';
import { PAGE_JUMPS } from '@/components/overlays/shortcuts';
import { TooltipProvider } from '@/components/ui';
import { noAccessText } from '@/features/access/NoAccessPage';
import { PageGate } from '@/features/access/PageGate';
import { SECTIONS, useSettingsSections } from '@/features/settings/sections';
import { IMAGE_ACTION_NEEDS } from '@/components/media/lightbox/useImageActions';
import { SelectionBar, type SelectionAction } from '@/features/characters/detail/SelectionBar';
import { GALLERY_SELECTION_NEEDS } from '@/features/gallery/components/SelectionBar';
import { ALL_CAPABILITIES, allowedActions, capabilitiesOf, type Need } from '@/lib/capabilities';
import { qk } from '@/lib/queries';
import { canVisit, PAGES, pageOf, showsEntry, type PageId } from './pages';
import { routes } from './router';

const local: Me = { kind: 'local', scopes: Object.keys(SCOPES) as Scope[] };
const device = (scopes: readonly Scope[] = DEVICE_DEFAULT_SCOPES): Me => ({
  kind: 'device',
  deviceId: 'd1',
  name: 'Pixel 7',
  scopes: [...scopes],
});
const phone = capabilitiesOf(device());
const desk = capabilitiesOf(local);

const isNeed = (n: unknown): n is Need => n === null || ALL_CAPABILITIES.includes(n as never);

/** 路由表里的每一项（展平） */
function flatten(list: RouteObject[]): RouteObject[] {
  return list.flatMap((r) => [r, ...flatten(r.children ?? [])]);
}

describe('路由：每一页都声明了需要的能力', () => {
  it('PAGES 的每一项都有 need（null 也要写出来）', () => {
    for (const [id, def] of Object.entries(PAGES)) {
      expect(['need' in def, isNeed(def.need)], id).toEqual([true, true]);
      expect(def.title.length, id).toBeGreaterThan(0);
    }
  });

  it('router.tsx 里每个有路径的路由都是从 PAGES 生成的（漏了登记就失败），路径一致', () => {
    const leaves = flatten(routes).filter((r) => r.path !== undefined || r.index);
    const ids = leaves.map((r) => (r.handle as { page?: PageId } | undefined)?.page);
    expect(ids.every((id) => id && id in PAGES)).toBe(true);
    for (const r of leaves) {
      const id = (r.handle as { page: PageId }).page;
      const expected = PAGES[id].path;
      expect([id, r.index ? '/' : r.path]).toEqual([id, id === 'welcome' ? expected : r.index ? '/' : expected.replace(/^\//, '')]);
    }
    // 每一页都挂上了（开发用的共用件页只在开发时注册，测试里也算开发）
    expect([...ids].sort()).toEqual((Object.keys(PAGES) as PageId[]).sort());
  });

  it('地址 → 页：带参数、查询、hash 的都认得；不认识的落到 fallback', () => {
    expect(pageOf('/')).toBe('home');
    expect(pageOf('/settings#jobs')).toBe('settings');
    expect(pageOf('/characters?source=custom')).toBe('characters');
    expect(pageOf('/characters/42')).toBe('character');
    expect(pageOf('/collections/7/read')).toBe('reader');
    expect(pageOf('/annex')).toBe('annex');
    expect(pageOf('/annex/comic')).toBe('annex');
    expect(pageOf('/no/such/page')).toBe('fallback');
  });

  it('默认权限的手机：去不了设置、重复（要 organize-files）、首次使用引导；电脑上哪都能去', () => {
    const blocked = ['/settings', '/duplicates', '/welcome'];
    for (const to of blocked) expect([to, canVisit(phone, to)]).toEqual([to, false]);
    const open = ['/', '/gallery', '/characters', '/characters/1', '/works/1', '/unrecognized', '/collections', '/annex/comic'];
    open.push('/excluded');
    for (const to of open) expect([to, canVisit(phone, to)]).toEqual([to, true]);
    for (const id of Object.keys(PAGES) as PageId[]) {
      const to = PAGES[id].path.replace(/:\w+\??/g, '1');
      expect([id, canVisit(desk, to)]).toEqual([id, true]);
    }
  });
});

const summary = {
  added: { today: 0, week: 0, lastAt: null },
  images: { total: 10, illustrations: 8, annex: 2, original: 1 },
  triage: { total: 3, images: 3, books: 0, waiting: 0 },
  duplicates: 2,
  originalWorkId: 'w9',
} as unknown as LibrarySummary;

describe('侧栏', () => {
  it('每一项都对应一页（不是落到不认识的地址）', () => {
    const { main, triage, footer } = sidebarItems(summary);
    for (const item of [...main, ...triage, ...footer]) expect([item.to, pageOf(item.to)]).not.toEqual([item.to, 'fallback']);
    expect([...main, ...triage, ...footer].map((i) => i.to)).toEqual([
      '/',
      '/gallery',
      '/characters',
      '/works/w9',
      '/collections',
      '/annex',
      '/unrecognized',
      '/duplicates',
      '/excluded',
      '/settings',
    ]);
  });

  it('底部标签栏（手机竖屏，A1）：首页、图库、角色、合集常驻，其余进「更多」；项和侧栏同一套，也按页过滤', () => {
    const { tabs, more } = tabBarItems(summary);
    expect(tabs.map((i) => i.label)).toEqual(['首页', '图库', '角色', '合集']);
    expect(more.map((i) => i.label)).toEqual(['原创', '别册', '未识别', '重复', '已排除', '设置']);
    // 和侧栏一项不多一项不少
    const side = Object.values(sidebarItems(summary)).flat();
    expect([...tabs, ...more].map((i) => i.to).sort()).toEqual(side.map((i) => i.to).sort());
    // 手机（默认权限）的「更多」里没有重复、设置
    expect(more.filter((i) => canVisit(phone, i.to)).map((i) => i.label)).toEqual(['原创', '别册', '未识别', '已排除']);
    // 「更多」里有待处理的（未识别、重复有数）时「更多」上点朱点；别册的张数不算
    expect(moreAlert(more)).toBe(true);
    expect(moreAlert(more.filter((i) => i.to === '/annex' || i.to === '/settings'))).toBe(false);
  });

  it('手机上（默认权限）没有重复、设置；加上 settings 之后有设置；电脑上全有', () => {
    const all = Object.values(sidebarItems(summary)).flat();
    const shown = (caps: ReturnType<typeof capabilitiesOf>) => all.filter((i) => canVisit(caps, i.to)).map((i) => i.label);
    expect(shown(phone)).toEqual(['首页', '图库', '角色', '原创', '合集', '别册', '未识别', '已排除']);
    expect(shown(capabilitiesOf(device([...DEVICE_DEFAULT_SCOPES, 'settings'])))).toContain('设置');
    expect(shown(desk)).toHaveLength(all.length);
  });

  it('数字键跳页、命令面板的「前往」也按页过滤：手机上没有 5（重复）', () => {
    expect(PAGE_JUMPS.filter((p) => canVisit(phone, p.to)).map((p) => p.key)).toEqual(['1', '2', '3', '4', '6']);
  });

  it('「插件」页：plugins、install-plugins 都没有的设备不放入口（侧栏、「更多」），地址照常能开（用户 2026-11-26）', () => {
    // 11-24 以前批准的平板：默认权限里还没有 plugins
    const tablet = capabilitiesOf(device(DEVICE_DEFAULT_SCOPES.filter((s) => s !== 'plugins')));
    const installOnly = capabilitiesOf(device([...DEVICE_DEFAULT_SCOPES.filter((s) => s !== 'plugins'), 'install-plugins']));
    for (const to of ['/plugins', '/plugins/pixiv-browser']) expect([to, canVisit(tablet, to)]).toEqual([to, true]);
    expect(showsEntry(tablet, '/plugins')).toBe(false);
    for (const caps of [phone, installOnly, desk]) expect(showsEntry(caps, '/plugins')).toBe(true);
    // 别的页不受影响
    expect(showsEntry(tablet, '/gallery')).toBe(true);
    expect(showsEntry(tablet, '/settings')).toBe(false);
    // 在侧栏显示「插件」以后：手机（默认权限）的「更多」里有，那台平板的没有
    const nav = builtinPluginsState().nav;
    const shown = { ...nav, footer: nav.footer.map((n) => (n.to === '/plugins' ? { ...n, visible: true } : n)) };
    const more = (caps: ReturnType<typeof capabilitiesOf>) =>
      tabBarItems(summary, shown, (to) => showsEntry(caps, to)).more.map((i) => i.label);
    expect(more(phone)).toContain('插件');
    expect(more(tablet)).not.toContain('插件');
  });
});

/** 静态渲染：查询缓存里放好 /api/me 的结果（undefined = 还没回来） */
function render(node: ReactNode, me: Me | undefined, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  if (me) client.setQueryData(qk.me, me);
  // 插件：什么都没改过（内置插件全部启用）
  client.setQueryData(qk.plugins(false), builtinPluginsState());
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <ScrollContainerContext.Provider value={{ current: null }}>{node}</ScrollContainerContext.Provider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('设置的分区', () => {
  it('每一节都声明了 need；手机访问要 devices、AI 助手要 assistant、后台任务要 jobs', () => {
    for (const s of SECTIONS) expect([s.id, 'need' in s, isNeed(s.need)]).toEqual([s.id, true, true]);
    const need = Object.fromEntries(SECTIONS.map((s) => [s.id, s.need]));
    expect(need).toMatchObject({ phone: 'devices', assistant: 'assistant', jobs: 'jobs', appearance: null, about: null });
  });

  it('加了 settings 的手机：没有手机访问、AI 助手、后台任务；电脑上全有', () => {
    function Probe() {
      return <>{useSettingsSections().map((s) => s.id).join(',')}</>;
    }
    expect(render(<Probe />, device([...DEVICE_DEFAULT_SCOPES, 'settings']))).toBe('library,tagger,danbooru,dedupe,appearance,plugins,about');
    expect(render(<Probe />, local)).toBe(SECTIONS.map((s) => s.id).join(','));
  });
});

describe('命令面板', () => {
  function Probe() {
    return <>{usePaletteCommands(() => {}).map((c) => c.value).join(' ')}</>;
  }
  it('手机上（默认权限）没有前往设置 / 重复、切换主题、运行任务；电脑上都有', () => {
    const phoneList = render(<Probe />, device()).split(' ');
    const hidden = ['go:/settings', 'go:/duplicates', 'act:theme', 'act:tag', 'act:dedupe', 'act:scan'];
    for (const v of hidden) expect(phoneList).not.toContain(v);
    for (const v of ['go:/', 'go:/gallery', 'go:/unrecognized', 'act:blur', 'act:help']) expect(phoneList).toContain(v);
    const deskList = render(<Probe />, local).split(' ');
    for (const v of hidden) expect(deskList).toContain(v);
  });

  it('前往「插件」：plugins、install-plugins 都没有的设备不列', () => {
    expect(render(<Probe />, device()).split(' ')).toContain('go:/plugins');
    const tablet = device(DEVICE_DEFAULT_SCOPES.filter((s) => s !== 'plugins'));
    expect(render(<Probe />, tablet).split(' ')).not.toContain('go:/plugins');
  });
});

describe('看图器和多选栏的操作', () => {
  it('看图器：手机上（默认权限）没有定位（desktop）、回收站（organize-files），收藏、归为原创、排除、改分级 / 类型 / 角色都在', () => {
    const phoneAllow = allowedActions(IMAGE_ACTION_NEEDS, phone);
    expect(phoneAllow).toMatchObject({ reveal: false, trash: false, favorite: true, original: true, exclude: true });
    expect(phoneAllow).toMatchObject({ rating: true, kind: true, characters: true, artists: true, source: true, collection: true });
    expect(Object.values(allowedActions(IMAGE_ACTION_NEEDS, desk)).every(Boolean)).toBe(true);
    // 只能看的设备：什么都改不了
    expect(Object.values(allowedActions(IMAGE_ACTION_NEEDS, capabilitiesOf(device(['read'])))).some(Boolean)).toBe(false);
  });

  it('图库的多选栏：手机上没有移动、回收站；每一项都声明了 need', () => {
    for (const [k, need] of Object.entries(GALLERY_SELECTION_NEEDS)) expect([k, isNeed(need)]).toEqual([k, true]);
    const allow = allowedActions(GALLERY_SELECTION_NEEDS, phone);
    expect(allow).toMatchObject({ move: false, trash: false, assign: true, favorite: true, group: true, exclude: true });
  });

  it('角色 / 作品 / 合集页的多选栏按每个操作的 need 过滤', () => {
    const act = (key: string, need: Need): SelectionAction => ({ key, label: key, icon: null, need, onClick: () => {} });
    const actions = [act('收藏', 'curate'), act('移动到文件夹', 'organize-files'), act('组图', 'collections')];
    const bar = (me: Me) => render(<SelectionBar count={2} actions={actions} onClear={() => {}} />, me);
    const onPhone = bar(device());
    expect(onPhone).toContain('收藏');
    expect(onPhone).toContain('组图');
    expect(onPhone).not.toContain('移动到文件夹');
    expect(bar(local)).toContain('移动到文件夹');
  });
});

describe('说明页', () => {
  it('缺哪项权限（和设置 →「手机访问」里勾选框上的说法一样）、去哪里加；电脑上才有的说到电脑上用', () => {
    expect(noAccessText('organize-files')).toEqual({
      title: '这台设备没有「移动、移到回收站、处理重复」的权限',
      description: '可以在电脑上 设置 → 手机访问 里给它加上；加上以后这一页会自己换过来，不用刷新。',
    });
    expect(noAccessText('settings').title).toBe('这台设备没有「图库设置、图库文件夹、识别方式」的权限');
    expect(noAccessText('desktop').title).toBe('「在这台电脑的屏幕上弹东西」只能在电脑上用');
    expect(noAccessText('assistant').title).toBe('「AI 助手」只能在电脑上用');
  });

  it('PageGate：手机打开 /duplicates、/settings 是说明页；有权限的照常；电脑上照常；还不知道是谁时什么也不画', () => {
    const page = <p>真正的页面</p>;
    const dup = render(<PageGate page="duplicates">{page}</PageGate>, device(), '/duplicates');
    expect(dup).toContain('这台设备没有「移动、移到回收站、处理重复」的权限');
    expect(dup).toContain('重复');
    expect(dup).not.toContain('真正的页面');
    expect(render(<PageGate page="settings">{page}</PageGate>, device(), '/settings')).toContain('图库设置、图库文件夹、识别方式');
    const withSettings = device([...DEVICE_DEFAULT_SCOPES, 'settings']);
    expect(render(<PageGate page="settings">{page}</PageGate>, withSettings, '/settings')).toBe('<p>真正的页面</p>');
    expect(render(<PageGate page="gallery">{page}</PageGate>, device(), '/gallery')).toBe('<p>真正的页面</p>');
    expect(render(<PageGate page="duplicates">{page}</PageGate>, local, '/duplicates')).toBe('<p>真正的页面</p>');
    expect(render(<PageGate page="duplicates">{page}</PageGate>, undefined, '/duplicates')).toBe('');
  });
});
