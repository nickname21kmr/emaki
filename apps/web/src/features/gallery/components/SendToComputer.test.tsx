import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Me, Scope } from '@emaki/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/Tooltip';
import type { AlbumSyncInfo } from '@emaki/shared';
import { qk } from '@/lib/queries';
import { SendToComputerButton, SendToComputerTip, showIntro } from './SendToComputer';

const g = globalThis as { EmakiApp?: unknown };
afterEach(() => {
  delete g.EmakiApp;
});

/** 这台设备的同步相册：syncing 个相册在同步 */
const albums = (syncing: number) =>
  ({
    albums: Array.from({ length: 2 }, (_, i) => ({ path: `A${i}`, sync: i < syncing })),
    state: { running: null },
  }) as unknown as AlbumSyncInfo;

function html(scopes: Scope[], opts: { albums?: AlbumSyncInfo; tip?: boolean } = {}) {
  const client = new QueryClient();
  const me: Me = { kind: 'device', deviceId: 'd1', name: '平板', scopes };
  client.setQueryData(qk.me, me);
  if (opts.albums) client.setQueryData(qk.albumSync(undefined), opts.albums);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>{opts.tip ? <SendToComputerTip /> : <SendToComputerButton />}</TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('「传到电脑」（docs/mobile.md 5.4、5.5）', () => {
  it('在 App 里（有 pickImages）、有上传权限：显示', () => {
    g.EmakiApp = { unpaired: () => {}, pickImages: () => {} };
    expect(html(['read', 'upload'])).toContain('aria-label="传到电脑"');
  });

  it('是页头的一个图标（和模糊、撤销、帮助一样），不是描边按钮；App 0.3.0 起点开面板（选图片上传、同步相册）', () => {
    g.EmakiApp = { unpaired: () => {}, pickImages: () => {}, syncAlbums: () => {} };
    const out = html(['read', 'upload']);
    expect(out).toContain('aria-label="传到电脑"');
    expect(out).not.toContain('从手机添加');
    expect(out).not.toContain('border');
  });

  it('没有上传权限、浏览器里（没有 App）、老版本的 App（没有 pickImages）：都不显示', () => {
    g.EmakiApp = { unpaired: () => {}, pickImages: () => {} };
    expect(html(['read'])).toBe('');
    delete g.EmakiApp;
    expect(html(['read', 'upload'])).toBe('');
    g.EmakiApp = { unpaired: () => {} };
    expect(html(['read', 'upload'])).toBe('');
  });
});

describe('第一次用的引导', () => {
  const app = { unpaired: () => {}, pickImages: () => {}, syncAlbums: () => {} };

  it('App 里还没有在同步的相册：图库里一条提示；页头图标上不加小红点', () => {
    g.EmakiApp = app;
    expect(html(['read', 'upload'], { tip: true, albums: albums(0) })).toContain('去看看');
    expect(html(['read', 'upload'], { albums: albums(0) })).not.toContain('bg-shu');
  });

  it('已经在同步、关掉过提示、浏览器里、没有上传权限：都不出现', () => {
    g.EmakiApp = app;
    expect(html(['read', 'upload'], { tip: true, albums: albums(1) })).toBe('');
    expect(html(['read'], { tip: true, albums: albums(0) })).toBe('');
    // 关掉过（renderToStaticMarkup 读不到 zustand 后来改的状态，判断条件单独测）
    expect(showIntro(true, true, albums(0))).toBe(false);
    expect(showIntro(true, false, albums(0))).toBe(true);
    expect(showIntro(true, false, undefined)).toBe(false);
    delete g.EmakiApp;
    expect(html(['read', 'upload'], { tip: true, albums: albums(0) })).toBe('');
  });
});
