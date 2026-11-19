import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Me, Scope } from '@emaki/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { qk } from '@/lib/queries';
import { AddFromPhoneButton } from './AddFromPhone';

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
      <AddFromPhoneButton />
    </QueryClientProvider>,
  );
}

describe('「从手机添加」（docs/mobile.md 5.4）', () => {
  it('在 App 里（有 pickImages）、有上传权限：显示', () => {
    g.EmakiApp = { unpaired: () => {}, pickImages: () => {} };
    expect(html(['read', 'upload'])).toContain('从手机添加');
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
