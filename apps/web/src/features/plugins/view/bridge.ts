/**
 * 插件视图的桥接（宿主这一端，docs/plugins.md 第 5 节、12.1 ②）：官方的 AppBridge 不接 MCP 客户端，
 * 视图的 tools/call 转给服务端（POST /api/plugins/:id/call，按插件的授权 ∩ 这个入口调注册表里的命令和查询）。
 * 另外挂 Emaki 自己的方法（emaki/…，带版本号，在宿主能力 experimental.emaki 里声明）：这一页是谁、图片地址的前缀、
 * 跳转、打开看图器、插件自己的存储；图库变了推 emaki/changed。
 *
 * 这个文件连同官方库约 1 MB，只在第一次打开插件页面时按需加载（ViewFrame 里 import()），不进主包。
 */
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { EMAKI_CHANGED_NOTIFICATION, EMAKI_VIEW_API_VERSION, EMAKI_VIEW_METHODS as M, type PluginView } from '@emaki/shared';
import { api } from '@/lib/api';
import { hostStyles, themeOf } from './frame';

/** 不校验的 schema：参数在下面按需要取 */
type Params = Record<string, unknown>;
const any = {
  '~standard': {
    version: 1 as const,
    vendor: 'emaki',
    validate: (value: unknown) => ({ value: (value ?? {}) as Params }),
    types: undefined as unknown as { input: unknown; output: Params },
  },
};

export interface ViewHost {
  /** 跳到 Emaki 里的一个地址 */
  navigate(to: string): void;
  /** 用看图器打开几张图 */
  openImages(ids: string[], index: number): void;
  /** 一次调用改了图库（可撤销的进撤销栈） */
  onMutation(result: { undoToken: string; message: string }): void;
  /** 从插件接管的链接打开的（link@1，docs/plugins.md 12.7）：那个链接；视图在 emaki/context 里拿到 */
  link?: string | null;
}

export interface ConnectedView {
  /** 握手完成（视图调了 connect） */
  ready: Promise<void>;
  /** 主题变了：把新的样式交给视图 */
  restyle(): void;
  /** 图库变了 */
  changed(reason: string): void;
  close(): Promise<void>;
}

/** 只认 Emaki 里的地址（/ 开头，不能是 //） */
const internal = (to: unknown): to is string => typeof to === 'string' && /^\/(?![/\\])/.test(to);

export function connectView(iframe: HTMLIFrameElement, view: PluginView, host: ViewHost): ConnectedView {
  const win = iframe.contentWindow!;
  const context = () => ({
    theme: themeOf(iframe),
    styles: { variables: hostStyles(iframe) },
    locale: 'zh-CN',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    displayMode: 'inline' as const,
    availableDisplayModes: ['inline' as const],
    platform: 'web' as const,
    containerDimensions: { width: iframe.clientWidth, height: iframe.clientHeight },
  });
  const bridge = new AppBridge(
    null,
    { name: 'Emaki', version: String(EMAKI_VIEW_API_VERSION) },
    {
      serverTools: {},
      openLinks: {},
      logging: {},
      experimental: { emaki: { version: EMAKI_VIEW_API_VERSION, methods: Object.values(M) } },
    },
    { hostContext: context() },
  );
  const { pluginId } = view;

  bridge.oncalltool = async (params) => {
    const result = await api.pluginCall(pluginId, params.name, (params.arguments ?? {}) as Params);
    // 改了图库、能撤销的：放进这个页面的撤销栈
    const text = result.content?.[0];
    if (!result.isError && text?.type === 'text' && text.text) {
      try {
        const r = JSON.parse(text.text) as { undoToken?: unknown; message?: unknown };
        if (typeof r.undoToken === 'string')
          host.onMutation({ undoToken: r.undoToken, message: typeof r.message === 'string' ? r.message : params.name });
      } catch {
        // 不是 JSON：读的结果，不管
      }
    }
    return result as Awaited<ReturnType<NonNullable<AppBridge['oncalltool']>>>;
  };
  bridge.onopenlink = async ({ url }) => {
    if (internal(url)) host.navigate(url);
    else if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
    return {};
  };
  bridge.onloggingmessage = () => {};

  bridge.setRequestHandler(M.context, { params: any, result: any }, () => ({
    pluginId,
    pageId: view.pageId,
    mediaBase: view.mediaBase,
    link: host.link ?? null,
  }));
  bridge.setRequestHandler(M.navigate, { params: any, result: any }, (p: Params) => {
    if (!internal(p.to)) throw new Error('只能跳到 Emaki 里的地址（以 / 开头）');
    host.navigate(p.to);
    return {};
  });
  bridge.setRequestHandler(M.openImages, { params: any, result: any }, (p: Params) => {
    const ids = Array.isArray(p.ids) ? p.ids.map(String).slice(0, 5000) : [];
    if (ids.length) host.openImages(ids, Math.max(0, Math.min(ids.length - 1, Number(p.index) || 0)));
    return {};
  });
  bridge.setRequestHandler(M.storageGet, { params: any, result: any }, async (p: Params) =>
    api.pluginStorage(pluginId, { op: 'get', key: String(p.key) }),
  );
  bridge.setRequestHandler(M.storageSet, { params: any, result: any }, async (p: Params) =>
    api.pluginStorage(pluginId, { op: 'set', key: String(p.key), value: p.value }),
  );
  bridge.setRequestHandler(M.storageDelete, { params: any, result: any }, async (p: Params) =>
    api.pluginStorage(pluginId, { op: 'delete', key: String(p.key) }),
  );
  bridge.setRequestHandler(M.storageList, { params: any, result: any }, async (p: Params) =>
    api.pluginStorage(pluginId, { op: 'list', prefix: typeof p.prefix === 'string' ? p.prefix : '' }),
  );

  const ready = new Promise<void>((resolve) => {
    bridge.oninitialized = () => resolve();
  });
  void bridge.connect(new PostMessageTransport(win, win));

  return {
    ready,
    restyle: () => void bridge.setHostContext(context()),
    changed: (reason) => void bridge.notification({ method: EMAKI_CHANGED_NOTIFICATION, params: { reason } }).catch(() => {}),
    close: async () => {
      await bridge.close().catch(() => {});
    },
  };
}
