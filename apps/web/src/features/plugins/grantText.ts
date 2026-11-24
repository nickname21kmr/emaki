/**
 * 授权单上的话（docs/plugins.md 4.2）：由宿主按清单生成，插件自己写不了，免得话术误导。
 * 「它会」：贡献的东西（侧栏加一项、改一个默认值）和要的权限，一条一句；「它不会」：几件大家最关心、它又没要的事；
 * 权限组合起来有风险时（能读图又联网）直接写出后果。授权单（GrantSheet）和插件详情里的「授权」用同一份。
 */
import {
  OVERRIDES,
  type FolderRequest,
  type Grant,
  type OverrideKey,
  type PluginManifest,
  type PluginPermissions,
  type Scope,
} from '@emaki/shared';
import { scopeText } from '@/features/access/format';

export interface GrantLine {
  key: string;
  text: string;
  detail?: string;
  /** 会动你的文件、整库批量改这类，朱色标出 */
  danger?: boolean;
  /** 要你选位置的文件夹 */
  folder?: FolderRequest;
}

/** 这些范围会动用户已有的东西，标出来 */
const DANGER_SCOPES: readonly Scope[] = ['organize-files', 'rules', 'settings'];

/** 贡献的东西：侧栏加一项、改一个默认值 */
export function contributionLines(m: PluginManifest): GrantLine[] {
  const lines: GrantLine[] = [];
  for (const n of m.contributes['nav.item@1'] ?? [])
    lines.push({ key: `nav:${n.id}`, text: `在侧栏加「${n.label}」`, detail: `打开 ${n.to}` });
  for (const [k, v] of Object.entries(m.contributes['override@1'] ?? {})) {
    const def = OVERRIDES[k as OverrideKey];
    const opt = def?.options.find((o) => o.value === v);
    lines.push({
      key: `override:${k}`,
      text: def ? `把「${def.label}」改成「${opt?.label ?? String(v)}」` : `改「${k}」`,
      detail: '停用就回到原来的',
    });
  }
  return lines;
}

/** 要的权限：一项一句 */
export function permissionLines(p: PluginPermissions): GrantLine[] {
  const lines: GrantLine[] = [];
  for (const s of p.scopes ?? []) {
    const { head, detail } = scopeText(s);
    lines.push({ key: `scope:${s}`, text: head, ...(detail && { detail }), ...(DANGER_SCOPES.includes(s) && { danger: true }) });
  }
  for (const f of p.folders ?? []) lines.push({ key: `folder:${f.id}`, text: '把文件放进', detail: f.purpose, folder: f });
  if (p.network?.length)
    lines.push({ key: 'network', text: `连接 ${p.network.join('、')}`, detail: '插件声明的；Emaki 不拦截插件服务端的联网，照它说的写在这里' });
  if (p.background) lines.push({ key: 'background', text: '在后台运行', detail: '任务列表里能看到、能取消' });
  if (p.unsafe) lines.push({ key: 'unsafe', text: '改 Emaki 的内部', detail: '可以做 Emaki 能做的任何事，只能用于这个版本的 Emaki', danger: true });
  return lines;
}

/** 组合起来的风险：能读图又能联网，直接写出后果 */
export function riskLine(p: PluginPermissions): string | null {
  if (p.scopes?.includes('read') && p.network?.length) return `可能把你的图发到 ${p.network.join('、')}`;
  return null;
}

/** 它不会：没要的几件要紧事 */
export function wontLine(p: PluginPermissions): string | null {
  const scopes = p.scopes ?? [];
  const items: string[] = [];
  if (!scopes.length) items.push('读或改你的图库');
  if (!scopes.includes('organize-files')) items.push('移动或删除你的图');
  if (!scopes.includes('settings')) items.push('改设置');
  if (!p.network?.length) items.push('联网');
  return items.length ? `它不会：${items.join('、')}` : null;
}

/** 给了的授权 → 权限的样子（插件详情里按同一套话显示） */
export const grantAsPermissions = (g: Grant, requested: PluginPermissions | undefined): PluginPermissions => ({
  ...(g.scopes.length && { scopes: g.scopes }),
  ...(g.folders.length && {
    folders: g.folders.map((f) => requested?.folders?.find((r) => r.id === f.id) ?? { id: f.id, purpose: f.id }),
  }),
  ...(g.network.length && { network: g.network }),
  ...(g.background && { background: true }),
  ...(g.unsafe && { unsafe: true }),
});

export const SOURCE_TEXT = { file: '本地文件', folder: '文件夹', git: 'git' } as const;
