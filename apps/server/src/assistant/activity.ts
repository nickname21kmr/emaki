import type { AssistantSession } from '@emaki/shared';

const LIMIT = 24000;
export function boundedText(text: string): string {
  return text.length > LIMIT ? text.slice(0, LIMIT) + '\n…（内容较长，显示前 24000 字符）' : text;
}

/** A readable preview, without binary media or credential fields. */
export function toolPreview(value: unknown): string {
  if (typeof value === 'string') return boundedText(value);
  if (value === undefined) return '';
  return boundedText(JSON.stringify(value, (key, item) => {
    if (/^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|secret)$/i.test(key)) return '[已隐藏]';
    if (item && typeof item === 'object' && ['image', 'audio'].includes(item.type)) return { type: item.type, description: '媒体内容' };
    if (typeof item === 'string' && /^data:[^;]+;base64,/.test(item)) return '[媒体内容]';
    return item;
  }, 2) ?? '');
}

/** Missing completion after stop/disconnect must never look like a successful call. */
export function interruptActivities(session: AssistantSession) {
  for (const message of session.messages) {
    if (message.tool?.status === 'running') { message.tool.status = 'interrupted'; message.tool.finishedAt = Date.now(); }
    if (message.reasoning?.status === 'running') { message.reasoning.status = 'interrupted'; message.reasoning.finishedAt = Date.now(); }
  }
}
