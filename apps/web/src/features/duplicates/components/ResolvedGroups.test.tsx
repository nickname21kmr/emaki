import type { DuplicateGroup, ImageItem } from '@emaki/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScrollContainerContext } from '@/components/layout/ScrollContainer';
import { ResolvedGroups } from './ResolvedGroups';

const image = (id: string): ImageItem =>
  ({ id, fileName: `${id}.png`, relPath: `a/${id}.png`, width: 800, height: 1200, bytes: 1000, dominantColor: '#888', rating: 'general', modifiedAt: '2026-01-01T00:00:00Z' }) as ImageItem;

const groups = (n: number): DuplicateGroup[] =>
  Array.from({ length: n }, (_, i) => {
    const images = [image(`g${i}a`), image(`g${i}b`)];
    return { id: `g${i}`, kind: 'exact', images, suggestedKeepId: images[0]!.id, suggestedKeepIds: [images[0]!.id] } as DuplicateGroup;
  });

const render = (list: DuplicateGroup[]) =>
  renderToStaticMarkup(
    <ScrollContainerContext.Provider value={{ current: null }}>
      <ResolvedGroups groups={list} />
    </ScrollContainerContext.Provider>,
  );
const cards = (html: string) => html.split('<article').length - 1;

describe('ResolvedGroups：已处理的重复组分批显示', () => {
  it('组数多时先只画第一批（60 组），后面留一个哨兵，滚到附近再加', () => {
    const html = render(groups(300));
    expect(cards(html)).toBe(60);
    expect(html).toContain('aria-hidden');
  });

  it('一批以内的全画出来，没有哨兵（和不分批时的结构一样）', () => {
    const html = render(groups(5));
    expect(cards(html)).toBe(5);
    expect(html).not.toContain('h-px');
  });
});
