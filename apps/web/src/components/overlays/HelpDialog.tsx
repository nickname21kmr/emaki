import { Emblem } from '@/components/ui/Emblem';
import { ArrowRight } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Dialog, Kbd } from '@/components/ui';
import { useOverlays } from '@/lib/stores';
import { PAGE_JUMPS, SHORTCUT_GROUPS, type ShortcutGroup, type ShortcutGroupId, type ShortcutItem } from './shortcuts';

/** 两列排版：按行数大致配平（左：全局 + 图库 + 重复；右：看图器 + 未识别） */
const COLUMNS: ShortcutGroupId[][] = [
  ['global', 'gallery', 'duplicates'],
  ['lightbox', 'unrecognized', 'reader'],
];

/**
 * 快捷键与帮助（? 打开）。
 * 快捷键清单来自 ./shortcuts.ts，和命令面板共用一份。
 */
export function HelpDialog() {
  const open = useOverlays((s) => s.helpOpen);
  const setOpen = useOverlays((s) => s.setHelpOpen);
  const navigate = useNavigate();

  const goto = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      width={780}
      title="快捷键与帮助"
      description="大多数整理操作都能只用键盘完成。焦点在输入框里时，单键快捷键不会触发。"
    >
      <div className="grid grid-cols-1 gap-x-12 gap-y-7 sm:grid-cols-2">
        {COLUMNS.map((column, i) => (
          <div key={i} className="flex flex-col gap-7">
            {column.map((id, row) => (
              <GroupBlock key={id} group={SHORTCUT_GROUPS[id]} delay={row * 70 + i * 35}>
                {id === 'global' && <PageJumps onJump={goto} />}
              </GroupBlock>
            ))}
          </div>
        ))}
      </div>

      <LocalNote onSettings={() => goto('/settings')} />
    </Dialog>
  );
}

/** 分组按阅读顺序依次淡入（delay 很短），只是让视线有个先后 */
function GroupBlock({ group, children, delay }: { group: ShortcutGroup; children?: ReactNode; delay: number }) {
  return (
    <section className="animate-fade-in" style={{ animationDelay: `${delay}ms` }}>
      <header className="mb-1.5 flex items-baseline gap-2">
        <h3 className="text-[13px] font-semibold tracking-tight text-fg">{group.title}</h3>
        <span className="text-[11.5px] text-fg-subtle">{group.hint}</span>
      </header>
      <ul>
        {group.items.map((item) => (
          <ShortcutRow key={item.label} item={item} />
        ))}
      </ul>
      {children}
    </section>
  );
}

/** 一行：名称 ····· 键帽。点线引导像目录页，眼睛能顺着找到右边的键 */
function ShortcutRow({ item }: { item: ShortcutItem }) {
  return (
    <li className="flex items-center gap-3 py-[7px]">
      <span className="shrink-0 text-[13px] text-fg-muted">{item.label}</span>
      <span aria-hidden className="h-0 min-w-4 flex-1 border-t border-dotted border-line-strong" />
      <span className="flex shrink-0 items-center gap-1.5">
        {item.keys.map((combo, i) => (
          <Fragment key={combo.join('+')}>
            {i > 0 && <span className="text-[11px] text-fg-subtle">/</span>}
            <span className="flex items-center gap-0.5">
              {combo.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </Fragment>
        ))}
      </span>
    </li>
  );
}

/** 数字键跳页：做成一排可点的小格子，顺便当导航用 */
function PageJumps({ onJump }: { onJump: (to: string) => void }) {
  return (
    <div className="mt-2">
      <div className="mb-2 text-[13px] text-fg-muted">跳转页面</div>
      <div className="grid grid-cols-5 gap-1.5">
        {PAGE_JUMPS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onJump(p.to)}
            className="group flex flex-col items-center gap-1.5 rounded-[10px] bg-sunken/60 py-2.5 transition-[background-color,transform] duration-200 hover:bg-hover active:scale-[0.97]"
          >
            <Kbd>{p.key}</Kbd>
            <span className="text-[11.5px] text-fg-muted transition-colors group-hover:text-fg">{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 底部的承诺：本地应用，图片不出门。朱印当落款 */
function LocalNote({ onSettings }: { onSettings: () => void }) {
  return (
    <div className="mt-8 flex items-center gap-4 rounded-[14px] bg-sunken/70 py-3.5 pr-3 pl-4">
      <Emblem size={36} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-fg">Emaki 是本地应用，图片不会上传到任何地方。</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">
          识别模型在本机运行；Danbooru 同步只下载标签资料，可以在设置里关掉。
        </p>
      </div>
      <button
        type="button"
        onClick={onSettings}
        className="flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        设置
        <ArrowRight className="size-3.5" />
      </button>
    </div>
  );
}
