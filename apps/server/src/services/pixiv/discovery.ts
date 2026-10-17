import {searchKey} from '@emaki/shared';
import type {Db} from '../../db/connection.ts';
import type {PixivArtwork} from './client.ts';
import type {DanbooruClient} from '../danbooru/client.ts';
import type {DanbooruCatalog} from '../danbooru/catalog.ts';

export interface PixivDiscoveryResult { changed: boolean }
/** 在线确认角色类型后补入目录；未知标签不生成角色建议。 */
export function createPixivDiscovery(db: Db, catalog: DanbooruCatalog, client: Pick<DanbooruClient,'autocomplete'|'tagsByNames'|'wikiByTitles'>) {
  const known = new Set((db.prepare(`SELECT search_key name FROM tag_name_keys
    UNION SELECT name FROM tags UNION SELECT name FROM characters UNION SELECT alias FROM aliases`).all() as {name:string}[]).map(r=>searchKey(r.name)));
  const queried = new Map<string,'unknown'|'noncharacter'|'character'>();
  return async (artwork: PixivArtwork, signal: AbortSignal): Promise<PixivDiscoveryResult> => {
    let changed=false;
    for(const item of artwork.tags.tags) {
      const names=[item.tag,...Object.values(item.translation??{})];
      if(names.some(n=>known.has(searchKey(n)))) continue;
      for(const query of names) {
        signal.throwIfAborted();
        const key=searchKey(query);
        if(!key) continue;
        const previous=queried.get(key);
        if(previous){if(previous!=='unknown') break;continue;}
        const hits=(await client.autocomplete(query,signal)).filter(h=>searchKey(h.antecedent??h.value)===key);
        const tags=[...new Set(hits.filter(h=>h.category===4).map(h=>h.value))];
        if(!tags.length){
          const noncharacter=hits.some(h=>h.category!==undefined&&h.category!==4);
          queried.set(key,noncharacter?'noncharacter':'unknown');
          if(noncharacter) break;
          continue;
        }
        const metadata=(await client.tagsByNames(tags,signal)).filter(t=>t.category===4);
        const pages=await client.wikiByTitles(metadata.map(t=>t.name),signal);
        signal.throwIfAborted();
        db.transaction(()=>{
          const now=new Date().toISOString();
          for(const tag of metadata){
            catalog.upsertBase(tag,now);
            const page=pages.find(p=>p.title===tag.name&&!p.is_deleted);
            catalog.setOtherNames(tag.name,[...new Set([...(catalog.get(tag.name)?.otherNames??[]),...(page?.other_names??[]),query])],now);
          }
        })();
        queried.set(key,metadata.length?'character':'unknown');
        if(metadata.length){known.add(key);changed=true;break;}
      }
    }
    return {changed};
  };
}
