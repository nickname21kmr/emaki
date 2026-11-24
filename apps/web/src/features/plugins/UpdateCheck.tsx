import { compareVersions, pluginLabel, type PluginInfo, type PluginPackage } from '@emaki/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useCan } from '@/lib/capabilities';
import { usePlugins } from '@/lib/plugins';
import { useMutate } from '@/lib/queries';
import { GrantSheet, InstallDialog } from './InstallDialogs';

/**
 * 装的插件的更新（docs/plugins.md 第 8 节）：不静默自动更新，你点了才去取。
 * - git：重新下载，版本比现在新才更新；权限没多一键更新，多了出授权单、只列新增的；
 * - 文件夹（开发用）：「重新读取」，权限没多直接读进来；
 * - 文件：选新的 zip，走安装（同一个 id 就是更新）。
 */
export function useCheckUpdate(p: PluginInfo) {
  const { state } = usePlugins();
  const canInstall = useCan('install-plugins') && !state.safeMode;
  const [pkg, setPkg] = useState<PluginPackage | null>(null);
  const [pickFile, setPickFile] = useState(false);
  const kind = p.installed?.kind;
  const reread = useMutate((pk: PluginPackage) => api.installPlugin(pk.token));
  const check = useMutation({
    mutationFn: () => api.checkPluginUpdate(p.id),
    onSuccess: (pk) => {
      if (pk.problems.length || Object.keys(pk.added).length) return setPkg(pk);
      if (kind === 'folder') return reread.mutate(pk);
      if (pk.current && !newer(pk.manifest.version, pk.current.version))
        return void toast(`「${pluginLabel(p)}」已经是最新的（${pk.current.version}）`);
      setPkg(pk);
    },
    onError: (e) => void toast(e instanceof Error ? e.message : String(e)),
  });
  return {
    available: canInstall && !!kind,
    label: kind === 'folder' ? '重新读取' : kind === 'git' ? '检查更新' : '选新的文件更新…',
    start: () => (kind === 'file' ? setPickFile(true) : check.mutate()),
    pending: check.isPending || reread.isPending,
    pkg,
    close: () => setPkg(null),
    pickFile,
    setPickFile,
  };
}

const newer = (a: string, b: string) => {
  try {
    return compareVersions(a, b) > 0;
  } catch {
    return true;
  }
};

export function UpdateCheck({ state: u }: { state: ReturnType<typeof useCheckUpdate> }) {
  return (
    <>
      {u.pkg && <GrantSheet pkg={u.pkg} open onOpenChange={(o) => !o && u.close()} />}
      {u.pickFile && <InstallDialog open onOpenChange={u.setPickFile} />}
    </>
  );
}
