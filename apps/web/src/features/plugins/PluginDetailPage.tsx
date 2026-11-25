import { OVERRIDES, pluginLabel, pluginPagePath, type LibraryRoot, type OverrideKey, type PluginInfo } from '@emaki/shared';
import { PencilLine, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { PageBody } from '@/components/layout/PageHeader';
import { DetailHeader } from '@/features/characters/detail/DetailHeader';
import { Badge, Button, EmptyState, Input, SectionTitle, Segmented, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/capabilities';
import { cn } from '@/lib/cn';
import { usePlugins } from '@/lib/plugins';
import { useMutate, useSettings } from '@/lib/queries';
import { PAGES, type PageId } from '@/pages';
import { displayPath } from '@/features/access/UploadTarget';
import { grantAsPermissions, permissionLines, riskLine, SOURCE_TEXT } from './grantText';
import { GrantRow } from './InstallDialogs';
import { RemoveDialog, RenameDialog } from './PluginDialogs';
import { KIND_LABEL, useEnablePlugin } from './PluginsPage';
import { UpdateCheck, useCheckUpdate } from './UpdateCheck';
import { Slot } from '@/blocks/Slot';

/**
 * 一个插件的详情（docs/plugins.md 9.7）：它贡献了什么（按贡献点列出）、覆盖的值（我的可以改）、冲突时用哪个、
 * 启用、改名、删除。装的插件另外有：从哪装的、版本和更新、授权（和授权单同一套说法）、不能启用的原因、出错记录。
 */
const SOURCE_PHRASE = { builtin: '内置的插件', mine: '你自己建的插件', installed: '装上的插件' } as const;

export function PluginDetailPage() {
  const { id = '' } = useParams();
  const { state, ready } = usePlugins();
  const p = state.plugins.find((x) => x.id === id);
  const can = useCan('plugins') && !state.safeMode;
  const enable = useEnablePlugin();
  const [dialog, setDialog] = useState<'rename' | 'remove' | null>(null);
  const update = useCheckUpdate(p ?? FALLBACK);

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
          <Slot
            id="page.plugin"
            render={{
              'plugin.rename': () =>
                can && (
                  <Button variant="ghost" size="sm" icon={<PencilLine />} onClick={() => setDialog('rename')}>
                    改名
                  </Button>
                ),
              'plugin.update': () =>
                update.available && (
                  <Button variant="ghost" size="sm" icon={<RefreshCw />} loading={update.pending} onClick={update.start}>
                    {update.label.replace('…', '')}
                  </Button>
                ),
              'plugin.remove': () =>
                can &&
                p.source !== 'builtin' && (
                  <Button variant="ghost" size="sm" icon={<Trash2 />} onClick={() => setDialog('remove')}>
                    {p.source === 'installed' ? '卸载' : '删除'}
                  </Button>
                ),
            }}
          />
        }
      />
      <PageBody className="flex max-w-[760px] flex-col gap-8">
        <p className="text-[13px] leading-relaxed text-fg-muted">
          {p.installed?.kind === 'ai' ? 'AI 助手做的页面' : SOURCE_PHRASE[p.source]}
          {p.installed?.kind === 'ai' && `，第 ${p.version.split('.')[0]} 版`}
          {p.installed && p.installed.kind !== 'ai' && `，版本 ${p.version}${p.installed.ref ? `（${p.installed.ref}）` : ''}，来自${SOURCE_TEXT[p.installed.kind]} `}
          {p.installed && p.installed.kind !== 'ai' && <span className="font-mono text-[12px] text-fg">{p.installed.location}</span>}
          {p.displayName ? `，原名「${p.name}」` : ''}。{p.description ?? ''}
        </p>
        {(p.problems.length > 0 || p.disabledReason) && (
          <div className="flex items-start gap-3 rounded-lg bg-warn-soft px-4 py-3 text-[13px] leading-relaxed">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
            <div className="flex-1">
              {p.problems.length > 0 ? (
                <>
                  <p className="font-medium">不能启用：</p>
                  <ul className="list-disc pl-5">
                    {p.problems.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>{p.disabledReason}</p>
              )}
            </div>
          </div>
        )}
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
                : p.kinds.includes('feature')
                  ? '停用以后它的页面、入口和在电脑上运行的程序一起停下；已经放进图库的图留着。'
                  : p.kinds.includes('page')
                    ? '停用以后这些页面和通往它们的入口都收起来；图库里的数据、后台的识别照常。'
                  : '停用以后它改的值回到原来的默认。'}
            </p>
          </div>
          <Switch
            checked={p.enabled}
            disabled={!can || p.required || enable.isPending || (!p.enabled && p.problems.length > 0)}
            onCheckedChange={(v) => enable.mutate({ id: p.id, enabled: v })}
            label={`${p.enabled ? '停用' : '启用'}「${label}」`}
          />
        </div>
        <Contributions plugin={p} can={can} />
        {!!p.contributes['setting@1']?.length && <SettingsSection plugin={p} />}
        {p.installed && <GrantSection plugin={p} />}
        {!!p.errors?.length && <ErrorsSection plugin={p} />}
      </PageBody>
      <RenameDialog plugin={p} open={dialog === 'rename'} onOpenChange={(o) => !o && setDialog(null)} />
      <RemoveDialog plugin={p} open={dialog === 'remove'} onOpenChange={(o) => !o && setDialog(null)} />
      <UpdateCheck state={update} />
    </>
  );
}

/** 没找到插件时给 useCheckUpdate 的占位（hook 不能条件调用） */
const FALLBACK: PluginInfo = {
  id: '',
  name: '',
  displayName: null,
  source: 'builtin',
  version: '',
  enabled: false,
  required: false,
  kinds: [],
  contributes: {},
  conflicts: [],
  problems: [],
};

/** 授权：装的时候在授权单上确认过的，用同一套说法；文件夹写出实际位置 */
function GrantSection({ plugin: p }: { plugin: PluginInfo }) {
  const roots: LibraryRoot[] = useSettings().data?.libraryRoots ?? [];
  const granted = grantAsPermissions(p.grant!, p.permissions);
  const lines = permissionLines(granted);
  const risk = riskLine(granted);
  return (
    <section>
      <SectionTitle numbered={false} hint="装的时候在授权单上确认的">
        授权
      </SectionTitle>
      {lines.length === 0 ? (
        <p className="text-[13px] text-fg-muted">没有要任何权限：它只有配置，不读也不改你的图库，不联网。</p>
      ) : (
        <ul className="flex flex-col gap-2.5 text-[13px] leading-relaxed">
          {lines.map((l) => {
            const f = l.folder && p.grant!.folders.find((x) => x.id === l.folder!.id);
            const root = f && roots.find((r) => r.id === String(f.rootId));
            return (
              <GrantRow
                key={l.key}
                line={f ? { ...l, folder: undefined, text: `把文件放进 ${root ? displayPath(root.path, f.dir) : f.dir}` } : l}
              />
            );
          })}
        </ul>
      )}
      {risk && <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{risk}</p>}
    </section>
  );
}

/**
 * 插件的设置（setting@1，docs/plugins.md 第 6 节）：宿主统一画。凭证（secret）只写不读：填过的只显示「已填写」，
 * 留空不改，可以清掉；只有插件在电脑上运行的程序读得到，它的页面读不到
 */
function SettingsSection({ plugin: p }: { plugin: PluginInfo }) {
  const can = useCan('install-plugins');
  const declared = p.contributes['setting@1'] ?? [];
  const current = new Map((p.settings ?? []).map((s) => [s.id, s]));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useMutate((values: Record<string, string | null>) => api.setPluginSettings(p.id, values), {
    onSuccess: () => setDraft({}),
  });
  // 凭证留空是不改（清掉用「清掉」）
  const values = Object.fromEntries(Object.entries(draft).filter(([k, v]) => v !== '' || declared.find((d) => d.id === k)?.type !== 'secret'));
  const changed = Object.keys(values).length > 0;
  return (
    <section>
      <SectionTitle numbered={false} hint="只有它在电脑上运行的程序读得到；登录凭证这类只写不读">
        设置
      </SectionTitle>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) save.mutate(values);
        }}
      >
        {declared.map((s) => {
          const now = current.get(s.id);
          const secret = s.type === 'secret';
          const value = draft[s.id] ?? (secret ? '' : (now?.value ?? ''));
          return (
            <div key={s.id} className="flex flex-col gap-1">
              <label htmlFor={`setting-${s.id}`} className="flex items-baseline gap-2 text-[13px] font-medium">
                {s.label}
                {secret && <span className="text-[12px] font-normal text-fg-subtle">{now?.filled ? '已填写' : '没填'}</span>}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id={`setting-${s.id}`}
                  type={secret ? 'password' : 'text'}
                  autoComplete="off"
                  className="flex-1"
                  disabled={!can}
                  value={value}
                  placeholder={secret && now?.filled ? '已填写，留空不改' : undefined}
                  onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                />
                {secret && now?.filled && can && (
                  <Button type="button" variant="ghost" size="sm" loading={save.isPending} onClick={() => save.mutate({ [s.id]: null })}>
                    清掉
                  </Button>
                )}
              </div>
              {s.hint && <p className="text-[12px] text-fg-muted">{s.hint}</p>}
            </div>
          );
        })}
        {can && (
          <div>
            <Button type="submit" variant="secondary" size="sm" disabled={!changed} loading={save.isPending}>
              保存设置
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}

function ErrorsSection({ plugin: p }: { plugin: PluginInfo }) {
  return (
    <section>
      <SectionTitle numbered={false} hint="最近 5 次">
        出错记录
      </SectionTitle>
      <ul className="divide-y divide-line rounded-lg bg-raised text-[12.5px] ring-1 ring-line">
        {p.errors!.map((e, i) => (
          <li key={i} className="flex gap-3 px-4 py-2">
            <span className="shrink-0 font-mono text-fg-subtle">{new Date(e.at).toLocaleString()}</span>
            <span className="shrink-0 text-fg-muted">{e.source}</span>
            <span className="min-w-0 flex-1 break-words">{e.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Contributions({ plugin: p, can }: { plugin: PluginInfo; can: boolean }) {
  const pages = p.contributes['page@1'] ?? [];
  const navs = p.contributes['nav.item@1'] ?? [];
  const blocks = p.contributes['block@1'] ?? [];
  const overrides = Object.entries(p.contributes['override@1'] ?? {}) as [OverrideKey, string][];
  const commands = p.contributes['command@1'] ?? [];
  const jobs = p.contributes['job.kind@1'] ?? [];
  return (
    <>
      {pages.length > 0 && (
        <section>
          <SectionTitle numbered={false} hint="停用时一起收起">
            页面
          </SectionTitle>
          <ul className="flex flex-wrap gap-2 text-[13px]">
            {pages.map((x) =>
              x.view ? (
                // 插件自己画的页面（视图）：能打开
                <li key={x.id}>
                  <Link
                    to={pluginPagePath(p.id, x.id)}
                    aria-disabled={!p.enabled}
                    className={cn('inline-block rounded-md bg-sunken px-2.5 py-1 hover:bg-hover', !p.enabled && 'pointer-events-none opacity-60')}
                  >
                    {x.title ?? pluginLabel(p)}
                    <span className="ml-1.5 font-mono text-[11.5px] text-fg-subtle">{pluginPagePath(p.id, x.id)}</span>
                  </Link>
                </li>
              ) : (
                <li key={x.id} className="rounded-md bg-sunken px-2.5 py-1">
                  {PAGES[x.id as PageId]?.title ?? x.id}
                  <span className="ml-1.5 font-mono text-[11.5px] text-fg-subtle">{PAGES[x.id as PageId]?.path}</span>
                </li>
              ),
            )}
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
      {(commands.length > 0 || jobs.length > 0) && (
        <section>
          <SectionTitle numbered={false} hint="它自己的程序在电脑上运行：只能读写它自己的文件夹，崩了不影响 Emaki">
            功能
          </SectionTitle>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {commands.map((c) => (
              <li key={c.name} className="flex flex-wrap items-baseline gap-x-2">
                <span>{c.summary}</span>
                <span className="font-mono text-[11.5px] text-fg-subtle">{c.name}</span>
              </li>
            ))}
            {jobs.map((j) => (
              <li key={j.kind} className="flex flex-wrap items-baseline gap-x-2">
                <span>后台任务「{j.label}」</span>
                <span className="text-[12px] text-fg-subtle">在任务列表里看进度、取消</span>
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
