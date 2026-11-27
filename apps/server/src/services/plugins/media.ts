/**
 * 插件视图里的图片（docs/plugins.md 第 5 节、12.1 ④）：视图在隔离的 iframe 里，是匿名来源，请求不带 Cookie，
 * 局域网入口认不出是谁；也不让视图直接请求 /api（安全策略只放行这里）。所以图片走地址里带短期令牌的方式：
 * /api/plugin-media/<令牌>/thumb/<图片 id>、/original/<图片 id>，用普通的 <img> 加载，不经过桥接拷贝。
 *
 * 令牌在打开视图时发（plugins.view），绑定插件和那时生效的权限范围（插件的授权 ∩ 打开它的入口）；
 * 过 TTL 作废，插件停用、卸载以后也不再认（http/pluginViews.ts 每次再查一遍插件还在不在）。
 * 只在内存里：重启以后视图重新打开就有新的。
 */
import type { Scope } from '@emaki/shared';
import { randomBytes } from 'node:crypto';

/** 令牌多久作废（视图开着超过这么久，重新打开一次） */
export const MEDIA_TTL_MS = 12 * 3600_000;
/** 最多同时记多少个（每次打开视图发一个；超了丢掉最早的） */
const MAX_TOKENS = 2000;

export interface MediaGrant {
  pluginId: string;
  /** 发令牌时生效的范围：之后取图按它拦（没有 read 就取不到） */
  scopes: ReadonlySet<Scope>;
  expiresAt: number;
}

export class PluginMedia {
  private readonly tokens = new Map<string, MediaGrant>();

  constructor(private readonly clock: () => number) {}

  /** 发一个令牌，返回图片地址的前缀 */
  mint(pluginId: string, scopes: Iterable<Scope>): string {
    this.expire();
    while (this.tokens.size >= MAX_TOKENS) this.tokens.delete(this.tokens.keys().next().value!);
    const token = randomBytes(18).toString('base64url');
    this.tokens.set(token, { pluginId, scopes: new Set(scopes), expiresAt: this.clock() + MEDIA_TTL_MS });
    return `/api/plugin-media/${token}`;
  }

  /** 令牌还有效就返回它绑定的插件和范围 */
  check(token: string): MediaGrant | null {
    const g = this.tokens.get(token);
    if (!g) return null;
    if (g.expiresAt <= this.clock()) {
      this.tokens.delete(token);
      return null;
    }
    return g;
  }

  /** 插件停用、卸载：它的令牌全部作废 */
  revoke(pluginId: string): void {
    for (const [t, g] of this.tokens) if (g.pluginId === pluginId) this.tokens.delete(t);
  }

  private expire(): void {
    const now = this.clock();
    for (const [t, g] of this.tokens) if (g.expiresAt <= now) this.tokens.delete(t);
  }
}
