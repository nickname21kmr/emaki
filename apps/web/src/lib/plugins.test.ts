import { builtinPluginsState, BUILTIN_PLUGINS, NAV_ICONS, resolvePlugins, type NavEntry, type NavSection } from '@emaki/shared';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_BLOCKS } from '@/blocks/registry';
import { activeNav, sidebarItems, tabBarItems } from '@/components/layout/Sidebar';
import { canVisit, PAGES, pageOf, type PageId } from '@/pages';
import { capabilitiesOf } from './capabilities';
import { readSafeMode } from './plugins';

/** 不归哪个插件管的页面：首次使用引导、开发用的共用件、不认识的地址（显示首页，跟着首页走） */
const UNOWNED: readonly PageId[] = ['welcome', 'devUi', 'fallback'];

describe('内置插件（docs/plugins.md 9.4）', () => {
  it('每一页正好属于一个内置插件；插件登记的页面、区块都存在', () => {
    const owners = new Map<string, string[]>();
    for (const p of BUILTIN_PLUGINS)
      for (const x of p.contributes['page@1'] ?? []) owners.set(x.id, [...(owners.get(x.id) ?? []), p.id]);
    for (const id of Object.keys(PAGES) as PageId[]) {
      if (UNOWNED.includes(id)) expect([id, owners.get(id)]).toEqual([id, undefined]);
      else expect([id, owners.get(id)?.length]).toEqual([id, 1]);
    }
    for (const id of owners.keys()) expect(Object.keys(PAGES)).toContain(id);
    const blocks = new Set(ALL_BLOCKS.map((b) => b.id));
    for (const p of BUILTIN_PLUGINS) for (const b of p.contributes['block@1'] ?? []) expect(blocks.has(b.id)).toBe(true);
  });

  it('导航项指向的页面属于同一个插件', () => {
    for (const p of BUILTIN_PLUGINS)
      for (const n of p.contributes['nav.item@1'] ?? []) {
        const page = pageOf(n.to.replace(':originalWorkId', '1'));
        expect([n.id, p.contributes['page@1']?.some((x) => x.id === page)]).toEqual([n.id, true]);
      }
  });

  it('停用的页面不能去；不认识的地址跟着首页', () => {
    const caps = capabilitiesOf(undefined);
    const off = new Set(['annex', 'home']);
    expect(canVisit(caps, '/annex/comic', off)).toBe(false);
    expect(canVisit(caps, '/gallery', off)).toBe(true);
    expect(canVisit(caps, '/no-such-page', off)).toBe(false);
    expect(canVisit(caps, '/annex')).toBe(true);
  });
});

describe('侧栏和底部标签栏按插件的顺序', () => {
  const summary = undefined;
  const custom = (sections: Record<NavSection, string[]>, visible: Record<string, boolean> = {}) =>
    resolvePlugins({
      plugins: BUILTIN_PLUGINS.map((m) => ({ manifest: m, source: 'builtin', required: !!m.required, enabled: m.id !== 'core.excluded', displayName: m.id === 'core.annex' ? '杂项' : null, enabledAt: null })),
      nav: { sections, visible },
      overrideChoices: {},
      safeMode: false,
    }).nav;

  it('什么都没改过：和以前一样（「插件」页不在侧栏）', () => {
    const { main, triage, footer } = sidebarItems(summary, builtinPluginsState().nav);
    expect(main.map((i) => i.label)).toEqual(['首页', '图库', '角色', '合集', '别册']);
    expect(triage.map((i) => i.label)).toEqual(['未识别', '重复', '已排除']);
    expect(footer.map((i) => i.label)).toEqual(['设置']);
  });

  it('调了顺序、改了名、拿掉、停用：侧栏和标签栏一起变', () => {
    const nav = custom({ main: ['annex', 'gallery', 'home', 'unrecognized'], triage: [], footer: [] }, { characters: false, plugins: true });
    const side = sidebarItems(summary, nav);
    expect(side.main.map((i) => i.label)).toEqual(['杂项', '图库', '首页', '未识别', '合集']);
    expect(side.triage.map((i) => i.label)).toEqual(['重复']);
    expect(side.footer.map((i) => i.label)).toEqual(['插件', '设置']);
    const { tabs, more } = tabBarItems(summary, nav);
    expect(tabs.map((i) => i.label)).toEqual(['杂项', '图库', '首页', '未识别']);
    expect(more.map((i) => i.label)).toEqual(['合集', '重复', '插件', '设置']);
    // 去不了的先过滤，前四个总是能去的
    expect(tabBarItems(summary, nav, (to) => to !== '/unrecognized').tabs.map((i) => i.label)).toEqual(['杂项', '图库', '首页', '合集']);
  });
});

describe('装的插件加的侧栏项（docs/plugins.md E2）', () => {
  it('能选的图标都有对应的图', () => {
    const nav = builtinPluginsState().nav;
    const extra: NavEntry[] = NAV_ICONS.map((icon) => ({ id: `p/${icon}`, label: icon, to: '/gallery', icon, section: 'main', plugin: 'p', visible: true }));
    const { main } = sidebarItems(undefined, { ...nav, main: [...nav.main, ...extra] });
    expect(main.filter((i) => !i.icon).map((i) => i.label)).toEqual([]);
  });

  it('指向同一页、带筛选参数的项：只亮它，不和「图库」一起亮；只有内置项时和原来一样', () => {
    const items = [{ to: '/' }, { to: '/gallery' }, { to: '/gallery?sort=random' }, { to: '/characters' }];
    expect(activeNav(items, '/gallery', '')).toBe('/gallery');
    expect(activeNav(items, '/gallery', '?kind=all&sort=random')).toBe('/gallery?sort=random');
    expect(activeNav(items, '/gallery', '?sort=bytes')).toBe('/gallery');
    expect(activeNav(items, '/', '')).toBe('/');
    expect(activeNav(items, '/characters/3', '')).toBe('/characters');
    expect(activeNav(items, '/plugins', '')).toBeNull();
  });
});

describe('安全模式（?safe）', () => {
  it('?safe 进、?safe=0 出，同一个标签页里记住', () => {
    const m = new Map<string, string>();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => m.set(k, v),
      removeItem: (k: string) => m.delete(k),
    };
    expect(readSafeMode('')).toBe(false);
    expect(readSafeMode('?safe')).toBe(true);
    expect(readSafeMode('')).toBe(true);
    expect(readSafeMode('?safe=0')).toBe(false);
    expect(readSafeMode('')).toBe(false);
  });
});

/**
 * 能被覆盖的值只在 @emaki/shared 的 OVERRIDES 里定义默认值（docs/plugins.md 9.5）：用到的地方从生效值取（网页 useOverride，
 * 服务端 plugins.overrideValue），不各自写死。现在只有图片的默认排序：扫源码，不许再出现「没给排序就当 addedAt」的写法。
 * 明确要「最新入库」的查询（首页的最新入库、别册目次）照写 sort: 'addedAt'，那不是默认值。
 */
describe('默认值只定义一次', () => {
  const ROOTS = [path.resolve(import.meta.dirname, '..'), path.resolve(import.meta.dirname, '../../../server/src')];
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  const DEFAULTING = [/\?\?\s*'addedAt'/, /===\s*'addedAt'/, /\?[^:\n]+:\s*'addedAt'\s*[;),]/];
  it('图片的默认排序没有写死在别处', () => {
    const offenders = ROOTS.flatMap(sources).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => [line, i] as const)
        .filter(([line]) => DEFAULTING.some((re) => re.test(line)))
        .map(([line, i]) => `${path.relative(ROOTS[0]!, f)}:${i + 1}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
