import {
  NAV_SECTIONS,
  OVERRIDES,
  pluginLabel,
  type BundledPlugin,
  type NavEntry,
  type NavSection,
  type PluginInfo,
  type PluginKind,
  type PluginPackage,
  type PluginSource,
} from '@emaki/shared';
import { useMutation } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Download, Ellipsis, GripVertical, PencilLine, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, IconButton, Menu, MenuItem, SearchInput, SectionTitle, Segmented, Switch, Tooltip } from '@/components/ui';
import { api } from '@/lib/api';
import { useCan } from '@/lib/capabilities';
import { cn } from '@/lib/cn';
import { usePlugins } from '@/lib/plugins';
import { useMutate } from '@/lib/queries';
import { useDragSort } from '@/lib/useDragSort';
import { toast } from 'sonner';
import { ConfirmPackage, GrantSheet, InstallDialog } from './InstallDialogs';
import { NewOverrideDialog, RemoveDialog, RenameDialog } from './PluginDialogs';
import { UpdateCheck, useCheckUpdate } from './UpdateCheck';
import { Slot } from '@/blocks/Slot';

export const SOURCE_LABEL: Record<PluginSource, string> = { builtin: '内置', mine: '我的', installed: '装的' };
export const KIND_LABEL: Record<PluginKind, string> = { page: '页面', override: '覆盖', feature: '功能', internal: '改内部' };
const SECTION_LABEL: Record<NavSection, string> = { main: '主要', triage: '整理', footer: '底部' };

type View = 'all' | 'pages';

/**
 * 「插件」页（docs/plugins.md 9.7）：一切都是插件——原来的每一页（内置）、自己或 AI 做的覆盖（我的）、从文件 / 文件夹 / git 装的（装的），
 * 都在这里启用、停用、改名、删除。「页面」视图按侧栏的顺序列出页面，在这里编排侧栏和手机的底部标签栏。
 * 改动都即时生效、能撤销（进撤销栈）。没有 plugins 权限的设备只能看；装插件要 install-plugins。
 */
export function PluginsPage() {
  const { state } = usePlugins();
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'pages' ? 'pages' : 'all';
  const setView = (v: View) => setParams((p) => (v === 'all' ? (p.delete('view'), p) : (p.set('view', v), p)), { replace: true });
  const off = state.plugins.filter((p) => !p.enabled).length;
  const [creating, setCreating] = useState(false);
  const [installing, setInstalling] = useState(false);
  const can = useCan('plugins') && !state.safeMode;
  const canInstall = useCan('install-plugins') && !state.safeMode;

  return (
    <>
      <PageHeader
        title="插件"
        nav="plugins"
        subtitle={`${state.plugins.length} 个插件${off ? ` · ${off} 个停用` : ''}`}
        actions={
          <Slot
            id="page.plugins"
            render={{
              'plugins.newOverride': () =>
                can && (
                  <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => setCreating(true)}>
                    新建覆盖
                  </Button>
                ),
              'plugins.install': () =>
                canInstall && (
                  <Button variant="secondary" size="sm" icon={<Download />} onClick={() => setInstalling(true)}>
                    安装…
                  </Button>
                ),
              // 安全模式（docs/plugins.md 第 8 节）：插件把页面弄坏了时，这个标签页只用内置插件、全部按原样打开；看得到这一页就能进
              'plugins.safeMode': () =>
                !state.safeMode && (
                  <Tooltip content="这个标签页只用内置插件、全部按原来的样子打开；插件把页面弄坏了时用">
                    <Button variant="ghost" size="sm" icon={<ShieldAlert />} onClick={() => window.location.assign('?safe')}>
                      安全模式
                    </Button>
                  </Tooltip>
                ),
            }}
          />
        }
      />
      <PageBody className="flex max-w-[880px] flex-col gap-6">
        {state.safeMode && <SafeModeNote />}
        <div className="self-start">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'all', label: '全部' },
              { value: 'pages', label: '页面顺序' },
            ]}
          />
        </div>
        {view === 'all' ? <AllView can={can} /> : <PagesView can={can} />}
      </PageBody>
      <NewOverrideDialog open={creating} onOpenChange={setCreating} />
      <InstallDialog open={installing} onOpenChange={setInstalling} />
      {params.get('confirm') && (
        <ConfirmPackage
          token={params.get('confirm')!}
          onClose={() =>
            setParams(
              (p) => {
                p.delete('confirm');
                return p;
              },
              { replace: true },
            )
          }
        />
      )}
    </>
  );
}

function SafeModeNote() {
  const { state } = usePlugins();
  const running = state.internalRunning ?? [];
  const canStop = useCan('plugins');
  const stop = useMutate(() => api.disableInternalPlugins());
  return (
    <div className="flex items-start gap-3 rounded-lg bg-warn-soft px-4 py-3 text-[13px] leading-relaxed">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="flex flex-1 flex-col gap-2">
        <span>
          现在是<b className="font-semibold">安全模式</b>：只用内置插件，全部按原来的样子；你的覆盖、改的名字和侧栏顺序都先不生效，也不能改。
          <a href="?safe=0" className="ml-1 font-medium text-fg underline-offset-2 hover:underline">
            退出安全模式
          </a>
        </span>
        {/* 网页的安全模式管不到服务端：改内部的插件的补丁还在（第 8 节），给一键停用 */}
        {running.length > 0 && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="flex-1">
              改内部的插件在 Emaki 的服务端里跑，安全模式管不到它们，还在生效：{running.map((p) => `「${p.name}」`).join('、')}。
            </span>
            {canStop && (
              <Button variant="secondary" size="sm" loading={stop.isPending} onClick={() => stop.mutate(undefined)}>
                全部停用
              </Button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 全部

function AllView({ can }: { can: boolean }) {
  const { state } = usePlugins();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'any' | PluginKind>('any');
  const [status, setStatus] = useState<'any' | 'on' | 'off' | 'conflict' | 'trouble'>('any');
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return state.plugins.filter(
      (p) =>
        (!needle || [p.name, p.displayName ?? '', p.description ?? '', p.id].some((s) => s.toLowerCase().includes(needle))) &&
        (kind === 'any' || p.kinds.includes(kind)) &&
        (status === 'any' ||
          (status === 'on' && p.enabled) ||
          (status === 'off' && !p.enabled) ||
          (status === 'conflict' && p.conflicts.length > 0) ||
          (status === 'trouble' && troubled(p))),
    );
  }, [state.plugins, q, kind, status]);
  const bundled = (state.bundled ?? []).filter(
    (b) =>
      status === 'any' &&
      kind === 'any' &&
      (!q.trim() || [b.name, b.description ?? '', b.id].some((s) => s.toLowerCase().includes(q.trim().toLowerCase()))),
  );
  const groups = (['builtin', 'mine', 'installed'] as const)
    .map((source) => ({ source, items: list.filter((p) => p.source === source) }))
    .filter((g) => g.items.length);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onClear={() => setQ('')}
          placeholder="搜插件"
          className="w-56 compact:w-full"
        />
        <Segmented
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'any', label: '全部类型' },
            { value: 'page', label: '页面' },
            { value: 'override', label: '覆盖' },
            { value: 'feature', label: '功能' },
            ...(state.plugins.some((p) => p.kinds.includes('internal')) ? [{ value: 'internal' as const, label: '改内部' }] : []),
          ]}
        />
        <Segmented
          size="sm"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'any', label: '全部' },
            { value: 'on', label: '启用' },
            { value: 'off', label: '停用' },
            { value: 'conflict', label: '冲突' },
            { value: 'trouble', label: '出错' },
          ]}
        />
      </div>
      {groups.length === 0 && !bundled.length && <p className="py-10 text-center text-[13px] text-fg-muted">没有符合条件的插件</p>}
      {groups.map((g) => (
        <section key={g.source}>
          <SectionTitle numbered={false} hint={`${g.items.length} 个`}>
            {SOURCE_LABEL[g.source]}
          </SectionTitle>
          <ul className="divide-y divide-line rounded-lg bg-raised ring-1 ring-line">
            {g.items.map((p) => (
              <PluginRow key={p.id} plugin={p} can={can} />
            ))}
          </ul>
        </section>
      ))}
      {!!state.patched?.length && (
        <section>
          {/* 谁改了哪里（docs/plugins.md 第 7 节）：出了问题能直接定位到是哪个插件 */}
          <SectionTitle numbered={false} hint="改内部的插件现在改着的地方；几个插件改同一处时按启用的先后叠起来">
            谁改了哪里
          </SectionTitle>
          <ul className="divide-y divide-line rounded-lg bg-raised text-[13px] ring-1 ring-line">
            {state.patched.map((x) => (
              <li key={x.point} className="flex flex-wrap items-baseline gap-x-2 px-4 py-2.5">
                <span className="font-medium">{x.label}</span>
                <span className="font-mono text-[11.5px] text-fg-subtle">{x.point}</span>
                <span className="ml-auto text-fg-muted">
                  {[...new Set(x.plugins)].map((id, i) => {
                    const owner = state.plugins.find((p) => p.id === id);
                    return (
                      <span key={id}>
                        {i > 0 && '、'}
                        <Link to={`/plugins/${encodeURIComponent(id)}`} className="text-fg hover:underline">
                          {owner ? pluginLabel(owner) : id}
                        </Link>
                      </span>
                    );
                  })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {bundled.length > 0 && (
        <section>
          <SectionTitle numbered={false} hint="随 Emaki 一起发，默认没装；启用时和别的插件一样先看授权单">
            附带的
          </SectionTitle>
          <ul className="divide-y divide-line rounded-lg bg-raised ring-1 ring-line">
            {bundled.map((b) => (
              <BundledRow key={b.id} plugin={b} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** 附带的、还没装的插件：「启用…」就是按文件夹装，出一样的授权单 */
function BundledRow({ plugin: b }: { plugin: BundledPlugin }) {
  const { state } = usePlugins();
  const canInstall = useCan('install-plugins') && !state.safeMode;
  const [pkg, setPkg] = useState<PluginPackage | null>(null);
  const inspect = useMutation({
    mutationFn: () => api.inspectPlugin({ kind: 'folder', path: b.path }),
    onSuccess: setPkg,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[14px] font-semibold tracking-tight text-fg-muted">{b.name}</span>
          <span className="font-mono text-[11.5px] text-fg-subtle">{b.version}</span>
        </div>
        {b.description && <p className="mt-0.5 truncate text-[12.5px] text-fg-muted">{b.description}</p>}
      </div>
      {canInstall && (
        <Button variant="secondary" size="sm" loading={inspect.isPending} onClick={() => inspect.mutate()}>
          启用…
        </Button>
      )}
      {pkg && <GrantSheet pkg={pkg} open onOpenChange={(o) => !o && setPkg(null)} />}
    </li>
  );
}

/** 有问题的：不能启用、自动停用了、有出错记录 */
const troubled = (p: PluginInfo) => p.problems.length > 0 || !!p.disabledReason || !!p.errors?.length;

export function useEnablePlugin() {
  return useMutate((v: { id: string; enabled: boolean }) => api.setPluginEnabled(v.id, v.enabled));
}

function PluginRow({ plugin: p, can }: { plugin: PluginInfo; can: boolean }) {
  const navigate = useNavigate();
  const enable = useEnablePlugin();
  const [dialog, setDialog] = useState<'rename' | 'remove' | null>(null);
  const label = pluginLabel(p);
  const update = useCheckUpdate(p);
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Link to={`/plugins/${encodeURIComponent(p.id)}`} className="group min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={cn('text-[14px] font-semibold tracking-tight group-hover:underline', !p.enabled && 'text-fg-muted')}>
            {label}
          </span>
          {p.displayName && <span className="text-[12px] text-fg-subtle">原名「{p.name}」</span>}
          {p.kinds.map((k) => (
            <Badge key={k}>{KIND_LABEL[k]}</Badge>
          ))}
          {p.required && <Badge>必需</Badge>}
          {p.conflicts.length > 0 && <Badge tone="warn">冲突</Badge>}
          {p.problems.length > 0 ? <Badge tone="warn">不能启用</Badge> : troubled(p) && <Badge tone="warn">出错</Badge>}
          {p.installed && <span className="font-mono text-[11.5px] text-fg-subtle">{p.version}</span>}
        </div>
        <p className="mt-0.5 truncate text-[12.5px] text-fg-muted">
          {p.problems[0] ?? p.disabledReason ?? p.description ?? overrideSummary(p)}
        </p>
      </Link>
      {p.required ? (
        <Tooltip content="必需的插件不能停用">
          <span>
            <Switch checked disabled onCheckedChange={() => {}} label={`${label}：必需`} />
          </span>
        </Tooltip>
      ) : (
        <Switch
          checked={p.enabled}
          disabled={!can || enable.isPending || (!p.enabled && p.problems.length > 0)}
          onCheckedChange={(v) => enable.mutate({ id: p.id, enabled: v })}
          label={`${p.enabled ? '停用' : '启用'}「${label}」`}
        />
      )}
      {can && (
        <Menu
          width={180}
          trigger={
            <IconButton label="更多" size="sm">
              <Ellipsis />
            </IconButton>
          }
        >
          {/* 按登记的顺序（blocks/slots.ts 的 menu.pluginRow） */}
          <Slot
            id="menu.pluginRow"
            render={{
              'pluginRow.rename': () => (
                <MenuItem icon={<PencilLine />} onSelect={() => setDialog('rename')}>
                  改名…
                </MenuItem>
              ),
              'pluginRow.detail': () => <MenuItem onSelect={() => navigate(`/plugins/${encodeURIComponent(p.id)}`)}>详情</MenuItem>,
              'pluginRow.update': () =>
                update.available && (
                  <MenuItem icon={<RefreshCw />} onSelect={update.start}>
                    {update.label}
                  </MenuItem>
                ),
              'pluginRow.remove': () =>
                p.source !== 'builtin' && (
                  <MenuItem danger icon={<Trash2 />} onSelect={() => setDialog('remove')}>
                    {p.source === 'installed' ? '卸载…' : '删除…'}
                  </MenuItem>
                ),
            }}
          />
        </Menu>
      )}
      <RenameDialog plugin={p} open={dialog === 'rename'} onOpenChange={(o) => !o && setDialog(null)} />
      <RemoveDialog plugin={p} open={dialog === 'remove'} onOpenChange={(o) => !o && setDialog(null)} />
      <UpdateCheck state={update} />
    </li>
  );
}

/** 覆盖插件没写说明时：它改了哪些值 */
export function overrideSummary(p: PluginInfo): string {
  const values = Object.entries(p.contributes['override@1'] ?? {});
  return values
    .map(([k, v]) => {
      const def = OVERRIDES[k as keyof typeof OVERRIDES];
      const opt = def?.options.find((o) => o.value === v);
      return def ? `${def.label}：${opt?.label ?? String(v)}` : `${k}：${String(v)}`;
    })
    .join(' · ');
}

// ---------------------------------------------------------------- 页面顺序

function PagesView({ can }: { can: boolean }) {
  const { state } = usePlugins();
  const save = useMutate((body: Parameters<typeof api.setNav>[0]) => api.setNav(body));
  const ids = (s: Record<NavSection, NavEntry[]>) =>
    Object.fromEntries(NAV_SECTIONS.map((k) => [k, s[k].map((n) => n.id)])) as Record<NavSection, string[]>;
  // 刚挪过、接口还没回来时按挪过的顺序画（拖完那一行不跳回去）；新的 state.nav 到了就不用它
  const [draft, setDraft] = useState<{ base: Record<NavSection, NavEntry[]>; order: Record<NavSection, string[]> } | null>(null);
  const sections = useMemo(() => {
    if (!draft || draft.base !== state.nav) return state.nav;
    const byId = new Map(NAV_SECTIONS.flatMap((k) => state.nav[k]).map((n) => [n.id, n]));
    return Object.fromEntries(NAV_SECTIONS.map((k) => [k, draft.order[k].flatMap((id) => byId.get(id) ?? [])])) as Record<
      NavSection,
      NavEntry[]
    >;
  }, [draft, state.nav]);
  const commit = (order: Record<NavSection, string[]>) => {
    setDraft({ base: state.nav, order });
    save.mutate({ sections: order }, { onError: () => setDraft(null) });
  };

  /** 上移 / 下移一格；到了这一段的头尾就挪到相邻那一段 */
  const move = (section: NavSection, index: number, dir: -1 | 1) => {
    const next = ids(sections);
    const list = next[section];
    const [id] = list.splice(index, 1);
    const si = NAV_SECTIONS.indexOf(section);
    const to = index + dir;
    if (to >= 0 && to <= list.length) list.splice(to, 0, id!);
    else if (dir < 0 && si > 0) next[NAV_SECTIONS[si - 1]!].push(id!);
    else if (dir > 0 && si < NAV_SECTIONS.length - 1) next[NAV_SECTIONS[si + 1]!].unshift(id!);
    else return;
    commit(next);
  };

  // 按住把手拖（鼠标、触屏），能拖到别的一段；拖着的时候按 sort.order 画（别的行让位）
  const box = useRef<HTMLDivElement>(null);
  const lists = useMemo(() => ids(sections), [sections]);
  const sort = useDragSort<NavSection>({ container: box, lists, disabled: !can || save.isPending, onDrop: commit });
  const byId = new Map(NAV_SECTIONS.flatMap((k) => sections[k]).map((n) => [n.id, n]));
  const shown = (k: NavSection) => sort.order[k].flatMap((id) => byId.get(id) ?? []);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-[13px] leading-relaxed text-fg-muted">
        侧栏按这里的顺序排，手机竖屏的底部标签栏放前四个（「原创」这种捷径不算），其余进「更多」。按住左边的把手拖，或者用箭头一格格挪。停用的页面不在这里，到「全部」里启用。
      </p>
      <div ref={box} className="relative flex flex-col gap-6">
        {NAV_SECTIONS.map((section, si) => (
          <section key={section}>
            <SectionTitle numbered={false}>{SECTION_LABEL[section]}</SectionTitle>
            <ul data-sort-group={section} className="divide-y divide-line rounded-lg bg-raised ring-1 ring-line">
              {shown(section).length === 0 && <li className="px-4 py-3 text-[13px] text-fg-subtle">这一段没有页面</li>}
              {shown(section).map((n, i, list) => (
                <PageRow
                  key={n.id}
                  entry={n}
                  can={can && !save.isPending}
                  first={si === 0 && i === 0}
                  last={si === NAV_SECTIONS.length - 1 && i === list.length - 1}
                  dragging={sort.dragging === n.id}
                  handle={sort.handle(n.id)}
                  onMove={(dir) => move(section, i, dir)}
                  onVisible={(v) => save.mutate({ visible: { [n.id]: v } })}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function PageRow({
  entry: n,
  can,
  first,
  last,
  dragging,
  handle,
  onMove,
  onVisible,
}: {
  entry: NavEntry;
  can: boolean;
  first: boolean;
  last: boolean;
  dragging: boolean;
  handle: ReturnType<ReturnType<typeof useDragSort>['handle']>;
  onMove: (dir: -1 | 1) => void;
  onVisible: (v: boolean) => void;
}) {
  const { state } = usePlugins();
  const plugin = state.plugins.find((p) => p.id === n.plugin);
  const [renaming, setRenaming] = useState(false);
  const pinned = n.id === 'settings';
  return (
    <li
      data-sort-item={n.id}
      className={cn(
        'flex items-center gap-3 bg-raised px-4 py-2.5 first:rounded-t-lg last:rounded-b-lg',
        dragging && 'relative z-10 rounded-lg shadow-lift ring-1 ring-line',
      )}
    >
      <span
        {...handle}
        title={can ? '按住拖动，调整顺序' : undefined}
        className={cn(
          'touch-hit -ml-1.5 flex h-8 w-5 shrink-0 items-center justify-center rounded text-fg-subtle',
          can ? 'hover:text-fg-muted' : 'opacity-40',
        )}
      >
        <GripVertical className="size-4" />
      </span>
      <div className="-ml-1 flex shrink-0 gap-0.5">
        <IconButton label="上移" size="sm" disabled={!can || first} onClick={() => onMove(-1)}>
          <ArrowUp />
        </IconButton>
        <IconButton label="下移" size="sm" disabled={!can || last} onClick={() => onMove(1)}>
          <ArrowDown />
        </IconButton>
      </div>
      <div className="min-w-0 flex-1">
        <span className={cn('text-[14px] font-medium', !n.visible && 'text-fg-muted')}>{n.label}</span>
        {plugin?.displayName && (
          <span className="ml-2 text-[12px] text-fg-subtle">原名「{n.label === plugin.displayName ? plugin.name : n.label}」</span>
        )}
      </div>
      {can && plugin && (
        <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
          改名
        </Button>
      )}
      <Tooltip
        content={
          pinned
            ? '「设置」要一直留在侧栏里：插件页的入口在设置里'
            : n.visible
              ? '从侧栏拿掉（页面还在，链接和命令面板照样能去）'
              : '放进侧栏'
        }
      >
        <span>
          <Switch checked={n.visible} disabled={!can || pinned} onCheckedChange={onVisible} label={`「${n.label}」在侧栏显示`} />
        </span>
      </Tooltip>
      {plugin && <RenameDialog plugin={plugin} open={renaming} onOpenChange={setRenaming} />}
    </li>
  );
}
