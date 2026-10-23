import { useNavigate } from 'react-router';
import { CalendarDays, ChartColumn, Link2, ScanFace, ScanSearch, Tags, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui';
import { GroupHeading, IconTile } from '@/components/overlays/palette/items';
import { focusComposer } from '../dock';
import { suggestions, type SuggestionKey } from '../presentation';
import type { ConversationView } from '../useConversation';

export interface BlankPageProps {
  conv: ConversationView;
}

const ICONS: Record<SuggestionKey, LucideIcon> = {
  who: ScanFace, source: Link2, tags: Tags, viewWho: ScanFace, viewSource: Link2,
  pickKnown: ScanSearch, recent: CalendarDays, unknown: ScanSearch, artists: ChartColumn,
};

/** 空白页（§12）：没选 backend 时指去设置；会话没有消息时给「可以这样问」 */
export function BlankPage({ conv }: BlankPageProps) {
  const navigate = useNavigate();
  if (!conv.backend) {
    return (
      <div className="pt-2">
        <h3 className="text-[15px] font-semibold tracking-tight">还没选 Agent 应用</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-balance text-fg-muted">助手通过本机的 Codex、Pi 或 DSH 运行，先在设置里选一个。</p>
        <Button size="sm" variant="secondary" className="mt-4" data-autofocus onClick={() => navigate('/settings#assistant')}>去设置</Button>
      </div>
    );
  }
  const fill = (prompt: string) => {
    conv.setDraft(prompt);
    // 等草稿写进输入框再把光标放到末尾
    requestAnimationFrame(() => focusComposer(true));
  };
  return (
    <div>
      <h3 className="text-[15px] font-semibold tracking-tight">想在图库里做什么？</h3>
      <p className="mt-1 text-[12.5px] leading-relaxed text-balance text-fg-muted">可以问图，也可以让它帮你整理。先选中图片再问，它会一起看到。</p>
      <div className="-mx-3 mt-3"><GroupHeading title="可以这样问" /></div>
      <ul className="-mx-2">
        {suggestions({ imageCount: conv.context.imageIds.length, viewing: Boolean(conv.viewedId), page: conv.context.page }).map(s => (
          <li key={s.key}>
            <button type="button" onClick={() => fill(s.prompt)} className="flex h-12 w-full items-center gap-3 rounded-[11px] px-2 text-left transition-colors hover:bg-hover">
              <IconTile icon={ICONS[s.key]} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-5 font-medium">{s.title}</span>
                {s.sub && <span className="block truncate text-[12px] leading-4 text-fg-muted">{s.sub}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-[11.5px] leading-relaxed text-pretty text-fg-subtle">回答由模型生成，可能出错。发送时会附上当前页面和选中的图片。</p>
    </div>
  );
}
