/**
 * 命令和查询的权限范围（docs/core-architecture.md 第 4.1、10 节）。每个命令 / 查询在注册表里声明一个 scope；
 * AI 助手（MCP）能用哪些由 scope 决定（ASSISTANT_SCOPES），以后给插件、AI 生成的页面授权也按它。
 * 命令的清单在服务端 GET /api/commands（名字、说明、scope、是否可撤销、是否支持 operationId）。
 */

export const SCOPES = {
  read: '读图库（列表、详情、计数）',
  curate: '改单张图的决定：角色、收藏、分级、类型、放下、原创、画师、来源、排除 / 恢复这张图',
  catalog: '改角色目录：建角色、改角色、合并、查证、画师的拆合',
  collections: '合集：建、改、解散、批量整理、出场角色',
  import: '把下载好的文件加进图库，或替换成高清版（不删、不移用户已有的文件）',
  'organize-files': '移动、移到回收站、处理重复（会动用户图库里的文件）',
  rules: '整库按规则批量改：排除规则、按阈值补采纳',
  duplicates: '查重的处理结果（忽略一组）',
  settings: '图库设置、图库文件夹、识别方式',
  jobs: '启动、取消后台任务（含重新识别）',
  history: '撤销、撤回最近的改动',
  ui: '界面上的小动作：标记看过',
  upload: '从手机上传图片',
  devices: '管理手机等设备：局域网入口的开关、批准、拒绝、撤销、改权限',
  desktop: '在这台电脑的屏幕上弹东西：在资源管理器中显示、选文件夹',
  plugins: '插件：启用、停用、改名、删除，新建覆盖，调整侧栏的页面顺序（docs/plugins.md）',
  'install-plugins': '装插件：从文件、文件夹或 git 地址安装、更新别人写的插件（授权单只能由你在页面上确认）',
} as const;
export type Scope = keyof typeof SCOPES;

/**
 * AI 助手能用的范围：和 P6 之前手写的 MCP 工具同一条边界——能读图库、改单张图的决定、编目、合集、导入替换、启动 / 取消任务；
 * 不能动用户已有的文件（移动、回收、处理重复）、不能改设置和规则、不能撤销（撤销由用户在页面上做）。
 * 改这里等于扩大助手的能力：test/architecture/registry.test.ts 的 MCP 快照会失败，要一起改并说明理由
 */
// plugins（2026-11-24 加）：用户要「说一句话让助手做一个覆盖插件」（docs/plugins.md 9.5）；插件的改动都能撤销
export const ASSISTANT_SCOPES: readonly Scope[] = ['read', 'curate', 'catalog', 'collections', 'import', 'jobs', 'plugins'];

/**
 * 手机等设备批准时默认给的范围（docs/mobile.md 2.5）：看、整理单张图、编目、合集、撤销、标记看过，加上 B 阶段的上传。
 */
// plugins（2026-11-24 加）：在平板上也能启用、停用插件、调侧栏顺序；都能撤销，不碰图库数据
export const DEVICE_DEFAULT_SCOPES: readonly Scope[] = ['read', 'curate', 'catalog', 'collections', 'history', 'ui', 'upload', 'plugins'];

/**
 * 批准时最多能勾的范围：默认的，加上移动文件、设置、规则、查重、任务、导入。
 * devices（管理设备）和 desktop（在电脑屏幕上弹窗）永远不在这里：设备凭证拿不到它们，怎么勾都不行
 * （test/access/permissions.test.ts 断言）。
 */
export const DEVICE_GRANTABLE_SCOPES: readonly Scope[] = [
  ...DEVICE_DEFAULT_SCOPES,
  'organize-files',
  'settings',
  'rules',
  'duplicates',
  'jobs',
  'import',
  'install-plugins',
];

/**
 * 插件能要的范围（docs/plugins.md 4.1）：图库的读写、整理、任务都行；管设备、在电脑屏幕上弹窗、管插件、装插件、手机上传不行
 * ——这些是给人和设备的。清单里要了别的，装不上（domain/plugins/manifest.ts）
 */
export const PLUGIN_GRANTABLE_SCOPES: readonly Scope[] = [
  'read',
  'curate',
  'catalog',
  'collections',
  'import',
  'organize-files',
  'rules',
  'duplicates',
  'settings',
  'jobs',
  'history',
  'ui',
];

/** AI 助手做的页面最多能要的范围：不超过助手自己的，也不超过插件能要的（docs/plugins.md 5.1） */
export const AI_VIEW_SCOPES: readonly Scope[] = ASSISTANT_SCOPES.filter((s) => PLUGIN_GRANTABLE_SCOPES.includes(s));

/** 命令名 → 工具名（MCP 工具、插件视图里调用用的名字）：curation.setFavorite → curation_set_favorite */
export const commandToolName = (command: string): string => command.replace(/\./g, '_').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** GET /api/commands：注册表里的一项 */
export interface CommandInfo {
  name: string;
  kind: 'command' | 'query';
  summary: string;
  scope: Scope;
  /** 命令：可撤销（返回 undoToken）；false 是撤销屏障 */
  undoable?: boolean;
  /** 命令：支持 operationId（请求头 Idempotency-Key） */
  idempotent?: boolean;
  /** 对应的 HTTP 地址（第一个是推荐的；legacy 的是兼容旧调用者的，以后可以删） */
  http: { method: string; path: string; legacy?: boolean }[];
}
