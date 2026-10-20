import { expect, it } from 'vitest';
import { resizeRect } from './useFloatingResize';

const rect = { x: 400, y: 100, width: 440, height: 500 };
it('keeps the opposite corner anchored when resizing from the upper left', () => {
  expect(resizeRect(rect, 'nw', -100, -50, 1280, 720)).toEqual({ x: 300, y: 50, width: 540, height: 550 });
});
it('resizes individual edges without changing the other axis', () => {
  expect(resizeRect(rect, 'w', 70, 50, 1280, 720)).toEqual({ x: 470, y: 100, width: 370, height: 500 });
  expect(resizeRect(rect, 's', 70, 50, 1280, 720)).toEqual({ x: 400, y: 100, width: 440, height: 550 });
});
it('limits shrinking and keeps the opposite edge in place', () => {
  expect(resizeRect(rect, 'nw', 2000, 2000, 1280, 720)).toEqual({ x: 520, y: 240, width: 320, height: 360 });
  expect(resizeRect(rect, 'se', -2000, -2000, 1280, 720)).toEqual({ x: 400, y: 100, width: 320, height: 360 });
});
it('clamps all edges inside the viewport', () => {
  expect(resizeRect(rect, 'nw', -2000, -2000, 1280, 720)).toEqual({ x: 8, y: 8, width: 832, height: 592 });
  expect(resizeRect(rect, 'se', 2000, 2000, 1280, 720)).toEqual({ x: 400, y: 100, width: 872, height: 612 });
});
