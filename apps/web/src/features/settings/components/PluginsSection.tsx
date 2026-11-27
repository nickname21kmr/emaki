import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { Field, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/capabilities';
import { usePlugins } from '@/lib/plugins';
import { useMutate } from '@/lib/queries';
import { SettingsCard, SettingsSection } from './SettingsSection';

/**
 * 设置 →「插件」（docs/plugins.md 9.7）：只放最基本的——「插件」页在不在侧栏，和去插件页的链接。
 * 插件可能很多，启用、停用、改名、删除、页面顺序都在插件页里，不塞进设置。
 */
export function PluginsSection() {
  const { state } = usePlugins();
  const can = useCan('plugins') && !state.safeMode;
  const entry = Object.values(state.nav)
    .flat()
    .find((n) => n.id === 'plugins');
  const save = useMutate((v: boolean) => api.setNav({ visible: { plugins: v } }));
  const off = state.plugins.filter((p) => !p.enabled).length;
  return (
    <SettingsSection
      id="plugins"
      description="原来的每一页都是一个插件，可以停用、改名、调整在侧栏里的顺序；改默认值的「覆盖」、AI 助手做的页面也在这里管。"
      actions={
        <Link to="/plugins" className="inline-flex items-center gap-1 text-[13px] font-medium text-fg hover:underline">
          管理插件 <ArrowRight className="size-3.5" />
        </Link>
      }
    >
      <SettingsCard>
        <Field label="在侧栏显示「插件」" hint={`${state.plugins.length} 个插件${off ? `，${off} 个停用` : ''}。关着也能从这里或命令面板进插件页。`}>
          <Switch
            checked={!!entry?.visible}
            disabled={!can || !entry || save.isPending}
            onCheckedChange={(v) => save.mutate(v)}
            label="在侧栏显示「插件」"
          />
        </Field>
      </SettingsCard>
    </SettingsSection>
  );
}
