import { memo, useId, type ReactNode } from 'react';
import { Dotted } from '@/components/overlays/palette/items';
import { cn } from '@/lib/cn';
import { contextPageLabel, messageSignature, modelLabel, parseAnswerText, quote, turnItemKey, turnTime, type Turn as TurnData, type TurnItem } from '../presentation';
import type { ConversationView } from '../useConversation';
import { useAssistantView } from '../viewState';
import { Erratum } from './Erratum';
import { Figure } from './Figure';
import { Prose } from './Prose';
import { SideNote } from './SideNote';
import { SystemNote } from './SystemNote';
import { TextToggle, useClamped, useEntrance } from './parts';

export interface TurnProps {
  turn: TurnData;
  conv: ConversationView;
  /** 只给最后一轮：中断便笺、提问便笺，排在本轮末尾 */
  tail?: ReactNode;
}

/**
 * 一轮（§6.2）：加粗的问句和一行小字（页面、选图、时间），下面是条目，本轮结束且有正文时落款。
 * 不用气泡、不写「你」、不加底色。
 */
export const Turn = memo(TurnView, (a, b) =>
  // 长会话里每份快照只重排变了的那一轮。conv 每次都是新对象，只比这里用到的几项；
  // actions 由 Transcript 换成转发到最新 conv 的稳定版本，不会拿到旧闭包
  a.tail === b.tail
  && a.conv.sessionId === b.conv.sessionId
  && a.conv.connected === b.conv.connected
  && waitingApproval(a.conv) === waitingApproval(b.conv)
  && a.conv.resultSelection === b.conv.resultSelection
  && a.conv.models.data === b.conv.models.data
  && a.conv.actions === b.conv.actions
  && (a.turn === b.turn || turnSignature(a.turn) === turnSignature(b.turn)));

/** 会话停在批准提问上（旁注里运行中的那一步其实在等你） */
const waitingApproval = (conv: ConversationView) => conv.session?.status === 'waiting' && conv.session.questions.some(q => q.kind === 'approval');

function TurnView({ turn, conv, tail }: TurnProps) {
  const hid = useId();
  const { request, variant } = turn;
  const enter = useEntrance(conv.sessionId, turn.id);
  return (
    <article
      aria-labelledby={request ? hid : undefined}
      className={cn(
        'mt-6 border-t pt-6 first:mt-0 first:border-t-0 first:pt-0',
        variant === 'resume' ? 'border-dashed border-line' : 'border-line',
        enter && 'animate-fade-in',
      )}
    >
      {request && <Request turn={turn} hid={hid} />}
      {(turn.items.length > 0 || tail) && (
        <div className={cn('space-y-3', request && 'mt-4')}>
          {turn.items.map(item => <Item key={turnItemKey(item)} item={item} conv={conv} />)}
          {tail}
        </div>
      )}
      {turn.colophon && <p className="mt-4 text-right text-[11px] text-fg-subtle">—— {modelLabel(turn.colophon.model, conv.models.data)}</p>}
    </article>
  );
}

/** 问句：超过 6 行折起来，下面是「展开全文 / 收起」 */
function Request({ turn, hid }: { turn: TurnData; hid: string }) {
  const request = turn.request!;
  const key = `${request.id}:full`;
  const full = useAssistantView(s => s.expanded[key] ?? false);
  const resume = turn.variant === 'resume';
  const text = turn.variant === 'answer' ? parseAnswerText(request.text)?.value ?? request.text : request.text;
  const [ref, over] = useClamped<HTMLHeadingElement>(!resume && !full, text);
  const ctx = request.context;
  const n = ctx?.imageIds.length ?? 0;
  const meta = [
    resume && turn.resumeText ? `接着${quote(turn.resumeText, 24)}` : null,
    ctx ? contextPageLabel(ctx.page) : null,
    ...requestSelection(ctx?.selectionScope, n),
    request.createdAt ? turnTime(request.createdAt) : null,
  ];
  return (
    <header>
      {turn.variant === 'answer' && turn.answerTo && <p className="mb-1 truncate text-[12px] text-fg-muted [font-feature-settings:'halt']">回应{quote(turn.answerTo, 24)}</p>}
      {resume ? (
        <h3 id={hid} className="text-[13px] font-medium text-fg-muted">继续处理上次的请求</h3>
      ) : (
        <>
          <h3 ref={ref} id={hid} className={cn('text-[14px] leading-[1.65] font-semibold tracking-tight text-pretty break-words whitespace-pre-wrap text-fg', !full && 'line-clamp-6')}>{text}</h3>
          {(over || full) && (
            <TextToggle open={full} className="mt-1" onClick={() => useAssistantView.getState().setExpanded(key, !full)}>{full ? '收起' : '展开全文'}</TextToggle>
          )}
        </>
      )}
      {/* 一行排不下就截断（不让「·」落到第二行开头），全文放在 title；halt 收紧引号两边的全角空白 */}
      <p className="mt-1.5 truncate text-[11.5px] leading-4 text-fg-subtle [font-feature-settings:'halt']" title={meta.filter(Boolean).join(' · ')}>
        <Dotted parts={meta} />
      </p>
    </header>
  );
}

/** 问句下那行小字里的选图：看图器里问的是当前这张，勾了结果图的写「助手结果」，没选过就不写 */
export function requestSelection(scope: string | undefined, n: number): string[] {
  if (scope === 'lightbox') return ['看图器', '当前这张'];
  if (!n) return [];
  if (scope?.startsWith('assistant-result:')) return ['助手结果', `${n} 张`];
  return [`已选 ${n} 张`];
}

/** 一轮里会影响显示的内容。SSE 快照每次都是新对象，按这个判断要不要重排 */
export function turnSignature(turn: TurnData) {
  const items = turn.items.map(item => {
    const body = item.kind === 'note' ? item.messages.map(messageSignature).join(',') : messageSignature(item.message);
    return `${turnItemKey(item)}:${body}${item.kind === 'figure' ? `#${item.figureNo ?? ''}/${item.tableNo ?? ''}` : ''}`;
  });
  return [turn.id, turn.variant, turn.answerTo, turn.resumeText, turn.colophon?.model, turn.request ? messageSignature(turn.request) : '', ...items].join('\n');
}

function Item({ item, conv }: { item: TurnItem; conv: ConversationView }) {
  // 首个快照里已有的条目不播；之后新来的第一次挂上时淡入
  const enter = useEntrance(conv.sessionId, turnItemKey(item));
  const className = enter ? 'animate-fade-in' : undefined;
  switch (item.kind) {
    case 'prose': return <Prose message={item.message} className={className} />;
    case 'note': return <SideNote id={item.id} messages={item.messages} paused={!conv.connected} waiting={waitingApproval(conv)} className={className} />;
    case 'figure': return <Figure message={item.message} card={item.card} figureNo={item.figureNo} tableNo={item.tableNo} conv={conv} className={className} />;
    case 'erratum': return <Erratum message={item.message} erratum={item.erratum} conv={conv} className={className} />;
    case 'system': return <SystemNote message={item.message} className={className} />;
    case 'plain': return <p className={cn('text-[12.5px] break-words text-fg-muted', className)}>{item.message.text}</p>;
  }
}
