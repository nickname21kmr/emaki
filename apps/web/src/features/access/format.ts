/** 手机访问的显示规则：剩余时间、权限范围的说法 */
import { DEVICE_DEFAULT_SCOPES, DEVICE_GRANTABLE_SCOPES, SCOPES, type Scope } from '@emaki/shared';

/** 剩余时间「4:32」（过了算 0:00） */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * SCOPES 里的中文说明拆成两段，勾选框上一行粗一行细：
 * 「读图库（列表、详情、计数）」→ 读图库 / 列表、详情、计数；「界面上的小动作：标记看过」→ 界面上的小动作 / 标记看过
 */
export function scopeText(scope: Scope): { head: string; detail: string | null } {
  const text: string = SCOPES[scope];
  const m = /^(.+?)(?:：(.+)|（(.+)）)$/.exec(text);
  return m ? { head: m[1]!, detail: (m[2] ?? m[3])! } : { head: text, detail: null };
}

/** 这些范围会动你已有的东西（文件、规则、设置）：授权单上朱色标出（设备、插件一样） */
export const DANGER_SCOPES: readonly Scope[] = ['organize-files', 'rules', 'settings'];

/** 批准时可以另外勾的（默认不给） */
export const EXTRA_SCOPES: readonly Scope[] = DEVICE_GRANTABLE_SCOPES.filter((s) => !DEVICE_DEFAULT_SCOPES.includes(s));

/** 按可授予范围的顺序排好、去掉不认识的 */
export const sortScopes = (scopes: Iterable<Scope>): Scope[] => {
  const set = new Set(scopes);
  return DEVICE_GRANTABLE_SCOPES.filter((s) => set.has(s));
};

/** 和默认权限一样吗（顺序无关） */
export const isDefaultScopes = (scopes: readonly Scope[]) =>
  scopes.length === DEVICE_DEFAULT_SCOPES.length && DEVICE_DEFAULT_SCOPES.every((s) => scopes.includes(s));

/** 设备列表里的一句话：默认权限 / 默认权限 + 2 项 / 5 项权限（少了默认里的几项时） */
export function describeScopes(scopes: readonly Scope[]): string {
  const granted = sortScopes(scopes);
  if (isDefaultScopes(granted)) return '默认权限';
  const extra = granted.filter((s) => !DEVICE_DEFAULT_SCOPES.includes(s));
  if (DEVICE_DEFAULT_SCOPES.every((s) => granted.includes(s))) return `默认权限 + ${extra.length} 项`;
  return granted.length ? `${granted.length} 项权限` : '没有权限';
}
