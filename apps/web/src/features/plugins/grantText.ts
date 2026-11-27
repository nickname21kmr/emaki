/**
 * 授权单上的话（docs/plugins.md 4.2）：由宿主按清单生成，插件自己写不了，免得话术误导。
 * 「它会」：贡献的东西（侧栏加一项、改一个默认值）和要的权限，一条一句；「它不会」：几件大家最关心、它又没要的事；
 * 权限组合起来有风险时（能读图又联网）直接写出后果。授权单（GrantSheet）和插件详情里的「授权」用同一份。
 */
import {
  OVERRIDES,
  type FolderRequest,
  type Grant,
  type ImageSource,
  type OverrideKey,
  type PatchInfo,
  type PluginManifest,
  type PluginPermissions,
  type Scope,
} from '@emaki/shared';
import { DANGER_SCOPES, scopeText } from '@/features/access/format';

export interface GrantLine {
  key: string;
  text: string;
  detail?: string;
  /** 会动你的文件、整库批量改这类，朱色标出 */
  danger?: boolean;
  /** 要你选位置的文件夹 */
  folder?: FolderRequest;
}

const SOURCE_LABEL: Record<ImageSource['site'], string> = { pixiv: 'Pixiv', twitter: 'X / Twitter', danbooru: 'Danbooru', fanbox: 'FANBOX', other: '其他网站' };


/** 贡献的东西：自己画的页面、侧栏加一项、改一个默认值、改内部的哪几处（patches：服务端给的点的人话名字） */
export function contributionLines(m: PluginManifest, patches?: readonly PatchInfo[]): GrantLine[] {
  const lines: GrantLine[] = [];
  for (const p of m.contributes['page@1'] ?? [])
    if (p.view)
      lines.push({
        key: `page:${p.id}`,
        text: `加一页「${p.title ?? m.name}」`,
        detail: '页面自己画，在隔离的框里显示：不能联网，只能经 Emaki 调下面允许的那些',
      });
  for (const n of m.contributes['nav.item@1'] ?? [])
    lines.push({ key: `nav:${n.id}`, text: `在侧栏加「${n.label}」`, detail: n.page !== undefined ? '打开它的那一页' : `打开 ${n.to}` });
  for (const site of m.contributes['site@1'] ?? [])
    lines.push({
      key: `site:${site.id}`,
      text: `在 App 里打开 ${site.title} 时，往网站上加它的按钮`,
      detail: `只在 ${site.matches.join('、')} 上；网站原来的样子不动，按钮经 Emaki 调它自己的命令`,
    });
  for (const b of m.contributes['lightbox.toolbar@1'] ?? [])
    if (b.label)
      lines.push({
        key: `lightbox:${b.id}`,
        text: `在看图器上加「${b.label}」`,
        detail: [
          b.sources?.length ? `只在来源是 ${b.sources.map((x) => SOURCE_LABEL[x]).join('、')} 的图上` : '每张图上都有',
          b.open === 'source' ? '点了打开这张图的来源' : '点了把这张图的文件名和来源交给它',
        ].join('；'),
      });
  for (const l of m.contributes['link@1'] ?? [])
    lines.push({
      key: `link:${l.id}`,
      text: `由它打开「${l.title}」的链接`,
      detail: `${l.urls.join('、')}：点了在它的${[l.site && '网站（App 里）', l.page && '页面'].filter(Boolean).join('或')}里打开；按住 Ctrl 点照旧去浏览器`,
    });
  if (m.server)
    lines.push({
      key: 'server',
      text: '在这台电脑上运行它自己的程序',
      detail: '单独一个进程：只能读写它自己的文件夹，经 Emaki 做下面允许的事；崩了不影响 Emaki',
    });
  // 改内部（第 3 层）：改的每一处一行，朱色
  for (const x of m.contributes['patch@1'] ?? []) {
    const label = patches?.find((y) => y.point === x.point)?.label ?? x.point;
    lines.push({ key: `patch:${x.point}`, text: `改 Emaki 内部的「${label}」`, detail: x.why ? `${x.why}（${x.point}）` : x.point, danger: true });
  }
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
  if (p.unsafe)
    lines.push({
      key: 'unsafe',
      text: '改 Emaki 的内部',
      detail: '它的代码在 Emaki 里面运行（电脑上的 Emaki 或网页里），不隔离，可以做 Emaki 能做的任何事。Emaki 更新后它改的地方变了，它会自动停用，等你确认',
      danger: true,
    });
  return lines;
}

/** 组合起来的风险：能读图又能联网，直接写出后果 */
export function riskLine(p: PluginPermissions): string | null {
  if (p.scopes?.includes('read') && p.network?.length) return `可能把你的图发到 ${p.network.join('、')}`;
  return null;
}

/** 它不会：没要的几件要紧事 */
export function wontLine(p: PluginPermissions): string | null {
  // 改内部的插件什么都能做：不说「它不会」
  if (p.unsafe) return null;
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

export const SOURCE_TEXT = { file: '本地文件', folder: '文件夹', git: 'git', ai: 'AI 助手' } as const;

/** 授权单上的「来自：…」（AI 做的页面没有文件、地址） */
export const sourceText = (s: { kind: keyof typeof SOURCE_TEXT; location: string; ref: string | null }): string =>
  s.kind === 'ai' ? 'AI 助手' : `${SOURCE_TEXT[s.kind]} ${s.location}${s.ref ? `（${s.ref}）` : ''}`;
