import { openEventStream } from '@/lib/events';

/** Reconnect the same session after proxy failures without resubmitting a turn. */
export function openSessionEvents(
  sessionId: string,
  on: { open: () => void; message: (data: string) => void; error: () => void; disabled: () => void; deleted?: () => void },
  make: (url: string) => EventSource = url => new EventSource(url),
): () => void {
  const close = openEventStream(on, () => {
    const source = make(`/api/assistant/sessions/${encodeURIComponent(sessionId)}/events`);
    source.addEventListener('disabled', () => { close(); on.disabled(); });
    // 会话在别处删掉了：不再重连
    source.addEventListener('deleted', () => { close(); on.deleted?.(); });
    return source;
  });
  return close;
}
