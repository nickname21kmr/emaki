/**
 * 插件接管的链接（link@1）和看图器顶栏上装的插件加的按钮（lightbox.toolbar@1），docs/plugins.md 12.7。
 *
 * - 链接：Emaki 里点到图片的来源（看图器的信息栏、未识别）时，有插件接管这种链接就在插件里打开——安卓 App 里打开插件的网站
 *   （就在这个地址，比如 Pixiv 的作品页），别的地方打开插件的页面（视图从 context 的 link 拿到地址）。
 *   按住 Ctrl / ⌘ / Shift 点、中键、右键菜单照旧在浏览器里打开；几个插件都接管时点了让你选。
 * - 按钮：调插件自己的命令（输入 { image }，返回的 message 显示出来），或者打开这张图的来源（走上面的链接）。
 */
import { commandToolName, linkHandlers, pluginLabel, pluginPagePath, type ImageDetail, type LightboxButtonContribution, type PluginInfo } from '@emaki/shared';
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { navIcon } from '@/components/layout/Sidebar';
import { LbButton } from '@/components/media/lightbox/LbButton';
import { Menu, MenuItem } from '@/components/ui';
import { api } from '@/lib/api';
import { useCapabilities } from '@/lib/capabilities';
import { appBridge } from '@/lib/deviceAuth';
import { usePlugins } from '@/lib/plugins';
import { errorMessage } from '@/lib/queries';
import { uuid } from '@/lib/random';
import { useLightbox } from '@/lib/stores';

export interface LinkTarget {
  key: string;
  /** 插件显示的名字 */
  name: string;
  open: () => void;
}

/** 这个链接在这台设备上能交给哪些插件打开（App 里要能打开插件的网站，别处要有插件的页面） */
export function linkTargets(plugins: readonly PluginInfo[], url: string, go: (to: string) => void): LinkTarget[] {
  const bridge = appBridge();
  const inApp = !!bridge?.openSite;
  return linkHandlers(plugins, url).flatMap(({ plugin, link }): LinkTarget[] => {
    const name = pluginLabel(plugin);
    const key = `${plugin.id}/${link.id}`;
    if (inApp && link.site !== undefined && bridge?.openSiteUrl) {
      const site = link.site;
      return [{ key, name, open: () => bridge.openSiteUrl?.(plugin.id, site, url) }];
    }
    if (link.page === undefined) return [];
    // App 里，对应网站的页面一打开就去网站的首页（PluginViewPage）：老的 App 不能打开到这个地址，那就照常在浏览器里打开
    if (inApp && plugin.contributes['page@1']?.find((p) => p.id === link.page)?.site !== undefined) return [];
    const to = `${pluginPagePath(plugin.id, link.page)}?link=${encodeURIComponent(url)}`;
    return [{ key, name, open: () => go(to) }];
  });
}

/** 去插件的页面：在看图器里点的，先关掉看图器 */
function useGo(): (to: string) => void {
  const navigate = useNavigate();
  return (to) => {
    const lb = useLightbox.getState();
    if (lb.open) lb.close();
    navigate(to);
  };
}

export function useLinkTargets(url: string | null | undefined): LinkTarget[] {
  const { state } = usePlugins();
  const go = useGo();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (url ? linkTargets(state.plugins, url, go) : []), [state.plugins, url]);
}

const openInBrowser = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

/** 普通的点击（不是 Ctrl / ⌘ / Shift / Alt 点、中键）：这种交给插件，别的照旧给浏览器 */
const plainClick = (e: MouseEvent) => e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;

/** 几个插件都接管这个链接：点了让你选（菜单挂在链接后面一个看不见的点上，免得链接本身被菜单接管） */
function Chooser({ targets, url, open, onOpenChange }: { targets: LinkTarget[]; url: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Menu open={open} onOpenChange={onOpenChange} align="start" trigger={<span aria-hidden className="inline-block w-0" />}>
      {targets.map((t) => (
        <MenuItem key={t.key} onSelect={t.open}>
          在「{t.name}」里打开
        </MenuItem>
      ))}
      <MenuItem onSelect={() => openInBrowser(url)}>在浏览器里打开</MenuItem>
    </Menu>
  );
}

/** 图片来源这类外部链接：有插件接管就在插件里打开（见文件头），没有就和普通的链接一样 */
export function SourceLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const targets = useLinkTargets(href);
  const [choosing, setChoosing] = useState(false);
  const first = targets[0];
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={className}
        title={first ? `在「${first.name}」里打开（按住 Ctrl 点在浏览器里打开）` : undefined}
        onClick={(e) => {
          if (!first || !plainClick(e)) return;
          e.preventDefault();
          if (targets.length === 1) first.open();
          else setChoosing(true);
        }}
      >
        {children}
      </a>
      {targets.length > 1 && <Chooser targets={targets} url={href} open={choosing} onOpenChange={setChoosing} />}
    </>
  );
}

/** 看图器顶栏上装的插件加的按钮（排在内置按钮后面、「信息」前面，blocks/slots.ts 的 pluginsBefore） */
export function PluginLightboxButtons({ detail }: { detail: ImageDetail | undefined }) {
  const { state } = usePlugins();
  const buttons = useMemo(
    () =>
      state.plugins
        .filter((p) => p.enabled && p.source !== 'builtin')
        .flatMap((plugin) => (plugin.contributes['lightbox.toolbar@1'] ?? []).filter((b) => b.label).map((button) => ({ plugin, button }))),
    [state.plugins],
  );
  if (!detail) return null;
  return buttons.map(({ plugin, button }) => <PluginButton key={button.id} plugin={plugin} button={button} detail={detail} />);
}

function PluginButton({ plugin, button, detail }: { plugin: PluginInfo; button: LightboxButtonContribution; detail: ImageDetail }) {
  const { can } = useCapabilities();
  const source = detail.source;
  const url = button.open === 'source' ? source?.url : undefined;
  const targets = useLinkTargets(url);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  if (button.sources && !(source && button.sources.includes(source.site))) return null;
  if (button.open === 'source' && !url) return null;
  const command = button.command === undefined ? undefined : plugin.contributes['command@1']?.find((c) => c.name === button.command);
  // 调命令要这台设备有那个命令的权限（手机上用插件，生效的是两边的交集）
  if (button.command !== undefined && !(command && can(command.scope))) return null;
  const Icon = navIcon(button.icon ?? 'puzzle');
  const label = button.label ?? pluginLabel(plugin);

  const run = async () => {
    if (!command) return;
    setBusy(true);
    try {
      // 插件的命令都要 operationId（和视图的 Emaki.call 一样补一个）
      const args = { image: { id: detail.id, fileName: detail.fileName, source: source ?? null }, operationId: uuid() };
      const r = await api.pluginCall(plugin.id, commandToolName(command.name), args);
      const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
      if (r.isError) {
        toast.error(text || `「${label}」没有做成`);
        return;
      }
      let message: unknown;
      try {
        message = (JSON.parse(text) as { message?: unknown }).message;
      } catch {
        // 不是 JSON：不显示内容
      }
      toast(typeof message === 'string' && message ? message : `${pluginLabel(plugin)}：${label}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const onClick = () => {
    if (button.open !== 'source') return void run();
    if (targets.length === 1) targets[0]!.open();
    else if (targets.length > 1) setChoosing(true);
    else openInBrowser(url!);
  };
  const shown = (
    <LbButton label={label} disabled={busy} onClick={onClick}>
      <Icon />
    </LbButton>
  );
  if (targets.length < 2) return shown;
  return (
    <span className="relative inline-flex">
      {shown}
      <span className="absolute bottom-0 left-0">
        <Chooser targets={targets} url={url!} open={choosing} onOpenChange={setChoosing} />
      </span>
    </span>
  );
}
