/**
 * 插件管理（docs/plugins.md 第 9 节）：统一的那一层。管插件本身（身份、启用、显示名、删除），算出「生效的贡献清单」；
 * 各贡献点（侧栏、页面、区块、覆盖的值）用这个结果，不知道插件是怎么装、怎么启用的。
 *
 * 表（迁移 052）只由这里写：plugin_state（启用、改的名字）、user_plugins（我的插件的清单）、plugin_point_state（贡献点自己的状态：
 * 侧栏的顺序和在不在侧栏、覆盖冲突时选了哪个）。写入都走 ctx.mutate：能撤销，声明 plugins.changed（缓存失效、网页刷新）。
 *
 * 状态每次现算（几张小表，几十行）：撤销直接还原表，不用操心内存里的副本过期。
 */
import {
  BUILTIN_PLUGINS,
  NAV_SECTIONS,
  OVERRIDE_KEYS,
  OVERRIDES,
  PINNED_NAV,
  pluginLabel,
  resolvePlugins,
  validOverride,
  type NavLayout,
  type NavSection,
  type OverrideKey,
  type OverrideValue,
  type PluginInfo,
  type PluginManifest,
  type PluginRecord,
  type PluginsState,
} from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import { iso } from '../../datasource/sqlite/sql.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { BadRequestError, NotFoundError } from '../../http/errors.ts';

interface StateRow {
  id: string;
  enabled: number;
  display_name: string | null;
  enabled_at: string | null;
}

interface Loaded {
  manifest: PluginManifest;
  source: PluginInfo['source'];
  required: boolean;
  row: StateRow | undefined;
}

export class Plugins {
  private readonly db: Db;

  constructor(
    private readonly ctx: SqliteContext,
    /** 服务端以安全模式启动（--safe） */
    private readonly safeMode: boolean,
  ) {
    this.db = ctx.db;
  }

  // ---------------------------------------------------------------- 读

  /** 全部插件和生效的结果（计算在 @emaki/shared 的 resolvePlugins，网页没取到时也用它）。safe：这一次按安全模式算（网页地址带 ?safe） */
  state(opts: { safe?: boolean } = {}): PluginsState {
    const safe = this.safeMode || !!opts.safe;
    return resolvePlugins({
      plugins: this.records(safe),
      nav: safe ? { sections: {}, visible: {} } : this.navLayout(),
      overrideChoices: safe ? {} : this.overrideChoices(),
      safeMode: safe,
    });
  }

  /** 某个值现在生效的是什么（服务端自己用，比如图片列表没给排序时按它排；安全模式下是内置默认） */
  overrideValue<K extends OverrideKey>(key: K): OverrideValue<K> {
    return this.state().overrides[key].value as OverrideValue<K>;
  }

  // ---------------------------------------------------------------- 写（都能撤销）

  setEnabled(id: string, enabled: boolean) {
    const p = this.require(id);
    if (!enabled && p.required) throw new BadRequestError(`「${pluginLabel(this.info(p))}」是必需的，不能停用`);
    return this.ctx.mutate((u) => {
      u.set('plugin_state', 'id = ?', [id]);
      const now = iso(this.ctx.clock());
      this.db
        .prepare(
          `INSERT INTO plugin_state (id, enabled, enabled_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled,
             enabled_at = CASE WHEN excluded.enabled = 1 THEN excluded.enabled_at ELSE plugin_state.enabled_at END,
             updated_at = excluded.updated_at`,
        )
        .run(id, enabled ? 1 : 0, enabled ? now : null, now);
      this.changed();
      return { message: `${enabled ? '已启用' : '已停用'}「${pluginLabel(this.info(p))}」` };
    });
  }

  rename(id: string, name: string | null) {
    const p = this.require(id);
    const next = name?.trim() || null;
    return this.ctx.mutate((u) => {
      u.set('plugin_state', 'id = ?', [id]);
      const now = iso(this.ctx.clock());
      this.db
        .prepare(
          `INSERT INTO plugin_state (id, enabled, display_name, enabled_at, updated_at) VALUES (?, 1, ?, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
        )
        .run(id, next === p.manifest.name ? null : next, now);
      this.changed();
      return { message: next && next !== p.manifest.name ? `已改名为「${next}」` : `「${p.manifest.name}」已恢复原名` };
    });
  }

  remove(id: string) {
    const p = this.require(id);
    if (p.source === 'builtin') throw new BadRequestError(`「${pluginLabel(this.info(p))}」是内置的，不能删除，可以停用`);
    return this.ctx.mutate((u) => {
      u.set('user_plugins', 'id = ?', [id]);
      u.set('plugin_state', 'id = ?', [id]);
      this.db.prepare('DELETE FROM user_plugins WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM plugin_state WHERE id = ?').run(id);
      this.changed();
      return { message: `已删除「${pluginLabel(this.info(p))}」` };
    });
  }

  /** 新建一个覆盖插件（我的）：只含配置，建好默认就启用 */
  createOverride(input: { name: string; values: Record<string, string>; enabled?: boolean }) {
    const values = checkValues(input.values);
    const name = input.name.trim();
    const id = this.newId();
    const manifest: PluginManifest = { id, name, version: '1', contributes: { 'override@1': values } };
    const enabled = input.enabled ?? true;
    const result = this.ctx.mutate((u) => {
      u.set('user_plugins', 'id = ?', [id]);
      u.set('plugin_state', 'id = ?', [id]);
      const now = iso(this.ctx.clock());
      this.db.prepare('INSERT INTO user_plugins (id, manifest, created_at) VALUES (?, ?, ?)').run(id, JSON.stringify(manifest), now);
      this.db
        .prepare('INSERT INTO plugin_state (id, enabled, enabled_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(id, enabled ? 1 : 0, enabled ? now : null, now);
      this.changed();
      return { message: `已新建${enabled ? '并启用' : ''}「${name}」` };
    });
    return { ...result, id };
  }

  /** 改一个覆盖插件（我的）里的值 */
  setOverrideValues(id: string, raw: Record<string, string>) {
    const p = this.require(id);
    if (p.source !== 'mine' || !p.manifest.contributes['override@1'])
      throw new BadRequestError(`「${pluginLabel(this.info(p))}」不是你建的覆盖插件，不能改它的值`);
    const values = checkValues(raw);
    return this.ctx.mutate((u) => {
      u.set('user_plugins', 'id = ?', [id]);
      const manifest: PluginManifest = { ...p.manifest, contributes: { ...p.manifest.contributes, 'override@1': values } };
      this.db.prepare('UPDATE user_plugins SET manifest = ? WHERE id = ?').run(JSON.stringify(manifest), id);
      this.changed();
      return { message: `已更新「${pluginLabel(this.info(p))}」` };
    });
  }

  /** 侧栏：三段的顺序、在不在侧栏（只改给出的部分） */
  setNav(input: { sections?: Record<NavSection, string[]>; visible?: Record<string, boolean> }) {
    const cur = this.navLayout();
    const known = new Set(this.load(false).flatMap((p) => (p.manifest.contributes['nav.item@1'] ?? []).map((n) => n.id)));
    const next: NavLayout = { sections: cur.sections, visible: { ...cur.visible } };
    if (input.sections) {
      const seen = new Set<string>();
      next.sections = Object.fromEntries(
        NAV_SECTIONS.map((s) => [s, input.sections![s].filter((id) => known.has(id) && !seen.has(id) && (seen.add(id), true))]),
      );
    }
    for (const [id, v] of Object.entries(input.visible ?? {})) {
      if (!known.has(id)) continue;
      if (!v && PINNED_NAV.has(id)) throw new BadRequestError('「设置」要一直留在侧栏里：插件页的入口在设置里');
      next.visible[id] = v;
    }
    return this.ctx.mutate((u) => {
      u.set('plugin_point_state', "point = 'nav'");
      this.db
        .prepare("INSERT INTO plugin_point_state (point, key, value) VALUES ('nav', 'layout', ?) ON CONFLICT(point, key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(next));
      this.changed();
      return { message: input.sections ? '已调整侧栏的顺序' : '已更新侧栏' };
    });
  }

  /** 覆盖冲突：这个值用哪个插件的（null = 按后启用的那个） */
  chooseOverride(key: string, plugin: string | null) {
    if (!(key in OVERRIDES)) throw new BadRequestError(`没有能覆盖的值「${key}」`);
    if (plugin) this.require(plugin);
    return this.ctx.mutate((u) => {
      u.set('plugin_point_state', "point = 'override' AND key = ?", [key]);
      this.db.prepare("DELETE FROM plugin_point_state WHERE point = 'override' AND key = ?").run(key);
      if (plugin) this.db.prepare("INSERT INTO plugin_point_state (point, key, value) VALUES ('override', ?, ?)").run(key, JSON.stringify(plugin));
      this.changed();
      return { message: `「${OVERRIDES[key as OverrideKey].label}」${plugin ? '改用你选的插件' : '按后启用的插件'}` };
    });
  }

  // ---------------------------------------------------------------- 内部

  private changed(): void {
    this.ctx.changed({ type: 'plugins.changed', ids: [] });
  }

  private load(safe: boolean): Loaded[] {
    const rows = new Map(
      (this.db.prepare('SELECT id, enabled, display_name, enabled_at FROM plugin_state').all() as StateRow[]).map((r) => [r.id, r]),
    );
    const builtins: Loaded[] = BUILTIN_PLUGINS.map((m) => ({
      manifest: m,
      source: 'builtin',
      required: !!m.required,
      row: rows.get(m.id),
    }));
    if (safe) return builtins;
    const mine: Loaded[] = [];
    for (const r of this.db.prepare('SELECT id, manifest FROM user_plugins ORDER BY created_at, id').all() as { id: string; manifest: string }[]) {
      try {
        const m = JSON.parse(r.manifest) as PluginManifest;
        mine.push({ manifest: { ...m, id: r.id }, source: 'mine', required: false, row: rows.get(r.id) });
      } catch {
        // 清单坏了：当它不存在（以后 E2 在插件页上标出来）
      }
    }
    return [...builtins, ...mine];
  }

  /** 每个插件这一次算出来的状态（安全模式下只有内置的、全部启用、原名） */
  private records(safe: boolean): PluginRecord[] {
    return this.load(safe).map((p) => ({
      manifest: p.manifest,
      source: p.source,
      required: p.required,
      enabled: p.required || (safe ? p.source === 'builtin' : p.row ? p.row.enabled === 1 : true),
      displayName: safe ? null : (p.row?.display_name ?? null),
      enabledAt: p.row?.enabled_at ?? null,
    }));
  }

  private overrideChoices(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM plugin_point_state WHERE point = 'override'").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.flatMap((r) => {
      const v = safeParse(r.value);
      return typeof v === 'string' ? [[r.key, v]] : [];
    }));
  }

  private require(id: string): Loaded {
    const p = this.load(false).find((x) => x.manifest.id === id);
    if (!p) throw new NotFoundError(`没有插件「${id}」`);
    return p;
  }

  private info(p: Loaded): Pick<PluginInfo, 'name' | 'displayName'> {
    return { name: p.manifest.name, displayName: p.row?.display_name ?? null };
  }

  private newId(): string {
    const taken = new Set((this.db.prepare('SELECT id FROM user_plugins').all() as { id: string }[]).map((r) => r.id));
    for (let n = 1; ; n++) if (!taken.has(`mine.override-${n}`)) return `mine.override-${n}`;
  }

  private navLayout(): NavLayout {
    const row = this.db.prepare("SELECT value FROM plugin_point_state WHERE point = 'nav' AND key = 'layout'").get() as { value: string } | undefined;
    try {
      const v = row ? (JSON.parse(row.value) as Partial<NavLayout>) : {};
      return { sections: v.sections ?? {}, visible: v.visible ?? {} };
    } catch {
      return { sections: {}, visible: {} };
    }
  }

}

function checkValues(raw: Record<string, string>): Partial<Record<OverrideKey, string>> {
  const entries = Object.entries(raw);
  if (!entries.length) throw new BadRequestError('至少要覆盖一个值');
  for (const [k, v] of entries) {
    if (!(k in OVERRIDES)) throw new BadRequestError(`没有能覆盖的值「${k}」；能用的：${OVERRIDE_KEYS.join('、')}`);
    if (!validOverride(k, v))
      throw new BadRequestError(`「${OVERRIDES[k as OverrideKey].label}」不能是「${v}」；能用的：${OVERRIDES[k as OverrideKey].options.map((o) => o.value).join('、')}`);
  }
  return raw as Partial<Record<OverrideKey, string>>;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
