/**
 * 插件（docs/plugins.md）。在用的人看来，页面、覆盖设置、以后的功能都是「插件」，在「插件」页里启用、停用、改名、删除；
 * 实现上只有**插件管理**是统一的（身份、启用、显示名、授权……），下面是各管各的**贡献点**（page、nav.item、override、block……），
 * 每种有自己的格式、合并和冲突规则（第 9 节）。
 *
 * 这个文件放两边都要用的：贡献点的格式、内置插件的清单（原来的每一页是一个内置插件）、能被覆盖的值（设置注册表）、
 * GET /api/plugins 的返回。谁启用了、生效的贡献清单由服务端算（domain/plugins/），网页只用它的结果。
 */
import type { ImageSort } from './api.ts';

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
] as const;
export type NavIcon = (typeof NAV_ICONS)[number];

// ---------------------------------------------------------------- 贡献点（E1：page、nav.item、block、override）

/** page@1：一页。内置插件写网页的页面 id（apps/web/src/pages.ts），插件的页面以后是视图（E4） */
export interface PageContribution {
  id: string;
}

/** nav.item@1：侧栏（手机上是底部标签栏）里的一项 */
export interface NavItemContribution {
  /** 稳定 id（顺序、在不在侧栏按它存） */
  id: string;
  label: string;
  /** 地址；`:originalWorkId` 这种由网页按图库的情况填（没有原创作品时不显示） */
  to: string;
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

export interface Contributes {
  'page@1'?: PageContribution[];
  'nav.item@1'?: NavItemContribution[];
  'block@1'?: BlockContribution[];
  /** override@1：设置注册表里登记过的值（OVERRIDES） */
  'override@1'?: Partial<Record<OverrideKey, unknown>>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  contributes: Contributes;
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
  builtin('works', '作品', '每部作品的页面，以及侧栏的「原创」', {
    'page@1': [{ id: 'work' }],
    'nav.item@1': [nav('original', '原创', '/works/:originalWorkId', 'sparkles', 'main', { shortcut: true })],
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
      'page@1': [{ id: 'plugins' }, { id: 'plugin' }],
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
export type PluginKind = 'page' | 'override';

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
}

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
  /** 停用的插件拥有的页面（网页的页面 id）和区块 */
  disabledPages: string[];
  disabledBlocks: string[];
  overrides: Record<OverrideKey, OverrideState>;
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
}

export function kindsOf(c: Contributes): PluginKind[] {
  const kinds: PluginKind[] = [];
  if (c['page@1']?.length || c['nav.item@1']?.length) kinds.push('page');
  if (c['override@1'] && Object.keys(c['override@1']).length) kinds.push('override');
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
  const enabledRecs = input.plugins.filter((p) => p.enabled);
  const overrides = resolveOverrides(enabledRecs, input.overrideChoices);
  const conflictsOf = (id: string) => OVERRIDE_KEYS.filter((k) => overrides[k].candidates.length > 1 && overrides[k].candidates.includes(id));
  const plugins: PluginInfo[] = input.plugins.map((p) => ({
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
  }));
  const off = input.plugins.filter((p) => !p.enabled);
  return {
    safeMode: input.safeMode,
    plugins,
    nav: resolveNav(
      plugins.filter((p) => p.enabled),
      input.nav,
    ),
    disabledPages: off.flatMap((p) => (p.manifest.contributes['page@1'] ?? []).map((x) => x.id)),
    disabledBlocks: off.flatMap((p) => (p.manifest.contributes['block@1'] ?? []).map((x) => x.id)),
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
