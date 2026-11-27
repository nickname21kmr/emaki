/**
 * 改网页的插件的加载（features/plugins/internal/webPatches.ts）：按服务端给的清单 import、activate；只能改清单里列的点；
 * 不在了、换了地址撤掉它的补丁；加载不了、补丁出错记在插件头上（同一处一分钟一次）。
 */
import type { WebPatchModule } from '@emaki/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { countUnit } from '@/lib/countUnit';
import { webPoints } from '@/lib/points';
import { WebPatchLoader, type WebInternalApi } from './webPatches';

const mod = (id: string, url: string, points = ['fn:count.unit']): WebPatchModule => ({ plugin: id, version: '1.0.0', url, points });

function setup(modules: Record<string, (api: WebInternalApi) => unknown>) {
  const reports: [string, string, string][] = [];
  const imported: string[] = [];
  let now = 0;
  const loader = new WebPatchLoader({
    import: async (url) => {
      imported.push(url);
      const activate = modules[url];
      if (!activate) throw new Error(`404 ${url}`);
      return { activate };
    },
    report: (plugin, source, message) => reports.push([plugin, source, message]),
    now: () => now,
  });
  return { loader, reports, imported, tick: (ms: number) => (now += ms) };
}

let current: WebPatchLoader | null = null;
afterEach(() => current?.close());

describe('改网页的插件的加载', () => {
  it('加载、换地址重新加载、不在了撤掉', async () => {
    const { loader, imported } = setup({
      '/v1': (api) => api.patch('fn:count.unit', { after: () => '件' }),
      '/v2': (api) => api.patch('fn:count.unit', { after: () => '组' }),
    });
    current = loader;
    await loader.sync([mod('p', '/v1')]);
    expect(countUnit()).toBe('件');
    await loader.sync([mod('p', '/v1')]);
    expect(imported).toEqual(['/v1']);
    await loader.sync([mod('p', '/v2')]);
    expect(countUnit()).toBe('组');
    await loader.sync([]);
    expect(countUnit()).toBe('张');
    expect(loader.isLoaded('p')).toBe(false);
  });

  it('清单里没列的点改不了；activate 出错撤掉已经加上的、记一次错', async () => {
    const { loader, reports } = setup({
      '/sneaky': (api) => {
        api.patch('fn:count.unit', { after: () => '件' });
        api.patch('component:lightbox.Stage', { after: (r) => r });
      },
    });
    current = loader;
    await loader.sync([mod('p', '/sneaky'), mod('q', '/missing')]);
    expect(countUnit()).toBe('张');
    expect(loader.isLoaded('p')).toBe(false);
    expect(reports).toEqual([
      ['p', '改网页', expect.stringMatching(/component:lightbox\.Stage.*没有写在清单的 patch@1 里/)],
      ['q', '改网页', '加载不了：404 /missing'],
    ]);
  });

  it('补丁出错记在插件头上，同一处一分钟只记一次', async () => {
    const { loader, reports, tick } = setup({
      '/bad': (api) =>
        api.patch('fn:count.unit', {
          after: () => {
            throw new Error('坏了');
          },
        }),
    });
    current = loader;
    await loader.sync([mod('p', '/bad')]);
    expect(() => countUnit()).toThrow('坏了');
    expect(() => countUnit()).toThrow('坏了');
    tick(61_000);
    expect(() => countUnit()).toThrow('坏了');
    expect(reports).toEqual([
      ['p', '改网页', 'fn:count.unit：坏了'],
      ['p', '改网页', 'fn:count.unit：坏了'],
    ]);
  });

  it('activate 拿到 Emaki 的 React 和 h', async () => {
    let got: WebInternalApi | null = null;
    const { loader } = setup({ '/x': (api) => void (got = api) });
    current = loader;
    await loader.sync([mod('p', '/x')]);
    expect(got!.plugin).toEqual({ id: 'p', version: '1.0.0' });
    expect(typeof got!.h).toBe('function');
    expect(got!.React.createElement).toBe(got!.h);
    expect(got!.points().map((p) => p.name)).toContain('fn:count.unit');
    expect(webPoints.patchedNames()).toEqual([]);
  });
});
