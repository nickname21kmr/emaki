import type { TaggerModelInfo } from '@emaki/shared';
import { Check, ChevronDown } from 'lucide-react';
import { DropdownMenu as M } from 'radix-ui';
import { Badge, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount } from '@/lib/format';
import { useTaggerModels } from '@/lib/queries';

/** 模型的一行说明：能认多少角色、数据到哪年、多大 */
const meta = (m: TaggerModelInfo) =>
  [
    m.characterCount > 0 && `${formatCount(m.characterCount)} 个角色`,
    m.dataUntil && `数据到 ${m.dataUntil.replace('-', ' 年 ')} 月`,
    m.downloaded ? '已下载' : `需下载 ${formatBytes(m.sizeBytes)}`,
  ]
    .filter(Boolean)
    .join(' · ');

// 后端的 label 带括号备注（「默认」「角色截至…」），这里已经有标记和说明行，去掉
const name = (m: TaggerModelInfo) => m.label.replace(/（[^）]*）$/, '');

/** 识别模型下拉框：每项两行，第一行名字 + 标记，第二行说明 */
export function ModelPicker({ value, onChange }: { value: string; onChange: (repo: string) => void }) {
  const { data: models, isLoading } = useTaggerModels();
  const current = models?.find((m) => m.repo === value);

  if (isLoading) return <Spinner />;
  // 列表拿不到（例如后端旧版本）时退回只读显示
  if (!models?.length) {
    return <code className="block max-w-72 truncate rounded-md bg-sunken px-2.5 py-1.5 font-mono text-xs text-fg-muted">{value}</code>;
  }

  return (
    <M.Root>
      <M.Trigger asChild>
        <button
          type="button"
          className="flex h-9 w-72 items-center gap-2 rounded-md bg-sunken px-3 text-left text-[13px] ring-1 ring-line outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-shu data-[state=open]:bg-hover"
        >
          <span className="flex-1 truncate">{current ? name(current) : value}</span>
          {current?.isDefault && <Badge tone="shu">默认</Badge>}
          <ChevronDown className="size-4 shrink-0 text-fg-muted" />
        </button>
      </M.Trigger>
      <M.Portal>
        <M.Content
          align="end"
          sideOffset={6}
          className="z-[60] max-h-[min(520px,var(--radix-dropdown-menu-content-available-height))] w-[400px] overflow-y-auto rounded-lg bg-raised p-1.5 shadow-pop ring-1 ring-line scrollbar-thin data-[state=open]:animate-rise"
        >
          <M.RadioGroup value={value} onValueChange={onChange}>
            {models.map((m) => (
              <M.RadioItem
                key={m.repo}
                value={m.repo}
                className={cn(
                  'relative cursor-default rounded-sm py-2 pr-8 pl-2.5 outline-none select-none data-[highlighted]:bg-hover',
                )}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  <span className="truncate">{name(m)}</span>
                  {m.isDefault && <Badge tone="shu">默认</Badge>}
                  <Badge>{m.gpu === 'webgpu' ? 'WebGPU' : 'DirectML'}</Badge>
                </div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">
                  {m.note && <div>{m.note}</div>}
                  <div className={cn('tabular', !m.downloaded && 'text-fg-subtle')}>{meta(m)}</div>
                </div>
                <M.ItemIndicator className="absolute top-2.5 right-2.5">
                  <Check className="size-4 text-shu" />
                </M.ItemIndicator>
              </M.RadioItem>
            ))}
          </M.RadioGroup>
          <div className="mx-2.5 mt-1 border-t border-line pt-2 pb-1 text-[11.5px] leading-relaxed text-fg-subtle">
            没下载的模型会在下次识别时自动下载。换模型后再运行识别，之前没认出角色的图会用新模型再认一遍，已经认出的不动。
          </div>
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
