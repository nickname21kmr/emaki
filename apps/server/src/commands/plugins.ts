/**
 * 插件（docs/plugins.md 第 9 节）：插件管理的查询和命令。写入都在插件模块（domain/plugins/），都能撤销。
 */
import {
  ChooseOverrideInput,
  CreateOverridePluginInput,
  PluginIdInput,
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
    summary: '删除一个「我的」插件（内置的不能删，可以停用）',
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
];
