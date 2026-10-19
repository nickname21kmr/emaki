import { useEffect, useState } from 'react';
import type { AssistantMessage, AssistantSession } from '@emaki/shared';
import { LoaderCircle, Check, CircleAlert, Pause } from 'lucide-react';

const names = { running: '运行中', succeeded: '成功', failed: '失败', interrupted: '已中断' };
const elapsed = (start: number, end: number) => { const seconds = Math.max(0, Math.floor((end - start) / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; };
function useClock(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (active) { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); } }, [active]);
  return now;
}
function Output({ title, text }: { title: string; text: string }) {
  return <div className="mt-2"><p className="text-[11px] text-fg-muted">{title}</p><pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-sunken p-2 text-xs">{text}</pre></div>;
}

export function ToolActivity({ message }: { message: AssistantMessage }) {
  const tool = message.tool!, now = useClock(tool.status === 'running');
  const Icon = tool.status === 'running' ? LoaderCircle : tool.status === 'succeeded' ? Check : tool.status === 'failed' ? CircleAlert : Pause;
  return <details className="rounded-lg border border-line p-2">
    <summary className="cursor-pointer text-xs"><span className="inline-flex max-w-full items-center gap-2 align-middle">
      <Icon size={14} className={tool.status === 'running' ? 'shrink-0 animate-spin' : tool.status === 'failed' ? 'shrink-0 text-danger' : 'shrink-0'} />
      <span className="break-all font-medium">{message.text}</span><span className={tool.status === 'failed' ? 'shrink-0 text-danger' : 'shrink-0 text-fg-muted'}>{names[tool.status]}</span>
      <span className="shrink-0 text-fg-subtle">{elapsed(tool.startedAt, tool.finishedAt ?? now)}</span>
    </span></summary>
    {tool.input && <Output title="调用参数" text={tool.input} />}
    {tool.output ? <Output title={tool.status === 'running' ? '实时输出' : '返回结果'} text={tool.output} /> : <p className="mt-2 text-xs text-fg-muted">{tool.status === 'running' ? '等待工具返回…' : '工具未返回文本内容'}</p>}
  </details>;
}

export function ReasoningActivity({ message }: { message: AssistantMessage }) {
  const reasoning = message.reasoning!, now = useClock(reasoning.status === 'running');
  return <details className="rounded-lg border border-line p-2 text-xs text-fg-muted">
    <summary className="cursor-pointer">{reasoning.status === 'running' ? '正在思考' : reasoning.status === 'interrupted' ? '思考已中断' : '思考过程'} · {elapsed(reasoning.startedAt, reasoning.finishedAt ?? now)}</summary>
    <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{reasoning.text}</p>
  </details>;
}

export function toolGroupLabel(messages: AssistantMessage[]): string {
  const running = messages.filter(m => m.tool?.status === 'running');
  const success = messages.filter(m => m.tool?.status === 'succeeded').length;
  const failed = messages.filter(m => m.tool?.status === 'failed').length;
  const interrupted = messages.filter(m => m.tool?.status === 'interrupted').length;
  return [`${messages.length} 条工具记录`, running.length ? `正在运行 ${running.at(-1)!.text}${running.length > 1 ? ` 等 ${running.length} 项` : ''}` : '', success ? `${success} 成功` : '', failed ? `${failed} 失败` : '', interrupted ? `${interrupted} 中断` : '', messages.some(m => m.undoToken) ? '含可撤销操作' : ''].filter(Boolean).join(' · ');
}

export function currentActivity(session: AssistantSession) {
  const index = session.messages.findLastIndex(m => m.role === 'user');
  const messages = session.messages.slice(index + 1);
  const tool = messages.findLast(m => m.tool?.status === 'running');
  const thinking = messages.findLast(m => m.reasoning?.status === 'running');
  const writing = messages.at(-1)?.role === 'assistant' && Boolean(messages.at(-1)?.text);
  return {
    label: session.status === 'waiting' ? '等待你的回应' : tool ? `正在运行 ${tool.text}` : thinking ? '正在思考' : writing ? '正在回复' : '等待模型回应',
    detail: session.status === 'waiting' ? '' : tool?.tool?.input?.split('\n').filter(Boolean).slice(0, 3).join(' ') ?? thinking?.reasoning?.text.slice(-160) ?? '',
    startedAt: session.messages[index]?.createdAt,
  };
}

export function ActivityStatus({ session }: { session: AssistantSession }) {
  const now = useClock(true), activity = currentActivity(session);
  return <div className="min-w-0 rounded-lg bg-sunken px-3 py-2 text-xs">
    <div role="status" className="flex items-center gap-2"><LoaderCircle size={14} className="shrink-0 animate-spin text-shu" /><span className="truncate">{activity.label}</span>{activity.startedAt && <span className="ml-auto shrink-0 text-fg-muted">已用 {elapsed(activity.startedAt, now)}</span>}</div>
    {activity.detail && <p className="mt-1 line-clamp-2 break-all text-[11px] text-fg-muted">{activity.detail}</p>}
  </div>;
}
