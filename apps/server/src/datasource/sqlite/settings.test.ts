import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../../http/errors.ts';
import { isInside, normalizeRootPath, rootPathKey, samePath } from './settings.ts';

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

  it.skipIf(process.platform !== 'win32')('rootPathKey：\\\\?\\ 前缀、大小写换成真实位置；本机管理共享换回盘符；不存在的按原样', async () => {
    const here = normalizeRootPath(import.meta.dirname);
    expect(await rootPathKey(normalizeRootPath(`\\\\?\\${import.meta.dirname.toUpperCase()}`))).toBe(here);
    expect(await rootPathKey('//localhost/Q$/没有/这个')).toBe('Q:/没有/这个');
    expect(await rootPathKey('//127.0.0.1/q$')).toBe('Q:/');
    expect(await rootPathKey('Q:/没有/这个')).toBe('Q:/没有/这个');
    expect(await rootPathKey('//nas/share/x')).toBe('//nas/share/x');
  });
});
