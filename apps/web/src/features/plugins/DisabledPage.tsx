import { BUILTIN_PLUGINS, pluginLabel } from '@emaki/shared';
import { Puzzle } from 'lucide-react';
import { useNavigate } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { Button, EmptyState } from '@/components/ui';
import { useCan } from '@/lib/capabilities';
import { usePlugins } from '@/lib/plugins';
import { api } from '@/lib/api';
import { useMutate } from '@/lib/queries';
import { PAGES, type PageId } from '@/pages';

/** 这一页属于哪个插件（内置插件登记了它拥有的页面） */
export const pluginOfPage = (page: string): string | undefined =>
  BUILTIN_PLUGINS.find((p) => p.contributes['page@1']?.some((x) => x.id === page))?.id;

/**
 * 直接打开停用的插件的页面时（docs/plugins.md 9.4）：页头照常，下面写这一页已停用，能改插件的直接「启用」，
 * 否则去「插件」页看。停用只影响界面，数据和后台照常，所以启用了立刻就是原来的样子。
 */
export function DisabledPage({ page }: { page: PageId }) {
  const navigate = useNavigate();
  const { state } = usePlugins();
  const can = useCan('plugins');
  const id = pluginOfPage(page);
  const plugin = state.plugins.find((p) => p.id === id);
  const name = plugin ? pluginLabel(plugin) : PAGES[page].title;
  const enable = useMutate((pid: string) => api.setPluginEnabled(pid, true));
  return (
    <>
      <PageHeader title={name} />
      <PageBody>
        <EmptyState
          glyph="停"
          title="这一页已停用"
          description={`「${name}」这个插件停用着：导航和入口都收起来了，图库里的数据、后台的识别照常。`}
          action={
            can && id ? (
              <Button variant="secondary" size="sm" icon={<Puzzle />} loading={enable.isPending} onClick={() => enable.mutate(id)}>
                启用
              </Button>
            ) : (
              <Button variant="secondary" size="sm" icon={<Puzzle />} onClick={() => navigate('/plugins')}>
                去插件页
              </Button>
            )
          }
        />
      </PageBody>
    </>
  );
}
