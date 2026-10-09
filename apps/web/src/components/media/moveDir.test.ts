import { describe, expect, it } from 'vitest';
import { resolveMoveDir } from './moveDir';

const roots = [
  { id: '1', path: 'D:/Pics' },
  { id: '2', path: 'D:/Pics/lib' },
  { id: '3', path: '\\\\NAS\\图' },
];

describe('resolveMoveDir', () => {
  it('相对路径原样交给后端', () => {
    expect(resolveMoveDir('角色/未花', roots)).toEqual({ rootId: null, dir: '角色/未花' });
    expect(resolveMoveDir('', roots)).toEqual({ rootId: null, dir: '' });
  });

  it('粘贴图库里的完整路径：换成相对路径，选中最里面那个文件夹', () => {
    expect(resolveMoveDir('D:\\Pics\\lib\\角色\\未花', roots)).toEqual({ rootId: '2', dir: '角色/未花' });
    expect(resolveMoveDir('"d:/pics/其他/"', roots)).toEqual({ rootId: '1', dir: '其他' });
    expect(resolveMoveDir('D:/Pics/lib', roots)).toEqual({ rootId: '2', dir: '' });
    expect(resolveMoveDir('\\\\NAS\\图\\a', roots)).toEqual({ rootId: '3', dir: 'a' });
  });

  it('前缀相同但不是同一个文件夹不算', () => {
    expect(resolveMoveDir('D:/Pictures/a', roots)).toHaveProperty('error');
  });

  it('不在图库里的完整路径报错', () => {
    expect(resolveMoveDir('E:\\别处', roots)).toHaveProperty('error');
    expect(resolveMoveDir('\\\\other\\x', roots)).toHaveProperty('error');
  });
});
