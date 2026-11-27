import { builtinPluginsState, SCOPES, type ImageDetail, type Me, type PluginInfo, type Scope } from '@emaki/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { qk } from '@/lib/queries';
import { linkTargets, PluginLightboxButtons, SourceLink } from './PluginLinks';

const URL_ = 'https://www.pixiv.net/artworks/123';

/** 装好的 Pixiv 浏览（0.6.0 的样子：接管作品页的链接，看图器上「在 Pixiv 打开」，再加一个调命令的按钮） */
function pixiv(over: Partial<PluginInfo> = {}): PluginInfo {
  const base = builtinPluginsState().plugins[0]!;
  return {
    ...base,
    id: 'pixiv-browser',
    name: 'Pixiv 浏览',
    displayName: null,
    source: 'installed',
    required: false,
    enabled: true,
    contributes: {
      'page@1': [{ id: 'browse', view: 'views/browse.html', site: 'pixiv' }],
      'site@1': [{ id: 'pixiv', title: 'Pixiv', url: 'https://www.pixiv.net/', matches: ['www.pixiv.net'], script: 'site/pixiv.js' }],
      'link@1': [{ id: 'artwork', title: 'Pixiv 作品', urls: ['https://www.pixiv.net/artworks/*'], page: 'browse', site: 'pixiv' }],
      'lightbox.toolbar@1': [
        { id: 'pixiv-browser/open', label: '在 Pixiv 打开', icon: 'external-link', sources: ['pixiv'], open: 'source' },
        { id: 'pixiv-browser/fill', label: '补齐作品', icon: 'download', sources: ['pixiv'], command: 'pixiv-browser.fill' },
      ],
      'command@1': [{ name: 'pixiv-browser.fill', summary: '补齐', scope: 'import' }],
    },
    ...over,
  };
}

const setBridge = (b: object | undefined) => ((globalThis as { EmakiApp?: object }).EmakiApp = b);
afterEach(() => setBridge(undefined));

describe('接管的链接在这台设备上怎么打开（docs/plugins.md 12.7）', () => {
  it('电脑上（浏览器里）：去插件的页面，带上链接', () => {
    const go = vi.fn();
    const t = linkTargets([pixiv()], URL_, go);
    expect(t.map((x) => x.name)).toEqual(['Pixiv 浏览']);
    t[0]!.open();
    expect(go).toHaveBeenCalledWith(`/p/pixiv-browser/browse?link=${encodeURIComponent(URL_)}`);
    expect(linkTargets([pixiv()], 'https://www.pixiv.net/users/1', go)).toEqual([]);
    expect(linkTargets([pixiv({ enabled: false })], URL_, go)).toEqual([]);
  });

  it('App 里：打开插件的网站，就在这个地址；老的 App 打不开到这个地址，照常去浏览器', () => {
    const openSiteUrl = vi.fn();
    setBridge({ openSite: vi.fn(), openSiteUrl });
    const go = vi.fn();
    linkTargets([pixiv()], URL_, go)[0]!.open();
    expect(openSiteUrl).toHaveBeenCalledWith('pixiv-browser', 'pixiv', URL_);
    expect(go).not.toHaveBeenCalled();
    // 0.5.0 的 App：只有 openSite。页面对应网站（一打开就去网站首页），不交给它
    setBridge({ openSite: vi.fn() });
    expect(linkTargets([pixiv()], URL_, go)).toEqual([]);
    // 只在页面里打开、页面不对应网站的：App 里也去那一页
    const pageOnly = pixiv({
      contributes: { ...pixiv().contributes, 'page@1': [{ id: 'browse', view: 'views/browse.html' }], 'link@1': [{ id: 'a', title: 'a', urls: [URL_], page: 'browse' }] },
    });
    expect(linkTargets([pageOnly], URL_, go)).toHaveLength(1);
  });
});

/** scopes：给了就是手机（只有这些权限），不给是这台电脑 */
function render(node: ReactNode, plugins: PluginInfo[], scopes?: Scope[]) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const me = scopes ? { kind: 'device', deviceId: 'd1', name: 'Pad', scopes } : { kind: 'local', scopes: Object.keys(SCOPES) };
  client.setQueryData(qk.me, me as Me);
  const state = builtinPluginsState();
  client.setQueryData(qk.plugins(false), { ...state, plugins: [...state.plugins, ...plugins] });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('来源的链接、看图器上插件的按钮', () => {
  it('链接：有插件接管时说在哪里打开，没有时就是普通的链接', () => {
    const link = <SourceLink href={URL_}>Pixiv #123</SourceLink>;
    expect(render(link, [pixiv()])).toContain('title="在「Pixiv 浏览」里打开（按住 Ctrl 点在浏览器里打开）"');
    expect(render(link, [pixiv({ enabled: false })])).not.toContain('title=');
    expect(render(link, [pixiv()])).toContain(`href="${URL_}"`);
  });

  it('按钮：只在声明的来源上；打开来源要有链接；调命令要这台设备有那个权限', () => {
    const detail = (source: ImageDetail['source']) => ({ id: '1', fileName: '123_p0.png', source }) as ImageDetail;
    const html = (d: ImageDetail | undefined, scopes?: Scope[]) => render(<PluginLightboxButtons detail={d} />, [pixiv()], scopes);
    const fromPixiv = detail({ site: 'pixiv', postId: '123', url: URL_ });
    expect(html(fromPixiv)).toContain('aria-label="在 Pixiv 打开"');
    expect(html(fromPixiv)).toContain('aria-label="补齐作品"');
    expect(html(fromPixiv, ['read'])).not.toContain('补齐作品');
    expect(html(detail({ site: 'pixiv', postId: '123' }))).not.toContain('在 Pixiv 打开');
    expect(html(detail({ site: 'twitter', url: 'https://x.com/a/status/1' }))).toBe('');
    expect(html(detail(null))).toBe('');
    expect(html(undefined)).toBe('');
  });
});
