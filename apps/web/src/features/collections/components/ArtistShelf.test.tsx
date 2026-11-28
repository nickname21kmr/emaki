import type { Artist } from '@emaki/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ScrollContainerContext } from '@/components/layout/ScrollContainer';
import { ArtistShelf } from './ArtistShelf';

const artists = (n: number): Artist[] =>
  Array.from({ length: n }, (_, i) => ({ tag: `artist_${i}`, name: `artist ${i}`, tags: [`artist_${i}`], aliases: [], twitter: null, imageCount: n - i, cover: null, manual: false }));

describe('ArtistShelf：画师按行虚拟化', () => {
  it('不把整份名单画出来：没量到滚动容器之前一张卡都不画，只先把高度撑开（后退回来时滚动位置才恢复得了）', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ScrollContainerContext.Provider value={{ current: null }}>
          <ArtistShelf list={artists(2640)} />
        </ScrollContainerContext.Provider>
      </MemoryRouter>,
    );
    expect(html.split('/gallery?artist=').length - 1).toBe(0);
    expect(html).toContain('role="list"');
    const height = Number(/height:([\d.]+)px/.exec(html)?.[1]);
    expect(height).toBeGreaterThan(100_000);
  });
});
