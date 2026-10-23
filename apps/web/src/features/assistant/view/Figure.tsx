import type { ReactNode } from 'react';
import type { AssistantCard, AssistantMessage } from '@emaki/shared';
import { Dotted } from '@/components/overlays/palette/items';
import { MountFrame, SelectCircle } from '@/components/media/ImageGrid';
import { Thumb } from '@/components/media/Thumb';
import { Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useLightbox } from '@/lib/stores';
import type { ConversationView } from '../useConversation';
import { useAssistantView } from '../viewState';
import { useAssistantImage } from './parts';

export interface FigureProps {
  /** present_result 那条消息（text 和卡片标题相同时不重复显示正文） */
  message: AssistantMessage;
  card: AssistantCard;
  /** 有图时的编号「图 n」 */
  figureNo?: number;
  /** 有列时的编号「表 n」 */
  tableNo?: number;
  conv: ConversationView;
  className?: string;
}

const PLATE_STEP = 12;
const ROW_STEP = 8;
const LINKS = 'flex items-center gap-4 text-xs font-medium text-fg-muted [&_button]:underline-offset-4 [&_button:hover]:text-fg [&_button:hover]:underline';

/** 图版和表（§8）：没有卡片边框，也没有内部滚动区；一张卡同时有图和表时先图后表 */
export function Figure({ message, card, figureNo, tableNo, conv, className }: FigureProps) {
  // 一条消息带几张卡时，正文只在第一张前面写一次
  const lead = message.cards?.[0]?.id === card.id && message.text.trim() && !message.cards.some(c => c.title === message.text);
  return (
    <div className={cn('space-y-3', className)}>
      {lead && <p className="text-[13.5px] leading-[1.75] break-words whitespace-pre-wrap">{message.text}</p>}
      {card.imageIds.length > 0 && <Plate card={card} n={figureNo} conv={conv} />}
      {card.columns && card.columns.length > 0 && <Table card={card} n={tableNo} />}
    </div>
  );
}

// ------------------------------------------------------------------ 图版

function Plate({ card, n, conv }: { card: AssistantCard; n?: number; conv: ConversationView }) {
  const ids = card.imageIds;
  const revealed = useAssistantView(s => s.revealed[card.id] ?? PLATE_STEP);
  const shown = ids.slice(0, revealed);
  const hidden = ids.length - shown.length;
  const expanded = revealed > PLATE_STEP;
  // 跨卡勾选时选择里也有别的卡的图，按 id 认
  const sel = new Set(conv.resultSelection?.ids ?? []);
  const picked = ids.filter(id => sel.has(id));
  const k = picked.length;
  const show = (i: number) => useLightbox.getState().show(ids, i);
  const { setRevealed } = useAssistantView.getState();
  return (
    <figure>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-1.5">
        {shown.map((id, i) => (
          <li key={id} className="group/tile relative aspect-[4/5] rounded-[var(--radius-plate-sm)]">
            <button
              type="button"
              aria-label={`看大图：图 ${n ?? ''} 第 ${i + 1} 张`}
              onClick={() => show(i)}
              className="focus-frame block size-full cursor-zoom-in rounded-[var(--radius-plate-sm)]"
            >
              <Tile id={id} />
            </button>
            <MountFrame selected={sel.has(id)} />
            <SelectCircle selected={sel.has(id)} selecting={k > 0} onToggle={() => conv.actions.selectResult(card, id, !sel.has(id))} />
          </li>
        ))}
      </ul>
      <figcaption className="mt-2 flex items-baseline gap-2 text-[12px] leading-5">
        <span className="shrink-0 font-semibold text-fg">图 {n}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{card.title}</span>
        <span className="shrink-0 text-fg-subtle tabular"><Dotted parts={[k ? `已选 ${k}` : null, `${ids.length} 张`]} /></span>
      </figcaption>
      <div className={cn('mt-1.5', LINKS)}>
        {(hidden > 0 || expanded) && (
          <button type="button" aria-expanded={expanded} onClick={() => setRevealed(card.id, expanded ? PLATE_STEP : ids.length)}>
            {expanded ? '收起' : `展开其余 ${hidden} 张`}
          </button>
        )}
        <button type="button" onClick={() => (k ? picked : ids).forEach(id => conv.actions.selectResult(card, id, !k))}>{k ? '清除' : '全选'}</button>
        <button type="button" className="ml-auto !no-underline" onClick={() => show(0)}>逐张看 →</button>
      </div>
    </figure>
  );
}

function Tile({ id }: { id: string }) {
  const image = useAssistantImage(id);
  if (image.data) return <Thumb image={image.data} width={240} className="size-full rounded-[var(--radius-plate-sm)]" />;
  if (image.isError) {
    return <span className="flex size-full items-center justify-center rounded-[var(--radius-plate-sm)] bg-sunken text-[11px] text-fg-subtle">已移除</span>;
  }
  return <Skeleton className="size-full animate-fade-in !rounded-[var(--radius-plate-sm)]" style={{ animationDelay: '140ms' }} />;
}

// ------------------------------------------------------------------ 表

/** 表格单元：空值写破折号，布尔写是 / 否，对象写成等宽的 JSON */
function cell(v: unknown): ReactNode {
  if (v === null || v === undefined) return <span className="text-fg-subtle">—</span>;
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'object') return <span className="font-mono text-[11.5px]">{JSON.stringify(v)}</span>;
  return String(v);
}

function Table({ card, n }: { card: AssistantCard; n?: number }) {
  const columns = card.columns ?? [];
  const rows = card.rows ?? [];
  const key = `${card.id}:rows`;
  const revealed = useAssistantView(s => s.revealed[key] ?? ROW_STEP);
  const shown = rows.slice(0, revealed);
  const hidden = rows.length - shown.length;
  const expanded = revealed > ROW_STEP;
  const pair = columns.length === 2;
  // 一列全是数字（空值不算）就整列右对齐，表头和破折号也跟着靠右
  const numeric = columns.map((_, j) => rows.some(r => typeof r[j] === 'number') && rows.every(r => r[j] == null || typeof r[j] === 'number'));
  return (
    <figure>
      {/* 表题在表上方（书籍惯例） */}
      <figcaption className="mb-2 flex items-baseline gap-2 text-[12px]">
        <span className="shrink-0 font-semibold text-fg">表 {n}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{card.title}</span>
        <span className="shrink-0 text-fg-subtle tabular">{rows.length} 行</span>
        {pair && <span className="sr-only">{columns.join('、')}</span>}
      </figcaption>
      {pair ? (
        // 正好两列：奥付小表
        <dl className="border-t border-rule text-[12px]">
          {shown.map((r, i) => (
            <div key={i} className="flex justify-between gap-4 border-b border-line py-2">
              <dt className="text-fg-subtle">{cell(r[0])}</dt>
              <dd className="min-w-0 text-right break-words">{cell(r[1])}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full border-collapse text-[12px] leading-snug">
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <th key={i} className={cn('border-b border-rule pr-3 pb-2 text-[11px] font-semibold tracking-[0.08em] whitespace-nowrap text-fg-subtle last:pr-0', numeric[i] ? 'text-right' : 'text-left')}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i}>
                  {columns.map((_, j) => (
                    <td key={j} className={cn('border-b border-line py-2 pr-3 align-top break-words last:pr-0', numeric[j] && 'text-right tabular')}>{cell(r[j])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(hidden > 0 || expanded) && (
        <div className={cn('mt-1.5', LINKS)}>
          <button type="button" aria-expanded={expanded} onClick={() => useAssistantView.getState().setRevealed(key, expanded ? ROW_STEP : rows.length)}>
            {expanded ? '收起' : `展开其余 ${hidden} 行`}
          </button>
        </div>
      )}
    </figure>
  );
}
