import { readSettings } from '../settings.ts';
import type { Db } from '../../../db/connection.ts';
import { hamming } from '../../../services/image/dhash.ts';
import { parseDHash, popcount32 } from '../../../services/dedupe/hamming.ts';

/** Reuse the existing dHash candidate stage for human selection, without changing duplicate decisions. */
export function collectionCandidates(db: Db, id: number): number[] {
  const source = db.prepare('SELECT dhash FROM v_counted_images WHERE id = ?').get(id) as { dhash: string | null } | undefined;
  const hash = source?.dhash;
  if (!hash || !/^[a-f\d]{16}$/i.test(hash)) return [];
  const [hi, lo] = parseDHash(hash);
  const bits = popcount32(hi) + popcount32(lo);
  if (bits <= 4 || bits >= 60) return [];
  const rows = db.prepare('SELECT id, dhash FROM v_counted_images WHERE id <> ? AND dhash IS NOT NULL').all(id) as {
    id: number;
    dhash: string;
  }[];
  const threshold = Math.min(16, Math.max(0, readSettings(db).dedupe.hammingThreshold));
  return rows
    .flatMap((r) => {
      if (!/^[a-f\d]{16}$/i.test(r.dhash)) return [];
      const [hi, lo] = parseDHash(r.dhash),
        bits = popcount32(hi) + popcount32(lo);
      if (bits <= 4 || bits >= 60) return [];
      const distance = hamming(hash, r.dhash);
      return distance <= threshold ? [{ id: r.id, distance }] : [];
    })
    .sort((a, b) => a.distance - b.distance || a.id - b.id)
    .slice(0, 200)
    .map((r) => r.id);
}
