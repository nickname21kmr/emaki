import { pluginPagePath, type LibraryRoot, type PluginPackage } from '@emaki/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileArchive, FolderOpen } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, Dialog, DialogFooter, Input, Segmented, Switch } from '@/components/ui';
import { displayPath } from '@/features/access/UploadTarget';
import { api } from '@/lib/api';
import { useCan } from '@/lib/capabilities';
import { cn } from '@/lib/cn';
import { useMutate, useSettings } from '@/lib/queries';
import { contributionLines, permissionLines, riskLine, sourceText, wontLine, type GrantLine } from './grantText';
import { toast } from 'sonner';

type Source = 'file' | 'folder' | 'git';

/**
 * 「安装…」（docs/plugins.md 9.7、4.2）：选来源（文件 / 文件夹 / git 地址），服务端取来、读清单以后，同一个对话框换成授权单。
 * 什么都还没装：授权单上点「允许并启用」才装。
 */
export function InstallDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [pkg, setPkg] = useState<PluginPackage | null>(null);
  const [source, setSource] = useState<Source>('file');
  const [file, setFile] = useState<File | null>(null);
  const [folder, setFolder] = useState('');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canPick = useCan('desktop');
  useEffect(() => {
    if (!open) return;
    setPkg(null);
    setError(null);
  }, [open]);

  const inspect = useMutation({
    mutationFn: () =>
      source === 'file'
        ? api.inspectPluginZip(file!)
        : source === 'folder'
          ? api.inspectPlugin({ kind: 'folder', path: folder.trim() })
          : api.inspectPlugin({ kind: 'git', url: url.trim(), ...(ref.trim() && { ref: ref.trim() }) }),
    onMutate: () => setError(null),
    onSuccess: setPkg,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const pick = useMutation({
    mutationFn: () => api.pickFolder(),
    onSuccess: (r) => r.path && setFolder(r.path),
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (pkg) return <GrantSheet pkg={pkg} open={open} onOpenChange={onOpenChange} onBack={() => setPkg(null)} />;

  const ready = source === 'file' ? !!file : source === 'folder' ? !!folder.trim() : !!url.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) inspect.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="安装插件" description="只装你信得过的来源。装之前会列出它会做的所有事，你确认了才装。" width={540}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div className="self-start">
          <Segmented
            value={source}
            onChange={(v) => {
              setSource(v);
              setError(null);
            }}
            options={[
              { value: 'file', label: '文件' },
              { value: 'folder', label: '文件夹' },
              { value: 'git', label: 'git 地址' },
            ]}
          />
        </div>
        {source === 'file' && (
          <div className="flex flex-col gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <div className="flex items-center gap-3">
              <Button type="button" variant="secondary" icon={<FileArchive />} onClick={() => fileInput.current?.click()}>
                {file ? '换一个…' : '选择 zip 文件…'}
              </Button>
              {file && <span className="min-w-0 truncate font-mono text-[12.5px]">{file.name}</span>}
            </div>
            <p className="text-[12.5px] leading-relaxed text-fg-muted">插件文件夹压成的 zip（直接压缩文件夹也行），最大 20 MB。</p>
          </div>
        )}
        {source === 'folder' && (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Input
                autoFocus
                value={folder}
                maxLength={500}
                placeholder="插件文件夹的完整路径，例如 D:\plugins\random-browse"
                onChange={(e) => setFolder(e.target.value)}
                className="min-w-0 flex-1 font-mono text-[12.5px]"
              />
              {canPick && (
                <Button type="button" variant="secondary" icon={<FolderOpen />} loading={pick.isPending} onClick={() => pick.mutate()}>
                  选文件夹…
                </Button>
              )}
            </div>
            <p className="text-[12.5px] leading-relaxed text-fg-muted">不复制：改了插件以后，在插件详情里点「重新读取」。写插件的时候用。</p>
          </div>
        )}
        {source === 'git' && (
          <div className="flex flex-col gap-2">
            <Input autoFocus value={url} maxLength={500} placeholder="https://github.com/…/….git" onChange={(e) => setUrl(e.target.value)} className="font-mono text-[12.5px]" />
            <Input value={ref} maxLength={100} placeholder="分支或标签（可以不填）" onChange={(e) => setRef(e.target.value)} className="font-mono text-[12.5px]" />
            <p className="text-[12.5px] leading-relaxed text-fg-muted">要这台电脑上装了 git；按 Emaki 的代理设置下载。</p>
          </div>
        )}
        {error && <p className="text-[12.5px] leading-relaxed text-danger">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={inspect.isPending} disabled={!ready}>
            {inspect.isPending && source === 'git' ? '正在下载…' : '下一步'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * 授权单（docs/plugins.md 4.2）：一张单子列出插件会做的所有事，要选的文件夹也在这里选好；点一次就全部生效，用的时候不再问。
 * 更新时只列新要的权限。话由宿主按清单生成（grantText.ts），插件自己写不了。
 */
export function GrantSheet({
  pkg,
  open,
  onOpenChange,
  onBack,
  onInstalled,
}: {
  pkg: PluginPackage;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onBack?: () => void;
  /** 装好以后（不给：打开插件详情） */
  onInstalled?: (id: string) => void;
}) {
  const g = useGrant(pkg, (id) => {
    onOpenChange(false);
    onInstalled?.(id);
  }, !onInstalled);
  const m = pkg.manifest;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex flex-wrap items-baseline gap-x-2">
          {g.update ? `${g.verb}「${m.name}」` : m.name}
          <span className={cn('text-[13px] font-normal text-fg-muted', !g.ai && 'font-mono')}>{g.versionText}</span>
        </span>
      }
      description={`来自：${sourceText(pkg.source)}`}
      width={560}
    >
      <GrantBody pkg={pkg} g={g} />
      <DialogFooter>
        {onBack && (
          <Button type="button" variant="ghost" className="mr-auto" onClick={onBack}>
            返回
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        {!g.blocked && (
          <Button variant="primary" loading={g.install.isPending} disabled={g.missingRoot} onClick={() => g.install.mutate(undefined)}>
            {g.action}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/**
 * 按 token 打开一张授权单：外部的 AI 客户端（Claude 这类，经 MCP 调 plugins_save_view）做好的页面，给的是
 * /plugins?confirm=<token> 这样的链接（docs/plugins.md 5.1）。包作废了就提示一下
 */
export function ConfirmPackage({ token, onClose }: { token: string; onClose: () => void }) {
  const can = useCan('install-plugins');
  const pkg = useQuery({ queryKey: ['plugin-package', token], queryFn: () => api.pluginPackage(token), retry: false, staleTime: Infinity, enabled: can });
  useEffect(() => {
    if (!can || pkg.error) {
      toast(can ? '这一份已经作废了（准备好的插件一小时内有效），让 AI 再保存一次' : '这台设备不能装插件');
      onClose();
    }
  }, [can, pkg.error, onClose]);
  return pkg.data ? <GrantSheet pkg={pkg.data} open onOpenChange={(o) => !o && onClose()} /> : null;
}

export type GrantForm = ReturnType<typeof useGrant>;

/**
 * 授权单的状态：要列的几行、选好的文件夹、放不放进侧栏、装。对话框（GrantSheet）和 AI 助手的保存卡片（PluginSaveCard）共用。
 * openDetail：装好以后打开插件详情
 */
export function useGrant(pkg: PluginPackage, onInstalled?: (id: string) => void, openDetail = true) {
  const navigate = useNavigate();
  const m = pkg.manifest;
  const update = pkg.current;
  const ai = pkg.source.kind === 'ai';
  // 新装的、带侧栏项的：在授权单上就选好放不放进侧栏（docs/plugins.md 5.1）
  const hasNav = !update && (m.contributes['nav.item@1']?.length ?? 0) > 0;
  const [showInNav, setShowInNav] = useState(true);
  const roots = (useSettings().data?.libraryRoots ?? []).filter((r: LibraryRoot) => r.enabled && r.mode === 'auto');
  const [folders, setFolders] = useState<Record<string, { rootId: string; dir: string }>>(() =>
    Object.fromEntries(
      Object.entries(pkg.folderDefaults).map(([k, v]) => [k, v ? { rootId: String(v.rootId), dir: v.dir } : { rootId: roots[0]?.id ?? '', dir: '' }]),
    ),
  );
  const install = useMutate(() => api.installPlugin(pkg.token, Object.keys(folders).length ? folders : undefined, hasNav ? showInNav : undefined), {
    onSuccess: (r) => {
      onInstalled?.(r.id);
      // AI 做的页面存好直接打开那一页；别的打开插件详情
      const view = ai ? m.contributes['page@1']?.find((p) => p.view) : undefined;
      if (openDetail) navigate(view ? pluginPagePath(r.id, view.id) : `/plugins/${encodeURIComponent(r.id)}`);
    },
  });
  const shown = update ? pkg.added : (m.permissions ?? {});
  const lines = [...(update ? [] : contributionLines(m)), ...permissionLines(shown)];
  // 更新时只在新要的权限和风险有关时再说一遍
  const risk = !update || pkg.added.network?.length || pkg.added.scopes?.includes('read') ? riskLine(m.permissions ?? {}) : null;
  const wont = update ? null : wontLine(m.permissions ?? {});
  const same = update?.version === m.version;
  const verb = ai ? '保存' : same ? '重新安装' : '更新';
  const blocked = pkg.problems.length > 0;
  const missingRoot = lines.some((l) => !!l.folder && !roots.some((r) => r.id === folders[l.folder!.id]?.rootId));
  // 只读的 AI 页面：这张单子就是一个「保存」按钮（docs/plugins.md 5.1）
  const onlyReads = !lines.some((l) => !l.key.startsWith('page:') && !l.key.startsWith('nav:') && l.key !== 'scope:read');
  const action = ai
    ? update
      ? lines.length
        ? '允许并保存'
        : '保存'
      : onlyReads
        ? '保存'
        : '允许并保存'
    : update
      ? lines.length
        ? `允许并${verb}`
        : verb
      : '允许并启用';
  const versionText = ai ? `第 ${m.version.split('.')[0]} 版` : update && !same ? `${update.version} → ${m.version}` : m.version;
  return { update, ai, hasNav, showInNav, setShowInNav, roots, folders, setFolders, install, lines, risk, wont, verb, blocked, missingRoot, action, versionText };
}

/** 授权单的内容：说明、装不上的原因或者它会做的事、风险、它不会做的事、放不放进侧栏 */
export function GrantBody({ pkg, g }: { pkg: PluginPackage; g: GrantForm }) {
  const m = pkg.manifest;
  return (
    <div className="flex flex-col gap-4 text-[13px] leading-relaxed">
      {m.description && <p className="text-fg-muted">{m.description}</p>}
      {g.blocked ? (
        <div className="rounded-lg bg-warn-soft px-4 py-3">
          <p className="font-medium">装不上：</p>
          <ul className="mt-1 list-disc pl-5">
            {pkg.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          {g.update && g.lines.length === 0 && <p>权限没有变。</p>}
          {g.lines.length > 0 && (
            <div>
              <p className="mb-1.5 font-medium">{g.update ? '这次新要的：' : '它会：'}</p>
              <ul className="flex flex-col gap-2.5">
                {g.lines.map((l) => (
                  <GrantRow
                    key={l.key}
                    line={l}
                    roots={g.roots}
                    value={l.folder ? g.folders[l.folder.id] : undefined}
                    onChange={(v) => l.folder && g.setFolders((f) => ({ ...f, [l.folder!.id]: v }))}
                  />
                ))}
              </ul>
            </div>
          )}
          {g.risk && <p className="rounded-lg bg-danger-soft px-3 py-2 text-danger">{g.risk}</p>}
          {g.wont && <p className="text-fg-muted">{g.wont}</p>}
          {g.hasNav && (
            <label className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <span>在侧栏显示</span>
              <Switch checked={g.showInNav} onCheckedChange={g.setShowInNav} label="在侧栏显示" />
            </label>
          )}
        </>
      )}
    </div>
  );
}

/** 授权单的一行；要选位置的文件夹在这一行里选 */
export function GrantRow({
  line: l,
  roots,
  value,
  onChange,
}: {
  line: GrantLine;
  roots?: LibraryRoot[];
  value?: { rootId: string; dir: string };
  onChange?: (v: { rootId: string; dir: string }) => void;
}) {
  const root = roots?.find((r) => r.id === value?.rootId);
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className={cn('mt-[9px] size-1 shrink-0 rounded-full', l.danger ? 'bg-danger' : 'bg-fg-subtle')} />
      <div className="min-w-0 flex-1">
        <span className={cn(l.danger && 'text-danger')}>{l.text}</span>
        {l.folder && value && onChange && roots && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {roots.length > 1 ? (
              <select
                aria-label="图库文件夹"
                value={value.rootId}
                onChange={(e) => onChange({ ...value, rootId: e.target.value })}
                className="h-8 rounded-[8px] bg-sunken px-2 text-[12.5px] ring-1 ring-line outline-none focus:ring-2 focus:ring-shu/40"
              >
                {roots.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.path}
                  </option>
                ))}
              </select>
            ) : !root ? (
              <span className="text-warn">没有自动识别的图库文件夹，先在设置 → 图库里添加一个</span>
            ) : null}
            <Input
              aria-label="里面的文件夹"
              value={value.dir}
              maxLength={300}
              onChange={(e) => onChange({ ...value, dir: e.target.value })}
              className="h-8 font-mono text-[12.5px]"
            />
            {root && <span className="truncate font-mono text-[12px] text-fg-muted">{displayPath(root.path, value.dir.replace(/\\/g, '/'))}</span>}
          </div>
        )}
        {l.detail && <span className="block text-[12px] text-fg-subtle">{l.detail}</span>}
      </div>
    </li>
  );
}
