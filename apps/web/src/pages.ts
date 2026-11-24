/**
 * 页面（路由）和它需要的能力（docs/mobile.md 4.4，lib/capabilities.ts）。router.tsx 只从这里生成路由；
 * 侧栏、命令面板、数字键跳页、首页的「去处理」这类链接都按目标地址查这里，没权限的不显示。
 * 直接打开没权限的地址时显示说明页（features/access/NoAccessPage.tsx）。
 * 每一页属于一个内置插件（@emaki/shared 的 BUILTIN_PLUGINS，docs/plugins.md 9.4）：插件停用了，这一页和通往它的入口一起不见，
 * 直接打开地址显示「这一页已停用」（features/plugins/DisabledPage.tsx）。
 *
 * need 按页面主要做的事调用的命令 / 查询的 scope 定（GET /api/commands）：能读不能改的页面照常显示（read），里面改的入口各自隐藏；
 * 页面本身就是为了改的（未识别 = 归角色，重复 = 处理重复会动文件，设置）要对应的能力。新页面在这里登记，漏了 need 类型检查不过。
 */
import { useCallback } from 'react';
import { matchPath } from 'react-router';
import { allows, useCapabilities, type Capability, type Need } from './lib/capabilities';
import { useDisabledPages } from './lib/plugins';

export interface PageDef {
  /** 路由的路径（react-router 的写法） */
  path: string;
  /** 说明页的标题 */
  title: string;
  need: Need;
}

export const PAGES = {
  // 首次使用引导：没有任何图库文件夹时 AppShell 跳过来；加文件夹是 settings
  welcome: { path: '/welcome', title: '开始使用', need: 'settings' },
  home: { path: '/', title: '首页', need: 'read' },
  gallery: { path: '/gallery', title: '图库', need: 'read' },
  characters: { path: '/characters', title: '角色', need: 'read' },
  character: { path: '/characters/:id', title: '角色', need: 'read' },
  work: { path: '/works/:id', title: '作品', need: 'read' },
  // 整页都是在给图归角色（curation.link 等）
  unrecognized: { path: '/unrecognized', title: '未识别', need: 'curate' },
  // 处理重复是把多余的移到回收站（duplicates.resolve）；「不是重复」（duplicates）、「重新查找」（jobs）在页面里各自判断
  duplicates: { path: '/duplicates', title: '重复', need: 'organize-files' },
  collections: { path: '/collections', title: '合集', need: 'read' },
  collection: { path: '/collections/:id', title: '合集', need: 'read' },
  reader: { path: '/collections/:id/read', title: '阅读', need: 'read' },
  annex: { path: '/annex/:kind?', title: '别册', need: 'read' },
  // 看得到排除了什么；加规则、恢复规则（rules）、恢复单张（curate）在页面里各自判断
  excluded: { path: '/excluded', title: '已排除', need: 'read' },
  settings: { path: '/settings', title: '设置', need: 'settings' },
  // 插件（docs/plugins.md 9.7）：谁都能看，改要 plugins（页面里各自判断）
  plugins: { path: '/plugins', title: '插件', need: 'read' },
  plugin: { path: '/plugins/:id', title: '插件', need: 'read' },
  // 开发用（生产构建不注册）
  devUi: { path: '/dev/ui', title: '共用件', need: null },
  // 不认识的地址显示首页
  fallback: { path: '*', title: '首页', need: 'read' },
} as const satisfies Record<string, PageDef>;

export type PageId = keyof typeof PAGES;

const MATCH_ORDER = (Object.keys(PAGES) as PageId[]).filter((id) => id !== 'fallback');

/** 地址对应哪一页（可以带 ?query、#hash）；不认识的是 fallback */
export function pageOf(to: string): PageId {
  const pathname = to.split(/[?#]/)[0] || '/';
  return MATCH_ORDER.find((id) => matchPath(PAGES[id].path, pathname)) ?? 'fallback';
}

/** 去这个地址要什么能力 */
export const pageNeed = (to: string): Need => PAGES[pageOf(to)].need;

/** 有这些能力、这些页面停用着时能不能去这个地址（侧栏、命令面板、链接都用它） */
export const canVisit = (caps: ReadonlySet<Capability>, to: string, disabled: ReadonlySet<string> = NONE): boolean => {
  const id = pageOf(to);
  // 不认识的地址显示首页：首页停用了它也去不了
  return !disabled.has(id === 'fallback' ? 'home' : id) && allows(caps, PAGES[id].need);
};
const NONE: ReadonlySet<string> = new Set();

/** 当前设备能不能去某个地址（还不知道是谁时按本机入口算；停用的插件的页面不能去） */
export function useCanVisit(): (to: string) => boolean {
  const { caps } = useCapabilities();
  const disabled = useDisabledPages();
  return useCallback((to: string) => canVisit(caps, to, disabled), [caps, disabled]);
}
