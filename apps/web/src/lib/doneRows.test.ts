import { describe, expect, it } from 'vitest';
import { enterAction } from '@/features/duplicates/utils';
import { keepInPlace } from './doneRows';
import { keepHeld } from './stores';

const id = (x: { id: string }) => x.id;
const ids = (xs: { id: string }[]) => xs.map(id);

describe('处理过的行留在原地', () => {
  it('刷新后不在列表里的已处理行留在原来的位置，下一行不会顶上来', () => {
    const prev = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const next = [{ id: 'a' }, { id: 'c' }, { id: 'd' }];
    expect(ids(keepInPlace(prev, next, (k) => k === 'b', id))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('没标成已处理的照常消失；新列表里的项用新数据', () => {
    const prev = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
    const next = [{ id: 'a', v: 2 }];
    const out = keepInPlace(prev, next, () => false, id);
    expect(out).toEqual([{ id: 'a', v: 2 }]);
  });

  it('第一次显示（没有上一次）就是新列表', () => {
    expect(ids(keepInPlace([], [{ id: 'x' }, { id: 'y' }], () => true, id))).toEqual(['x', 'y']);
  });
});

describe('看图器里刚排除的那张', () => {
  it('网格刷新后它不在了：停留期间放回原来的位置', () => {
    expect(keepHeld(['a', 'b', 'c'], ['a', 'c'], 'b')).toEqual(['a', 'b', 'c']);
    expect(keepHeld(['a', 'b'], ['a'], 'b')).toEqual(['a', 'b']);
    expect(keepHeld(['a', 'b'], ['a'], null)).toEqual(['a']);
  });
});

describe('重复页的回车', () => {
  it('会移到回收站的组：Enter 不处理，要 Shift+Enter', () => {
    expect(enterAction(2, false)).toBe('needShift');
    expect(enterAction(2, true)).toBe('resolve');
  });

  it('全部保留的组：Enter 照旧处理', () => {
    expect(enterAction(0, false)).toBe('resolve');
    expect(enterAction(0, true)).toBe('resolve');
  });
});
