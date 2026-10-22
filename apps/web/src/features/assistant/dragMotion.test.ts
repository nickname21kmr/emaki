import { afterEach, expect, it, vi } from 'vitest';
import { dragMotion } from './dragMotion';

afterEach(() => vi.unstubAllGlobals());

function surface() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  const request = vi.fn((cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const element = { style: { left: '', top: '', right: '', bottom: '', transform: '', willChange: 'auto' } } as HTMLElement;
  const motion = dragMotion(element, { left: 500, top: 100, width: 440, height: 600 } as DOMRect, { x: 1280, y: 800 });
  const paint = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(0)); };
  return { motion, element, request, frames, paint };
}

it('coalesces a burst of pointer moves into one frame without changing layout', () => {
  const s = surface();
  for (let x = 501; x <= 600; x++) s.motion.move({ x, y: 140 });
  expect(s.request).toHaveBeenCalledTimes(1);
  expect(s.element.style.left).toBe('');
  s.paint();
  expect(s.element.style.transform).toBe('translate3d(100px, 40px, 0)');
  expect(s.motion.finish()).toEqual({ x: 600, y: 140 });
  expect(s.element.style.left).toBe('600px');
  expect(s.element.style.top).toBe('140px');
  expect(s.element.style.transform).toBe('');
  expect(s.element.style.willChange).toBe('auto');
});

it('commits the latest clamped position even if released before the next frame', () => {
  const s = surface();
  s.motion.move({ x: 10000, y: -200 });
  expect(s.motion.finish()).toEqual({ x: 832, y: 8 });
  expect(s.frames.size).toBe(0);
  s.paint();
  expect(s.element.style.transform).toBe('');
  expect(s.element.style.left).toBe('832px');
});

it('cancels a pending frame when the floating surface unmounts', () => {
  const s = surface();
  s.motion.move({ x: 600, y: 100 });
  s.motion.cancel();
  expect(s.frames.size).toBe(0);
  expect(s.element.style.left).toBe('');
  expect(s.element.style.willChange).toBe('auto');
});
