/**
 * 插件（docs/plugins.md 第 9 节）：插件管理的查询和命令。写入都在插件模块（domain/plugins/），都能撤销。
 *
 * 装插件（E2）分两步：plugins.inspect（文件夹、git；zip 走 http/pluginPackages.ts 的 PUT /api/plugins/packages）把包准备好，
 * 网页出授权单；你确认以后 plugins.install。这两个的范围是 install-plugins：不给 AI 助手（授权单必须由你确认），设备默认也没有。
 */
import {
  ChooseOverrideInput,
  CreateOverridePluginInput,
  InspectPluginInput,
  InstallPluginInput,
  PluginIdInput,
  PluginPackageTokenInput,
  SaveAiViewInput,
  PluginsStateInput,
  RenamePluginInput,
  SetNavInput,
  SetOverrideValuesInput,
  SetPluginEnabledInput,
} from '@emaki/shared/schemas';
import { BadRequestError } from '../http/errors.ts';
import { defineCommand, defineQuery } from './registry.ts';

export const pluginQueries = [
  defineQuery({
    name: 'plugins.state',
    summary: '全部插件（内置的页面、我的覆盖……）和生效的结果：侧栏的顺序、停用的页面、每个能覆盖的值现在是多少、谁给的',
    input: PluginsStateInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/plugins' }],
    run: (e, q) => e.plugins.state({ safe: q.safe }),
  }),
  defineQuery({
    name: 'plugins.package',
    summary: '准备好的一个包（还没装）：授权单要列的东西。助手的保存卡片、「插件」页的确认链接按 token 再取一次',
    input: PluginPackageTokenInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/plugins/packages/:token' }],
    run: (e, q) => e.plugins.stagedPackage(q.token),
  }),
];

export const pluginCommands = [
  defineCommand({
    name: 'plugins.setEnabled',
    summary: '启用或停用一个插件（停用内置的页面：导航和入口一起不见，不改数据；必需的不能停用）',
    input: SetPluginEnabledInput,
    scope: 'plugins',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/plugins/:id/enabled' }],
    tx: (e, { id, enabled }) => e.plugins.setEnabled(id, enabled),
  }),
  defineCommand({
    name: 'plugins.rename',
    summary: '改插件显示的名字（页面插件的导航项跟着变）；name 为 null 恢复原名',
    input: RenamePluginInput,
    scope: 'plugins',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/plugins/:id/name' }],
    tx: (e, { id, name }) => e.plugins.rename(id, name),
  }),
  defineCommand({
    name: 'plugins.remove',
    summary: '删除「我的」插件、卸载装的插件：它的授权和存储一起删，它导入的图和改过的数据留着（内置的不能删，可以停用）',
    input: PluginIdInput,
    scope: 'plugins',
    undoable: true,
    idempotent: true,
    http: [{ method: 'DELETE', path: '/api/plugins/:id' }],
    mcp: { destructive: true },
    tx: (e, { id }) => e.plugins.remove(id),
  }),
  defineCommand({
    name: 'plugins.createOverride',
    summary: '新建一个覆盖插件：只含配置，比如把图片的默认排序改成按修改时间；建好默认就启用，停用就回到原来的默认',
    input: CreateOverridePluginInput,
    scope: 'plugins',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/plugins/overrides' }],
    tx: (e, input) => e.plugins.createOverride(input),
  }),
  defineCommand({
    name: 'plugins.setOverrideValues',
    summary: '改一个「我的」覆盖插件里的值',
    input: SetOverrideValuesInput,
    scope: 'plugins',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/plugins/:id/overrides' }],
    tx: (e, { id, values }) => e.plugins.setOverrideValues(id, values),
  }),
  defineCommand({
    name: 'plugins.setNav',
    summary: '侧栏（手机上是底部标签栏）：三段各自的页面顺序、在不在侧栏显示',
    input: SetNavInput,
    scope: 'plugins',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/plugins/nav' }],
    tx: (e, input) => {
      if (!input.sections && !input.visible) throw new BadRequestError('要给 sections 或 visible');
      return e.plugins.setNav(input);
    },
  }),
  defineCommand({
    name: 'plugins.chooseOverride',
    summary: '两个启用的插件覆盖同一个值时，选用哪个插件的（plugin 为 null：按后启用的那个）',
    input: ChooseOverrideInput,
    scope: 'plugins',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/plugins/overrides/choice' }],
    tx: (e, { key, plugin }) => e.plugins.chooseOverride(key, plugin),
  }),
  defineCommand({
    name: 'plugins.inspect',
    summary: '准备安装一个插件：从这台电脑上的文件夹，或者 git 地址取来、读清单、检查，返回授权单要列的东西（还没装）',
    input: InspectPluginInput,
    scope: 'install-plugins',
    undoable: false,
    barrier: false,
    idempotent: false,
    http: [{ method: 'POST', path: '/api/plugins/packages/inspect' }],
    run: (e, { source }) => e.plugins.inspect(source),
  }),
  defineCommand({
    name: 'plugins.checkUpdate',
    summary: '装的插件再从它的来源取一遍（git 重新下载、文件夹重新读取），返回新版本和这次要新给的权限（还没更新）',
    input: PluginIdInput,
    scope: 'install-plugins',
    undoable: false,
    barrier: false,
    idempotent: false,
    http: [{ method: 'POST', path: '/api/plugins/:id/check-update' }],
    run: (e, { id }) => e.plugins.checkUpdate(id),
  }),
  defineCommand({
    name: 'plugins.install',
    summary: '授权单上确认了：装上（或更新）准备好的插件，新装的直接启用',
    input: InstallPluginInput,
    scope: 'install-plugins',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/plugins/install' }],
    run: (e, { token, folders, showInNav }) => e.plugins.install(token, folders, { showInNav }),
  }),
  defineCommand({
    name: 'plugins.saveView',
    summary:
      'AI 助手做的页面（docs/plugins.md 5.1）：存成插件 ai.<name>。第一次存、或者多要了权限时只准备好包，等你在授权单上确认（plugins.install）；修改已有的页面、权限没变时直接存成新的一版',
    input: SaveAiViewInput,
    scope: 'plugins',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/plugins/ai-views' }],
    run: (e, input) => {
      const r = e.plugins.saveAiView(input);
      if (r.status === 'saved') return r;
      return {
        status: r.status,
        id: r.id,
        token: r.package.token,
        name: r.package.manifest.name,
        version: r.package.manifest.version,
        message: `「${r.package.manifest.name}」准备好了，等你确认保存`,
      };
    },
  }),
];
