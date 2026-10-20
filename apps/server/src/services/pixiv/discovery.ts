import { searchKey, katakanaToHiragana } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import type { PixivArtwork } from './client.ts';
import type { DanbooruClient } from '../danbooru/client.ts';
import type { DanbooruCatalog } from '../danbooru/catalog.ts';
import { pickCopyrights } from '../danbooru/copyright.ts';

export interface PixivDiscoveryResult { changed: boolean }
export type PixivDiscover = (artwork: PixivArtwork, signal: AbortSignal, onAdded?: (tags: string[]) => void) => Promise<PixivDiscoveryResult>;
type Client = Pick<DanbooruClient, 'autocomplete' | 'tagsByNames' | 'wikiByTitles'> & Partial<Pick<DanbooruClient, 'relatedCopyrights'>>;
// Keep qualifiers: a matching base name is a candidate, not identity evidence.
const identityKey = (name: string) => katakanaToHiragana(name.normalize('NFKC').toLowerCase().replace(/[\s_·・-]+/g, ''));
const reversedName = (query: string, tag: string) => {
  const words = (s: string) => s.normalize('NFKC').toLowerCase().replace(/_\([^)]*\)$/, '').split(/[\s_]+/);
  const a = words(query), b = words(tag);
  return a.length === 2 && b.length === 2 && [...a, ...b].every(w => /^[a-z]{2,}$/.test(w)) && a[0] === b[1] && a[1] === b[0];
};

/** Recall candidates first, verify names against metadata, then let the matcher apply its normal gates. */
export function createPixivDiscovery(db: Db, catalog: DanbooruCatalog, client: Client): PixivDiscover {
  const known = new Set((db.prepare(`SELECT search_key name FROM tag_name_keys
    UNION SELECT name FROM tags UNION SELECT name FROM characters UNION SELECT alias FROM aliases`).all() as { name: string }[]).map(r => searchKey(r.name)));
  const queried = new Map<string, 'unknown' | 'noncharacter' | 'character'>();
  // 每个角色每轮最多补一次作品，不管成不成；没成的下一轮再试
  const enrichTried = new Set<string>();
  const knownCharacters = db.prepare(`SELECT DISTINCT k.tag FROM tag_name_keys k
    LEFT JOIN danbooru_tags d ON d.name=k.tag LEFT JOIN tag_i18n i ON i.tag=k.tag
    WHERE k.search_key=? AND COALESCE(NULLIF(d.category,-1),i.category)=4`);
  const workKeys = db.prepare(`SELECT tag FROM tag_name_keys k WHERE search_key=? AND (
    EXISTS (SELECT 1 FROM danbooru_tags d WHERE d.name=k.tag AND d.category=3)
    OR EXISTS (SELECT 1 FROM tag_i18n i WHERE i.tag=k.tag AND i.category=3))
    UNION SELECT danbooru_tag FROM works WHERE name=? AND danbooru_tag IS NOT NULL`);

  return async (artwork, signal, onAdded) => {
    let changed = false;
    const workTags = () => new Set(artwork.tags.tags.flatMap(item => [item.tag, ...Object.values(item.translation ?? {})])
      .flatMap(name => (workKeys.all(searchKey(name), name) as { tag: string }[]).map(r => catalog.canonicalize(r.tag))));
    const enrichWorks = async (tag: string) => {
      if (!client.relatedCopyrights || enrichTried.has(tag) || catalog.copyrights(tag).length || catalog.get(tag)?.relatedFetchedAt) return;
      enrichTried.add(tag);
      // Dictionary-only characters have no cache row for setCopyrights to update yet.
      if (!catalog.get(tag)) {
        const base = (await client.tagsByNames([tag], signal)).find(t => t.name === tag && t.category === 4);
        if (!base) return;
        signal.throwIfAborted();
        db.transaction(() => catalog.upsertBase(base, new Date().toISOString()))();
      }
      const related = await client.relatedCopyrights(tag, signal);
      // 同 danbooru/sync.ts：Danbooru 上查不到这个标签就记成没有作品，以后不再重查
      if (!related.tag) {
        signal.throwIfAborted();
        db.transaction(() => catalog.setCopyrights(tag, [], new Date().toISOString()))();
        return;
      }
      // 别名对不上的留给 danbooru 同步按 sync.ts 的流程 markAlias
      if (related.tag.category !== 4 || catalog.canonicalize(related.tag.name) !== catalog.canonicalize(tag)) return;
      const candidates = related.related_tags.filter(x => x.tag.category === 3 && x.frequency >= 0.3);
      const names = candidates.map(x => x.tag.name);
      const metadata = names.length ? (await client.tagsByNames(names, signal)).filter(t => t.category === 3 && names.includes(t.name)) : [];
      const pages = metadata.length ? await client.wikiByTitles(metadata.map(t => t.name), signal) : [];
      signal.throwIfAborted();
      db.transaction(() => {
        const now = new Date().toISOString();
        for (const t of metadata) {
          catalog.upsertBase(t, now);
          catalog.setOtherNames(t.name, [...new Set([...(catalog.get(t.name)?.otherNames ?? []), ...(pages.find(p => p.title === t.name && !p.is_deleted)?.other_names ?? [])])], now);
        }
        const verified = new Set(metadata.map(t => t.name));
        catalog.setCopyrights(tag, pickCopyrights(candidates.filter(x => verified.has(x.tag.name)).map(x => ({ name: x.tag.name, frequency: x.frequency, postCount: x.tag.post_count, implies: catalog.impliesClosure(x.tag.name) }))), now);
      })();
      onAdded?.([tag, ...metadata.map(t => t.name)]);
    };

    for (const item of artwork.tags.tags) {
      const names = [item.tag, ...Object.values(item.translation ?? {})];
      if (known.has(searchKey(item.tag))) {
        // Previously discovered names may still lack work metadata (including an interrupted fetch).
        for (const row of knownCharacters.all(searchKey(item.tag)) as { tag: string }[]) await enrichWorks(row.tag);
        continue;
      }
      // Retain the existing shortcut for known non-character translations. Only a
      // character translation needs the unknown original checked for identity.
      if (names.slice(1).some(n => known.has(searchKey(n)) && !knownCharacters.get(searchKey(n)))) continue;
      for (const query of names) {
        signal.throwIfAborted();
        const key = identityKey(query);
        if (!key) continue;
        if (known.has(searchKey(query))) {
          for (const row of knownCharacters.all(searchKey(query)) as { tag: string }[]) await enrichWorks(row.tag);
          continue;
        }
        const previous = queried.get(key);
        if (previous) { if (previous !== 'unknown') break; continue; }
        const hits = await client.autocomplete(query, signal);
        const exact = hits.filter(h => identityKey(h.antecedent ?? h.value) === key);
        if (exact.some(h => h.category !== undefined && h.category !== 4) && !exact.some(h => h.category === 4)) {
          queried.set(key, 'noncharacter'); break;
        }
        const candidates = [...new Set(hits.filter(h => h.category === 4).map(h => h.value))].slice(0, 10);
        if (!candidates.length) { queried.set(key, 'unknown'); continue; }
        const pages = await client.wikiByTitles(candidates, signal);
        const verifiedName = (name: string) => identityKey(name) === key || exact.some(h => h.category === 4 && h.value === name)
          || pages.some(p => p.title === name && !p.is_deleted && p.other_names.some(n => identityKey(n) === key));
        const plausible = candidates.filter(name => verifiedName(name) || reversedName(query, name));
        if (!plausible.length) { queried.set(key, 'unknown'); continue; }
        const metadata = (await client.tagsByNames(plausible, signal)).filter(t => t.category === 4 && plausible.includes(t.name));
        let accepted = false;
        for (const tag of metadata) {
          const page = pages.find(p => p.title === tag.name && !p.is_deleted);
          const exactName = verifiedName(tag.name);
          const reordered = reversedName(query, tag.name);
          if (!exactName && !reordered) continue;
          signal.throwIfAborted();
          db.transaction(() => {
            const now = new Date().toISOString();
            catalog.upsertBase(tag, now);
            catalog.setOtherNames(tag.name, [...new Set([...(catalog.get(tag.name)?.otherNames ?? []), ...(page?.other_names ?? []), ...(exactName ? [query] : [])])], now);
          })();
          onAdded?.([tag.name]);
          await enrichWorks(tag.name);
          // Reordered words alone are not enough: the artwork's work must agree too.
          if (!exactName && (artwork.isOriginal || !catalog.copyrights(tag.name).some(w => workTags().has(w)))) continue;
          if (!exactName) {
            const now = new Date().toISOString();
            db.transaction(() => catalog.setOtherNames(tag.name, [...new Set([...(catalog.get(tag.name)?.otherNames ?? []), query])], now))();
            onAdded?.([tag.name]);
          }
          accepted = true; changed = true;
        }
        // Failed work checks are specific to this artwork, not a run-wide negative cache.
        if (metadata.some(t => reversedName(query, t.name))) {
          if (accepted) break;
          continue;
        }
        queried.set(key, accepted ? 'character' : 'unknown');
        if (accepted) { known.add(searchKey(query)); break; }
      }
    }
    return { changed };
  };
}
