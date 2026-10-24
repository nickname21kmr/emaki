import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openSessionEvents } from './sessionEvents';

class Source {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  disabled: (() => void) | null = null;
  deleted: (() => void) | null = null;
  addEventListener(type: string, cb: () => void) { if (type === 'deleted') this.deleted = cb; else this.disabled = cb; }
  close() { this.readyState = 2; }
  fail() { this.close(); this.onerror?.(); }
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup() {
  const sources: Source[] = [];
  const make = vi.fn((_url: string) => { const source = new Source(); sources.push(source); return source as unknown as EventSource; });
  const on = { open: vi.fn(), message: vi.fn(), error: vi.fn(), disabled: vi.fn(), deleted: vi.fn() };
  const close = openSessionEvents('same-session', on, make);
  return { sources, make, on, close };
}
it('recovers from proxy closure and receives the existing session snapshot', () => {
  const { sources, make, on, close } = setup();
  sources[0]!.fail();
  expect(on.error).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1000);
  expect(make.mock.calls).toEqual([['/api/assistant/sessions/same-session/events'], ['/api/assistant/sessions/same-session/events']]);
  sources[1]!.onopen?.();
  sources[1]!.onmessage?.({ data: '{"status":"idle","messages":[]}' });
  expect(on.open).toHaveBeenCalledOnce();
  expect(on.message).toHaveBeenCalledWith('{"status":"idle","messages":[]}');
  close();
});
it('disabling the assistant closes the stream and cancels pending reconnects', () => {
  const { sources, make, on } = setup();
  sources[0]!.fail();
  sources[0]!.disabled?.();
  vi.advanceTimersByTime(30000);
  expect(make).toHaveBeenCalledOnce();
  expect(on.disabled).toHaveBeenCalledOnce();
  expect(sources[0]!.readyState).toBe(2);
});
it('a session deleted elsewhere closes the stream for good', () => {
  const { sources, make, on } = setup();
  sources[0]!.deleted?.();
  vi.advanceTimersByTime(30000);
  expect(make).toHaveBeenCalledOnce();
  expect(on.deleted).toHaveBeenCalledOnce();
  expect(on.disabled).not.toHaveBeenCalled();
  expect(sources[0]!.readyState).toBe(2);
});
it('closing the panel cancels pending reconnects', () => {
  const { sources, make, close } = setup();
  sources[0]!.fail(); close();
  vi.advanceTimersByTime(30000);
  expect(make).toHaveBeenCalledOnce();
});
