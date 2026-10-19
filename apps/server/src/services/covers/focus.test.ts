import { expect, it } from 'vitest';
import { inferCoverFocus } from './focus.ts';

it('clothing and leg tags cannot drag the head-first focus below the head', () => {
  const base = inferCoverFocus([]);
  for (const tag of ['thigh_focus','feet_focus','foot_focus','ass_focus','thighhighs','pantyhose','barefoot','feet'])
    expect(inferCoverFocus([[tag, 0.99]])).toMatchObject({ x: base.x, y: base.y, space: 'image' });
  expect(base).toEqual({ x: 0.5, y: 0.28, space: 'image' });
});

it('跟着构图：腿、脚是重点时另给 legsY，往下；只是有腿时稍微往下；弱标签不算', () => {
  expect(inferCoverFocus([['thigh_focus', 0.8]]).legsY).toBe(0.7);
  expect(inferCoverFocus([['feet_focus', 0.6], ['upper_body', 0.9]])).toEqual({ x: 0.5, y: 0.35, space: 'image', legsY: 0.7 });
  expect(inferCoverFocus([['pantyhose', 0.7]]).legsY).toBe(0.6);
  expect(inferCoverFocus([['pantyhose', 0.55]]).legsY).toBeUndefined();
  expect(inferCoverFocus([['portrait', 0.9]]).legsY).toBeUndefined();
});

it('uses image-space framing hints rather than fixed CSS offsets', () => {
  expect(inferCoverFocus([['full_body', 0.8],['pantyhose',0.99]])).toEqual({ x: 0.5, y: 0.3, space: 'image', legsY: 0.6 });
  expect(inferCoverFocus([['upper_body', 0.8]])).toEqual({ x: 0.5, y: 0.35, space: 'image' });
  expect(inferCoverFocus([['portrait', 0.8]])).toEqual({ x: 0.5, y: 0.4, space: 'image' });
  expect(inferCoverFocus([['chibi', 0.8],['upper_body',0.9]])).toEqual({ x: 0.5, y: 0.5, space: 'image' });
  expect(inferCoverFocus([['head_out_of_frame',0.8]])?.y).toBe(0.5);
  expect(inferCoverFocus([['close-up',0.8]])?.y).toBe(0.5);
});

it('weak pose tags do not override the upper-body fallback', () => {
  expect(inferCoverFocus([['full_body', 0.4], ['chibi', 0.49]])).toEqual(inferCoverFocus([]));
});
