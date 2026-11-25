import { pluginLabel, type PluginView } from '@emaki/shared';
import { Puzzle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { Button, EmptyState, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/capabilities';
import { usePlugins } from '@/lib/plugins';
import { errorMessage, useMutate } from '@/lib/queries';
import { ViewFrame } from './ViewFrame';

/**
 * 插件自己画的一页（/p/:plugin/:page，docs/plugins.md 第 5 节）：页头和别的页面一样，下面整块是插件的视图（ViewFrame）。
 * 标题按你改的名字（9.6）；停用了显示「这一页已停用」和「启用」，和内置的页面停用时一样（9.4）。
 */
export function PluginViewPage() {
  const { plugin = '', page = '' } = useParams();
  const navigate = useNavigate();
  const { state, ready } = usePlugins();
  const can = useCan('plugins');
  const enable = useMutate((id: string) => api.setPluginEnabled(id, true));
  const info = state.plugins.find((p) => p.id === plugin);
  const enabled = !!info?.enabled;
  const view = useView(plugin, page, enabled ? `${info?.version}|${info?.displayName ?? ''}` : null);
  const name = info ? pluginLabel(info) : '插件';

  if (!ready) return <PageHeader title="插件" />;
  if (!info || (enabled && view.error && !view.data))
    return (
      <>
        <PageHeader title={name} />
        <PageBody>
          <EmptyState
            glyph="无"
            title={info ? '这一页打不开' : '没有这个插件'}
            description={info ? errorMessage(view.error) : `「${plugin}」不在了：可能已经删掉或卸载了。`}
            action={
              <Button variant="secondary" size="sm" icon={<Puzzle />} onClick={() => navigate('/plugins')}>
                去插件页
              </Button>
            }
          />
        </PageBody>
      </>
    );
  if (!enabled)
    return (
      <>
        <PageHeader title={name} />
        <PageBody>
          <EmptyState
            glyph="停"
            title="这一页已停用"
            description={info.disabledReason ?? `「${name}」这个插件停用着。`}
            action={
              can && !info.problems.length ? (
                <Button variant="secondary" size="sm" icon={<Puzzle />} loading={enable.isPending} onClick={() => enable.mutate(info.id)}>
                  启用
                </Button>
              ) : (
                <Button variant="secondary" size="sm" icon={<Puzzle />} onClick={() => navigate(`/plugins/${encodeURIComponent(info.id)}`)}>
                  去插件页
                </Button>
              )
            }
          />
        </PageBody>
      </>
    );
  return (
    <div className="flex h-full flex-col">
      <PageHeader title={view.data?.title ?? name} />
      <div className="min-h-0 flex-1 px-8 pb-6 narrow:px-5 compact:px-4 compact:pb-4">
        {view.data ? (
          <ViewFrame view={view.data} label={view.data.title} />
        ) : (
          <div className="flex h-full items-center justify-center text-fg-subtle">
            <Spinner />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 取一页视图。不放进查询缓存：图库一变网页会让缓存整个重取，重取一次就是重新发图片令牌、重新载入 iframe（视图里的状态全丢）。
 * 只在插件的版本、改的名字变了时重取（HTML、标题、授权都可能变）；key 为 null 是停用着，不取
 */
function useView(plugin: string, page: string, key: string | null): { data: PluginView | null; error: unknown } {
  const [s, set] = useState<{ for: string; data: PluginView | null; error: unknown }>({ for: '', data: null, error: null });
  const want = key === null ? null : `${plugin}/${page}|${key}`;
  useEffect(() => {
    if (want === null) return;
    let alive = true;
    api.pluginView(plugin, page).then(
      (data) => alive && set({ for: want, data, error: null }),
      (error: unknown) => alive && set({ for: want, data: null, error }),
    );
    return () => {
      alive = false;
    };
  }, [want, plugin, page]);
  return s.for === want ? s : { data: null, error: null };
}
