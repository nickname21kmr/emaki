import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { edgeScroll, moveTo, sameLists, sortTarget, type SortGroupBox } from './useDragSort';

// 三段：main 三行（0–40、40–80、80–120），空的 triage（140–180），footer 一行（200–240）
const groups: SortGroupBox<'main' | 'triage' | 'footer'>[] = [
  {
    key: 'main',
    top: 0,
    bottom: 120,
    items: [
      { id: 'a', top: 0, bottom: 40 },
      { id: 'b', top: 40, bottom: 80 },
      { id: 'c', top: 80, bottom: 120 },
    ],
  },
  { key: 'triage', top: 140, bottom: 180, items: [] },
  { key: 'footer', top: 200, bottom: 240, items: [{ id: 'd', top: 200, bottom: 240 }] },
];
/** 拖着 id、它的上边在 top（行高 40） */
const at = (id: string, top: number) => sortTarget(groups, { id, top, bottom: top + 40 });

describe('拖动排序（useDragSort）', () => {
  it('同一段里：下边越过下面一行的中线、上边越过上面一行的中线才换', () => {
    // a 往下拖：下边过了 b 的中线（60）才排到 b 后面
    expect(at('a', 15)).toEqual({ group: 'main', index: 0 });
    expect(at('a', 21)).toEqual({ group: 'main', index: 1 });
    expect(at('a', 61)).toEqual({ group: 'main', index: 2 });
    // c 往上拖：上边过了 b 的中线（60）才排到 b 前面
    expect(at('c', 65)).toEqual({ group: 'main', index: 2 });
    expect(at('c', 59)).toEqual({ group: 'main', index: 1 });
    expect(at('c', 19)).toEqual({ group: 'main', index: 0 });
    // 原地不动
    expect(at('b', 40)).toEqual({ group: 'main', index: 1 });
  });

  it('拖到别的一段、空的一段；在两段之间算离得近的那段，拖出整组也有落点', () => {
    expect(at('a', 205)).toEqual({ group: 'footer', index: 1 });
    expect(at('a', 175)).toEqual({ group: 'footer', index: 0 });
    expect(at('a', 140)).toEqual({ group: 'triage', index: 0 });
    expect(at('a', 105)).toEqual({ group: 'main', index: 2 });
    expect(at('b', -200)).toEqual({ group: 'main', index: 0 });
    expect(at('b', 900)).toEqual({ group: 'footer', index: 1 });
    expect(sortTarget([], { id: 'a', top: 0, bottom: 40 })).toBeNull();
  });

  it('挪过去：同一段里换位置、挪到别的段；没动返回 null', () => {
    const lists: Record<'main' | 'triage' | 'footer', string[]> = { main: ['a', 'b', 'c'], triage: [], footer: ['d'] };
    expect(moveTo(lists, 'a', { group: 'main', index: 2 })).toEqual({ main: ['b', 'c', 'a'], triage: [], footer: ['d'] });
    expect(moveTo(lists, 'c', { group: 'main', index: 0 })).toEqual({ main: ['c', 'a', 'b'], triage: [], footer: ['d'] });
    expect(moveTo(lists, 'b', { group: 'triage', index: 0 })).toEqual({ main: ['a', 'c'], triage: ['b'], footer: ['d'] });
    expect(moveTo(lists, 'd', { group: 'main', index: 1 })).toEqual({ main: ['a', 'd', 'b', 'c'], triage: [], footer: [] });
    expect(moveTo(lists, 'b', { group: 'main', index: 1 })).toBeNull();
    expect(moveTo(lists, 'x', { group: 'main', index: 0 })).toBeNull();
    // 不改原来的
    expect(lists.main).toEqual(['a', 'b', 'c']);
    expect(sameLists(lists, { main: ['a', 'b', 'c'], triage: [], footer: ['d'] })).toBe(true);
    expect(sameLists(lists, moveTo<keyof typeof lists>(lists, 'a', { group: 'main', index: 1 })!)).toBe(false);
  });

  it('靠近滚动区上下边自动滚，越近越快', () => {
    expect(edgeScroll(400, 0, 800)).toBe(0);
    expect(edgeScroll(50, 0, 800)).toBeLessThan(0);
    expect(edgeScroll(2, 0, 800)).toBeLessThan(edgeScroll(50, 0, 800));
    expect(edgeScroll(790, 0, 800)).toBeGreaterThan(edgeScroll(750, 0, 800));
    expect(edgeScroll(-100, 0, 800)).toBe(-14);
  });
});

/** 拖着排序只有这一份（docs/FRONTEND.md「交互只有一个实现」）：列表要拖动排序用 useDragSort，不在页面里另写 */
it('data-sort-item 只和 useDragSort 一起用', () => {
  const SRC = path.resolve(import.meta.dirname, '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  const bad = sources(SRC)
    .map((f) => [path.relative(SRC, f).split(path.sep).join('/'), readFileSync(f, 'utf8')] as const)
    .filter(([f, text]) => f !== 'lib/useDragSort.ts' && /data-sort-item/.test(text) && !/useDragSort/.test(text))
    .map(([f]) => f);
  expect(bad).toEqual([]);
});
