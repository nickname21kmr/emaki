import { describe, expect, it } from 'vitest';
import { builtinPluginsState, linkHandlers, linkMatches, type PluginInfo } from './plugins.ts';

describe('接管的链接（link@1，docs/plugins.md 12.7）', () => {
  it('* 是路径里的一段；问号、# 以后的不看；末尾的 / 可有可无；域名不分大小写', () => {
    const p = 'https://www.pixiv.net/artworks/*';
    expect(linkMatches(p, 'https://www.pixiv.net/artworks/123')).toBe(true);
    expect(linkMatches(p, 'https://WWW.PIXIV.NET/artworks/123/')).toBe(true);
    expect(linkMatches(p, 'https://www.pixiv.net/artworks/123?lang=zh#comments')).toBe(true);
    expect(linkMatches(p, 'https://www.pixiv.net/artworks/')).toBe(false);
    expect(linkMatches(p, 'https://www.pixiv.net/artworks/123/extra')).toBe(false);
    expect(linkMatches(p, 'https://www.pixiv.net/en/artworks/123')).toBe(false);
    expect(linkMatches('https://www.pixiv.net/*/artworks/*', 'https://www.pixiv.net/en/artworks/123')).toBe(true);
    expect(linkMatches(p, 'https://www.pixiv.net.evil.example/artworks/123')).toBe(false);
    expect(linkMatches(p, 'https://evil.example/https://www.pixiv.net/artworks/123')).toBe(false);
    expect(linkMatches(p, 'https://user@www.pixiv.net/artworks/123')).toBe(false);
    expect(linkMatches(p, 'javascript:alert(1)')).toBe(false);
    expect(linkMatches(p, 'not a url')).toBe(false);
    // 点不是通配
    expect(linkMatches('https://www.pixiv.net/a.b', 'https://www.pixiv.net/axb')).toBe(false);
    expect(linkMatches('https://x.example/', 'https://x.example')).toBe(true);
  });

  it('只找启用着的插件，按插件的顺序', () => {
    const base = builtinPluginsState().plugins[0]!;
    const plugin = (id: string, enabled: boolean): PluginInfo => ({
      ...base,
      id,
      enabled,
      contributes: { 'link@1': [{ id: 'artwork', title: 'Pixiv 作品', urls: ['https://www.pixiv.net/artworks/*'], site: 'pixiv' }] },
    });
    const url = 'https://www.pixiv.net/artworks/1';
    expect(linkHandlers([plugin('a', true), plugin('b', false), plugin('c', true)], url).map((h) => h.plugin.id)).toEqual(['a', 'c']);
    expect(linkHandlers([plugin('a', true)], 'https://www.pixiv.net/users/1')).toEqual([]);
    expect(linkHandlers(builtinPluginsState().plugins, url)).toEqual([]);
  });
});
