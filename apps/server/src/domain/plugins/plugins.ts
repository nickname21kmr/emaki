/**
 * 插件管理（docs/plugins.md 第 9 节）：统一的那一层。管插件本身（身份、启用、显示名、删除），算出「生效的贡献清单」；
 * 各贡献点（侧栏、页面、区块、覆盖的值）用这个结果，不知道插件是怎么装、怎么启用的。
 *
 * 表（迁移 052、053）只由这里写：plugin_state（启用、改的名字、自动停用的原因）、user_plugins（我的插件的清单）、
 * installed_plugins（装的插件：清单、从哪装的、包在哪）、plugin_grants（授权单上确认过的授权）、plugin_storage（插件自己的键值）、
 * plugin_errors（出错记录）、plugin_point_state（贡献点自己的状态：侧栏的顺序和在不在侧栏、覆盖冲突时选了哪个）。
 * 你做的修改都走 ctx.mutate：能撤销，声明 plugins.changed（缓存失效、网页刷新）；出错记录、自动停用不是你做的，不进撤销栈。
 *
 * 状态每次现算（几张小表，几十行）：撤销直接还原表，不用操心内存里的副本过期。
 *
 * 装插件分两步（docs/plugins.md 4.2）：先把包准备好（inspect*：解开、读清单、检查，算出这次要新给的权限），
 * 网页据此出一张授权单；你确认以后 install 才写库。更新也一样，权限没多就不用再出授权单。
 */
import {
  BUILTIN_PLUGINS,
  EMPTY_GRANT,
  missingPermissions,
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
  type FolderGrant,
  type Grant,
  type ID,
  type PackageKind,
  type PluginErrorInfo,
  type PluginInfo,
  type PluginManifest,
  type PluginPackage,
  type PluginRecord,
  type PluginsState,
} from '@emaki/shared';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../../db/connection.ts';
import { iso, parseId } from '../../datasource/sqlite/sql.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { BadRequestError, NotFoundError } from '../../http/errors.ts';
import { ROOT_ACTIVE } from '../../readmodel/terms.ts';
import type { PluginPackages, Staged } from '../../services/plugins/packages.ts';
import { normalizeSubdir } from '../library/move.ts';
import { checkManifest, MANIFEST_FILE, readManifest } from './manifest.ts';
import { PluginStorage } from './storage.ts';

/** 自动停用：这么久之内出错这么多次 */
export const AUTO_DISABLE = { errors: 5, windowMs: 10 * 60_000 };
/** 每个插件留多少条出错记录 */
const KEEP_ERRORS = 20;

interface StateRow {
  id: string;
  enabled: number;
  display_name: string | null;
  enabled_at: string | null;
  disabled_reason: string | null;
}

interface InstalledRow {
  id: string;
  manifest: string;
  source_kind: PackageKind;
  source: string;
  source_ref: string | null;
  package_dir: string;
  installed_at: string;
  updated_at: string;
}

interface Loaded {
  manifest: PluginManifest;
  source: PluginInfo['source'];
  required: boolean;
  row: StateRow | undefined;
  problems: string[];
  installed?: InstalledRow;
  grant?: Grant;
}

export class Plugins {
  private readonly db: Db;
  /** 插件自己的键值存储（E4 的视图、E5 的服务端逻辑用） */
  readonly storage: PluginStorage;

  constructor(
    private readonly ctx: SqliteContext,
    /** 服务端以安全模式启动（--safe） */
    private readonly safeMode: boolean,
    private readonly packages: PluginPackages,
    /** 现在的 Emaki 版本：检查插件的 engines.emaki */
    private readonly emakiVersion: string,
  ) {
    this.db = ctx.db;
    this.storage = new PluginStorage(ctx);
  }

  /** 启动时：清掉没装完的包、没有插件指向的包 */
  cleanup(): void {
    const dirs = this.db.prepare("SELECT package_dir FROM installed_plugins WHERE source_kind != 'folder'").pluck().all() as string[];
    this.packages.cleanup(dirs);
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
    if (enabled && p.problems.length) throw new BadRequestError(`「${pluginLabel(this.info(p))}」不能启用：${p.problems[0]}`);
    return this.ctx.mutate((u) => {
      u.set('plugin_state', 'id = ?', [id]);
      const now = iso(this.ctx.clock());
      // 你重新启用了，自动停用的原因就不用再显示
      this.db
        .prepare(
          `INSERT INTO plugin_state (id, enabled, enabled_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled,
             enabled_at = CASE WHEN excluded.enabled = 1 THEN excluded.enabled_at ELSE plugin_state.enabled_at END,
             disabled_reason = CASE WHEN excluded.enabled = 1 THEN NULL ELSE plugin_state.disabled_reason END,
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

  /**
   * 删除我的插件、卸载装的插件：它的清单、授权、存储、启用状态一起删（能撤销）；出错记录直接删掉。
   * 装的包留在磁盘上，下次启动时没有插件指向就删（撤销只在内存里，重启以后找不回来了）。它导入的图和改过的数据留着
   */
  remove(id: string) {
    const p = this.require(id);
    if (p.source === 'builtin') throw new BadRequestError(`「${pluginLabel(this.info(p))}」是内置的，不能删除，可以停用`);
    return this.ctx.mutate((u) => {
      u.set('user_plugins', 'id = ?', [id]);
      u.set('installed_plugins', 'id = ?', [id]);
      u.set('plugin_state', 'id = ?', [id]);
      u.set('plugin_grants', 'plugin_id = ?', [id]);
      u.set('plugin_storage', 'plugin_id = ?', [id]);
      this.db.prepare('DELETE FROM user_plugins WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM installed_plugins WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM plugin_state WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM plugin_grants WHERE plugin_id = ?').run(id);
      this.db.prepare('DELETE FROM plugin_storage WHERE plugin_id = ?').run(id);
      this.db.prepare('DELETE FROM plugin_errors WHERE plugin_id = ?').run(id);
      this.changed();
      return { message: `已${p.source === 'installed' ? '卸载' : '删除'}「${pluginLabel(this.info(p))}」` };
    });
  }

  // ---------------------------------------------------------------- 装插件（docs/plugins.md E2）

  /** 从 zip 准备一个包（PUT /api/plugins/packages） */
  inspectZip(fileName: string, buf: Buffer): PluginPackage {
    return this.toPackage(this.packages.stageZip(fileName, buf));
  }

  /** 从文件夹、git 地址准备一个包（plugins.inspect） */
  async inspect(source: { kind: 'folder'; path: string } | { kind: 'git'; url: string; ref?: string }): Promise<PluginPackage> {
    const staged =
      source.kind === 'folder' ? this.packages.stageFolder(source.path) : await this.packages.stageGit(source.url, source.ref?.trim() || null);
    return this.toPackage(staged);
  }

  /** 装过的插件再取一遍它的来源（git 重新下载、文件夹重新读取），交给授权单比较；从文件装的要你选新的文件 */
  async checkUpdate(id: string): Promise<PluginPackage> {
    const p = this.require(id);
    if (!p.installed) throw new BadRequestError(`「${pluginLabel(this.info(p))}」不是装的插件`);
    const r = p.installed;
    if (r.source_kind === 'file') throw new BadRequestError('从文件装的插件，选新的文件来更新');
    const pkg =
      r.source_kind === 'folder' ? await this.inspect({ kind: 'folder', path: r.source }) : await this.inspect({ kind: 'git', url: r.source, ...(r.source_ref && { ref: r.source_ref }) });
    if (pkg.manifest.id !== id) {
      this.packages.discard(pkg.token);
      throw new BadRequestError(`来源里现在是另一个插件「${pkg.manifest.id}」，不是「${id}」`);
    }
    return pkg;
  }

  /**
   * 授权单上确认了：装上（或更新）并启用。folders 是授权单上给每个要的文件夹选的位置（不给的用默认）。
   * 包先放到固定的位置，再在一个事务里写清单、授权、启用状态；能撤销（撤销后包在下次启动时删掉）
   */
  install(token: string, folders: Record<string, { rootId: ID; dir: string }> = {}) {
    const staged = this.packages.get(token);
    if (!staged) throw new BadRequestError('这个包已经过期了，重新选一次');
    const { manifest, problems } = this.checkStaged(staged);
    if (!manifest || problems.length) {
      this.packages.discard(token);
      throw new BadRequestError(problems[0] ?? '装不上');
    }
    const id = manifest.id;
    const existing = this.installedRow(id);
    const oldGrant = existing ? this.grantOf(id) : null;
    const grant: Grant = {
      scopes: [...(manifest.permissions?.scopes ?? [])],
      folders: (manifest.permissions?.folders ?? []).map((f): FolderGrant => {
        const chosen = folders[f.id];
        if (chosen) return { id: f.id, ...this.checkFolder(chosen.rootId, chosen.dir) };
        const old = oldGrant?.folders.find((x) => x.id === f.id);
        if (old) return old;
        const def = this.defaultFolder(f.suggest, manifest.name);
        if (!def) throw new BadRequestError('还没有能放文件的图库文件夹（要「自动识别」的），先在设置里加一个');
        return { id: f.id, ...def };
      }),
      network: [...(manifest.permissions?.network ?? [])],
      background: !!manifest.permissions?.background,
      unsafe: !!manifest.permissions?.unsafe,
    };
    const dir = this.packages.commit(staged, id, manifest.version);
    const result = this.ctx.mutate((u) => {
      u.set('installed_plugins', 'id = ?', [id]);
      u.set('plugin_grants', 'plugin_id = ?', [id]);
      u.set('plugin_state', 'id = ?', [id]);
      const now = iso(this.ctx.clock());
      this.db
        .prepare(
          `INSERT INTO installed_plugins (id, manifest, source_kind, source, source_ref, package_dir, installed_at, updated_at)
           VALUES (@id, @manifest, @kind, @source, @ref, @dir, @now, @now)
           ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, source_kind = excluded.source_kind, source = excluded.source,
             source_ref = excluded.source_ref, package_dir = excluded.package_dir, updated_at = excluded.updated_at`,
        )
        .run({ id, manifest: JSON.stringify(manifest), kind: staged.kind, source: staged.location, ref: staged.ref, dir, now });
      this.db
        .prepare(
          `INSERT INTO plugin_grants (plugin_id, grant_json, granted_at) VALUES (?, ?, ?)
           ON CONFLICT(plugin_id) DO UPDATE SET grant_json = excluded.grant_json, granted_at = excluded.granted_at`,
        )
        .run(id, JSON.stringify(grant), now);
      // 新装的启用；更新的保持原来的启用状态
      if (!existing)
        this.db
          .prepare(
            `INSERT INTO plugin_state (id, enabled, enabled_at, updated_at) VALUES (?, 1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET enabled = 1, enabled_at = excluded.enabled_at, disabled_reason = NULL, updated_at = excluded.updated_at`,
          )
          .run(id, now, now);
      this.changed();
      const old = existing ? (safeParse(existing.manifest) as PluginManifest | null) : null;
      return {
        message: !existing
          ? `已安装并启用「${manifest.name}」`
          : old?.version === manifest.version
            ? `已重新读取「${manifest.name}」`
            : `已把「${manifest.name}」更新到 ${manifest.version}`,
      };
    });
    return { ...result, id };
  }

  /** 不装了：删掉准备好的包 */
  discardPackage(token: string): void {
    this.packages.discard(token);
  }

  // ---------------------------------------------------------------- 出错和自动停用（docs/plugins.md 第 8 节）

  /**
   * 记一次插件出错（视图坏了、服务端逻辑崩了……，E4、E5 接上）。AUTO_DISABLE.windowMs 内出错 AUTO_DISABLE.errors 次就自动停用，
   * 写明原因；不进撤销栈。返回这次是不是把它停用了
   */
  recordError(id: string, source: string, message: string): { autoDisabled: boolean } {
    const p = this.require(id);
    const now = this.ctx.clock();
    return this.ctx.apply(() => {
      this.db
        .prepare('INSERT INTO plugin_errors (plugin_id, at, source, message) VALUES (?, ?, ?, ?)')
        .run(id, iso(now), source.slice(0, 40), message.slice(0, 500));
      this.db
        .prepare(
          'DELETE FROM plugin_errors WHERE plugin_id = ? AND id NOT IN (SELECT id FROM plugin_errors WHERE plugin_id = ? ORDER BY id DESC LIMIT ?)',
        )
        .run(id, id, KEEP_ERRORS);
      const recent = this.db
        .prepare('SELECT COUNT(*) FROM plugin_errors WHERE plugin_id = ? AND at >= ?')
        .pluck()
        .get(id, iso(now - AUTO_DISABLE.windowMs)) as number;
      const enabled = p.row ? p.row.enabled === 1 : true;
      const autoDisabled = recent >= AUTO_DISABLE.errors && enabled && !p.required && p.source !== 'builtin';
      if (autoDisabled) {
        const reason = `${AUTO_DISABLE.windowMs / 60_000} 分钟内出错 ${recent} 次，自动停用了。最近一次：${message.slice(0, 200)}`;
        this.db
          .prepare(
            `INSERT INTO plugin_state (id, enabled, disabled_reason, updated_at) VALUES (?, 0, ?, ?)
             ON CONFLICT(id) DO UPDATE SET enabled = 0, disabled_reason = excluded.disabled_reason, updated_at = excluded.updated_at`,
          )
          .run(id, reason, iso(now));
      }
      this.changed();
      return { autoDisabled };
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
      (this.db.prepare('SELECT id, enabled, display_name, enabled_at, disabled_reason FROM plugin_state').all() as StateRow[]).map((r) => [
        r.id,
        r,
      ]),
    );
    const builtins: Loaded[] = BUILTIN_PLUGINS.map((m) => ({
      manifest: m,
      source: 'builtin',
      required: !!m.required,
      row: rows.get(m.id),
      problems: [],
    }));
    if (safe) return builtins;
    const mine: Loaded[] = [];
    for (const r of this.db.prepare('SELECT id, manifest FROM user_plugins ORDER BY created_at, id').all() as { id: string; manifest: string }[]) {
      const m = safeParse(r.manifest) as PluginManifest | null;
      mine.push(
        m
          ? { manifest: { ...m, id: r.id }, source: 'mine', required: false, row: rows.get(r.id), problems: [] }
          : { manifest: broken(r.id), source: 'mine', required: false, row: rows.get(r.id), problems: ['记下的清单坏了'] },
      );
    }
    const grants = new Map(
      (this.db.prepare('SELECT plugin_id, grant_json FROM plugin_grants').all() as { plugin_id: string; grant_json: string }[]).map((g) => [
        g.plugin_id,
        { ...EMPTY_GRANT, ...(safeParse(g.grant_json) as Partial<Grant> | null) },
      ]),
    );
    const installed: Loaded[] = [];
    for (const r of this.db.prepare('SELECT * FROM installed_plugins ORDER BY installed_at, id').all() as InstalledRow[]) {
      // 每次按现在的 Emaki 版本再查一遍：升级以后不兼容的写明原因、不生效
      const checked = checkManifest(safeParse(r.manifest), this.emakiVersion);
      const problems = [...checked.problems];
      if (!existsSync(path.join(this.packages.resolve(r.package_dir), MANIFEST_FILE)))
        problems.push(r.source_kind === 'folder' ? `文件夹不见了（${r.package_dir}）` : '插件的文件不见了，重新安装');
      const m = checked.manifest ?? broken(r.id);
      // 导航项的 id 带上插件的 id，和内置的、别的插件的不撞
      const navs = m.contributes['nav.item@1']?.map((n) => ({ ...n, id: `${r.id}/${n.id}` }));
      installed.push({
        manifest: { ...m, id: r.id, contributes: { ...m.contributes, ...(navs && { 'nav.item@1': navs }) } },
        source: 'installed',
        required: false,
        row: rows.get(r.id),
        problems,
        installed: r,
        grant: grants.get(r.id) ?? EMPTY_GRANT,
      });
    }
    return [...builtins, ...mine, ...installed];
  }

  /** 每个插件这一次算出来的状态（安全模式下只有内置的、全部启用、原名） */
  private records(safe: boolean): PluginRecord[] {
    const loaded = this.load(safe);
    const errors = safe ? new Map<string, PluginErrorInfo[]>() : this.errorsByPlugin();
    return loaded.map((p) => ({
      manifest: p.manifest,
      source: p.source,
      required: p.required,
      enabled: p.required || (safe ? p.source === 'builtin' : p.row ? p.row.enabled === 1 : true),
      displayName: safe ? null : (p.row?.display_name ?? null),
      enabledAt: p.row?.enabled_at ?? null,
      problems: p.problems,
      ...(p.source !== 'builtin' && {
        extra: {
          errors: errors.get(p.manifest.id) ?? [],
          disabledReason: p.row?.disabled_reason ?? null,
          ...(p.installed && {
            installed: {
              kind: p.installed.source_kind,
              location: p.installed.source,
              ref: p.installed.source_ref,
              installedAt: p.installed.installed_at,
              updatedAt: p.installed.updated_at,
            },
            permissions: p.manifest.permissions ?? {},
            grant: p.grant ?? EMPTY_GRANT,
          }),
        },
      }),
    }));
  }

  private errorsByPlugin(): Map<string, PluginErrorInfo[]> {
    const out = new Map<string, PluginErrorInfo[]>();
    for (const r of this.db.prepare('SELECT plugin_id, at, source, message FROM plugin_errors ORDER BY id DESC').all() as ({
      plugin_id: string;
    } & PluginErrorInfo)[]) {
      const list = out.get(r.plugin_id) ?? [];
      if (list.length < 5) list.push({ at: r.at, source: r.source, message: r.message });
      out.set(r.plugin_id, list);
    }
    return out;
  }

  private installedRow(id: string): InstalledRow | undefined {
    return this.db.prepare('SELECT * FROM installed_plugins WHERE id = ?').get(id) as InstalledRow | undefined;
  }

  private grantOf(id: string): Grant | null {
    const row = this.db.prepare('SELECT grant_json FROM plugin_grants WHERE plugin_id = ?').pluck().get(id) as string | undefined;
    return row ? { ...EMPTY_GRANT, ...(safeParse(row) as Partial<Grant> | null) } : null;
  }

  /** 准备好的包里的清单，再加上「和已有的插件撞了 id」这种只有装的时候才知道的问题 */
  private checkStaged(s: Staged): { manifest: PluginManifest | null; problems: string[] } {
    const { manifest, problems } = readManifest(s.root, this.emakiVersion);
    if (manifest && this.load(false).some((p) => p.manifest.id === manifest.id && p.source !== 'installed'))
      problems.push(`已经有一个 id 是「${manifest.id}」的插件了`);
    return { manifest, problems };
  }

  private toPackage(s: Staged): PluginPackage {
    const { manifest, problems } = this.checkStaged(s);
    if (!manifest) {
      this.packages.discard(s.token);
      throw new BadRequestError(`不是能装的插件：${problems.join('；')}`);
    }
    const existing = this.installedRow(manifest.id);
    const grant = existing ? (this.grantOf(manifest.id) ?? EMPTY_GRANT) : null;
    const folderDefaults = Object.fromEntries(
      (manifest.permissions?.folders ?? []).map((f) => {
        const old = grant?.folders.find((x) => x.id === f.id);
        return [f.id, old ? { rootId: old.rootId, dir: old.dir } : this.defaultFolder(f.suggest, manifest.name)];
      }),
    );
    return {
      token: s.token,
      source: { kind: s.kind, location: s.location, ref: s.ref },
      manifest,
      problems,
      current: existing && grant ? { version: (safeParse(existing.manifest) as PluginManifest | null)?.version ?? '?', grant } : null,
      added: missingPermissions(manifest.permissions, grant),
      folderDefaults,
    };
  }

  /** 要的文件夹默认放在哪：第一个自动识别的图库文件夹下，插件建议的路径（没建议就是「插件/插件名」） */
  private defaultFolder(suggest: string | undefined, name: string): { rootId: number; dir: string } | null {
    const root = this.db.prepare(`SELECT id FROM library_roots WHERE ${ROOT_ACTIVE('')} AND content_mode = 'auto' ORDER BY id`).pluck().get() as
      | number
      | undefined;
    if (root === undefined) return null;
    let dir: string;
    try {
      dir = normalizeSubdir(suggest ?? `插件/${name}`);
    } catch {
      dir = normalizeSubdir(`插件/${name.replace(/[<>:"|?*\\/]/g, '_')}`);
    }
    return { rootId: root, dir };
  }

  /** 授权单上选的文件夹：图库文件夹在用、是自动识别的，相对路径合法 */
  private checkFolder(rootId: ID, dir: string): { rootId: number; dir: string } {
    const id = parseId(rootId);
    const root =
      id === null
        ? undefined
        : (this.db.prepare(`SELECT id, content_mode FROM library_roots WHERE id = ? AND ${ROOT_ACTIVE('')}`).get(id) as
            | { id: number; content_mode: string }
            | undefined);
    if (!root) throw new NotFoundError('图库文件夹');
    if (root.content_mode !== 'auto') throw new BadRequestError('「按漫画导入」的图库文件夹不能给插件放文件：放进去的图会被当成漫画页');
    return { rootId: root.id, dir: normalizeSubdir(dir) };
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

/** 清单读不出来的插件：给一个只有 id 的空壳，插件页上照样能看到、能删 */
const broken = (id: string): PluginManifest => ({ id, name: id, version: '?', contributes: {} });

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
