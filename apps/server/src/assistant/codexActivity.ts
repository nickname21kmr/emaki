import type { ToolUpdate } from './backends.ts';
import { toolPreview } from './activity.ts';

// Protocol: codex app-server generate-ts (ThreadItem and ServerNotification).
// https://developers.openai.com/codex/app-server — final items are authoritative.
export function codexToolActivity(item: any, done: boolean): { id: string; name: string; update: ToolUpdate } | null {
  if (!item?.id) return null;
  let name: string, input: unknown, output: unknown;
  switch (item.type) {
    case 'commandExecution':
      name = '执行命令'; input = item.cwd ? { command: item.command, cwd: item.cwd } : item.command;
      output = item.aggregatedOutput;
      break;
    case 'mcpToolCall':
      name = item.server ? `${item.server} · ${item.tool}` : item.tool;
      input = item.arguments; output = item.error ?? item.result;
      break;
    case 'dynamicToolCall':
      name = item.namespace ? `${item.namespace} · ${item.tool}` : item.tool;
      input = item.arguments; output = item.contentItems;
      break;
    case 'webSearch':
      name = item.action?.type === 'openPage' ? '打开网页' : item.action?.type === 'findInPage' ? '查找网页内容' : '联网搜索';
      input = item.action ?? item.query; output = item.results;
      break;
    case 'fileChange':
      name = '修改文件'; input = item.changes; output = item.changes;
      break;
    case 'imageView': name = '查看图片'; input = item.path; break;
    case 'collabAgentToolCall':
    case 'collabToolCall': // Older app-server releases.
      name = `子任务 · ${item.tool}`;
      input = { prompt: item.prompt, model: item.model, reasoningEffort: item.reasoningEffort, receiverThreadIds: item.receiverThreadIds ?? item.receiverThreadId };
      output = item.agentsStates ?? item.agentStatus;
      break;
    case 'sleep': name = '等待'; input = { durationMs: item.durationMs }; break;
    default: return null;
  }
  const failed = Boolean(item.error || item.success === false || item.result?.isError || ['failed', 'declined'].includes(item.status)
    || (typeof item.exitCode === 'number' && item.exitCode !== 0));
  const status = !done ? 'running' : item.status === 'interrupted' || item.status === 'cancelled' ? 'interrupted' : failed ? 'failed' : 'succeeded';
  return { id: item.id, name, update: {
    status,
    ...(input != null ? { input: toolPreview(input) } : {}),
    // Null/absent final output must not erase previously streamed output.
    ...(done && output != null ? { output: toolPreview(output) } : {}),
    ...(done && typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
    ...(done && typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
  } };
}
