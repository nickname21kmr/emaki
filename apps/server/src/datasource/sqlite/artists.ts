/**
 * 画师列表：识别结果（image_artists）按「同一个人」合并（artistGroups），名字用 Danbooru 资料里挑的显示名。
 * 没同步过 Danbooru 的画师照样列出，显示标签。
 */
import type { Artist, ID, ImageArtist, Rating } from '@emaki/shared';
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

/** 用户手动拆开（null）/ 合并（并到的标签）的画师标签 */
export function loadLinks(db: Db): Map<string, string | null> {
  const rows = db.prepare('SELECT tag, group_tag FROM artist_links').all() as { tag: string; group_tag: string | null }[];
  return new Map(rows.map((r) => [r.tag, r.group_tag]));
}

/** 标签 → 组的代表标签（只看认出来过的标签） */
export function artistGroupMap(db: Db): Map<string, string> {
  const present = db.prepare('SELECT DISTINCT artist FROM image_artists').pluck().all() as string[];
  return artistGroups(present, loadMeta(db), loadLinks(db));
}

/** 按画师筛图时要包含的全部标签（同一个人的不同标签）；给的是被并进去的标签时按它所在的人算 */
export function tagsOfArtist(db: Db, artist: string): string[] {
  const groups = artistGroupMap(db);
  const rep = groups.get(artist) ?? artist;
  const tags = [...groups].filter(([, c]) => c === rep).map(([t]) => t);
  return tags.length ? tags : [artist];
}

/**
 * 手动拆开 / 合并时用的分组：除了认出来过的标签，还算上手动设置里出现的标签和这次要改的标签
 * （有的标签只出现在漫画页上、或者暂时没有图，也要跟着这个人一起改）
 */
export function linkGroups(db: Db, extra: string[]): { groups: Map<string, string>; links: Map<string, string | null> } {
  const links = loadLinks(db);
  const present = db.prepare('SELECT DISTINCT artist FROM image_artists').pluck().all() as string[];
  const all = [...new Set([...present, ...links.keys(), ...[...links.values()].filter((v): v is string => !!v), ...extra])];
  return { groups: artistGroups(all, loadMeta(db), links), links };
}

const pretty = (tag: string) => tag.replace(/_/g, ' ');

/** 一张图的画师：同一个人的几个标签合成一条，名字和画师列表里一致 */
export function imageArtists(db: Db, imageId: number): ImageArtist[] {
  const tags = db.prepare('SELECT artist FROM image_artists WHERE image_id = ? ORDER BY score DESC, artist').pluck().all(imageId) as string[];
  if (!tags.length) return [];
  const meta = loadMeta(db);
  const groups = artistGroupMap(db);
  const out = new Map<string, ImageArtist>();
  for (const t of tags) {
    const g = groups.get(t) ?? t;
    const e = out.get(g);
    if (e) e.tags.push(t);
    else out.set(g, { tag: g, name: meta.get(g)?.display ?? pretty(g), tags: [t] });
  }
  return [...out.values()];
}

/** 改画师时提示里用的名字：按人去重（同一个人的几个标签只说一次） */
export function artistNames(db: Db, tags: string[]): string[] {
  const meta = loadMeta(db);
  const present = db.prepare('SELECT DISTINCT artist FROM image_artists').pluck().all() as string[];
  const groups = artistGroups([...new Set([...present, ...tags])], meta, loadLinks(db));
  return [...new Set(tags.map((t) => groups.get(t) ?? t))].map((g) => meta.get(g)?.display ?? pretty(g));
}

/** 每个标签自己的显示名（拆开时说清楚拆出来的是谁） */
export function tagNames(db: Db, tags: string[]): string[] {
  const meta = loadMeta(db);
  return tags.map((t) => meta.get(t)?.display ?? pretty(t));
}

export function listArtists(db: Db): Artist[] {
  const meta = loadMeta(db);
  const links = loadLinks(db);
  const groups = artistGroups(db.prepare('SELECT DISTINCT artist FROM image_artists').pluck().all() as string[], meta, links);
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
      manual: links.has(tag) || [...e.tags].some((t) => links.has(t)),
    });
  }
  return out.sort((a, b) => b.imageCount - a.imageCount || a.tag.localeCompare(b.tag));
}
