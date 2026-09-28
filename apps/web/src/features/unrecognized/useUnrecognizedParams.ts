import {
  UNRECOGNIZED_ANNEX_KINDS,
  UNRECOGNIZED_AREAS,
  UNRECOGNIZED_BUCKETS,
  UNRECOGNIZED_THEMES,
  type UnrecognizedAnnexKind,
  type UnrecognizedArea,
  type UnrecognizedBucket,
  type UnrecognizedSummary,
  type UnrecognizedTheme,
} from '@emaki/shared';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { useSelection } from '@/lib/stores';

/** 「插画 · 漫画」里的分段：服务端的四段，加上前端的「成册待整理」（按本处理，T38f） */
export type UnrecognizedView = UnrecognizedBucket | 'books';
const VIEWS: readonly UnrecognizedView[] = ['books', ...UNRECOGNIZED_BUCKETS];

const pick = <T extends string>(all: readonly T[], v: string | null): T | undefined => (v && (all as readonly string[]).includes(v) ? (v as T) : undefined);

/**
 * 未识别页的 URL 参数（T34b）：?area= ?bucket= ?theme= ?kind=，不合法的值当作没有。
 * 汇总到了以后补默认值（replace，不留历史）：分段取第一个非空的，主题 / 类型同理。
 */
export function useUnrecognizedParams(summary?: UnrecognizedSummary, pendingBooks = 0) {
  const [sp, setSp] = useSearchParams();
  const area: UnrecognizedArea = pick(UNRECOGNIZED_AREAS, sp.get('area')) ?? 'art';
  const bucket = area === 'art' ? pick(VIEWS, sp.get('bucket')) : undefined;
  const theme = area === 'art' && bucket === 'unsure' ? pick(UNRECOGNIZED_THEMES, sp.get('theme')) : undefined;
  const kind = area === 'annex' ? pick(UNRECOGNIZED_ANNEX_KINDS, sp.get('kind')) : undefined;

  useEffect(() => {
    if (!summary) return;
    const next = new URLSearchParams(sp);
    const set = (k: string, v: string | undefined) => (v === undefined ? next.delete(k) : next.set(k, v));
    if (area === 'art') {
      let b: UnrecognizedView | undefined = bucket;
      if (!b) b = (['suggested', 'unsure', 'untagged'] as const).find((x) => summary.art[x] > 0) ?? (pendingBooks > 0 ? 'books' : 'suggested');
      if (b === 'shelved' && summary.art.shelved === 0) b = 'suggested';
      set('bucket', b);
      if (b === 'unsure') set('theme', theme ?? UNRECOGNIZED_THEMES.find((t) => summary.art.themes[t] > 0) ?? 'legs');
      else set('theme', undefined);
      set('kind', undefined);
    } else {
      set('kind', kind ?? UNRECOGNIZED_ANNEX_KINDS.find((k) => summary.annex.kinds[k] > 0) ?? 'screenshot');
      set('bucket', undefined);
      set('theme', undefined);
    }
    if (next.toString() !== sp.toString()) setSp(next, { replace: true });
  }, [summary, pendingBooks, area, bucket, theme, kind, sp, setSp]);

  const go = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) next.delete(k);
      else next.set(k, v);
    }
    useSelection.getState().clear();
    setSp(next, { replace: true });
  };

  return {
    area,
    bucket,
    theme,
    kind,
    setArea: (a: UnrecognizedArea) => go({ area: a === 'art' ? undefined : a, bucket: undefined, theme: undefined, kind: undefined }),
    setBucket: (b: UnrecognizedView) => go({ bucket: b, theme: undefined }),
    setTheme: (t: UnrecognizedTheme) => go({ theme: t }),
    setKind: (k: UnrecognizedAnnexKind) => go({ kind: k }),
  };
}

export type UnrecognizedParamsApi = ReturnType<typeof useUnrecognizedParams>;
