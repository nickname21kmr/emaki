/**
 * 插件的设置和凭证（docs/plugins.md 第 6 节，E5）：表 plugin_settings（迁移 055）。
 * - 设置：清单里 setting@1 登记的，你在插件详情里填（plugins.setSettings）；插件的服务端用 emaki.settings.get 读。
 *   类型是 secret 的（登录凭证这类）网页只看得到填没填。
 * - 凭证：插件的服务端自己存的（emaki.secrets，比如登录以后拿到的令牌），和 secret 类型的设置在同一张表、同一种保护。
 * 只有插件的服务端读得到，视图读不到（视图的存储是 plugin_storage）。插件自己的运行状态，不进撤销栈；卸载时一起删（Plugins.remove）。
 */
import type { PluginSettingValue, SettingContribution } from '@emaki/shared';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { iso } from '../../datasource/sqlite/sql.ts';
import { BadRequestError } from '../../http/errors.ts';

export const SETTINGS_LIMITS = { keyLength: 100, valueBytes: 16 * 1024, keys: 200 };

export class PluginSettings {
  constructor(private readonly ctx: SqliteContext) {}

  /** 服务端读一项（设置、凭证都行）；没有是 null */
  get(plugin: string, key: string): string | null {
    return (
      (this.ctx.db.prepare('SELECT value FROM plugin_settings WHERE plugin_id = ? AND key = ?').pluck().get(plugin, key) as
        string | undefined) ?? null
    );
  }

  /** 服务端存一项；null 是删掉。secret 的在网页上只显示填没填 */
  put(plugin: string, key: string, value: string | null, secret: boolean): void {
    if (!key || key.length > SETTINGS_LIMITS.keyLength) throw new BadRequestError(`键要有 1 到 ${SETTINGS_LIMITS.keyLength} 个字`);
    if (value === null) {
      this.ctx.db.prepare('DELETE FROM plugin_settings WHERE plugin_id = ? AND key = ?').run(plugin, key);
      return;
    }
    if (typeof value !== 'string') throw new BadRequestError('值要是字符串');
    if (Buffer.byteLength(value) > SETTINGS_LIMITS.valueBytes)
      throw new BadRequestError(`一个值最大 ${SETTINGS_LIMITS.valueBytes / 1024} KB`);
    const n = this.ctx.db
      .prepare('SELECT COUNT(*) FROM plugin_settings WHERE plugin_id = ? AND key != ?')
      .pluck()
      .get(plugin, key) as number;
    if (n + 1 > SETTINGS_LIMITS.keys) throw new BadRequestError(`一个插件最多存 ${SETTINGS_LIMITS.keys} 项`);
    this.ctx.db
      .prepare(
        `INSERT INTO plugin_settings (plugin_id, key, value, secret, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at`,
      )
      .run(plugin, key, value, secret ? 1 : 0, iso(this.ctx.clock()));
  }

  /** 网页上画的：清单里登记的每一项现在的值（凭证不给值） */
  values(plugin: string, declared: readonly SettingContribution[]): PluginSettingValue[] {
    if (!declared.length) return [];
    const rows = new Map(
      (
        this.ctx.db.prepare('SELECT key, value FROM plugin_settings WHERE plugin_id = ?').all(plugin) as { key: string; value: string }[]
      ).map((r) => [r.key, r.value]),
    );
    return declared.map((s) => {
      const v = rows.get(s.id);
      return { id: s.id, value: s.type === 'secret' ? null : (v ?? null), filled: v !== undefined && v !== '' };
    });
  }

  /** 你在插件详情里填的：只认清单里登记的；空的是清掉 */
  setDeclared(plugin: string, declared: readonly SettingContribution[], values: Record<string, string | null>): number {
    let n = 0;
    for (const [key, raw] of Object.entries(values)) {
      const s = declared.find((d) => d.id === key);
      if (!s) throw new BadRequestError(`这个插件没有设置「${key}」`);
      const value = raw === null || raw.trim() === '' ? null : s.type === 'secret' ? raw.trim() : raw;
      this.put(plugin, key, value, s.type === 'secret');
      n += 1;
    }
    return n;
  }
}
