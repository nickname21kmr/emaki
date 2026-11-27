import { OVERRIDE_KEYS, OVERRIDES, pluginLabel, type OverrideKey, type PluginInfo } from '@emaki/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Dialog, DialogFooter, Input, Segmented } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutate } from '@/lib/queries';

/** 改名：页面插件的导航项和页头标题跟着变（docs/plugins.md 9.6）；留空或「恢复原名」回到原名 */
export function RenameDialog({ plugin: p, open, onOpenChange }: { plugin: PluginInfo; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState(pluginLabel(p));
  useEffect(() => {
    if (open) setName(pluginLabel(p));
  }, [open, p]);
  const rename = useMutate((v: string | null) => api.renamePlugin(p.id, v), { onSuccess: () => onOpenChange(false) });
  const submit = () => rename.mutate(name.trim() && name.trim() !== p.name ? name.trim() : null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`给「${pluginLabel(p)}」改名`} description="页面的名字会同时改侧栏、手机底部标签栏和页头标题。" width={420}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input autoFocus value={name} maxLength={40} placeholder={p.name} onChange={(e) => setName(e.target.value)} />
        <DialogFooter>
          {p.displayName && (
            <Button type="button" variant="ghost" onClick={() => rename.mutate(null)} disabled={rename.isPending}>
              恢复原名「{p.name}」
            </Button>
          )}
          <Button type="submit" variant="primary" loading={rename.isPending}>
            保存
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** 删除「我的」插件、卸载装的插件：能撤销，删掉以后它覆盖的值回到原来的；装的插件的授权、存储一起删，它导入的图留着 */
export function RemoveDialog({ plugin: p, open, onOpenChange }: { plugin: PluginInfo; open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const remove = useMutate(() => api.removePlugin(p.id), {
    onSuccess: () => {
      onOpenChange(false);
      navigate('/plugins', { replace: true });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${p.source === 'installed' ? '卸载' : '删除'}「${pluginLabel(p)}」？`}
      description={
        p.source === 'installed'
          ? '它的授权和存的东西一起删掉，它改的东西回到原来的样子；它导入的图和改过的数据留着。可以撤销（Ctrl+Z）。'
          : '删掉以后它改的东西回到原来的样子。可以撤销（Ctrl+Z）。'
      }
      width={420}
    >
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(undefined)}>
          {p.source === 'installed' ? '卸载' : '删除'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * 新建覆盖（docs/plugins.md 9.5）：从能覆盖的值里选一项、选值、起名，建好就启用；停用它就回到原来的默认。
 * 现在能覆盖的只有几项，所以每项直接摆出来选。
 */
export function NewOverrideDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [key, setKey] = useState<OverrideKey>(OVERRIDE_KEYS[0]!);
  const def = OVERRIDES[key];
  const firstOther = def.options.find((o) => o.value !== def.default)?.value ?? def.default;
  const [value, setValue] = useState<string>(firstOther);
  const [name, setName] = useState('');
  useEffect(() => {
    if (!open) return;
    setValue(firstOther);
    setName('');
  }, [open, key, firstOther]);
  const label = def.options.find((o) => o.value === value)?.label ?? value;
  const suggested = `${def.label}：${label}`;
  const create = useMutate((body: { name: string; values: Record<string, string> }) => api.createOverride(body), {
    onSuccess: (r) => {
      onOpenChange(false);
      navigate(`/plugins/${encodeURIComponent(r.id)}`);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="新建覆盖"
      description="覆盖是只含设置的插件：启用就生效，停用就回到原来的默认。也可以直接跟 AI 助手说「默认按修改时间排」。"
      width={520}
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ name: name.trim() || suggested, values: { [key]: value } });
        }}
      >
        {OVERRIDE_KEYS.length > 1 && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">改哪一项</span>
            <Segmented value={key} onChange={setKey} options={OVERRIDE_KEYS.map((k) => ({ value: k, label: OVERRIDES[k].label }))} />
          </label>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">{def.label}</span>
          <p className="text-[12.5px] leading-relaxed text-fg-muted">{def.hint}</p>
          <Segmented
            value={value}
            onChange={setValue}
            options={def.options.map((o) => ({ value: o.value, label: o.value === def.default ? `${o.label}（原来的）` : o.label }))}
          />
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">名字</span>
          <Input value={name} maxLength={40} placeholder={suggested} onChange={(e) => setName(e.target.value)} />
        </label>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={value === def.default}>
            新建并启用
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
