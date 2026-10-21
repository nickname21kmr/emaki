import type { Db } from '../../db/connection.ts';
import { PixivArtworkSchema, type PixivArtwork } from './client.ts';

/** Cache source metadata, never the matching decision: local rules can change. */
export function cachedArtwork(db: Db, id: string): PixivArtwork | undefined {
  const raw = db.prepare('SELECT artwork FROM pixiv_artwork_cache WHERE post_id=?').pluck().get(id) as string | undefined;
  if (raw === undefined) return;
  try {
    const parsed = PixivArtworkSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.id === id) return parsed.data;
  } catch { /* Old or invalid cache entries are fetched again. */ }
}

export function cacheArtwork(db: Db, artwork: PixivArtwork, fetchedAt: string): void {
  db.prepare(`INSERT INTO pixiv_artwork_cache(post_id,artwork,fetched_at) VALUES (?,?,?)
    ON CONFLICT(post_id) DO UPDATE SET artwork=excluded.artwork,fetched_at=excluded.fetched_at`)
    .run(artwork.id, JSON.stringify(PixivArtworkSchema.parse(artwork)), fetchedAt);
}
