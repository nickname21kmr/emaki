import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Me, Scope } from '@emaki/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { qk } from '@/lib/queries';
import { SendToComputerButton } from './SendToComputer';

const g = globalThis as { EmakiApp?: unknown };
afterEach(() => {
  delete g.EmakiApp;
});

function html(scopes: Scope[]) {
  const client = new QueryClient();
  const me: Me = { kind: 'device', deviceId: 'd1', name: '平板', scopes };
  client.setQueryData(qk.me, me);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <SendToComputerButton />
      </TooltipProvider>
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
