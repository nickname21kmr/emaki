import { EyeOff } from 'lucide-react';
import { Dotted } from '@/components/overlays/palette/items';
import { Thumb } from '@/components/media/Thumb';
import { focusComposer } from '../dock';
import { contextPageLabel, selectionLabel } from '../presentation';
import type { ConversationView } from '../useConversation';
import { useAssistantImage } from './parts';

export interface ContextLineProps {
  conv: ConversationView;
  /** 不识图提示里的「换一个」：打开模型菜单 */
  onSwitchModel: () => void;
}

/**
 * 输入面里的上下文行（§11.4）：发送时会附上的页面和图片，前面叠三张小缩略图。
 * 当前模型不识图而上下文里有图时，下面多一行提示。
 */
export function ContextLine({ conv, onSwitchModel }: ContextLineProps) {
  const { context, viewedId, resultSelection } = conv;
  const ids = context.imageIds;
  const n = ids.length;
  const parts = viewedId ? ['看图器', '当前这张'] : resultSelection ? [resultSelection.title, `已选 ${n} 张`] : [contextPageLabel(context.page), selectionLabel(n)];
  const current = conv.models.data?.find(m => m.id === conv.model);
  const visionWarn = current?.vision === false && n > 0;
  const running = conv.session?.status === 'running' || conv.session?.status === 'waiting';
  return (
    <>
      {/* 写的是会一起发给模型的东西，用 fg-muted，凹面上也读得清 */}
      <div className="flex h-6 min-w-0 items-center gap-2 text-[11.5px] text-fg-muted">
        {n > 0 && (
          <span aria-hidden className="flex shrink-0">
            {ids.slice(0, 3).map(id => (
              <span key={id} className="-ml-1.5 size-5 overflow-hidden rounded-[var(--radius-xs)] bg-sunken ring-2 ring-sunken first:ml-0 group-has-[textarea:focus]/surface:ring-raised">
                <ContextThumb id={id} />
              </span>
            ))}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate" title={parts.join(' · ')}><Dotted parts={parts} /></span>
        {resultSelection && !viewedId && (
          // 按钮点完就没了：焦点放回输入框，不掉到 body
          <button type="button" className="shrink-0 text-fg-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => { conv.actions.clearResultSelection(); focusComposer(); }}>改用页面选择</button>
        )}
      </div>
      {visionWarn && (
        <p className="flex items-center gap-1.5 pb-0.5 text-[11.5px] text-warn">
          <EyeOff strokeWidth={1.8} className="size-3.5 shrink-0" />
          <span className="truncate">这个模型看不到图片</span>
          {/* 运行中模型菜单是禁用的，「换一个」也先不给 */}
          {!running && <button type="button" className="shrink-0 font-medium text-fg-muted underline-offset-4 hover:text-fg hover:underline" onClick={onSwitchModel}>换一个</button>}
        </p>
      )}
    </>
  );
}

function ContextThumb({ id }: { id: string }) {
  const image = useAssistantImage(id);
  return image.data ? <Thumb image={image.data} width={240} blurBadge="none" className="size-full" /> : null;
}
