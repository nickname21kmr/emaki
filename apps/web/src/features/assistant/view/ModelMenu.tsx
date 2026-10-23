import { ChevronDown } from 'lucide-react';
import type { AssistantModel } from '@emaki/shared';
import { Dotted } from '@/components/overlays/palette/items';
import { Menu, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, Spinner, Tooltip } from '@/components/ui';
import { EFFORT_LABEL } from '../presentation';
import type { ConversationView } from '../useConversation';

export interface ModelMenuProps {
  conv: ConversationView;
  /** 受控：不识图提示里的「换一个」也能打开它 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// provider 是小写 id，分组标题写成品牌名；不认识的原样
const PROVIDER_LABEL: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek', google: 'Google', openrouter: 'OpenRouter', dsh: 'DSH', emaki: 'Emaki' };

/** 按 provider 分组，保持第一次出现的顺序 */
function byProvider(models: readonly AssistantModel[]) {
  const groups = new Map<string, AssistantModel[]>();
  for (const m of models) {
    const key = m.provider ?? '';
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups];
}

/** 模型和思考强度合成一个菜单（§11.5）。运行中禁用，悬停时说明这一轮结束后可以换 */
export function ModelMenu({ conv, open, onOpenChange }: ModelMenuProps) {
  const { models, model, effort, session, busy, sessionId } = conv;
  const running = session?.status === 'running' || session?.status === 'waiting';
  const list = models.data ?? [];
  const current = list.find(m => m.id === model);
  const groups = byProvider(list);
  // 全都能看图（或都不能）时「识图」不带信息，只在混着的时候标
  const markVision = list.some(m => m.vision) && list.some(m => !m.vision);
  // 页脚错误行已经用红字写了原因时，这里不再标红
  const label = models.isFetching && !models.data ? <><Spinner className="size-3" />读取模型…</>
    : models.error && !models.data ? <span className={conv.error ? 'text-danger' : undefined}>模型没读出来</span>
    : current ? <Dotted parts={[current.name, effort ? EFFORT_LABEL[effort] ?? effort : null]} />
    : '选择模型';
  return (
    <Tooltip content={running ? '这一轮结束后可以换' : null} side="top">
      {/* -ml-2.5：文字和上面的上下文行、placeholder 对齐，悬停底座往外伸 */}
      <span className="-ml-2.5 inline-flex max-w-[60%] min-w-0 @max-[380px]:max-w-[55%]">
        <Menu
          align="start"
          width={264}
          open={open}
          onOpenChange={onOpenChange}
          trigger={
            <button
              type="button"
              disabled={running || busy || !sessionId}
              className="inline-flex h-7 max-w-full min-w-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0"
            >
              <span className="flex min-w-0 items-center gap-1 truncate">{label}</span>
              <ChevronDown strokeWidth={1.8} />
            </button>
          }
        >
          <MenuLabel>模型</MenuLabel>
          <MenuRadioGroup value={model} onValueChange={conv.actions.pickModel}>
            {groups.map(([provider, items], i) => (
              <div key={provider}>
                {groups.length > 1 && i > 0 && <MenuSeparator />}
                {groups.length > 1 && provider && <MenuLabel>{PROVIDER_LABEL[provider.toLowerCase()] ?? provider}</MenuLabel>}
                {items.map(m => (
                  <MenuRadioItem key={m.id} value={m.id}>
                    <span className="flex w-full items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      {markVision && m.vision && <span className="rounded-full bg-sunken px-1.5 py-px text-[10px] font-medium text-fg-muted">识图</span>}
                    </span>
                  </MenuRadioItem>
                ))}
              </div>
            ))}
          </MenuRadioGroup>
          {!!current?.efforts.length && (
            <>
              <MenuSeparator />
              <MenuLabel>思考强度</MenuLabel>
              <MenuRadioGroup value={effort || 'default'} onValueChange={conv.actions.pickEffort}>
                <MenuRadioItem value="default">默认</MenuRadioItem>
                {current.efforts.map(e => <MenuRadioItem key={e} value={e}>{EFFORT_LABEL[e] ?? e}</MenuRadioItem>)}
              </MenuRadioGroup>
            </>
          )}
        </Menu>
      </span>
    </Tooltip>
  );
}
