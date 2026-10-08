/**
 * 合集（T38d）的文案、书架分组、阅读进度。
 */
import type { CollectionKind, CollectionSummary } from '@emaki/shared';
import { BookImage, BookOpen, type LucideIcon } from 'lucide-react';
import { shouldBlur, type BlurPrefs } from './blur';

export const COLLECTION_META: Record<CollectionKind, { label: string; unit: string; glyph: string; icon: LucideIcon; hint: string }> = {
  doujin: { label: '本子', unit: '本', glyph: '本', icon: BookOpen, hint: '按页码顺序读' },
  artbook: { label: '画集', unit: '册', glyph: '画', icon: BookImage, hint: '里面的插画照常计入角色' },
};

export const displayTitle = (c: Pick<CollectionSummary, 'title' | 'folderName'>) => c.title ?? `无题 #${c.folderName.slice(0, 6)}`;

/** 展会 · 社团（作者） */
export function byline(c: Pick<CollectionSummary, 'event' | 'circle' | 'artist'>): string {
  const who = c.circle && c.artist ? `${c.circle}（${c.artist}）` : (c.circle ?? c.artist);
  return [c.event, who].filter(Boolean).join(' · ');
}

export type ShelfUnit = { type: 'single'; c: CollectionSummary } | { type: 'series'; key: string; items: CollectionSummary[] };

/**
 * 书架单元：同一系列 ≥ 2 本合成一个系列卡。
 * 排序（RV-C-5）：无题的排最后；其余按单元总页数降序，相同再按标题。
 */
export function toShelfUnits(list: CollectionSummary[]): ShelfUnit[] {
  const series = new Map<string, CollectionSummary[]>();
  for (const c of list) if (c.seriesKey) series.set(c.seriesKey, [...(series.get(c.seriesKey) ?? []), c]);
  const units: ShelfUnit[] = [];
  const done = new Set<string>();
  for (const c of list) {
    const items = c.seriesKey ? series.get(c.seriesKey)! : [c];
    if (items.length >= 2) {
      if (done.has(c.seriesKey!)) continue;
      done.add(c.seriesKey!);
      units.push({ type: 'series', key: c.seriesKey!, items: [...items].sort((a, b) => (a.volumeNo ?? 1e9) - (b.volumeNo ?? 1e9)) });
    } else units.push({ type: 'single', c });
  }
  const first = (u: ShelfUnit) => (u.type === 'single' ? u.c : u.items[0]!);
  const pages = (u: ShelfUnit) => (u.type === 'single' ? u.c.pageCount : u.items.reduce((n, c) => n + c.pageCount, 0));
  const collator = new Intl.Collator('ja', { numeric: true });
  return units.sort(
    (a, b) =>
      (first(a).title === null ? 1 : 0) - (first(b).title === null ? 1 : 0) ||
      pages(b) - pages(a) ||
      collator.compare(first(a).title ?? '', first(b).title ?? ''),
  );
}

/** 连载按「话」，其余按「册」 */
export const unitOfFolder = (folderName: string) => (/[话話回章]\s*$/.test(folderName) ? '话' : '册');
export const unitWord = (items: Pick<CollectionSummary, 'folderName'>[]) => (items.some((c) => unitOfFolder(c.folderName) === '话') ? '话' : '册');

const KEY = (id: string) => `emaki.read.v1.${id}`;
export const readProgress = {
  get(id: string): number | null {
    try {
      const v = Number(localStorage.getItem(KEY(id)));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  },
  set(id: string, page: number): void {
    try {
      localStorage.setItem(KEY(id), String(page));
    } catch {
      /* 隐私模式等：不记进度 */
    }
  },
};

/**
 * 布面：开着模糊时，封面敏感、没有封面，或本子封面还没识别过（分级不可信，本子封面大多敏感），都换成布面精装。
 */
export function shouldCloth(c: Pick<CollectionSummary, 'covers' | 'kind' | 'coverTagged'>, prefs: BlurPrefs): boolean {
  if (!prefs.blurSensitive) return false;
  const cover = c.covers[0];
  if (!cover) return true;
  return shouldBlur({ rating: cover.rating }, prefs) || (c.kind === 'doujin' && !c.coverTagged);
}
