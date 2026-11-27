/**
 * 插件的授权检查只有这一处（docs/plugins.md 4.1「检查只有一处」）：插件要做的事——用一个权限范围的命令、连一个网站、
 * 往一个文件夹放文件、在后台运行——都问 authorize(授权, 要做什么)，不行的返回写给人看的原因。
 * 插件的服务端（services/plugins/runtime/host.ts）、视图的桥接（http/pluginViews.ts）都经这里；命令注册表按调用时的范围再查一遍（runCall 的 grant），
 * 那是对所有调用者的同一道检查。
 *
 * 另外放授权和清单之间的换算：你在插件详情里关掉的权限（declinedOf）、更新时新的授权（grantForUpdate）。
 */
import { hostAllowed, SCOPES, type FolderGrant, type Grant, type PluginPermissions, type Scope } from '@emaki/shared';

export type PluginRequest = { scope: Scope } | { network: string } | { folder?: string } | { background: true };

const scopeName = (s: Scope) => SCOPES[s].split(/[：（，]/)[0]!;

/** 这件事授权里有没有：有返回 null，没有返回原因 */
export function authorize(grant: Grant, req: PluginRequest): string | null {
  if ('scope' in req) return grant.scopes.includes(req.scope) ? null : `没有授权「${scopeName(req.scope)}」`;
  if ('network' in req)
    return hostAllowed(req.network.toLowerCase(), grant.network) ? null : `没有授权连接 ${req.network}（在清单的 permissions.network 里声明，授权单上确认）`;
  if ('background' in req) return grant.background ? null : '没有授权在后台运行（清单 permissions.background）';
  if (req.folder !== undefined) return grant.folders.some((f) => f.id === req.folder) ? null : `授权里没有文件夹「${req.folder}」`;
  return grant.folders.length ? null : '授权里没有给放文件的文件夹（清单 permissions.folders）';
}

/** 同上，没有就抛出（插件的请求用：原因原样回给插件） */
export function requireGrant(grant: Grant, req: PluginRequest): void {
  const why = authorize(grant, req);
  if (why) throw new Error(why);
}

/** 授权给的文件夹（不写 id 是第一个）；没有就抛出 */
export function grantedFolder(grant: Grant, id?: string): FolderGrant {
  requireGrant(grant, { folder: id });
  return id === undefined ? grant.folders[0]! : grant.folders.find((f) => f.id === id)!;
}

/** 这些权限范围里授权了的（视图的桥接：插件的授权 ∩ 打开它的入口） */
export const grantedScopes = (grant: Grant, scopes: Iterable<Scope>): Set<Scope> =>
  new Set([...scopes].filter((s) => authorize(grant, { scope: s }) === null));

/** 清单里要了、授权里没有的：你在插件详情里关掉的（装的时候授权单上是全给的） */
export function declinedOf(requested: PluginPermissions | undefined, grant: Grant): PluginPermissions {
  const r = requested ?? {};
  const out: PluginPermissions = {};
  const scopes = (r.scopes ?? []).filter((s) => !grant.scopes.includes(s));
  if (scopes.length) out.scopes = scopes;
  const folders = (r.folders ?? []).filter((f) => !grant.folders.some((x) => x.id === f.id));
  if (folders.length) out.folders = folders;
  const network = (r.network ?? []).filter((h) => !grant.network.includes(h));
  if (network.length) out.network = network;
  if (r.background && !grant.background) out.background = true;
  return out;
}

/** 两份权限合起来（更新时：现在的授权 + 你关掉的，都不算「这次新要的」） */
export function withDeclined(grant: Grant, declined: PluginPermissions): Grant {
  return {
    ...grant,
    scopes: [...new Set([...grant.scopes, ...(declined.scopes ?? [])])],
    network: [...new Set([...grant.network, ...(declined.network ?? [])])],
    background: grant.background || !!declined.background,
    // 关掉的文件夹没有位置，只拿来比 id
    folders: [...grant.folders, ...(declined.folders ?? []).map((f) => ({ id: f.id, rootId: -1, dir: '' }))],
  };
}
