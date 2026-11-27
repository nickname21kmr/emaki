import type { PluginView } from '@emaki/shared';
import { PowerOff, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, EmptyState, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/capabilities';
import { onLibraryChanged } from '@/lib/events';
import { useMutate } from '@/lib/queries';
import { useLightbox, useUndoStore } from '@/lib/stores';
import { askAssistant } from '@/features/assistant/dock';
import { useAssistantSettings } from '@/features/assistant/client';
import type { ConnectedView } from './bridge';
import { useViewContext } from './viewContext';
import { themeOf, viewSrcdoc } from './frame';

/** 视图多久没连上算坏了 */
const HANDSHAKE_MS = 15_000;

/**
 * 一个插件视图（docs/plugins.md 第 5 节）：隔离的 iframe（只开 allow-scripts），加上桥接（./bridge.ts，按需加载）。
 * iframe 在这里自己建：先设好 sandbox 和 srcdoc 再放进页面，第一次 load 就是视图本身，之后再 load 说明它把自己跳走了
 * （可能借此把数据带出去，docs/plugins.md 第 5 节「自己跳走」）——马上撤掉、记一次错。没连上、跳走了都显示一张错误卡，
 * 卡上能重新载入、停用这个插件；出错多次服务端自动停用。
 */
export function ViewFrame({ view, label, link = null }: { view: PluginView; label: string; link?: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | 'ready' | { error: string }>('loading');
  const [attempt, setAttempt] = useState(0);
  const can = useCan('plugins');
  const disable = useMutate((id: string) => api.setPluginEnabled(id, false));
  // 回调里用最新的 navigate，不让 effect 因它重跑（重跑就是重新载入视图）
  const nav = useRef(navigate);
  nav.current = navigate;
  // AI 助手开着、这台设备能用（ui/message 才放进输入框）
  const canAssistant = useCan('assistant');
  const assistantOn = useAssistantSettings().data?.enabled ?? false;
  const assistant = useRef(false);
  assistant.current = canAssistant && assistantOn;

  useEffect(() => {
    const container = box.current!;
    let alive = true;
    let conn: ConnectedView | null = null;
    let iframe: HTMLIFrameElement | null = null;
    /** blame：是插件的问题（记一次错，出错多次自动停用）；Emaki 自己的（运行库没加载出来）不算插件的 */
    const fail = (message: string, blame = true) => {
      if (!alive) return;
      alive = false;
      setState({ error: message });
      iframe?.remove();
      void conn?.close();
      if (blame) void api.pluginError(view.pluginId, message).catch(() => {});
    };
    const timer = setTimeout(() => fail(`页面 ${HANDSHAKE_MS / 1000} 秒内没有连上 Emaki（页面里要调用 Emaki.connect()）`), HANDSHAKE_MS);
    let pending: string | null = null;
    let flush: ReturnType<typeof setTimeout> | null = null;
    // 图库变了：半秒内的合成一次告诉视图
    const offChanged = onLibraryChanged((reason) => {
      pending = reason;
      flush ??= setTimeout(() => {
        flush = null;
        if (pending !== null) conn?.changed(pending);
        pending = null;
      }, 500);
    });
    const themeWatch = new MutationObserver(() => {
      if (iframe) iframe.style.colorScheme = themeOf(container);
      conn?.restyle();
    });
    themeWatch.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-theme', 'data-palette'] });

    void import('./bridge').then(
      ({ connectView }) => {
        if (!alive) return;
        iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.setAttribute('title', label);
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.className = 'block h-full w-full border-0 bg-transparent';
        iframe.style.colorScheme = themeOf(container);
        iframe.srcdoc = viewSrcdoc(view.html, window.location.origin);
        let loads = 0;
        iframe.addEventListener('load', () => {
          loads += 1;
          if (loads > 1) fail('页面把自己跳到了别的地址，已经撤掉');
        });
        container.appendChild(iframe);
        conn = connectView(iframe, view, {
          navigate: (to) => nav.current(to),
          openImages: (ids, index) => useLightbox.getState().show(ids, index, `plugin:${view.pluginId}`),
          onMutation: (r) =>
            useUndoStore.getState().push({ token: r.undoToken, label: `${label}：${r.message}`, by: `plugin:${view.pluginId}` }),
          link,
          ask: (text) => {
            if (!assistant.current) return false;
            askAssistant(text);
            return true;
          },
          setModelContext: (text) => useViewContext.setState({ current: { plugin: view.pluginId, page: view.pageId, text } }),
        });
        void conn.ready.then(() => {
          clearTimeout(timer);
          if (alive) setState('ready');
        });
      },
      () => fail('Emaki 显示插件页面用的运行库没有加载出来（不是这个插件的问题），刷新整个页面再试', false),
    );
    return () => {
      alive = false;
      clearTimeout(timer);
      if (flush) clearTimeout(flush);
      offChanged();
      themeWatch.disconnect();
      iframe?.remove();
      void conn?.close();
      // 离开这一页：它报的上下文不再随问题发
      const cur = useViewContext.getState().current;
      if (cur?.plugin === view.pluginId && cur.page === view.pageId) useViewContext.setState({ current: null });
    };
    // 换了链接（看图器里点了另一张图的来源）：重新载入，视图按新的链接画
  }, [view, label, attempt, link]);

  const error = typeof state === 'object' ? state.error : null;
  return (
    <div className="relative h-full min-h-[320px]">
      <div ref={box} className={error ? 'hidden' : 'h-full'} data-emaki-ref={`view:${view.pluginId}/${view.pageId}`} />
      {state === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-fg-subtle">
          <Spinner />
        </div>
      )}
      {error && (
        <EmptyState
          glyph="坏"
          title="这一页出错了"
          description={error}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<RotateCw />}
                onClick={() => {
                  setState('loading');
                  setAttempt((n) => n + 1);
                }}
              >
                重新载入
              </Button>
              {can && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<PowerOff />}
                  loading={disable.isPending}
                  onClick={() => disable.mutate(view.pluginId)}
                >
                  停用这个插件
                </Button>
              )}
            </div>
          }
        />
      )}
    </div>
  );
}
