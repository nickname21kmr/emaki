import { describe, expect, it } from 'vitest';
import { withParam } from './urlPrefs';

describe('withParam（本机偏好补进 URL，附录 #32）', () => {
  it('改了才返回新的参数，原来的不动', () => {
    const prev = new URLSearchParams('q=mika');
    const next = withParam(prev, 'collapse', 'off');
    expect(next.toString()).toBe('q=mika&collapse=off');
    expect(prev.toString()).toBe('q=mika');
  });
  it('值一样就原样返回（不触发导航）', () => {
    const prev = new URLSearchParams('kind=illustration');
    expect(withParam(prev, 'kind', 'illustration')).toBe(prev);
  });
});
