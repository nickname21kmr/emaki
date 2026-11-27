/** 内部点（core/points.ts，docs/plugins.md 第 7 节）：补丁叠起来、撤掉、出错算谁的、指纹 */
import { describe, expect, it } from 'vitest';
import { Points } from './points.ts';

const add = (a: number, b: number) => a + b;

function setup() {
  const points = new Points();
  points.define('term:add', { kind: 'term', label: '加法' }, add);
  const errors: [string, string, string][] = [];
  points.onPatchError((owner, point, e) => errors.push([owner, point, (e as Error).message]));
  return { points, errors, call: (a: number, b: number) => points.wrap('term:add', add)(a, b) };
}

describe('内部点', () => {
  it('没有补丁就是原来的函数', () => {
    const { points } = setup();
    expect(points.wrap('term:add', add)).toBe(add);
  });

  it('before 换参数、after 换结果、around 包一层；后加的在外层', () => {
    const { points, call } = setup();
    points.patch('term:add', 'a', { before: ([x, y]) => [Number(x) * 10, y] });
    points.patch('term:add', 'b', { after: (r) => r + 1 });
    points.patch('term:add', 'c', { around: (next, x, y) => `<${next(x, y)}>` });
    // c( b( a(add) ) )：(1*10 + 2) + 1 → <13>
    expect(call(1, 2)).toBe('<13>');
    expect(points.patched()).toEqual([{ name: 'term:add', kind: 'term', label: '加法', owners: ['a', 'b', 'c'] }]);
    // before / after 返回 undefined 照旧
    points.patch('term:add', 'd', { before: () => undefined, after: () => undefined });
    expect(call(1, 2)).toBe('<13>');
  });

  it('撤掉一个插件的补丁不影响别的', () => {
    const { points, call } = setup();
    const undo = points.patch('term:add', 'a', { after: (r) => r * 2 });
    points.patch('term:add', 'b', { after: (r) => r + 1 });
    expect(call(1, 2)).toBe(7);
    expect(points.removeOwner('b')).toEqual(['term:add']);
    expect(call(1, 2)).toBe(6);
    undo();
    expect(call(1, 2)).toBe(3);
    expect(points.wrap('term:add', add)).toBe(add);
    expect(points.patched()).toEqual([]);
  });

  it('原来的返回 Promise：after 等它好了再调', async () => {
    const points = new Points();
    const slow = async (x: number) => x + 1;
    points.define('job:slow', { kind: 'job', label: '慢' }, slow);
    points.patch('job:slow', 'a', { after: (r) => r * 10 });
    await expect(points.wrap('job:slow', slow)(1)).resolves.toBe(20);
  });

  it('补丁自己抛的错记在打补丁的插件头上；里层的错不算它的', async () => {
    const { points, errors, call } = setup();
    points.patch('term:add', 'inner', { before: () => { throw new Error('里层坏了'); } });
    points.patch('term:add', 'outer', { around: (next, x, y) => next(x, y) });
    expect(() => call(1, 2)).toThrow('里层坏了');
    expect(errors).toEqual([['inner', 'term:add', '里层坏了']]);

    const p2 = new Points();
    const fail = async () => {
      throw new Error('原来的坏了');
    };
    p2.define('job:fail', { kind: 'job', label: '坏' }, fail);
    const errs: string[] = [];
    p2.onPatchError((o) => errs.push(o));
    p2.patch('job:fail', 'a', { after: (r) => r });
    p2.patch('job:fail', 'b', { around: async () => { throw new Error('b 坏了'); } });
    await expect(p2.wrap('job:fail', fail)()).rejects.toThrow('b 坏了');
    expect(errs).toEqual(['b']);
    p2.removeOwner('b');
    await expect(p2.wrap('job:fail', fail)()).rejects.toThrow('原来的坏了');
    expect(errs).toEqual(['b']);
  });

  it('指纹：只按约定算（实现变了不算）；约定里没有的点按实现、格式、版本算', () => {
    const points = new Points();
    points.define('term:x', { kind: 'term', label: 'x', contract: ['signature: (a, b)', 'version: 1'] }, add);
    const a = points.fingerprint('term:x');
    expect(a).toMatch(/^c1:[0-9a-f]{16}$/);
    // 实现换了、说法换了：约定一样，指纹一样
    points.define('term:x', { kind: 'term', label: '换了说法', contract: ['signature: (a, b)', 'version: 1'] }, (x: number, y: number) => x * y);
    expect(points.fingerprint('term:x')).toBe(a);
    points.define('term:x', { kind: 'term', label: 'x', contract: ['signature: (a, b)', 'version: 2'] }, add);
    expect(points.fingerprint('term:x')).not.toBe(a);

    // 约定里没有：按实现算
    points.define('term:y', { kind: 'term', label: 'y' }, add);
    const b = points.fingerprint('term:y');
    points.define('term:y', { kind: 'term', label: 'y' }, (x: number, y: number) => x - y);
    expect(points.fingerprint('term:y')).not.toBe(b);
    expect(points.fingerprint('term:nope')).toBeNull();
  });

  it('名字不对、没登记过的点、空补丁都不行', () => {
    const points = new Points();
    expect(() => points.define('nope', { kind: 'term', label: 'x' }, add)).toThrow(/名字/);
    expect(() => points.define('query:x', { kind: 'term', label: 'x' }, add)).toThrow(/名字/);
    expect(() => points.patch('term:nope', 'a', { after: (r) => r })).toThrow(/没有内部点/);
    points.define('term:x', { kind: 'term', label: 'x' }, add);
    expect(() => points.patch('term:x', 'a', {})).toThrow(/至少一个/);
    expect(() => points.patch('term:x', 'a', { after: 1 as never })).toThrow(/函数/);
  });
});
