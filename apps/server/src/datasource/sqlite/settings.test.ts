import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../../http/errors.ts';
import { isInside, normalizeRootPath, samePath } from './settings.ts';

describe('normalizeRootPath', () => {
  it.each([
    ['"D:\\Pictures\\插画"', 'D:/Pictures/插画'],
    ['D:', 'D:/'],
    ['D:\\', 'D:/'],
    ['d:/', 'D:/'],
    ['D:\\a\\', 'D:/a'],
    ['d:\\a', 'D:/a'],
    ['\\\\nas\\share\\x', '//nas/share/x'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRootPath(input)).toBe(expected);
  });

  it.each(['a\\b', '.\\a', '', '   '])('相对路径 / 空路径 %j 报错', (input) => {
    expect(() => normalizeRootPath(input)).toThrow(BadRequestError);
  });
});

describe('路径比较', () => {
  it('不区分大小写', () => expect(samePath('D:/Pics', 'd:/pics')).toBe(true));
  it('isInside 只认完整的目录层级', () => {
    expect(isInside('D:/Pics/sub', 'D:/Pics')).toBe(true);
    expect(isInside('D:/Pics2', 'D:/Pics')).toBe(false);
    expect(isInside('D:/x', 'D:/')).toBe(true);
  });
});
