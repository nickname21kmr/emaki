import { pluginLabel, type PluginView } from '@emaki/shared';
import { ExternalLink, Puzzle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { Button, EmptyState, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/capabilities';
import { appBridge } from '@/lib/deviceAuth';
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
  // 页面对应的网站（site@1），App 能打开时才算
  const siteId = info?.contributes['page@1']?.find((p) => p.id === page)?.site;
  const bridge = appBridge();
  const site = enabled && siteId && bridge?.openSite ? info?.contributes['site@1']?.find((x) => x.id === siteId) : undefined;
  const [showView, setShowView] = useState(false);
  const openSite = () => site && bridge?.openSite?.(info!.id, site.id);
  // 进这一页就打开一次（从网站返回时不再自动打开）
  useEffect(() => {
    if (site) bridge?.openSite?.(plugin, site.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin, site?.id]);

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
  // 这一页对应插件的一个外部网站，又在 App 里（能直接打开网站、加上插件的按钮）：打开网站本身
  if (site && !showView)
    return (
      <>
        <PageHeader title={view.data?.title ?? name} />
        <PageBody>
          <EmptyState
            glyph="站"
            title={`${site.title} 在 App 里打开了`}
            description={`在 ${site.title} 的页面上选作品，点底部的「下载到 Emaki」；按返回键回到这里。`}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" size="sm" icon={<ExternalLink />} onClick={openSite}>
                  再打开 {site.title}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowView(true)}>
                  用 Emaki 里的浏览页
                </Button>
              </div>
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
