/**
 * 用真实的 Danbooru 接口查几个标签（内存 SQLite），看改名解析和作品推断是否正确。
 *   npx tsx apps/server/scripts/danbooru-probe.ts 'mika_(blue_archive)' gojou_satoru [--log]
 */
import { EventBus } from '../src/core/events.ts';
import { SqliteDataSource } from '../src/datasource/sqlite/SqliteDataSource.ts';
import { defaultFetchLike, type FetchLike } from '../src/net/http.ts';
import { DanbooruClient } from '../src/services/danbooru/client.ts';
import { pickCopyrights } from '../src/services/danbooru/copyright.ts';
import { makeTmpDir } from '../test/helpers/tmp.ts';

const args = process.argv.slice(2);
const logRequests = args.includes('--log');
const tags = args.filter((a) => a !== '--log');
if (!tags.length) {
  console.error("用法：npx tsx apps/server/scripts/danbooru-probe.ts <tag...> [--log]");
  process.exit(1);
}

const ds = await SqliteDataSource.open(new EventBus(), makeTmpDir('probe'), { memory: true, autoJobs: false });
const d = ds.danbooru;
const t0 = Date.now();
const fetchImpl: FetchLike = (url, init) => {
  if (logRequests) console.log(`  [${((Date.now() - t0) / 1000).toFixed(2)}s] GET ${decodeURIComponent(new URL(url).pathname + new URL(url).search).slice(0, 110)}`);
  return defaultFetchLike(url, init);
};
const client = new DanbooruClient({ fetchImpl });
const signal = new AbortController().signal;
const now = () => new Date().toISOString();

for (const raw of tags) {
  let tag = raw;
  const [meta] = await client.tagsByNames([tag], signal);
  if (meta?.antecedent_alias?.status === 'active') {
    d.markAlias(tag, meta.antecedent_alias.consequent_name, now());
    tag = meta.antecedent_alias.consequent_name;
  }
  const r = await client.relatedCopyrights(tag, signal);
  if (r.tag && r.tag.name !== tag) tag = r.tag.name;
  const cands = r.related_tags.filter((x) => x.tag.category === 3 && x.frequency >= 0.3);
  const metas = cands.length ? await client.tagsByNames(cands.map((x) => x.tag.name), signal) : [];
  for (const m of metas) d.upsertBase(m, now());
  const picked = pickCopyrights(cands.map((x) => ({ name: x.tag.name, frequency: x.frequency, postCount: x.tag.post_count, implies: d.impliesClosure(x.tag.name) })));
  const [wiki] = await client.wikiByTitles([tag], signal);
  console.log(`${raw}${tag !== raw ? ` → ${tag}` : ''}：category ${r.tag?.category ?? '?'} · copyrights [${picked.join(', ')}] · other_names ${JSON.stringify((wiki?.other_names ?? []).slice(0, 5))}`);
}
await ds.close();
