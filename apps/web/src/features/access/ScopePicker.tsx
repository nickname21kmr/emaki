import { DEVICE_DEFAULT_SCOPES, type Scope } from '@emaki/shared';
import { DANGER_SCOPES, EXTRA_SCOPES, scopeText, sortScopes } from './format';
import { GrantList } from './GrantList';

/**
 * 设备的权限（docs/mobile.md 2.5）：和装插件的授权单同一种样子（GrantList，docs/plugins.md 4.2「一张授权单」），每一项一个开关；
 * 上面是默认给的，下面是要你另外打开的；说明来自 shared 的 SCOPES，会动文件、改规则和设置的朱色标出。
 * 管理设备、在电脑屏幕上弹窗这两项永远不给，不列出来
 */
export function ScopePicker({ value, onChange }: { value: readonly Scope[]; onChange: (next: Scope[]) => void }) {
  const set = new Set(value);
  const toggle = (s: Scope, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(s);
    else next.delete(s);
    onChange(sortScopes(next));
  };
  const items = (scopes: readonly Scope[]) =>
    scopes.map((s) => {
      const { head, detail } = scopeText(s);
      return {
        key: s,
        text: head,
        detail,
        danger: DANGER_SCOPES.includes(s),
        checked: set.has(s),
        onCheckedChange: (on: boolean) => toggle(s, on),
        label: head,
      };
    });
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1.5 text-[12px] font-medium text-fg-subtle">默认给的</legend>
        <GrantList items={items(DEVICE_DEFAULT_SCOPES)} />
      </fieldset>
      <fieldset>
        <legend className="mb-1.5 text-[12px] font-medium text-fg-subtle">默认不给（会动文件、改设置、整库批量改）</legend>
        <GrantList items={items(EXTRA_SCOPES)} />
      </fieldset>
    </div>
  );
}
