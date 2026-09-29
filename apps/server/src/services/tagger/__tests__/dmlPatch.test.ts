import { describe, expect, it } from 'vitest';
import { clearReshapeAllowzero } from '../dmlPatch.ts';

const attr = (name: string, v: number) => Buffer.from([0x0a, name.length, ...Buffer.from(name), 0x18, v]);

describe('clearReshapeAllowzero', () => {
  it('只改 allowzero=1，长度不变，别的属性不动', () => {
    const buf = Buffer.concat([attr('allowzero', 1), attr('axis', 1), attr('allowzero', 0), attr('allowzero', 1)]);
    const len = buf.length;
    expect(clearReshapeAllowzero(buf)).toBe(2);
    expect(buf.length).toBe(len);
    expect(buf).toEqual(Buffer.concat([attr('allowzero', 0), attr('axis', 1), attr('allowzero', 0), attr('allowzero', 0)]));
    expect(clearReshapeAllowzero(buf)).toBe(0);
  });
});
