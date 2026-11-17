/**
 * Pixiv 证据的存储（docs/core-architecture.md 第 2.1 节，P3b）：投稿缓存、待查记录、不可访问的投稿，以及把匹配结果写成证据。
 * pixiv_artwork_cache / pixiv_character_checks / pixiv_unavailable_posts 只在 domain/evidence/ 里写。
 *
 * Pixiv 只负责把投稿标签解释成「候选 + 置信度」证据，外加原创信号（附录 #2）：匹配器确认对上的候选置信度是 1，
 * 只是候选（有歧义、作品对不上、多页多角色……）的是 0；采不采纳由 decideAuto 按设置里 Pixiv 的自动阈值决定
 * （没单独设就用 autoAcceptThreshold），不再有自己的 automatic 判断和写死的 0.8。
 *
 * 资格（要不要联网去查）和模型一致：插画、漫画、动图（漫画页不看「未识别里也列出漫画页」，附录 #1）、没放下、
 * 不在整本处理的合集里、不在漫画区、来源是 Pixiv 投稿、还没有角色、投稿不是明确不存在的。模型分数落在哪一档都不影响。
 */
import type { Db } from '../../db/connection.ts';
import { NOT_IN_BOOK } from '../../datasource/sqlite/sql.ts';
import { IN_COMIC } from '../../services/classify/comicAreas.ts';
import { PixivArtworkSchema, type PixivArtwork } from '../../services/pixiv/client.ts';
import { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import { stmt } from '../tx.ts';
import type { CharacterCandidate } from './store.ts';

/** Pixiv 证据的置信度 */
export const PIXIV_CONFIDENCE = {
  /** 匹配器确认对上（投稿标签明确是这个角色、作品吻合、没有歧义） */
  confirmed: 1,
  /** 只是候选：等人确认 */
  candidate: 0,
} as const;

/** 能去查 Pixiv 的图（i 是 v_counted_images 的别名），不看原创 */
export const PIXIV_ELIGIBLE_BASE = `i.content_kind IN ('illustration','comic','animated') AND i.shelved_at IS NULL
  AND ${NOT_IN_BOOK} AND NOT ${IN_COMIC('i')} AND i.source_site='pixiv' AND i.source_post_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id=i.id)
  AND NOT EXISTS (SELECT 1 FROM pixiv_unavailable_posts p WHERE p.post_id=i.source_post_id)`;
export const PIXIV_ELIGIBLE = `${PIXIV_ELIGIBLE_BASE} AND i.original_at IS NULL`;
/** 登记了、还没查的 */
export const PIXIV_PENDING = `${PIXIV_ELIGIBLE} AND EXISTS (SELECT 1 FROM pixiv_character_checks p WHERE p.image_id=i.id
  AND p.checked_at IS NULL AND p.post_id=i.source_post_id AND p.modified_at=i.modified_at)`;

/**
 * 登记待查：ids 给了 = 自动登记（只登记这些图、只在投稿或文件变了时重来）；不给 = 显式补跑，还重查未匹配、失败、跳过，
 * 以及仍留着 Pixiv 建议的图。用户撤掉过的（dismissed）、关联上了的、标了原创的不重来
 */
export function queuePixivImages(db: Db, ids?: number[]): void {
  const automatic = ids !== undefined;
  db.prepare(`INSERT INTO pixiv_character_checks(image_id,post_id,modified_at)
    SELECT i.id,i.source_post_id,i.modified_at FROM v_counted_images i WHERE ${PIXIV_ELIGIBLE}
    ${automatic ? 'AND i.id IN (SELECT value FROM json_each(?))' : ''}
    ON CONFLICT(image_id) DO UPDATE SET post_id=excluded.post_id,modified_at=excluded.modified_at,checked_at=NULL,result=NULL
    WHERE pixiv_character_checks.post_id<>excluded.post_id OR pixiv_character_checks.modified_at<>excluded.modified_at
    ${automatic ? '' : `OR COALESCE(pixiv_character_checks.result,'') NOT IN ('linked','original','suggested','dismissed')
      OR (pixiv_character_checks.result='suggested' AND EXISTS
        (SELECT 1 FROM v_character_suggestions cs WHERE cs.image_id=excluded.image_id))`}`)
    .run(...(automatic ? [JSON.stringify(ids)] : []));
}

/** 以前只查静态图时漏掉的动图补登记 */
export function queueUnseenPixivAnimations(db: Db): void {
  const ids = db
    .prepare(
      `SELECT i.id FROM v_counted_images i WHERE ${PIXIV_ELIGIBLE}
       AND i.content_kind='animated' AND i.tagged_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pixiv_character_checks p WHERE p.image_id=i.id)`,
    )
    .pluck()
    .all() as number[];
  if (ids.length) queuePixivImages(db, ids);
}

/** 显式刷新：只清这一轮真的会处理的投稿的缓存 */
export function clearPendingPixivCache(db: Db): void {
  db.prepare(`DELETE FROM pixiv_artwork_cache WHERE post_id IN (SELECT i.source_post_id FROM v_counted_images i WHERE ${PIXIV_PENDING})`).run();
}

/** 记下这张图查过了：result 是这轮 Pixiv 给的结论（linked 确认、original 原创、suggested 只有候选、unmatched、unavailable、skipped） */
export function completePixivCheck(db: Db, imageId: number, at: string, result: string): void {
  stmt(
    db,
    `UPDATE pixiv_character_checks SET checked_at=?,result=?,
       modified_at=(SELECT modified_at FROM images WHERE id=pixiv_character_checks.image_id) WHERE image_id=?`,
  ).run(at, result, imageId);
}

/** 明确不存在的投稿：之后不再请求 */
export function markPixivPostUnavailable(db: Db, postId: string, at: string): void {
  stmt(db, 'INSERT OR IGNORE INTO pixiv_unavailable_posts(post_id,checked_at) VALUES (?,?)').run(postId, at);
}

/** 投稿缓存：只存来源的元数据，不存匹配结论（本地规则会变） */
export function cachedArtwork(db: Db, id: string): PixivArtwork | undefined {
  const raw = db.prepare('SELECT artwork FROM pixiv_artwork_cache WHERE post_id=?').pluck().get(id) as string | undefined;
  if (raw === undefined) return;
  try {
    const parsed = PixivArtworkSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.id === id) return parsed.data;
  } catch {
    /* 旧的、坏的缓存重新获取 */
  }
}

export function cacheArtwork(db: Db, artwork: PixivArtwork, fetchedAt: string): void {
  db.prepare(`INSERT INTO pixiv_artwork_cache(post_id,artwork,fetched_at) VALUES (?,?,?)
    ON CONFLICT(post_id) DO UPDATE SET artwork=excluded.artwork,fetched_at=excluded.fetched_at`).run(
    artwork.id,
    JSON.stringify(PixivArtworkSchema.parse(artwork)),
    fetchedAt,
  );
}

/**
 * 匹配器的结论 → 角色候选：确认对上的置信度 1、只是候选的 0；自建角色记占位标签和真引用（已经不在的跳过）
 */
export function pixivCandidates(db: Db, match: { tags: string[]; automatic: boolean }): CharacterCandidate[] {
  const score = match.automatic ? PIXIV_CONFIDENCE.confirmed : PIXIV_CONFIDENCE.candidate;
  const out: CharacterCandidate[] = [];
  const alive = stmt(db, 'SELECT 1 FROM characters WHERE id = ? AND danbooru_tag IS NULL');
  for (const tag of match.tags) {
    if (!CharacterCatalog.isCustomTag(tag)) {
      out.push({ tag, score });
      continue;
    }
    const id = CharacterCatalog.customId(tag);
    if (id !== null && alive.get(id)) out.push({ tag, characterId: id, score });
  }
  return out;
}
