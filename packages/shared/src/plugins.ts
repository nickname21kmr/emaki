/**
 * 插件（docs/plugins.md）。在用的人看来，页面、覆盖设置、以后的功能都是「插件」，在「插件」页里启用、停用、改名、删除；
 * 实现上只有**插件管理**是统一的（身份、启用、显示名、授权……），下面是各管各的**贡献点**（page、nav.item、override、block……），
 * 每种有自己的格式、合并和冲突规则（第 9 节）。
 *
 * 这个文件放两边都要用的：贡献点的格式、内置插件的清单（原来的每一页是一个内置插件）、能被覆盖的值（设置注册表）、
 * GET /api/plugins 的返回。谁启用了、生效的贡献清单由服务端算（domain/plugins/），网页只用它的结果。
 */
import type { ImageSort } from './api.ts';
import type { Scope } from './commands.ts';
import type { ImageSource } from './domain.ts';

/** 插件从哪来：内置（原来的页面）、我的（自己或 AI 做的）、装的（E2 起） */
export type PluginSource = 'builtin' | 'mine' | 'installed';

/** 侧栏分三段：主要的页面、整理（未识别、重复、已排除）、底部（设置） */
export const NAV_SECTIONS = ['main', 'triage', 'footer'] as const;
export type NavSection = (typeof NAV_SECTIONS)[number];

/** 导航项的图标（网页映射到 lucide 图标；插件只能从这些里选） */
export const NAV_ICONS = [
  'house',
  'images',
  'users',
  'sparkles',
  'library',
  'book-copy',
  'circle-help',
  'copy',
  'ban',
  'settings',
  'puzzle',
  // 给插件用的
  'clock',
  'star',
  'bookmark',
  'folder',
  'chart',
  'compass',
  'download',
  'heart',
  'external-link',
] as const;
export type NavIcon = (typeof NAV_ICONS)[number];

// ---------------------------------------------------------------- 贡献点（E1：page、nav.item、block、override）

/**
 * page@1：一页。内置插件写网页的页面 id（apps/web/src/pages.ts）；装的插件、AI 做的页面是视图（E4，docs/plugins.md 第 5 节）：
 * 包里的一个 HTML 文件，在隔离的 iframe 里显示，地址是 pluginPagePath(插件, 页面)
 */
export interface PageContribution {
  id: string;
  /** 视图：包里的 HTML 文件（相对路径，比如 views/stats.html） */
  view?: string;
  /** 页头上的标题（不写用插件的名字） */
  title?: string;
  /**
   * 这一页对应插件的一个外部网站（site@1 的 id）：能直接打开网站、给网站加按钮的地方（安卓 App）打开那个网站，
   * 不能的（电脑上的浏览器）照常显示视图
   */
  site?: string;
}

/**
 * site@1：插件给一个外部网站用的脚本（docs/plugins.md 第 6 节，E5）。能打开网站的宿主（安卓 App 里的站内浏览）打开 url，
 * 在 matches 的网站上加载 script（加多选、「下载到 Emaki」这类按钮）。脚本经宿主调这个插件自己的命令（window.__emakiSite.call）。
 * matches 里的域名要在 permissions.network 里
 */
export interface SiteContribution {
  id: string;
  title: string;
  /** 打开时的起始页 */
  url: string;
  /** 在哪些网站上加载脚本（域名，和 permissions.network 同样写法） */
  matches: string[];
  /** 脚本：包里的 .js */
  script: string;
}

/** 域名在不在列表里：列表里的 pixiv.net 也算 www.pixiv.net（子域名），*.pixiv.net 同样 */
export const hostAllowed = (host: string, allowed: readonly string[]): boolean =>
  allowed.some((a) => {
    const h = a.toLowerCase().replace(/^\*\./, '');
    const x = host.toLowerCase();
    return x === h || x.endsWith(`.${h}`);
  });

/** GET /api/plugins/sites：启用着的插件的站点脚本（给安卓 App） */
export interface PluginSite extends SiteContribution {
  pluginId: string;
  version: string;
  /** 脚本的内容 */
  code: string;
}

/** 插件的视图页面在网页上的地址 */
export const pluginPagePath = (pluginId: string, pageId: string): string => `/p/${pluginId}/${pageId}`;

/** 视图页面在 MCP 里的资源地址（MCP Apps 的 ui://，在 Claude 里打开用） */
export const pluginViewUri = (pluginId: string, pageId: string): string => `ui://${pluginId}/${pageId}`;

/** nav.item@1：侧栏（手机上是底部标签栏）里的一项 */
export interface NavItemContribution {
  /** 稳定 id（顺序、在不在侧栏按它存） */
  id: string;
  label: string;
  /** 地址；`:originalWorkId` 这种由网页按图库的情况填（没有原创作品时不显示）。装的插件写 page 时由宿主填成那一页的地址 */
  to: string;
  /** 装的插件：指向自己的哪一页（page@1 的 id），不写 to */
  page?: string;
  icon: NavIcon;
  section: NavSection;
  /** 默认不在侧栏里（「插件」页） */
  hiddenByDefault?: boolean;
  /** 只是一个捷径，不放到手机底部标签栏的常驻位（「原创」） */
  shortcut?: boolean;
}

/** block@1：放在别的页面里的区块（apps/web/src/blocks/registry.ts 的 id）。插件停用时这些区块一起不显示 */
export interface BlockContribution {
  id: string;
}

/**
 * page.action@1、menu.item@1、lightbox.toolbar@1、lightbox.panel@1：几样东西按顺序排在一处的地方的条目
 * （apps/web/src/blocks/slots.ts 的 id，E3）。内置插件在这里登记它放在别的插件的页面里的条目，停用时一起不画
 */
export interface SlotEntryContribution {
  id: string;
}

/** 图片的来源网站（ImageSource 的 site） */
export const SOURCE_SITES = ['pixiv', 'twitter', 'danbooru', 'fanbox', 'other'] as const satisfies readonly ImageSource['site'][];

/**
 * lightbox.toolbar@1：看图器顶栏的按钮。内置插件只写 id（blocks/slots.ts 里登记的条目）；装的插件写按钮本身（docs/plugins.md 12.7），
 * 排在内置的按钮后面、「信息」前面。点了做两种事之一：
 * - command：调这个插件自己的命令，输入是 `{ image: { id, fileName, source } }`，返回的 message 显示出来；
 * - open: 'source'：打开这张图的来源（原作链接），有插件接管这种链接（link@1）就在插件里打开
 */
export interface LightboxButtonContribution extends SlotEntryContribution {
  label?: string;
  icon?: NavIcon;
  /** 只在这些来源的图上显示（不写就是每张图都有） */
  sources?: ImageSource['site'][];
  command?: string;
  open?: 'source';
}

/**
 * link@1：插件接管的链接（docs/plugins.md 12.7）。Emaki 里点到这种链接（看图器、未识别里图片的来源），在插件里打开：
 * 安卓 App 里打开插件的网站（site，就在这个地址），别的地方打开插件的页面（page，视图从 context 的 link 拿到地址）；
 * 两样都不能用的地方照常在浏览器里打开。按住 Ctrl / ⌘ 点、中键、右键菜单照旧去浏览器。几个插件都接管同一个链接时点了让你选
 */
export interface LinkContribution {
  id: string;
  title: string;
  /** 哪些链接，比如 https://www.pixiv.net/artworks/*：* 是路径里的一段，问号以后的不看；域名要在 permissions.network 里 */
  urls: string[];
  page?: string;
  site?: string;
}

/** 链接对不对得上 link@1 的写法（只比到路径，问号、# 以后的不看；* 是一段，末尾的 / 可有可无） */
export function linkMatches(pattern: string, url: string): boolean {
  // shared 不带 DOM 的类型（没有 URL）：按 协议://主机/路径 拆
  const m = /^(https?):\/\/([^/?#@\s]+)([^?#\s]*)/i.exec(url);
  if (!m) return false;
  const target = `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}${m[3]!}`.replace(/\/+$/, '');
  const re = pattern
    .replace(/\/+$/, '')
    .split('*')
    .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${re}$`, 'i').test(target);
}

/** 接管这个链接的插件（启用着的，按插件的顺序） */
export function linkHandlers(plugins: readonly PluginInfo[], url: string): { plugin: PluginInfo; link: LinkContribution }[] {
  return plugins
    .filter((p) => p.enabled)
    .flatMap((plugin) => (plugin.contributes['link@1'] ?? []).filter((l) => l.urls.some((x) => linkMatches(x, url))).map((link) => ({ plugin, link })));
}

/**
 * command@1：插件自己的命令（服务端逻辑实现，E5，docs/plugins.md 第 6 节）。名字带插件前缀（<插件 id>.<名字>），
 * 进命令注册表，和内置命令一样能被视图、AI 助手和 HTTP 调用；调用的人要有 scope
 */
export interface CommandContribution {
  name: string;
  summary: string;
  scope: Scope;
  /** 输入的 JSON Schema（对象）；不写就是什么参数都不要 */
  input?: Record<string, unknown>;
}

/** job.kind@1：插件的后台任务种类（E5）。进现有的任务列表：进度、取消都和内置的一样；要授权「在后台运行」 */
export interface JobKindContribution {
  kind: string;
  label: string;
}

/** setting@1：插件自己的设置，宿主在插件详情里统一画（E5）。secret 是登录凭证这类：只有插件的服务端读得到，视图读不到 */
export interface SettingContribution {
  id: string;
  label: string;
  type: 'string' | 'secret';
  hint?: string;
}

/**
 * patch@1：改内部（第 3 层，docs/plugins.md 第 7 节，E6）。清单里列出要改的内部点，代码在 internal 入口里用 internal.patch 改，
 * 没列的点改不了；授权单、「插件」页按这里说「它改了哪里」
 */
export interface PatchContribution {
  /** 内部点的名字：command:<命令>、query:<查询>、reaction:<反应>、job:<任务种类>、term:<口径>，比如 term:count.unit */
  point: string;
  /** 为什么改、改成什么样（插件页上显示） */
  why?: string;
}

export interface Contributes {
  'page@1'?: PageContribution[];
  'nav.item@1'?: NavItemContribution[];
  'block@1'?: BlockContribution[];
  'page.action@1'?: SlotEntryContribution[];
  'menu.item@1'?: SlotEntryContribution[];
  'lightbox.toolbar@1'?: LightboxButtonContribution[];
  'lightbox.panel@1'?: SlotEntryContribution[];
  /** override@1：设置注册表里登记过的值（OVERRIDES） */
  'override@1'?: Partial<Record<OverrideKey, unknown>>;
  'command@1'?: CommandContribution[];
  'job.kind@1'?: JobKindContribution[];
  'setting@1'?: SettingContribution[];
  'site@1'?: SiteContribution[];
  'link@1'?: LinkContribution[];
  'patch@1'?: PatchContribution[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** 兼容哪些版本的 Emaki（semver 范围，packages/shared/src/semver.ts）；不写就是都行 */
  engines?: { emaki?: string };
  /** 装的插件要的权限（授权单上列出来，docs/plugins.md 4.2） */
  permissions?: PluginPermissions;
  contributes: Contributes;
  /** 服务端逻辑的入口（包里的 .js / .mjs / .cjs，E5）：每个插件一个 Node 子进程 */
  server?: string;
  /** 改内部的入口（包里的 .js / .mjs，E6）：在 Emaki 自己的进程里加载，用 internal.patch 改 patch@1 里列的服务端的点 */
  internal?: string;
  /** 改网页的入口（包里的 .js / .mjs，E6）：在 Emaki 的网页里加载，用 internal.patch 改 patch@1 里列的网页的点（component:、fn:） */
  web?: string;
}

/**
 * 网页上登记过名字的内部点（docs/plugins.md 第 7 节，E6）：第 3 层插件的 web 入口只能改这些。
 * 网页里用 patchable（组件）、patchableFn（函数）登记，名字和这里一一对上（apps/web/src/lib/points.test.ts 扫源码查）；
 * file 是它在 apps/web/src 下的源文件；指纹按约定算（组件的 props、函数的签名，从这个文件里取，apps/server/src/core/pointContracts.ts），
 * version 是手动的版本号（行为变了、约定看不出来时加一）
 */
export const WEB_POINTS = [
  { name: 'fn:count.unit', label: '排名的张数后面写的字', file: 'lib/countUnit.ts', version: 1 },
  { name: 'component:character.Cover', label: '角色卡', file: 'components/media/CharacterCover.tsx', version: 1 },
  { name: 'component:lightbox.Stage', label: '看图器的大图', file: 'components/media/lightbox/Stage.tsx', version: 1 },
  { name: 'component:lightbox.InfoPanel', label: '看图器的信息栏', file: 'components/media/lightbox/InfoPanel.tsx', version: 1 },
] as const satisfies readonly { name: `${'component' | 'fn'}:${string}`; label: string; file: string; version: number }[];

/** 网页要加载的一个改网页的模块（PluginsState.webPatches）：插件启用着、授权了改内部、它改的点没变 */
export interface WebPatchModule {
  plugin: string;
  version: string;
  /** 模块的地址（/api/plugin-web/<插件>/<版本和修改时间>/<入口>） */
  url: string;
  /** 它能改的点（清单 patch@1 里网页的那些） */
  points: string[];
}

/** 条目类的贡献点（E3）：它们的条目停用时一起不画 */
export const SLOT_POINT_KEYS = ['page.action@1', 'menu.item@1', 'lightbox.toolbar@1', 'lightbox.panel@1'] as const;

/**
 * 装的插件现在能贡献的：不跑代码的那几种、视图页面（E4）、服务端逻辑的命令、任务、设置、网站（E5）、看图器顶栏的按钮、接管的链接（12.7）。
 * 区块、菜单项、页头的操作这些以后开放
 */
export const INSTALLABLE_POINTS = [
  'nav.item@1',
  'override@1',
  'page@1',
  'command@1',
  'job.kind@1',
  'setting@1',
  'site@1',
  'lightbox.toolbar@1',
  'link@1',
  'patch@1',
] as const;

// ---------------------------------------------------------------- 授权（docs/plugins.md 第 4 节）

/** 清单里要一个文件夹：插件放文件的地方，装的时候在授权单上选好 */
export interface FolderRequest {
  /** 插件里怎么叫它（清单里唯一） */
  id: string;
  /** 用来干什么（授权单上写出来） */
  purpose: string;
  /** 建议放在图库文件夹下的哪个相对路径 */
  suggest?: string;
}

/** 清单里要的权限 */
export interface PluginPermissions {
  scopes?: Scope[];
  folders?: FolderRequest[];
  /** 声明会连的域名 */
  network?: string[];
  /** 会在后台跑（任务、对变化的反应） */
  background?: boolean;
  /** 改内部（第 3 层） */
  unsafe?: boolean;
}

/** 授权里选好的文件夹：哪个图库文件夹下的哪个相对路径 */
export interface FolderGrant {
  id: string;
  rootId: number;
  dir: string;
}

/**
 * 授权：设备、AI 助手、插件被授予的是同一种东西（docs/plugins.md 4.1）。
 * 设备的仍存在 devices 表（scopes、上传到哪），插件的存在 plugin_grants，都转成这个类型。
 */
export interface Grant {
  scopes: Scope[];
  folders: FolderGrant[];
  network: string[];
  background: boolean;
  unsafe: boolean;
}

export const EMPTY_GRANT: Grant = { scopes: [], folders: [], network: [], background: false, unsafe: false };

/** 什么都没要 */
export const emptyPermissions = (p: PluginPermissions | undefined): boolean =>
  !p || (!p.scopes?.length && !p.folders?.length && !p.network?.length && !p.background && !p.unsafe);

/** 要的权限里，授权里还没有的（更新时只为这些出授权单；grant 为 null 是全部） */
export function missingPermissions(want: PluginPermissions | undefined, grant: Grant | null): PluginPermissions {
  const w = want ?? {};
  const g = grant ?? EMPTY_GRANT;
  const out: PluginPermissions = {};
  const scopes = (w.scopes ?? []).filter((s) => !g.scopes.includes(s));
  if (scopes.length) out.scopes = scopes;
  const folders = (w.folders ?? []).filter((f) => !g.folders.some((x) => x.id === f.id));
  if (folders.length) out.folders = folders;
  const network = (w.network ?? []).filter((h) => !g.network.includes(h));
  if (network.length) out.network = network;
  if (w.background && !g.background) out.background = true;
  if (w.unsafe && !g.unsafe) out.unsafe = true;
  return out;
}

// ---------------------------------------------------------------- 能被覆盖的值（设置注册表，第 9.5 节）

/** 图片列表能用的排序（不含合集按页、按姿势这种只在特定场合有的） */
export const LIST_SORTS = ['addedAt', 'modifiedAt', 'fileName', 'bytes', 'random'] as const satisfies readonly ImageSort[];
export type ListSort = (typeof LIST_SORTS)[number];

export const SORT_LABELS: Record<ListSort, string> = {
  addedAt: '最近添加',
  modifiedAt: '修改时间',
  fileName: '文件名',
  bytes: '体积',
  random: '随机',
};

interface OverrideDef<T extends string> {
  label: string;
  hint: string;
  /** 内置默认值：没有插件覆盖时就是它 */
  default: T;
  /** 能取的值（校验和「新建覆盖」的表单都用它；现在能覆盖的都是几选一） */
  options: readonly { value: T; label: string }[];
}

const def = <T extends string>(d: OverrideDef<T>) => d;

/**
 * 能被覆盖插件改的值。每个值只在这里定义一次默认值；用到它的地方（服务端的图片列表、网页的排序控件）都从生效值里取，
 * 不各自写死（apps/web/src/lib/plugins.test.ts 扫源码）。
 */
export const OVERRIDES = {
  'images.defaultSort': def<ListSort>({
    label: '图片的默认排序',
    hint: '图库、别册、角色和作品页的图片，没选排序时按这个排；页面上的排序控件照旧能换',
    default: 'addedAt',
    options: LIST_SORTS.map((value) => ({ value, label: SORT_LABELS[value] })),
  }),
} as const;
export type OverrideKey = keyof typeof OVERRIDES;
export type OverrideValue<K extends OverrideKey> = (typeof OVERRIDES)[K]['default'];
export const OVERRIDE_KEYS = Object.keys(OVERRIDES) as OverrideKey[];

/** 这个值能不能用来覆盖 key（不认识的键、不在选项里的值都不行） */
export function validOverride(key: string, value: unknown): key is OverrideKey {
  const d = (OVERRIDES as Record<string, OverrideDef<string>>)[key];
  return !!d && d.options.some((o) => o.value === value);
}

/** 图片的默认排序：内置的（没有覆盖时）。只有这里和 OVERRIDES 引用它 */
export const BUILTIN_DEFAULT_SORT: ListSort = OVERRIDES['images.defaultSort'].default;

// ---------------------------------------------------------------- 内置插件：原来的每一页

export interface BuiltinPlugin extends PluginManifest {
  /** 必需的（设置、「插件」页）：不能停用 */
  required?: boolean;
}

const nav = (
  id: string,
  label: string,
  to: string,
  icon: NavIcon,
  section: NavSection,
  extra: Partial<NavItemContribution> = {},
): NavItemContribution => ({ id, label, to, icon, section, ...extra });

const builtin = (
  id: string,
  name: string,
  description: string,
  contributes: Contributes,
  required = false,
): BuiltinPlugin => ({ id: `core.${id}`, name, version: '1', description, contributes, ...(required && { required }) });

/**
 * 内置插件，按这个顺序排侧栏的默认顺序（同一段里）。每个登记它拥有的页面、导航项和放在别的页面里的区块：
 * 停用了，这些一起不见，不会留下死链接（docs/plugins.md 9.4）。看图器、阅读器这些功能以后（E3）再拆成贡献点。
 */
export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = [
  builtin('home', '首页', '统计、今日一枚、待处理、最近在收和最新入库', {
    'page@1': [{ id: 'home' }],
    'nav.item@1': [nav('home', '首页', '/', 'house', 'main')],
  }),
  builtin('gallery', '图库', '全部插画，筛选、搜索、自定义画面', {
    'page@1': [{ id: 'gallery' }],
    'nav.item@1': [nav('gallery', '图库', '/gallery', 'images', 'main')],
  }),
  builtin('characters', '角色', '角色总览和每个角色的扉页', {
    'page@1': [{ id: 'characters' }, { id: 'character' }],
    'nav.item@1': [nav('characters', '角色', '/characters', 'users', 'main')],
  }),
  builtin('works', '作品', '每部作品的页面，以及侧栏的「原创」、角色总览里的「作品页」链接', {
    'page@1': [{ id: 'work' }],
    'nav.item@1': [nav('original', '原创', '/works/:originalWorkId', 'sparkles', 'main', { shortcut: true })],
    'page.action@1': [{ id: 'characters.workPage' }],
  }),
  builtin('collections', '合集', '本子、画集、组图，以及阅读器', {
    'page@1': [{ id: 'collections' }, { id: 'collection' }, { id: 'reader' }],
    'nav.item@1': [nav('collections', '合集', '/collections', 'library', 'main')],
  }),
  builtin('annex', '别册', '截图、漫画、照片、文字、表情和动图，以及首页的别册目次', {
    'page@1': [{ id: 'annex' }],
    'nav.item@1': [nav('annex', '别册', '/annex', 'book-copy', 'main')],
    'block@1': [{ id: 'home.annex' }],
  }),
  builtin('unrecognized', '未识别', '没认出角色的图，按数字键归类', {
    'page@1': [{ id: 'unrecognized' }],
    'nav.item@1': [nav('unrecognized', '未识别', '/unrecognized', 'circle-help', 'triage')],
  }),
  builtin('duplicates', '重复', '重复的图，逐组选保留哪些', {
    'page@1': [{ id: 'duplicates' }],
    'nav.item@1': [nav('duplicates', '重复', '/duplicates', 'copy', 'triage')],
  }),
  builtin('excluded', '已排除', '排除规则和被排除的图', {
    'page@1': [{ id: 'excluded' }],
    'nav.item@1': [nav('excluded', '已排除', '/excluded', 'ban', 'triage')],
  }),
  builtin(
    'plugins',
    '插件',
    '管理插件：启用、停用、改名、删除，调整侧栏的页面顺序',
    {
      'page@1': [{ id: 'plugins' }, { id: 'plugin' }, { id: 'pluginView' }],
      'nav.item@1': [nav('plugins', '插件', '/plugins', 'puzzle', 'footer', { hiddenByDefault: true })],
    },
    true,
  ),
  builtin(
    'settings',
    '设置',
    '图库文件夹、识别、外观、后台任务、手机访问',
    {
      'page@1': [{ id: 'settings' }],
      'nav.item@1': [nav('settings', '设置', '/settings', 'settings', 'footer')],
    },
    true,
  ),
];

// ---------------------------------------------------------------- GET /api/plugins

/** 插件页上显示的类型（从贡献推出来，不另存） */
/** 用户看到的类型（从贡献推出来，9.0）：页面、覆盖、功能（有服务端逻辑）、改内部（第 3 层） */
export type PluginKind = 'page' | 'override' | 'feature' | 'internal';

/** 装的插件从哪来；ai 是 AI 助手做的页面（docs/plugins.md 5.1，算「我的」） */
export type PackageKind = 'file' | 'folder' | 'git' | 'ai';

export interface InstalledInfo {
  kind: PackageKind;
  /** 文件名、文件夹的路径、git 地址 */
  location: string;
  /** git 的分支或标签 */
  ref: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface PluginErrorInfo {
  at: string;
  /** 哪里出的错（加载、视图、服务端……） */
  source: string;
  message: string;
}

export interface PluginInfo {
  id: string;
  /** 清单里的名字 */
  name: string;
  /** 你改的名字（null = 用原名） */
  displayName: string | null;
  source: PluginSource;
  version: string;
  description?: string;
  enabled: boolean;
  required: boolean;
  kinds: PluginKind[];
  contributes: Contributes;
  /** 覆盖的值和别的启用的插件冲突（被别的插件压过时也列出来） */
  conflicts: OverrideKey[];
  /** 不能启用的原因（版本不兼容、用到了还不支持的贡献点、包不见了……）；有的话 enabled 一定是 false */
  problems: string[];
  /** 装的插件：从哪装的 */
  installed?: InstalledInfo;
  /** 装的插件：清单里要的权限、给了的授权 */
  permissions?: PluginPermissions;
  grant?: Grant;
  /** 最近的出错记录（新的在前）；自动停用时写明原因 */
  errors?: PluginErrorInfo[];
  disabledReason?: string | null;
  /** 清单里 setting@1 登记的设置现在的值（凭证只说填没填，值不给网页） */
  settings?: PluginSettingValue[];
  /** 改内部的插件（patch@1）：改的每个点现在怎么样 */
  patches?: PatchInfo[];
}

/**
 * 改内部的插件改的一个点现在怎么样：active 补丁加上了；off 没加（插件停用了、还在加载）；
 * changed 装上、启用以后 Emaki 改了这个点（更新了），插件自动停用，等你「仍然启用」；missing 这个版本的 Emaki 里没有这个点
 */
export interface PatchInfo {
  point: string;
  /** 点的人话名字（「排名的张数怎么数」） */
  label: string;
  why?: string;
  status: 'active' | 'off' | 'changed' | 'missing';
}

/** 加了补丁的一个内部点：谁改了它（按加上的顺序，后面的在外层） */
export interface PatchedPoint {
  point: string;
  label: string;
  plugins: string[];
}

/** 插件的一项设置现在的值：普通的给值；凭证（secret）value 一律是 null，只看 filled */
export interface PluginSettingValue {
  id: string;
  value: string | null;
  filled: boolean;
}

/** 随 Emaki 一起发的插件（仓库的 plugins/ 下，docs/plugins.md 第 6 节）：默认没装，在「插件」页「附带的」里启用，走一样的授权单 */
export interface BundledPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 文件夹（按文件夹装：plugins.inspect { kind: 'folder', path }） */
  path: string;
}

/**
 * 准备安装（或更新）的一个包：服务端解开、读了清单，等你在授权单上确认（PUT /api/plugins/packages、plugins.inspect）。
 * token 交给 plugins.install；过一小时作废。
 */
export interface PluginPackage {
  token: string;
  source: { kind: PackageKind; location: string; ref: string | null };
  manifest: PluginManifest;
  /** 装不上的原因（有的话授权单上只能取消） */
  problems: string[];
  /** 已经装了同一个插件：现在的版本和授权（这次就是更新） */
  current: { version: string; grant: Grant } | null;
  /** 这次要新给的权限（没装过就是全部）；更新时什么都没多，就不用再出授权单 */
  added: PluginPermissions;
  /** 每个要的文件夹默认放在哪（装过的沿用原来选的） */
  folderDefaults: Record<string, { rootId: number; dir: string } | null>;
  /** 改内部的插件：要改的点（授权单上列出来） */
  patches?: PatchInfo[];
}

/** 打开一个视图页面要的东西（plugins.view，GET /api/plugins/:id/pages/:page） */
export interface PluginView {
  pluginId: string;
  pageId: string;
  version: string;
  /** 页头上的标题 */
  title: string;
  /** 视图的 HTML（宿主再加上安全策略，放进隔离的 iframe） */
  html: string;
  /** 图片的短期地址前缀：`${mediaBase}/thumb/<图片 id>`、`${mediaBase}/original/<图片 id>`；没有「读图库」的授权时是 null */
  mediaBase: string | null;
  /** 视图能调的工具（按授权过滤过的，名字和 MCP 里的一样） */
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
}

/** 视图调一个工具的结果（MCP 的 CallToolResult：文本是 JSON） */
export interface PluginCallResult {
  isError?: boolean;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: unknown;
}

/**
 * 视图能用的 Emaki 自己的方法（MCP Apps 之外的，docs/plugins.md 第 5 节），走同一条 postMessage 通道。
 * 版本号在宿主信息里（hostInfo.name 是 Emaki 时看 experimental.emaki.version）；在 Claude 里没有这些方法，视图要退化。
 */
export const EMAKI_VIEW_API_VERSION = 1;
export const EMAKI_VIEW_METHODS = {
  /** 这个视图是谁、图片地址的前缀、从哪个接管的链接打开的、能调的工具（{ pluginId, pageId, mediaBase, link, tools }） */
  context: 'emaki/context',
  /** 跳到 Emaki 里的一个地址（{ to: '/gallery?favorite=1' }） */
  navigate: 'emaki/navigate',
  /** 用看图器打开几张图（{ ids, index? }） */
  openImages: 'emaki/openImages',
  /** 插件自己的键值存储（{ key }、{ key, value }、{ prefix }） */
  storageGet: 'emaki/storage/get',
  storageSet: 'emaki/storage/set',
  storageDelete: 'emaki/storage/delete',
  storageList: 'emaki/storage/list',
} as const;
/** 宿主推给视图的通知：图库变了（{ reason }），视图可以重新取数 */
export const EMAKI_CHANGED_NOTIFICATION = 'emaki/changed';

/** 侧栏里的一项（已经按你的顺序排好；停用的插件的项不在这里） */
export interface NavEntry extends NavItemContribution {
  plugin: string;
  /** 在不在侧栏显示 */
  visible: boolean;
}

export interface OverrideState {
  value: unknown;
  /** 哪个插件给的值；null = 内置默认 */
  plugin: string | null;
  /** 覆盖这个值的所有启用着的插件（多于一个就是冲突） */
  candidates: string[];
}

export interface PluginsState {
  /** 安全模式：只用内置插件、全部按原样，我的和装的不加载，覆盖不生效 */
  safeMode: boolean;
  plugins: PluginInfo[];
  /** 侧栏：三段，各自按顺序 */
  nav: Record<NavSection, NavEntry[]>;
  /** 停用的插件拥有的页面（网页的页面 id）、区块、别处的条目（页头操作、菜单项、看图器的按钮和信息栏） */
  disabledPages: string[];
  disabledBlocks: string[];
  disabledEntries: string[];
  overrides: Record<OverrideKey, OverrideState>;
  /** 附带的插件里还没装的（服务端填；安全模式下没有） */
  bundled?: BundledPlugin[];
  /** 「谁改了哪里」：加了补丁的内部点（服务端填，docs/plugins.md 第 7 节） */
  patched?: PatchedPoint[];
  /** 网页要加载的改网页的模块（服务端填；安全模式下没有） */
  webPatches?: WebPatchModule[];
  /**
   * 网页的安全模式（?safe）下，服务端还在跑的改内部的插件：网页的安全模式管不到服务端，它们的补丁还在（张数这类还是改过的）。
   * 「插件」页给「全部停用」（plugins.disableInternal）。后端以 --safe 启动、或者没有在跑的时候没有（docs/plugins.md 第 8 节）
   */
  internalRunning?: { id: string; name: string }[];
}

/** 插件显示的名字：改过就用改的 */
export const pluginLabel = (p: Pick<PluginInfo, 'name' | 'displayName'>): string => p.displayName ?? p.name;

// ---------------------------------------------------------------- 从状态算出生效的结果（服务端用它；网页在还没取到时用它算内置的默认）

/** 侧栏的布局（贡献点 nav.item 的状态）：三段各自的顺序、在不在侧栏 */
export interface NavLayout {
  sections: Partial<Record<NavSection, string[]>>;
  visible: Record<string, boolean>;
}

/** 必需的导航项：不能从侧栏拿掉（设置里有「插件」页的入口，拿掉就没处去了） */
export const PINNED_NAV: ReadonlySet<string> = new Set(['settings']);

export interface PluginRecord {
  manifest: PluginManifest;
  source: PluginSource;
  required: boolean;
  enabled: boolean;
  displayName: string | null;
  /** 最近一次启用的时间（覆盖冲突时按后启用的那个） */
  enabledAt: string | null;
  /** 不能启用的原因：有的话按停用算 */
  problems?: string[];
  /** 原样带到 PluginInfo 上的（装的插件的来源、授权、出错记录） */
  extra?: Pick<PluginInfo, 'installed' | 'permissions' | 'grant' | 'errors' | 'disabledReason' | 'settings' | 'patches'>;
}

export function kindsOf(c: Contributes): PluginKind[] {
  const kinds: PluginKind[] = [];
  if (c['page@1']?.length || c['nav.item@1']?.length) kinds.push('page');
  if (c['override@1'] && Object.keys(c['override@1']).length) kinds.push('override');
  if (c['command@1']?.length || c['job.kind@1']?.length) kinds.push('feature');
  if (c['patch@1']?.length) kinds.push('internal');
  return kinds;
}

/**
 * 插件 + 各贡献点的状态 → 生效的结果（PluginsState）。只有这一份：服务端（domain/plugins/）按数据库里的状态算，
 * 网页在 GET /api/plugins 回来之前按内置插件的默认算（结果和服务端什么都没改过时一样，所以不闪）。
 */
export function resolvePlugins(input: {
  plugins: readonly PluginRecord[];
  nav: NavLayout;
  /** 覆盖冲突时选了哪个插件 */
  overrideChoices: Readonly<Record<string, string>>;
  safeMode: boolean;
}): PluginsState {
  const recs = input.plugins.map((p) => (p.problems?.length && p.enabled ? { ...p, enabled: false } : p));
  const enabledRecs = recs.filter((p) => p.enabled);
  const overrides = resolveOverrides(enabledRecs, input.overrideChoices);
  const conflictsOf = (id: string) => OVERRIDE_KEYS.filter((k) => overrides[k].candidates.length > 1 && overrides[k].candidates.includes(id));
  const plugins: PluginInfo[] = recs.map((p) => ({
    id: p.manifest.id,
    name: p.manifest.name,
    displayName: p.displayName,
    source: p.source,
    version: p.manifest.version,
    ...(p.manifest.description && { description: p.manifest.description }),
    enabled: p.enabled,
    required: p.required,
    kinds: kindsOf(p.manifest.contributes),
    contributes: p.manifest.contributes,
    conflicts: conflictsOf(p.manifest.id),
    problems: p.problems ?? [],
    ...p.extra,
  }));
  const off = recs.filter((p) => !p.enabled);
  return {
    safeMode: input.safeMode,
    plugins,
    nav: resolveNav(
      plugins.filter((p) => p.enabled),
      input.nav,
    ),
    disabledPages: off.flatMap((p) => (p.manifest.contributes['page@1'] ?? []).map((x) => x.id)),
    disabledBlocks: off.flatMap((p) => (p.manifest.contributes['block@1'] ?? []).map((x) => x.id)),
    disabledEntries: off.flatMap((p) => SLOT_POINT_KEYS.flatMap((k) => (p.manifest.contributes[k] ?? []).map((x) => x.id))),
    overrides,
  };
}

/** 侧栏：先按你排的，没排到的（新启用的、新加的）接在它默认那一段的最后 */
function resolveNav(enabled: readonly PluginInfo[], layout: NavLayout): Record<NavSection, NavEntry[]> {
  const items = new Map<string, NavEntry>();
  for (const p of enabled) {
    const navs = p.contributes['nav.item@1'] ?? [];
    for (const n of navs) {
      // 只有一个导航项的插件（原来的每一页）：改插件的名字就是改这一页的名字
      const label = p.displayName && navs.length === 1 ? p.displayName : n.label;
      const visible = PINNED_NAV.has(n.id) ? true : (layout.visible[n.id] ?? !n.hiddenByDefault);
      items.set(n.id, { ...n, label, plugin: p.id, visible });
    }
  }
  const out = Object.fromEntries(NAV_SECTIONS.map((s) => [s, [] as NavEntry[]])) as Record<NavSection, NavEntry[]>;
  const placed = new Set<string>();
  for (const s of NAV_SECTIONS)
    for (const id of layout.sections[s] ?? []) {
      const it = items.get(id);
      if (it && !placed.has(id)) {
        placed.add(id);
        out[s].push({ ...it, section: s });
      }
    }
  for (const it of items.values()) if (!placed.has(it.id)) out[it.section].push(it);
  return out;
}

/** 每个能覆盖的值：启用的插件里谁覆盖了它；冲突时按你选的，没选按后启用的那个 */
function resolveOverrides(enabled: readonly PluginRecord[], choices: Readonly<Record<string, string>>): Record<OverrideKey, OverrideState> {
  const byEnabledAt = [...enabled].sort((a, b) => (a.enabledAt ?? '').localeCompare(b.enabledAt ?? ''));
  return Object.fromEntries(
    OVERRIDE_KEYS.map((key) => {
      const cands = byEnabledAt.filter((p) => validOverride(key, p.manifest.contributes['override@1']?.[key]));
      const chosen = cands.find((p) => p.manifest.id === choices[key]) ?? cands.at(-1);
      const state: OverrideState = {
        value: chosen ? chosen.manifest.contributes['override@1']![key] : OVERRIDES[key].default,
        plugin: chosen?.manifest.id ?? null,
        candidates: cands.map((p) => p.manifest.id),
      };
      return [key, state];
    }),
  ) as Record<OverrideKey, OverrideState>;
}

/** 什么都没改过（或者安全模式）时的结果：内置插件全部启用、按原样 */
export function builtinPluginsState(safeMode = false): PluginsState {
  return resolvePlugins({
    plugins: BUILTIN_PLUGINS.map((m) => ({ manifest: m, source: 'builtin', required: !!m.required, enabled: true, displayName: null, enabledAt: null })),
    nav: { sections: {}, visible: {} },
    overrideChoices: {},
    safeMode,
  });
}
