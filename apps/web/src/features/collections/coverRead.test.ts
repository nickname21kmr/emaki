import { describe, expect, it } from 'vitest';
import { coverRead } from './coverRead';

describe('coverRead：扉页上点封面去读', () => {
  it('没读过、只看了第 1 页：从第 1 页开始', () => {
    expect(coverRead('12', null, '页')).toEqual({ href: '/collections/12/read?p=1', label: '从头读' });
    expect(coverRead('12', 1, '页')).toEqual({ href: '/collections/12/read?p=1', label: '从头读' });
  });

  it('读过：接着那一页（和页头的「继续读」同一个地址）', () => {
    expect(coverRead('12', 8, '页')).toEqual({ href: '/collections/12/read?p=8', label: '继续读 · 第 8 页' });
    // 组图说「张」
    expect(coverRead('27', 3, '张')).toEqual({ href: '/collections/27/read?p=3', label: '继续读 · 第 3 张' });
  });
});
