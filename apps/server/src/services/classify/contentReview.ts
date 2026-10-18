import { CONTENT_KINDS, type ContentKind } from '@emaki/shared';

/** 视觉复核记录由批处理写入；文件哈希变化后不再使用。 */
export interface ContentReview {
  version: 1;
  sha256: string;
  kind: ContentKind;
  model: string;
  confidence: number;
  reason: string;
  reviewedAt: string;
}

export function readContentReview(value: string | null | undefined, sha256: string | undefined): ContentReview | null {
  if (!value || !sha256) return null;
  try {
    const r: unknown = JSON.parse(value);
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const x = r as Record<string, unknown>;
    if (x.version !== 1 || x.sha256 !== sha256 || !CONTENT_KINDS.includes(x.kind as ContentKind) ||
      typeof x.confidence !== 'number' || !Number.isFinite(x.confidence) || x.confidence < 0.9 || x.confidence > 1 ||
      typeof x.model !== 'string' || !x.model.trim() || typeof x.reason !== 'string' || !x.reason.trim() ||
      typeof x.reviewedAt !== 'string' || !Number.isFinite(Date.parse(x.reviewedAt))) return null;
    return x as unknown as ContentReview;
  } catch {
    return null;
  }
}
