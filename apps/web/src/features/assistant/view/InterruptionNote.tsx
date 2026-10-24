import { Dotted } from '@/components/overlays/palette/items';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { quote } from '../presentation';
import type { ConversationView } from '../useConversation';

export interface InterruptionNoteProps {
  conv: ConversationView;
  className?: string;
}

const REASON = { restart: 'Emaki 重启过，上次请求停在了一半。', error: '处理出错，上次请求停在了一半。', stopped: '已经停下，上次请求没做完。' } as const;

/** 中断便笺（§10.2）：session.interruption 且没在运行时，排在最后一轮末尾、提问之前；禁用时写出原因 */
export function InterruptionNote({ conv, className }: InterruptionNoteProps) {
  const interruption = conv.session?.interruption;
  if (!interruption) return null;
  const req = conv.session?.messages.find(m => m.id === interruption.messageId);
  const n = req?.context?.imageIds.length ?? 0;
  return (
    <div className={cn('rounded-[14px] bg-sunken/70 py-3.5 pr-3.5 pl-4', className)}>
      <p className="text-[13px] font-medium text-pretty">{REASON[interruption.reason]}</p>
      {/* halt：收紧引号外的全角空白，「」 和后面的 · 不隔得太开 */}
      <p className="mt-0.5 truncate text-[12px] text-fg-muted [font-feature-settings:'halt']" title={req?.text}>
        <Dotted parts={[req ? quote(req.text, 24) : null, n ? `${n} 张图片` : null]} />
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" variant="primary" loading={conv.busy} disabled={!conv.model || !conv.connected} onClick={conv.actions.resume}>
          {interruption.reason === 'error' ? '重试并继续' : '继续处理'}
        </Button>
        {!conv.model ? <span className="text-[11.5px] text-fg-subtle">先选一个模型</span> : !conv.connected && <span className="text-[11.5px] text-fg-subtle">连上之后再继续</span>}
      </div>
    </div>
  );
}
