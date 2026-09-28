import type { DuplicateGroup, ID, ImageItem, LibraryRoot } from '@emaki/shared';
import { formatPercent } from '@/lib/format';

/** 图片行的最大高度（px，TR-5：240 → 360，相似组才看得出哪张清楚）。组内所有图等高，宽度按比例 */
export const TILE_HEIGHT = 360;
export const TILE_GAP = 16;
/** 一行最多几张；超过 FOLDED_ROWS 行的组先折起来 */
export const PER_ROW = 6;
export const FOLDED_ROWS = 2;

/** 太窄的长图 / 太宽的全景图限制一下比例，保证下面的对比信息有地方放 */
export const tileRatio = (img: Pick<ImageItem, 'width' | 'height'>) => Math.min(Math.max(img.width / Math.max(img.height, 1), 0.62), 2.1);

export const kindLabel = (g: Pick<DuplicateGroup, 'kind' | 'similarity'>) =>
  g.kind === 'exact' ? '完全相同' : `相似 ${formatPercent(g.similarity)}`;

/**
 * 当前组要保留的图：用户改过就用用户的，否则用推荐。
 * 过滤掉已经不在组里的 id（撤销 / 刷新后组可能变了），全空时退回推荐，保证至少留一张。
 */
export function resolveKeep(group: DuplicateGroup, override: readonly ID[] | undefined): ID[] {
  const ids = new Set(group.images.map((i) => i.id));
  const kept = (override ?? [group.suggestedKeepId]).filter((id) => ids.has(id));
  if (kept.length) return kept;
  return [ids.has(group.suggestedKeepId) ? group.suggestedKeepId : group.images[0]!.id];
}

/** 处理后能释放的空间 = 不保留的图片体积之和 */
export function reclaimBytes(group: DuplicateGroup, keepIds: readonly ID[]): number {
  return group.images.reduce((sum, img) => (keepIds.includes(img.id) ? sum : sum + img.bytes), 0);
}

/** 组内「最好」的值：分辨率最高 / 体积最大。全都一样时不标（没有比较意义） */
export function bestValues(images: readonly ImageItem[]) {
  const pick = (value: (i: ImageItem) => number) => {
    const values = images.map(value);
    const max = Math.max(...values);
    if (values.every((v) => v === max)) return new Set<ID>();
    return new Set(images.filter((_, k) => values[k] === max).map((i) => i.id));
  };
  return {
    resolution: pick((i) => i.width * i.height),
    bytes: pick((i) => i.bytes),
  };
}

/** 文件夹显示：短的（库根目录名 + 相对目录）给眼睛看，完整绝对路径放 title */
export function folderOf(img: ImageItem, roots: ReadonlyMap<ID, LibraryRoot>): { short: string; full: string } {
  const rel = img.relPath.replace(/\\/g, '/');
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const rootPath = roots.get(img.libraryRootId)?.path.replace(/\\/g, '/').replace(/\/$/, '');
  const rootName = rootPath?.split('/').pop() ?? '';
  return {
    short: [rootName, dir].filter(Boolean).join('/') || '/',
    full: rootPath ? [rootPath, dir].filter(Boolean).join('/') : dir || '/',
  };
}

/**
 * 完全相同组的文件夹（TR-11）：按 / 分段取组内公共前缀，返回每张的「公共前缀 + 不同的那段」。
 * 只有一张或全都一样时，rest 为空。
 */
export function splitCommon(folders: string[]): { prefix: string; rest: string }[] {
  const parts = folders.map((f) => f.split('/'));
  let n = 0;
  while (parts.every((p) => p.length > n && p[n] === parts[0]![n])) n++;
  return parts.map((p) => {
    const prefix = p.slice(0, n).join('/');
    const rest = p.slice(n).join('/');
    return { prefix: rest && prefix ? `${prefix}/` : prefix, rest };
  });
}
