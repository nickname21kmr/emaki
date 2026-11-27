/**
 * 插件视图用的库（docs/plugins.md 第 5 节）。宿主在 /plugin-sdk/app.js 提供（vite.plugin-sdk.ts 打成一个 IIFE，不进网页的主包），
 * 视图写 `<script src="/plugin-sdk/app.js"></script>`，得到全局的 `Emaki`：
 * - `Emaki.App`：官方的 App 类（MCP Apps，@modelcontextprotocol/ext-apps 2.0.4），想自己管协议的直接用它；
 * - `Emaki.connect()`：一层小封装——连上宿主、套上宿主给的主题和 CSS 变量，返回 read / call / thumb / open / storage / onChanged。
 *
 * 同一页经 MCP 给到 Claude 这类别的宿主时，这个文件被内联进页面（apps/server/src/assistant/views.ts），同一套写法照样能用：
 * Emaki 自己的方法（emaki/…）在那边没有，这里退化——跳转、打开看图器什么都不做，存储放在内存里，图片经 read_media 取成 data: 地址。
 */
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps/app-with-deps';
import { commandToolName, EMAKI_CHANGED_NOTIFICATION, EMAKI_VIEW_API_VERSION, EMAKI_VIEW_METHODS as M } from '@emaki/shared';
// 匿名来源的 iframe 不一定是安全上下文（局域网 http）：用带退路的 uuid
import { uuid } from '@/lib/random';

export { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables };

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type HostContext = ReturnType<App['getHostContext']>;

export interface EmakiView {
  /** 官方的 App（已经连上） */
  readonly app: App;
  /** 在 Emaki 里（有 emaki/ 方法）；在 Claude 等别的宿主里是 false */
  readonly inEmaki: boolean;
  /**
   * 从插件接管的链接（清单里的 link@1，docs/plugins.md 12.7）打开这一页的：那个链接（比如图片来源的作品页），
   * 视图按它显示；直接打开这一页、在别的宿主里是 null
   */
  readonly link: string | null;
  /**
   * 调一个工具，返回解析好的结果（文本是 JSON 就解析）；工具报错时抛出。写操作没给 operationId 自动补一个。
   * 也可以直接写命令名（带点的，比如插件自己的 pixiv-browser.download），自动换成工具名
   */
  call<T = Json>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** read_library：按 Emaki 的地址读图库（/api/works?limit=20），返回解析好的 JSON */
  read<T = Json>(path: string): Promise<T>;
  /** 一张图的缩略图地址（img.src 用） */
  thumb(imageId: string | number, width?: number): Promise<string>;
  /** 一张图的原图地址 */
  original(imageId: string | number): Promise<string>;
  /** 插件自己文件夹里一张图的地址（插件的服务端下载的缩略图这类，img.src 用）；只在 Emaki 里有，别的宿主是 null */
  file(path: string): string | null;
  /** 跳到 Emaki 里的一个地址（只在 Emaki 里有） */
  open(to: string): void;
  /** 用看图器打开几张图（只在 Emaki 里有） */
  openImages(ids: (string | number)[], index?: number): void;
  /** 这一页自己的键值存储（在别的宿主里只在内存里） */
  readonly storage: {
    get<T = Json>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };
  /** 图库变了（整理、导入以后）；返回取消订阅（只在 Emaki 里有） */
  onChanged(fn: (reason: string) => void): () => void;
}

/** 不校验的 schema（自定义方法的结果原样拿回来） */
const any = { '~standard': { version: 1 as const, vendor: 'emaki', validate: (value: unknown) => ({ value }) } };

function applyContext(ctx: HostContext): void {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

/** 工具的结果 → 值：出错抛出；文本是 JSON 就解析；图片给 data: 地址 */
function unwrap(result: {
  isError?: boolean;
  content?: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: unknown;
}): Json {
  const first = result.content?.[0];
  if (result.isError) throw new Error(first?.text ?? '调用失败');
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!first) return null;
  if (first.type === 'image') return `data:${first.mimeType ?? 'image/jpeg'};base64,${first.data}`;
  if (first.type !== 'text') return first;
  try {
    return JSON.parse(first.text ?? '');
  } catch {
    return first.text;
  }
}

export async function connect(info: { name?: string; version?: string } = {}): Promise<EmakiView> {
  const app = new App({ name: info.name ?? 'emaki-view', version: info.version ?? '1.0.0' });
  const listeners = new Set<(reason: string) => void>();
  app.setNotificationHandler(EMAKI_CHANGED_NOTIFICATION, { params: any }, (params: Json) => {
    for (const fn of listeners) fn(String(params?.reason ?? ''));
  });
  app.onhostcontextchanged = (ctx) => applyContext(ctx);
  await app.connect();
  applyContext(app.getHostContext());

  const emaki = (app.getHostCapabilities()?.experimental as Record<string, { version?: number }> | undefined)?.emaki;
  const inEmaki = app.getHostVersion()?.name === 'Emaki' && (emaki?.version ?? 0) >= EMAKI_VIEW_API_VERSION;
  const request = (method: string, params: Record<string, unknown> = {}) => app.request({ method, params }, any) as Promise<Json>;
  const context: { mediaBase: string | null; link?: string | null } = inEmaki ? await request(M.context) : { mediaBase: null };

  const call = async (command: string, args: Record<string, unknown> = {}) => {
    const name = command.includes('.') ? commandToolName(command) : command;
    // 写工具都要 operationId（重试时用同一个），没给就补一个；读工具多一个参数也不碍事
    const withOp = name.startsWith('read_') || 'operationId' in args ? args : { operationId: uuid(), ...args };
    return unwrap((await app.callServerTool({ name, arguments: withOp })) as Parameters<typeof unwrap>[0]);
  };
  const memory = new Map<string, unknown>();
  const media = async (size: 'thumb' | 'original', id: string | number, width?: number): Promise<string> => {
    if (context.mediaBase) return `${context.mediaBase}/${size}/${encodeURIComponent(String(id))}${width ? `?w=${width}` : ''}`;
    // 别的宿主：经 read_media 取成 data:（它只认原图，缩到 size）
    return call('read_media', { imageId: String(id), ...(size === 'thumb' && { size: width ?? 480 }) });
  };

  return {
    app,
    inEmaki,
    link: typeof context.link === 'string' ? context.link : null,
    call,
    read: (path) => call('read_library', { path }),
    thumb: (id, width) => media('thumb', id, width),
    original: (id) => media('original', id),
    file: (path) => (context.mediaBase ? `${context.mediaBase}/file/${path.split('/').map(encodeURIComponent).join('/')}` : null),
    open(to) {
      if (inEmaki) void request(M.navigate, { to });
    },
    openImages(ids, index = 0) {
      if (inEmaki) void request(M.openImages, { ids: ids.map(String), index });
    },
    storage: {
      get: async (key) => (inEmaki ? ((await request(M.storageGet, { key })).value ?? null) : (memory.get(key) ?? null)),
      set: async (key, value) => void (inEmaki ? await request(M.storageSet, { key, value }) : memory.set(key, value)),
      delete: async (key) => void (inEmaki ? await request(M.storageDelete, { key }) : memory.delete(key)),
      list: async (prefix = '') =>
        inEmaki ? (await request(M.storageList, { prefix })).keys : [...memory.keys()].filter((k) => k.startsWith(prefix)),
    },
    onChanged(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
