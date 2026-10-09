import { describe, expect, it } from 'vitest';
import { previousPath, type NavigationLike } from './previousPath';

const nav = (urls: string[], index: number): NavigationLike => ({
  currentEntry: { index },
  entries: () => urls.map((url) => ({ url })),
});

describe('previousPath', () => {
  it('从扉页点「从头读」进来：上一条是扉页', () => {
    const n = nav(['http://localhost:5183/collections', 'http://localhost:5183/collections/col2?x=1', 'http://localhost:5183/collections/col2/read?p=1'], 2);
    expect(previousPath(n)).toBe('/collections/col2');
  });

  it('直接打开阅读器（第一条）或者不支持 Navigation API：null', () => {
    expect(previousPath(nav(['http://localhost:5183/collections/col2/read'], 0))).toBeNull();
    expect(previousPath(undefined)).toBeNull();
    expect(previousPath({ currentEntry: null, entries: () => [] })).toBeNull();
  });

  it('上一条的 url 拿不到：null', () => {
    expect(previousPath({ currentEntry: { index: 1 }, entries: () => [{ url: null }, { url: 'http://localhost:5183/x' }] })).toBeNull();
  });
});
