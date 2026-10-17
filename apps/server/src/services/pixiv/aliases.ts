import type { Db } from '../../db/connection.ts';
import type { JobContext } from '../../core/jobs.ts';
import type { DanbooruCatalog } from '../danbooru/catalog.ts';
import type { DanbooruClient } from '../danbooru/client.ts';

/** 复用 Danbooru wiki 别名和索引写入，只补尚未获取的已知角色/作品。 */
export async function refreshPixivAliases(db: Db, catalog: DanbooruCatalog, client: Pick<DanbooruClient, 'wikiByTitles'>, job: JobContext): Promise<void> {
  const names = db.prepare(`SELECT name FROM danbooru_tags WHERE category IN (3,4)
    AND not_found=0 AND alias_of IS NULL AND wiki_fetched_at IS NULL ORDER BY name`).pluck().all() as string[];
  for (let offset=0; offset<names.length; offset+=100) {
    job.signal.throwIfAborted();
    // 同道有更急的任务：让出，没补的仍是 wiki_fetched_at 为空，下一轮接着补（随后的投稿循环也会立刻让出）
    if (job.shouldYield()) { job.requeue(); return; }
    const batch=names.slice(offset,offset+100);
    job.setMessage(`补全角色/作品别名 ${offset}/${names.length}`);
    const pages=await client.wikiByTitles(batch,job.signal);
    job.signal.throwIfAborted();
    const byTitle=new Map(pages.filter(p=>!p.is_deleted).map(p=>[p.title,p.other_names]));
    db.transaction(()=>{
      const now=new Date().toISOString();
      for(const name of batch) catalog.setOtherNames(name,byTitle.get(name)??[],now);
    })();
  }
}
