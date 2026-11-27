import type { AssistantPluginCard, PluginPackage } from '@emaki/shared';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/capabilities';
import { usePlugins } from '@/lib/plugins';
import { GrantBody, useGrant } from './InstallDialogs';

const major = (v: string) => Number.parseInt(v.split('.')[0] ?? '0', 10) || 0;

/**
 * AI 助手做好的页面等你保存（docs/plugins.md 5.1）：对话里的这张卡片就是授权单（同 GrantSheet 的内容）加「在侧栏显示」，
 * 点一次「保存」就存好、启用。存好以后（或者这一版已经在了）卡片变成「已保存 · 打开」；包一小时没存就作废，让助手再存一次。
 * 只有能装插件的入口（install-plugins，本机默认有）能存：AI 自己确认不了。
 */
export function PluginSaveCard({ card }: { card: AssistantPluginCard }) {
  const navigate = useNavigate();
  const canSave = useCan('install-plugins');
  const { state } = usePlugins();
  const current = state.plugins.find((p) => p.id === card.pluginId);
  const saved = !!current && major(current.version) >= major(card.version);
  const pkg = useQuery({
    queryKey: ['plugin-package', card.token],
    queryFn: () => api.pluginPackage(card.token!),
    enabled: !!card.token && !saved,
    retry: false,
    staleTime: Infinity,
  });
  return (
    <figure className="rounded-[var(--radius-md)] border border-line bg-raised px-4 py-3">
      <figcaption className="mb-3 flex items-baseline gap-2 text-[12px]">
        <span className="shrink-0 font-semibold text-fg">页面</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">
          「{card.name}」第 {major(card.version)} 版
        </span>
      </figcaption>
      {saved ? (
        <div className="flex items-center justify-between gap-3 text-[13px]">
          <span className="text-fg-muted">{current?.enabled ? '已保存' : '已保存（停用着）'}</span>
          <Button size="sm" variant="secondary" icon={<ExternalLink />} onClick={() => navigate(card.to)}>
            打开
          </Button>
        </div>
      ) : pkg.data ? (
        canSave ? (
          <SaveForm pkg={pkg.data} onSaved={() => navigate(card.to)} />
        ) : (
          <p className="text-[13px] text-fg-muted">这台设备不能保存插件，到电脑上的对话里保存。</p>
        )
      ) : pkg.error ? (
        <p className="text-[13px] text-fg-muted">
          {card.token ? '这一份已经作废了（准备好的页面一小时内有效），让助手再保存一次。' : '没有可保存的内容。'}
        </p>
      ) : (
        <div className="flex justify-center py-2 text-fg-subtle">
          <Spinner />
        </div>
      )}
    </figure>
  );
}

function SaveForm({ pkg, onSaved }: { pkg: PluginPackage; onSaved: () => void }) {
  const g = useGrant(pkg, onSaved, false);
  return (
    <div className="flex flex-col gap-3">
      <GrantBody pkg={pkg} g={g} />
      {!g.blocked && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="primary"
            loading={g.install.isPending}
            disabled={g.missingRoot}
            onClick={() => g.install.mutate(undefined)}
          >
            {g.action}
          </Button>
        </div>
      )}
    </div>
  );
}
