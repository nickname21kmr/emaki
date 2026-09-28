/**
 * 合集摘要（T38c 4.1）：纯函数，mock 和 sqlite 共用，保证两边口径一致。
 * 输入是一本的行、按页序排好的可见页、角色 / 作品在这本里的命中页数和手动关联；输出页数、出场角色、封面、待整理。
 */
import type { CollectionKind, Rating } from '@emaki/shared';

export interface SumPage<K> {
  id: K;
  width: number;
  height: number;
  rating: Rating;
  kind: string;
  color: string | null;
  tagged: boolean;
  addedAt: string;
  hasChar: boolean;
}

export interface SumInput<K> {
  kind: CollectionKind;
  coverImageId: K | null;
  reviewed: boolean;
  /** 可见页，按 page_no 排好 */
  pages: SumPage<K>[];
  charHits: Map<K, number>;
  workHits: Map<K, number>;
  manualChars: K[];
  manualWorks: K[];
  /** 手动关联角色所属的作品也并进来 */
  worksOfCharacter: (id: K) => K[];
}

export interface SumResult<K> {
  pageCount: number;
  cast: { id: K; pageCount: number; manual: boolean }[];
  works: { id: K; pageCount: number; manual: boolean }[];
  unrecognizedPageCount: number;
  pending: boolean;
  covers: { imageId: K; rating: Rating; color: string | null }[];
  coverTagged: boolean;
  lastAddedAt: string | null;
}

/** 出场的门槛：本子 max(2, ceil(10% 页数))，画集 1 页（一页误认不算，实测滤掉了 5 个错认） */
export const castThreshold = (kind: CollectionKind, pageCount: number) => (kind === 'doujin' ? Math.max(2, Math.ceil(0.1 * pageCount)) : 1);

const coverable = (p: SumPage<unknown>) => (p.kind === 'illustration' || p.kind === 'comic') && Math.max(p.width, p.height) >= 600;

function ranked<K>(hits: Map<K, number>, manual: K[], threshold: number) {
  const manualSet = new Set(manual);
  const out = manual.map((id) => ({ id, pageCount: hits.get(id) ?? 0, manual: true }));
  const auto = [...hits].filter(([id, n]) => !manualSet.has(id) && n >= threshold).sort((a, b) => b[1] - a[1]);
  return [...out, ...auto.map(([id, n]) => ({ id, pageCount: n, manual: false }))];
}

export function summarize<K>(x: SumInput<K>): SumResult<K> {
  const n = x.pages.length;
  const threshold = castThreshold(x.kind, n);
  const cast = ranked(x.charHits, x.manualChars, threshold);
  const extraWorks = [...new Set(x.manualChars.flatMap((c) => x.worksOfCharacter(c)))].filter((w) => !x.manualWorks.includes(w));
  const works = ranked(x.workHits, [...x.manualWorks, ...extraWorks], threshold).map((w) => ({
    ...w,
    manual: x.manualWorks.includes(w.id),
  }));
  const unrecognizedPageCount = x.kind === 'artbook' ? x.pages.filter((p) => p.kind === 'illustration' && !p.hasChar).length : 0;
  const pending =
    !x.reviewed &&
    x.manualChars.length === 0 &&
    x.manualWorks.length === 0 &&
    n > 0 &&
    (x.kind === 'doujin' ? cast.length === 0 : unrecognizedPageCount >= 1);

  // 封面：手动选的页；否则第一张像样的插画 / 漫画页；[1][2] 取书中约 35%、65% 处往后的第一张
  const covers: SumPage<K>[] = [];
  const manualCover = x.coverImageId !== null ? x.pages.find((p) => p.id === x.coverImageId) : undefined;
  const first = manualCover ?? x.pages.find(coverable) ?? x.pages[0];
  if (first) covers.push(first);
  for (const at of [0.35, 0.65]) {
    if (n < 3) break;
    const start = Math.floor(at * (n - 1));
    const pick = x.pages.slice(start).find((p) => coverable(p) && !covers.includes(p));
    if (pick) covers.push(pick);
  }
  return {
    pageCount: n,
    cast,
    works,
    unrecognizedPageCount,
    pending,
    covers: covers.map((p) => ({ imageId: p.id, rating: p.rating, color: p.color })),
    coverTagged: !!first?.tagged,
    lastAddedAt: x.pages.reduce<string | null>((m, p) => (m === null || p.addedAt > m ? p.addedAt : m), null),
  };
}
