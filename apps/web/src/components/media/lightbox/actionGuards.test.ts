import { describe, expect, it } from 'vitest';
import { canLeave, pendingOn } from './actionGuards';

describe('看图器里的守卫', () => {
  const favA = { isPending: true, variables: { id: 'a', value: true } };

  it('同一张图上这个动作还没做完：拦（返回它的参数，界面按目标值画）', () => {
    expect(pendingOn(favA, 'a')).toEqual({ id: 'a', value: true });
  });

  it('换了一张：放行（上一张的请求和刷新还在进行也不拦）', () => {
    expect(pendingOn(favA, 'b')).toBeUndefined();
  });

  it('做完了、还没开始过、没有当前图：都不拦', () => {
    expect(pendingOn({ isPending: false, variables: { id: 'a', value: true } }, 'a')).toBeUndefined();
    expect(pendingOn({ isPending: false }, 'a')).toBeUndefined();
    expect(pendingOn(favA, undefined)).toBeUndefined();
  });

  it('排除 / 回收站：有一个在进行、或者上一张还在原地停留时照旧都拦，不分哪张图', () => {
    expect(canLeave({ excluding: false, trashing: false, holding: false })).toBe(true);
    expect(canLeave({ excluding: true, trashing: false, holding: false })).toBe(false);
    expect(canLeave({ excluding: false, trashing: true, holding: false })).toBe(false);
    expect(canLeave({ excluding: false, trashing: false, holding: true })).toBe(false);
  });
});
