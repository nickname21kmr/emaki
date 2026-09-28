/**
 * images 行 → ImageItem。一次查询拿整页的角色和作品，不要 N+1。
 */
import type { ContentKind, ContentKindSource, ImageFormat, ImageItem, ImageSource, Rating } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import { DEFAULT_DOMINANT, toId } from './sql.ts';

export interface ImageRow {
  id: number;
  root_id: number;
  rel_path: string;
  file_name: string;
  width: number;
  height: number;
  bytes: number;
  format: ImageFormat;
  sha256: string;
  dominant_color: string | null;
  rating: Rating;
  favorite: number;
  source_site: ImageSource['site'] | null;
  source_post_id: string | null;
  source_artist: string | null;
  source_url: string | null;
  added_at: string;
  modified_at: string;
  excluded_by: number | null;
  tagged_at: string | null;
  content_kind: ContentKind;
  content_kind_source: ContentKindSource | null;
  content_kind_evidence: string | null;
  content_kind_manual: number;
  page_no: number | null;
  original_at: string | null;
}

export const IMAGE_COLS = `i.id, i.root_id, i.rel_path, i.file_name, i.width, i.height, i.bytes, i.format, i.sha256,
  i.dominant_color, i.rating, i.favorite, i.source_site, i.source_post_id, i.source_artist, i.source_url,
  i.added_at, i.modified_at, i.excluded_by, i.tagged_at,
  i.content_kind, i.content_kind_source, i.content_kind_evidence, i.content_kind_manual, i.page_no, i.original_at`;

function groupPairs(rows: { image_id: number; other: number }[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const r of rows) {
    const list = m.get(r.image_id);
    if (list) list.push(r.other);
    else m.set(r.image_id, [r.other]);
  }
  return m;
}

export function hydrateImages(db: Db, rows: ImageRow[]): ImageItem[] {
  if (!rows.length) return [];
  const ids = JSON.stringify(rows.map((r) => r.id)); // 数字数组
  const charRows = db
    .prepare(
      `SELECT ic.image_id, ic.character_id AS other, c.name FROM image_characters ic JOIN characters c ON c.id = ic.character_id
       WHERE ic.image_id IN (SELECT value FROM json_each(?)) ORDER BY ic.image_id, ic.added_at, ic.character_id`,
    )
    .all(ids) as { image_id: number; other: number; name: string }[];
  const chars = groupPairs(charRows);
  const names = new Map<number, string[]>();
  for (const r of charRows) names.set(r.image_id, [...(names.get(r.image_id) ?? []), r.name]);
  const works = groupPairs(
    db
      .prepare(
        `SELECT image_id, work_id AS other FROM v_image_works
         WHERE image_id IN (SELECT value FROM json_each(?)) ORDER BY image_id, work_id`,
      )
      .all(ids) as { image_id: number; other: number }[],
  );
  return rows.map((r) => {
    const c = chars.get(r.id) ?? [];
    return {
      id: toId(r.id),
      relPath: r.rel_path,
      fileName: r.file_name,
      libraryRootId: toId(r.root_id),
      width: r.width,
      height: r.height,
      bytes: r.bytes,
      format: r.format,
      addedAt: r.added_at,
      modifiedAt: r.modified_at,
      rating: r.rating,
      // 有角色，或不是插画 / 漫画（别册不用找角色）→ recognized；放下的仍是 unrecognized（T27 补充）
      status:
        r.excluded_by != null
          ? 'excluded'
          : c.length || r.original_at || (r.content_kind !== 'illustration' && r.content_kind !== 'comic')
            ? 'recognized'
            : 'unrecognized',
      kind: r.content_kind,
      characterIds: c.map(toId),
      characterNames: names.get(r.id) ?? [],
      workIds: (works.get(r.id) ?? []).map(toId),
      dominantColor: r.dominant_color ?? DEFAULT_DOMINANT,
      source: r.source_site
        ? {
            site: r.source_site,
            ...(r.source_post_id ? { postId: r.source_post_id } : {}),
            ...(r.source_artist ? { artist: r.source_artist } : {}),
            ...(r.source_url ? { url: r.source_url } : {}),
          }
        : null,
      favorite: r.favorite === 1,
    };
  });
}

/** 按一批 id 取 ImageItem，返回顺序 = ids 顺序（不存在的跳过；不检查可见性） */
export function loadImageItems(db: Db, ids: number[]): ImageItem[] {
  if (!ids.length) return [];
  const rows = db
    .prepare(`SELECT ${IMAGE_COLS} FROM images i WHERE i.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as ImageRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return hydrateImages(
    db,
    ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [r] : [];
    }),
  );
}

/** ImageDetail.kindReason：判定依据写成一句话；手动设置的调用方传 null */
export function describeKindReason(source: ContentKindSource | null, evidence: string | null): string | null {
  if (evidence) return evidence;
  if (source === 'tags') return '识别标签看起来是插画';
  if (source === 'default') return '还没识别，默认当插画';
  return null;
}
