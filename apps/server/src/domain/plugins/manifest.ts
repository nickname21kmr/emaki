/**
 * 插件清单 emaki-plugin.json 的检查（docs/plugins.md 第 8 节）。结构用 shared 的 PluginManifestSchema；
 * 其余（版本范围、要的权限插件能不能拿、贡献点认不认识、覆盖的值对不对）逐项写成能看懂的话，授权单和插件页上直接显示。
 *
 * 装的时候检查一次（装不上就不让装），之后每次算插件状态时用当前的 Emaki 版本再查一次：Emaki 升级后不兼容的自动不生效、写明原因。
 */
import {
  INSTALLABLE_POINTS,
  OVERRIDES,
  PLUGIN_GRANTABLE_SCOPES,
  SCOPES,
  satisfies,
  validOverride,
  validRange,
  validVersion,
  type Contributes,
  type NavItemContribution,
  type OverrideKey,
  type PageContribution,
  type PluginManifest,
  type PluginPermissions,
  type Scope,
} from '@emaki/shared';
import { InstalledNavItemSchema, InstalledPageSchema, PluginManifestSchema } from '@emaki/shared/schemas';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const MANIFEST_FILE = 'emaki-plugin.json';
/** 一个视图文件最大多少（官方 App 类由宿主在 /plugin-sdk/app.js 提供，视图本身不用带） */
export const MAX_VIEW_BYTES = 2 * 1024 * 1024;

/** 留给 Emaki 自己的 id 前缀：内置的、我的、AI 做的 */
const RESERVED_PREFIXES = ['core.', 'mine.', 'ai.'];

export interface CheckedManifest {
  /** 结构对的话是规范化以后的清单（去重、补默认值）；结构不对是 null */
  manifest: PluginManifest | null;
  /** 装不上 / 不能启用的原因 */
  problems: string[];
}

const scopeName = (s: Scope) => SCOPES[s].split(/[：（]/)[0]!;
const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];

/** ai：AI 助手做的页面（id 必须是 ai. 开头，宿主生成的清单）；别的插件不能用 core.、mine.、ai. */
export function checkManifest(raw: unknown, emakiVersion: string, opts: { ai?: boolean } = {}): CheckedManifest {
  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success)
    return {
      manifest: null,
      problems: parsed.error.issues.slice(0, 5).map((i) => `清单里的 ${i.path.join('.') || '内容'}：${i.message}`),
    };
  const m = parsed.data;
  const problems: string[] = [];

  if (opts.ai) {
    if (!m.id.startsWith('ai.')) problems.push(`AI 做的页面的 id 要以 ai. 开头（现在是「${m.id}」）`);
  } else if (RESERVED_PREFIXES.some((p) => m.id.startsWith(p))) problems.push(`id「${m.id}」以 ${m.id.split('.')[0]}. 开头，这是留给 Emaki 自己的`);
  if (!validVersion(m.version)) problems.push(`版本号「${m.version}」要写成 1.2.3 这样`);
  const range = m.engines?.emaki;
  if (range !== undefined) {
    if (!validRange(range)) problems.push(`engines.emaki「${range}」不是能看懂的版本范围`);
    else if (!satisfies(emakiVersion, range)) problems.push(`需要 Emaki ${range}，现在是 ${emakiVersion}`);
  }

  // 权限
  const perms = m.permissions ?? {};
  const scopes: Scope[] = [];
  for (const s of uniq(perms.scopes ?? [])) {
    if (!(s in SCOPES)) problems.push(`要的权限「${s}」Emaki 不认识`);
    else if (!PLUGIN_GRANTABLE_SCOPES.includes(s as Scope)) problems.push(`要的权限「${scopeName(s as Scope)}」只给人和设备，插件拿不到`);
    else scopes.push(s as Scope);
  }
  const folderIds = (perms.folders ?? []).map((f) => f.id);
  if (new Set(folderIds).size !== folderIds.length) problems.push('permissions.folders 里有重复的 id');
  if (perms.unsafe) problems.push('它要改 Emaki 的内部（第 3 层），这个版本的 Emaki 还不支持');
  if (m.server) problems.push('它带服务端代码，这个版本的 Emaki 还不能运行');
  const permissions: PluginPermissions = {
    ...(scopes.length && { scopes }),
    ...(perms.folders?.length && { folders: perms.folders }),
    ...(perms.network?.length && { network: uniq(perms.network.map((h) => h.toLowerCase())) }),
    ...(perms.background && { background: true }),
    ...(perms.unsafe && { unsafe: true }),
  };

  // 贡献点：只认这个版本的 Emaki 给装的插件开放的
  const contributes: Contributes = {};
  for (const [point, value] of Object.entries(m.contributes)) {
    if (!(INSTALLABLE_POINTS as readonly string[]).includes(point)) {
      problems.push(`用到了「${point}」，这个版本的 Emaki 还不支持`);
      continue;
    }
    if (point === 'nav.item@1') {
      const r = InstalledNavItemSchema.array().max(10).safeParse(value);
      if (!r.success) {
        const i = r.error.issues[0]!;
        problems.push(`nav.item@1 的 ${i.path.join('.')}：${i.message}`);
        continue;
      }
      const ids = r.data.map((n) => n.id);
      if (new Set(ids).size !== ids.length) problems.push('nav.item@1 里有重复的 id');
      contributes['nav.item@1'] = r.data as NavItemContribution[];
    } else if (point === 'override@1') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        problems.push('override@1 要写成 { "值的名字": "值" }');
        continue;
      }
      const values: Partial<Record<OverrideKey, unknown>> = {};
      for (const [k, v] of Object.entries(value)) {
        if (!(k in OVERRIDES)) problems.push(`override@1 里的「${k}」Emaki 不认识`);
        else if (!validOverride(k, v))
          problems.push(`「${OVERRIDES[k as OverrideKey].label}」不能是「${String(v)}」，能用的：${OVERRIDES[k as OverrideKey].options.map((o) => o.value).join('、')}`);
        else values[k] = v;
      }
      contributes['override@1'] = values;
    } else if (point === 'page@1') {
      const r = InstalledPageSchema.array().min(1).max(10).safeParse(value);
      if (!r.success) {
        const i = r.error.issues[0]!;
        problems.push(`page@1 的 ${i.path.join('.')}：${i.message}`);
        continue;
      }
      const ids = r.data.map((p) => p.id);
      if (new Set(ids).size !== ids.length) problems.push('page@1 里有重复的 id');
      contributes['page@1'] = r.data as PageContribution[];
    }
  }
  // 导航项指向自己的页面：要有这一页
  for (const n of contributes['nav.item@1'] ?? [])
    if (n.page !== undefined && !contributes['page@1']?.some((p) => p.id === n.page)) problems.push(`导航项「${n.label}」指向的页面「${n.page}」在 page@1 里没有`);
  if (!Object.keys(m.contributes).length) problems.push('它什么都没有贡献（contributes 是空的）');

  const manifest: PluginManifest = {
    id: m.id,
    name: m.name,
    version: m.version,
    ...(m.description && { description: m.description }),
    ...(m.author && { author: m.author }),
    ...(m.homepage && { homepage: m.homepage }),
    ...(range !== undefined && { engines: { emaki: range } }),
    ...(Object.keys(permissions).length && { permissions }),
    contributes,
  };
  return { manifest, problems };
}

/** 读一个包里的清单（去掉 BOM）；读不到、不是 JSON 都写成问题 */
export function readManifest(dir: string, emakiVersion: string, opts: { ai?: boolean } = {}): CheckedManifest {
  let text: string;
  try {
    text = readFileSync(path.join(dir, MANIFEST_FILE), 'utf8').replace(/^﻿/, '');
  } catch {
    return { manifest: null, problems: [`没有找到 ${MANIFEST_FILE}`] };
  }
  let checked: CheckedManifest;
  try {
    checked = checkManifest(JSON.parse(text), emakiVersion, opts);
  } catch (e) {
    return { manifest: null, problems: [`${MANIFEST_FILE} 不是合法的 JSON：${(e as Error).message}`] };
  }
  if (checked.manifest) checked.problems.push(...checkViewFiles(dir, checked.manifest));
  return checked;
}

/** 视图文件在不在包里、大不大（装的时候查，之后每次算状态再查：文件夹装的可能改了） */
export function checkViewFiles(dir: string, m: PluginManifest): string[] {
  const problems: string[] = [];
  for (const p of m.contributes['page@1'] ?? []) {
    if (!p.view) continue;
    const size = fileSize(path.join(dir, ...p.view.split('/')));
    if (size === null) problems.push(`页面「${p.title ?? p.id}」的视图文件 ${p.view} 不在包里`);
    else if (size > MAX_VIEW_BYTES) problems.push(`页面「${p.title ?? p.id}」的视图文件 ${p.view} 太大（最多 ${MAX_VIEW_BYTES / 1024 / 1024} MB）`);
  }
  return problems;
}

function fileSize(file: string): number | null {
  try {
    const st = statSync(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}
