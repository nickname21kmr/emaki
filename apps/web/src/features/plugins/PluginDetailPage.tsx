import { OVERRIDES, pluginLabel, type OverrideKey, type PluginInfo } from '@emaki/shared';
import { PencilLine, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { PageBody } from '@/components/layout/PageHeader';
import { DetailHeader } from '@/features/characters/detail/DetailHeader';
import { Badge, Button, EmptyState, SectionTitle, Segmented, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/capabilities';
import { usePlugins } from '@/lib/plugins';
import { useMutate } from '@/lib/queries';
import { PAGES, type PageId } from '@/pages';
import { RemoveDialog, RenameDialog } from './PluginDialogs';
import { KIND_LABEL, useEnablePlugin } from './PluginsPage';

/**
 * 一个插件的详情（docs/plugins.md 9.7）：它贡献了什么（按贡献点列出）、覆盖的值（我的可以改）、冲突时用哪个、
 * 启用、改名、删除。以后装的插件在这里看授权、版本和出错记录（E2）。
 */
const SOURCE_PHRASE = { builtin: '内置的插件', mine: '你自己建的插件', installed: '装上的插件' } as const;

export function PluginDetailPage() {
  const { id = '' } = useParams();
  const { state, ready } = usePlugins();
  const p = state.plugins.find((x) => x.id === id);
  const can = useCan('plugins') && !state.safeMode;
  const enable = useEnablePlugin();
  const [dialog, setDialog] = useState<'rename' | 'remove' | null>(null);

  if (!p)
    return (
      <>
        <DetailHeader crumbs={[{ label: '插件', to: '/plugins' }]} current="没有这个插件" />
        <PageBody>
          {ready && (
            <EmptyState
              glyph="无"
              title="没有这个插件"
              description="可能已经删掉了。"
              action={
                <Link to="/plugins" className="text-[13px] font-medium hover:underline">
                  回到插件页
                </Link>
              }
            />
          )}
        </PageBody>
      </>
    );

  const label = pluginLabel(p);
  return (
    <>
      <DetailHeader
        crumbs={[{ label: '插件', to: '/plugins' }]}
        current={label}
        actions={
          <>
            {can && (
              <Button variant="ghost" size="sm" icon={<PencilLine />} onClick={() => setDialog('rename')}>
                改名
              </Button>
            )}
            {can && p.source !== 'builtin' && (
              <Button variant="ghost" size="sm" icon={<Trash2 />} onClick={() => setDialog('remove')}>
                删除
              </Button>
            )}
          </>
        }
      />
      <PageBody className="flex max-w-[760px] flex-col gap-8">
        <p className="text-[13px] leading-relaxed text-fg-muted">
          {SOURCE_PHRASE[p.source]}{p.displayName ? `，原名「${p.name}」` : ''}。{p.description ?? ''}
        </p>
        <div className="flex items-center gap-3 rounded-lg bg-raised px-4 py-3 ring-1 ring-line">
          <div className="min-w-0 flex-1 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.enabled ? '启用中' : '已停用'}</span>
              {p.kinds.map((k) => (
                <Badge key={k}>{KIND_LABEL[k]}</Badge>
              ))}
              {p.required && <Badge>必需</Badge>}
            </div>
            <p className="mt-0.5 text-fg-muted">
              {p.required
                ? '必需的插件不能停用。'
                : p.kinds.includes('page')
                  ? '停用以后这些页面和通往它们的入口都收起来；图库里的数据、后台的识别照常。'
                  : '停用以后它改的值回到原来的默认。'}
            </p>
          </div>
          <Switch
            checked={p.enabled}
            disabled={!can || p.required || enable.isPending}
            onCheckedChange={(v) => enable.mutate({ id: p.id, enabled: v })}
            label={`${p.enabled ? '停用' : '启用'}「${label}」`}
          />
        </div>
        <Contributions plugin={p} can={can} />
      </PageBody>
      <RenameDialog plugin={p} open={dialog === 'rename'} onOpenChange={(o) => !o && setDialog(null)} />
      <RemoveDialog plugin={p} open={dialog === 'remove'} onOpenChange={(o) => !o && setDialog(null)} />
    </>
  );
}

function Contributions({ plugin: p, can }: { plugin: PluginInfo; can: boolean }) {
  const pages = p.contributes['page@1'] ?? [];
  const navs = p.contributes['nav.item@1'] ?? [];
  const blocks = p.contributes['block@1'] ?? [];
  const overrides = Object.entries(p.contributes['override@1'] ?? {}) as [OverrideKey, string][];
  return (
    <>
      {pages.length > 0 && (
        <section>
          <SectionTitle numbered={false} hint="停用时一起收起">
            页面
          </SectionTitle>
          <ul className="flex flex-wrap gap-2 text-[13px]">
            {pages.map((x) => (
              <li key={x.id} className="rounded-md bg-sunken px-2.5 py-1">
                {PAGES[x.id as PageId]?.title ?? x.id}
                <span className="ml-1.5 font-mono text-[11.5px] text-fg-subtle">{PAGES[x.id as PageId]?.path}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {navs.length > 0 && (
        <section>
          <SectionTitle numbered={false} hint={<Link to="/plugins?view=pages">调整页面顺序 →</Link>}>
            侧栏
          </SectionTitle>
          <ul className="flex flex-wrap gap-2 text-[13px]">
            {navs.map((n) => (
              <li key={n.id} className="rounded-md bg-sunken px-2.5 py-1">
                {n.label}
                {n.hiddenByDefault && <span className="ml-1.5 text-fg-subtle">默认不在侧栏</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {blocks.length > 0 && (
        <section>
          <SectionTitle numbered={false} hint="放在别的页面里，停用时一起收起">
            区块
          </SectionTitle>
          <ul className="flex flex-wrap gap-2 font-mono text-[12px]">
            {blocks.map((b) => (
              <li key={b.id} className="rounded-md bg-sunken px-2.5 py-1">
                {b.id}
              </li>
            ))}
          </ul>
        </section>
      )}
      {overrides.length > 0 && (
        <section className="flex flex-col gap-4">
          <SectionTitle numbered={false}>覆盖的值</SectionTitle>
          {overrides.map(([k, v]) => (
            <OverrideValue key={k} plugin={p} k={k} value={v} can={can} />
          ))}
        </section>
      )}
    </>
  );
}

function OverrideValue({ plugin: p, k, value, can }: { plugin: PluginInfo; k: OverrideKey; value: string; can: boolean }) {
  const { state } = usePlugins();
  const def = OVERRIDES[k];
  const cur = state.overrides[k];
  const editable = can && p.source === 'mine';
  const set = useMutate((v: string) => api.setOverrideValues(p.id, { ...(p.contributes['override@1'] as Record<string, string>), [k]: v }));
  const choose = useMutate((plugin: string | null) => api.chooseOverride(k, plugin));
  const others = cur.candidates.filter((c) => c !== p.id);
  const winning = cur.plugin === p.id;
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-raised px-4 py-3 ring-1 ring-line">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium">{def?.label ?? k}</span>
        {p.enabled && (
          <span className="text-[12px] text-fg-muted">{winning ? '现在生效的就是这个值' : others.length ? '被别的插件压过了' : ''}</span>
        )}
      </div>
      {def && (
        <Segmented
          value={value}
          onChange={(v) => editable && v !== value && set.mutate(v)}
          options={def.options.map((o) => ({
            value: o.value,
            label: o.value === def.default ? `${o.label}（原来的）` : o.label,
            disabled: !editable && o.value !== value,
          }))}
        />
      )}
      {p.enabled && others.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-fg-muted">
          <Badge tone="warn">冲突</Badge>
          <span>
            {others.map((o) => `「${pluginLabel(state.plugins.find((x) => x.id === o) ?? { name: o, displayName: null })}」`).join('、')}也改了这一项。
          </span>
          {can && !winning && (
            <Button variant="secondary" size="sm" onClick={() => choose.mutate(p.id)}>
              改用这个
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
