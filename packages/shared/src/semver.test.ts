import { describe, expect, it } from 'vitest';
import { compareVersions, satisfies, validRange, validVersion } from './semver.ts';

describe('版本范围（插件清单的 engines.emaki）', () => {
  it('版本号', () => {
    expect(['1.2.3', '0.1.17', '1.0.0-beta.1', 'v2.0.0'].every(validVersion)).toBe(true);
    expect(['1.2', '1', 'abc', '1.2.3.4', ''].some(validVersion)).toBe(false);
    expect(compareVersions('0.1.17', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it.each([
    ['0.1.17', '*', true],
    ['0.1.17', '0.1.17', true],
    ['0.1.17', '=0.1.17', true],
    ['0.1.18', '0.1.17', false],
    ['0.1.17', '0.1', true],
    ['0.2.0', '0.1', false],
    ['0.1.17', '0.x', true],
    ['0.1.17', '>=0.1 <0.2', true],
    ['0.1.17', '>= 0.1 < 0.2', true],
    ['0.2.0', '>=0.1 <0.2', false],
    ['0.2.0-beta', '>=0.1 <0.2', false],
    ['0.0.9', '>=0.1 <0.2', false],
    ['0.1.17', '^0.1.10', true],
    ['0.2.0', '^0.1.10', false],
    ['1.9.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.9.0', '~1', true],
    ['0.1.17', '>0.1', false],
    ['0.2.0', '>0.1', true],
    ['0.1.17', '<=0.1', true],
    ['0.2.0', '<=0.1', false],
    ['0.1.17', '>=0.3 || 0.1.x', true],
    ['0.1.17', '>=0.3 || 0.2', false],
  ])('%s 在 %s 里：%s', (v, range, ok) => expect(satisfies(v, range)).toBe(ok));

  it('写法不对的范围不合法，也不满足', () => {
    for (const r of ['', 'abc', '>>1', '1.2.3.4', '>=', '^x']) {
      expect([r, validRange(r)]).toEqual([r, false]);
      expect(satisfies('0.1.17', r)).toBe(false);
    }
  });
});
