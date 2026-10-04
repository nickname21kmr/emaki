/**
 * 画师列表：识别结果（image_artists）按「同一个人」合并（artistGroups），名字用 Danbooru 资料里挑的显示名。
 * 没同步过 Danbooru 的画师照样列出，显示标签。
 */
import type { Artist, ID, Rating } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import { artistGroups, type ArtistMeta } from '../../services/danbooru/artistNames.ts';
import { toId } from './sql.ts';

function loadMeta(db: Db): Map<string, ArtistMeta> {
  const rows = db.prepare('SELECT name, display, names, twitter, alias_of FROM danbooru_artists WHERE not_found = 0').all() as {
    name: string;
    display: string | null;
    names: string;
    twitter: string | null;
    alias_of: string | null;
  }[];
  return new Map(
    rows.map((r) => [r.name, { name: r.name, display: r.display, names: JSON.parse(r.names) as string[], twitter: r.twitter, aliasOf: r.alias_of }]),
  );
}

/** 标签 → 组的代表标签（只看认出来过的标签） */
export function artistGroupMap(db: Db): Map<string, string> {
  const present = db.prepare('SELECT DISTINCT artist FROM image_artists').pluck().all() as string[];
  return artistGroups(present, loadMeta(db));
}

/** 按画师筛图时要包含的全部标签（同一个人的不同标签） */
export function tagsOfArtist(db: Db, artist: string): string[] {
  const groups = artistGroupMap(db);
  const tags = [...groups].filter(([, c]) => c === artist).map(([t]) => t);
  return tags.length ? tags : [artist];
}

const pretty = (tag: string) => tag.replace(/_/g, ' ');

export function listArtists(db: Db): Artist[] {
  const meta = loadMeta(db);
  const groups = artistGroups(db.prepare('SELECT DISTINCT artist FROM image_artists').pluck().all() as string[], meta);
  const rows = db
    .prepare(
      `SELECT ia.artist, ia.score, i.id, i.dominant_color, i.rating, i.width, i.height
       FROM image_artists ia JOIN v_counted_images i ON i.id = ia.image_id
       WHERE i.content_kind = 'illustration'`,
    )
    .all() as { artist: string; score: number; id: number; dominant_color: string | null; rating: Rating; width: number; height: number }[];

  const byGroup = new Map<string, { ids: Set<number>; tags: Set<string>; best: (typeof rows)[number] | null }>();
  // 封面：全年龄优先，再按分数
  const better = (a: (typeof rows)[number], b: (typeof rows)[number] | null): boolean => {
    if (!b) return true;
    if ((a.rating === 'general') !== (b.rating === 'general')) return a.rating === 'general';
    if (a.score !== b.score) return a.score > b.score;
    return a.id < b.id;
  };
  for (const r of rows) {
    const g = groups.get(r.artist) ?? r.artist;
    let e = byGroup.get(g);
    if (!e) byGroup.set(g, (e = { ids: new Set(), tags: new Set(), best: null }));
    e.ids.add(r.id);
    e.tags.add(r.artist);
    if (better(r, e.best)) e.best = r;
  }

  const out: Artist[] = [];
  for (const [tag, e] of byGroup) {
    const m = meta.get(tag);
    // 合并进来的标签（社团名、旧名）和它们的显示名都能搜到
    const aliases = new Set<string>();
    for (const t of e.tags) {
      if (t !== tag) aliases.add(pretty(t));
      const mt = meta.get(t);
      if (mt?.display && mt.display !== m?.display) aliases.add(mt.display);
      for (const n of mt?.names ?? []) aliases.add(n.replace(/_/g, ' '));
    }
    const b = e.best;
    out.push({
      tag,
      name: m?.display ?? pretty(tag),
      tags: [...e.tags],
      aliases: [...aliases].slice(0, 30),
      twitter: m?.twitter ?? null,
      imageCount: e.ids.size,
      cover: b ? { id: toId(b.id) as ID, dominantColor: b.dominant_color ?? '#888888', rating: b.rating, width: b.width, height: b.height } : null,
    });
  }
  return out.sort((a, b) => b.imageCount - a.imageCount || a.tag.localeCompare(b.tag));
}
