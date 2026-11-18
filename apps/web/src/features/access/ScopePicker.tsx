import { DEVICE_DEFAULT_SCOPES, type Scope } from '@emaki/shared';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import { EXTRA_SCOPES, scopeText, sortScopes } from './format';

/**
 * 勾选设备的权限（docs/mobile.md 2.5）：上面是默认给的，下面是要你另外勾的；说明来自 shared 的 SCOPES。
 * 管理设备、在电脑屏幕上弹窗这两项永远不给，不列出来。墨色勾（不用朱，朱只做印）
 */
export function ScopePicker({ value, onChange }: { value: readonly Scope[]; onChange: (next: Scope[]) => void }) {
  const set = new Set(value);
  const toggle = (s: Scope) => {
    const next = new Set(set);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    onChange(sortScopes(next));
  };
  return (
    <div className="space-y-3">
      <ScopeGroup title="默认给的" scopes={DEVICE_DEFAULT_SCOPES} checked={set} onToggle={toggle} />
      <ScopeGroup title="默认不给（会动文件、改设置、整库批量改）" scopes={EXTRA_SCOPES} checked={set} onToggle={toggle} />
    </div>
  );
}

function ScopeGroup({
  title,
  scopes,
  checked,
  onToggle,
}: {
  title: string;
  scopes: readonly Scope[];
  checked: ReadonlySet<Scope>;
  onToggle: (s: Scope) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1 text-[12px] font-medium text-fg-subtle">{title}</legend>
      <ul className="-mx-2 grid gap-x-2 sm:grid-cols-2">
        {scopes.map((s) => {
          const on = checked.has(s);
          const { head, detail } = scopeText(s);
          return (
            <li key={s}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => onToggle(s)}
                className="flex w-full items-start gap-2.5 rounded-[8px] px-2 py-1.5 text-left hover:bg-hover"
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px]',
                    on ? 'bg-ink text-fg-inverse' : 'text-transparent ring-1 ring-line-strong ring-inset',
                  )}
                >
                  <Check className="size-3" strokeWidth={2.5} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-5">{head}</span>
                  {detail && <span className="block text-[11.5px] leading-4 text-fg-subtle">{detail}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
