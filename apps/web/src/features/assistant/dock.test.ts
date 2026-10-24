import { describe, expect, it } from 'vitest';
import { useAssistantDock } from './dock';
import { draftAfterSend } from './useConversation';
import { runUndo, useAssistantView } from './viewState';

describe('dock shown', () => {
  it('clears shown right away when no sheet ever mounted (closed during the capsule exit)', () => {
    const dock = useAssistantDock.getState();
    dock.setOpen(true);
    expect(useAssistantDock.getState().shown).toBe(true);
    dock.setOpen(false);
    expect(useAssistantDock.getState().shown).toBe(false);
  });
  it('keeps shown while a sheet is exiting and clears it when the last one unmounts', () => {
    const dock = useAssistantDock.getState();
    dock.setOpen(true);
    const a = dock.mountSheet();
    // 换纸：新的先挂上，旧的后卸下
    const b = dock.mountSheet();
    a();
    expect(useAssistantDock.getState().shown).toBe(true);
    dock.setOpen(false);
    expect(useAssistantDock.getState().shown).toBe(true);
    b();
    expect(useAssistantDock.getState()).toMatchObject({ shown: false, sheets: 0 });
  });
  it('does not clear shown when a sheet unmounts while still open (StrictMode, frame switch)', () => {
    const dock = useAssistantDock.getState();
    dock.setOpen(true);
    dock.mountSheet()();
    expect(useAssistantDock.getState().shown).toBe(true);
    dock.setOpen(false);
  });
});

describe('composer draft', () => {
  it('drops the sent text and keeps what was typed while waiting', () => {
    expect(draftAfterSend('hello', 'hello')).toBe('');
    expect(draftAfterSend('hello\n再补一句', 'hello')).toBe('再补一句');
    expect(draftAfterSend('换了一句', 'hello')).toBe('换了一句');
  });
  it('keeps drafts per session', () => {
    const view = useAssistantView.getState();
    view.setDraft('s1', 'a');
    view.setDraft('s2', 'b');
    view.setDraft('s1', current => `${current}c`);
    expect(useAssistantView.getState().drafts).toMatchObject({ s1: 'ac', s2: 'b' });
    view.setDraft('s1', '');
    expect('s1' in useAssistantView.getState().drafts).toBe(false);
  });
});

describe('erratum undo', () => {
  it('marks a token the backend no longer has as expired, and keeps network failures retryable', async () => {
    await runUndo('t-ok', async () => 'ok');
    await runUndo('t-gone', async () => 'gone');
    await runUndo('t-net', async () => 'failed');
    await runUndo('t-throw', async () => { throw new Error('x'); });
    const { undo } = useAssistantView.getState();
    expect(undo['t-ok']).toBe('undone');
    expect(undo['t-gone']).toBe('expired');
    expect(undo['t-net']).toEqual({ failed: '可以再试一次' });
    expect(undo['t-throw']).toEqual({ failed: '可以再试一次' });
  });
});
