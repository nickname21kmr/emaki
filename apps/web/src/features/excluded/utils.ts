import type { Exclusion, ExclusionKind } from '@emaki/shared';
import { Folder, Image as ImageIcon, Tag, UserRound, type LucideIcon } from 'lucide-react';

export const KIND_META: Record<ExclusionKind, { label: string; icon: LucideIcon }> = {
  tag: { label: '标签', icon: Tag },
  folder: { label: '文件夹', icon: Folder },
  character: { label: '角色', icon: UserRound },
  image: { label: '单张', icon: ImageIcon },
};

/** 规则在列表里的顺序：标签 → 文件夹 → 角色，同类里新的在前 */
const KIND_ORDER: ExclusionKind[] = ['tag', 'folder', 'character', 'image'];

export function sortRules(list: Exclusion[]): Exclusion[] {
  return [...list].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.createdAt.localeCompare(a.createdAt),
  );
}

/** label 形如「标签 · comic（漫画分镜）」，前半截是类型（图标已经表达了），只取后半截当标题 */
export function ruleTitle(e: Exclusion): string {
  const i = e.label.indexOf(' · ');
  return i >= 0 ? e.label.slice(i + 3) : e.label;
}

/** 标题里没有体现的原始目标（文件夹的绝对路径、标签的原名），用等宽小字补充 */
export function ruleDetail(e: Exclusion): string | null {
  if (e.kind === 'character' || e.kind === 'image') return null;
  return ruleTitle(e).startsWith(e.target) ? null : e.target;
}

/** 规则目标的规范化：标签用下划线代替空格（Danbooru 标签不含空格）；路径统一正斜杠、去掉结尾斜杠 */
export function normalizeTarget(kind: ExclusionKind, raw: string): string {
  const v = raw.trim();
  if (kind === 'tag') return v.toLowerCase().replace(/\s+/g, '_');
  if (kind === 'folder') return v.replace(/\\/g, '/').replace(/\/+$/, '');
  return v;
}
