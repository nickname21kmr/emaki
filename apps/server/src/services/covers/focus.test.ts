import { expect, it } from 'vitest';
import { inferCoverFocus } from './focus.ts';

it('按构图标签推断焦点，第一条命中的规则生效', () => {
  expect(inferCoverFocus([['thigh_focus', 0.7], ['full_body', 0.9]])).toEqual({ x: 0.5, y: 0.65 });
  expect(inferCoverFocus([['full_body', 0.8], ['thighs', 0.9]])).toEqual({ x: 0.5, y: 0.08 });
  expect(inferCoverFocus([['upper_body', 0.6]])).toEqual({ x: 0.5, y: 0.28 });
  expect(inferCoverFocus([['cowboy_shot', 0.55]])).toEqual({ x: 0.5, y: 0.18 });
  expect(inferCoverFocus([['thighhighs', 0.7]])).toEqual({ x: 0.5, y: 0.58 });
});

it('分数不够或没有构图标签 → 居中（null）', () => {
  expect(inferCoverFocus([['thighs', 0.55]])).toBeNull();
  expect(inferCoverFocus([['full_body', 0.4]])).toBeNull();
  expect(inferCoverFocus([])).toBeNull();
});
