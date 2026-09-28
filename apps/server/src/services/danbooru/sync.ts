/**
 * 「同步 Danbooru」后台任务。每次网络请求结束后才开同步事务写库（事务里不能 await）。
 *   A 标签元数据（存在否、分类、改名、implication）
 *   C 角色 → 作品（related_tag，按库里张数优先，每次最多 1500 个，可让出）
 *   B wiki other_names（放在 C 之后，C 新发现的作品也能拿到）
 *   D 自建角色在线匹配（autocomplete）
 *   E 落库（即使前面失败也执行；关闭联网时只做 E）
 */
import { searchKey } from '@emaki/shared';
import type { JobRunner } from '../../core/jobs.ts';
import type { Db } from '../../db/connection.ts';
import type { FetchLike } from '../../net/http.ts';
import type { CharacterCatalog } from '../catalog/characterCatalog.ts';
import type { Localizer } from '../i18n/localizer.ts';
import { applyToLibrary, type ApplyDeps } from './apply.ts';
import type { DanbooruCatalog } from './catalog.ts';
import { DanbooruClient } from './client.ts';
import { pickCopyrights } from './copyright.ts';
import type { RateLimiter } from './rateLimiter.ts';

export interface DanbooruSyncDeps {
  db: Db;
  danbooru: DanbooruCatalog;
  getCatalog(): CharacterCatalog;
  localizer: Localizer;
  getDanbooru(): { enabled: boolean; username: string; apiKey: string | null };
  setLastSyncAt(iso: string): void;
  relocalizeAll?: ApplyDeps['relocalizeAll'];
  now?: () => number;
  // 测试注入
  fetchImpl?: FetchLike;
  limiter?: RateLimiter;
}

const TTL_DAYS = 30;
const NOT_FOUND_TTL_DAYS = 7;
const MAX_RELATED_PER_RUN = 1500;
const ONLINE_MATCH_PER_RUN = 50;
const MIN_FREQ = 0.3;
const WIKI_BATCH = 100;
const DAY = 86_400_000;

export function createDanbooruSyncRunner(deps: DanbooruSyncDeps): JobRunner {
  const { db, danbooru } = deps;
  const nowMs = () => deps.now?.() ?? Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();

  return async (ctx) => {
    const settings = deps.getDanbooru();
    const apply = () => {
      const r = applyToLibrary({ db, danbooru, getCatalog: deps.getCatalog, localizer: deps.localizer, relocalizeAll: deps.relocalizeAll });
      deps.localizer.invalidate();
      return r;
    };
    if (!settings.enabled) {
      ctx.setMessage('联网同步已关闭，只用本地词库整理');
      apply();
      return '同步 Danbooru：联网同步已关闭，已用本地词库整理';
    }

    const client = new DanbooruClient({
      login: settings.username || undefined,
      apiKey: settings.apiKey ?? undefined,
      fetchImpl: deps.fetchImpl,
      limiter: deps.limiter,
    });
    const signal = ctx.signal;
    const stale = iso(nowMs() - TTL_DAYS * DAY);
    const notFoundStale = iso(nowMs() - NOT_FOUND_TTL_DAYS * DAY);
    let updatedTags = 0;
    let copyrightChars = 0;
    let otherNames = 0;
    let done = 0;
    let completed = false;
    let yielded = false;

    /** 查标签元数据并落库；改名的新名字再递归一次 */
    const fetchTagMeta = async (names: string[], depth = 0): Promise<void> => {
      if (!names.length || signal.aborted) return;
      const tags = await client.tagsByNames(names, signal);
      const now = iso(nowMs());
      const returned = new Set(tags.map((t) => t.name));
      const renamedTo: string[] = [];
      db.transaction(() => {
        for (const t of tags) {
          // tags.json 会返回已改名的旧名（post_count 0 + antecedent_alias），不能当成正常标签存
          if (t.antecedent_alias && t.antecedent_alias.status === 'active') {
            danbooru.markAlias(t.name, t.antecedent_alias.consequent_name, now);
            renamedTo.push(t.antecedent_alias.consequent_name);
          } else {
            danbooru.upsertBase(t, now);
          }
          updatedTags++;
        }
      })();
      const missing = names.filter((n) => !returned.has(n));
      if (missing.length) {
        const aliases = await client.aliasesByAntecedents(missing, signal);
        const now2 = iso(nowMs());
        const aliased = new Set<string>();
        db.transaction(() => {
          for (const a of aliases) {
            danbooru.markAlias(a.antecedent_name, a.consequent_name, now2);
            aliased.add(a.antecedent_name);
            renamedTo.push(a.consequent_name);
          }
          for (const n of missing) if (!aliased.has(n)) danbooru.markNotFound(n, now2);
        })();
      }
      const follow = [...new Set(renamedTo)].filter((n) => danbooru.needsMeta(n, stale));
      if (depth < 1 && follow.length) await fetchTagMeta(follow, depth + 1);
    };

    try {
      // ---- A：需要查的标签
      const wanted = db
        .prepare(
          `WITH wanted(name) AS (
             SELECT danbooru_tag FROM characters WHERE danbooru_tag IS NOT NULL
             UNION SELECT danbooru_tag FROM works WHERE danbooru_tag IS NOT NULL
             UNION SELECT danbooru_tag FROM character_suggestions
             UNION SELECT name FROM tags WHERE category IN ('character', 'copyright')
           )
           SELECT w.name FROM wanted w LEFT JOIN danbooru_tags d ON d.name = w.name
           WHERE d.name IS NULL
              OR (d.not_found = 0 AND d.fetched_at < @stale)
              OR (d.not_found = 1 AND d.fetched_at < @notFoundStale)`,
        )
        .pluck()
        .all({ stale, notFoundStale }) as string[];

      const relatedQuery = db.prepare(
        `SELECT d.name FROM danbooru_tags d
         LEFT JOIN characters c ON c.danbooru_tag = d.name
         LEFT JOIN image_characters ic ON ic.character_id = c.id
         WHERE d.category = 4 AND d.not_found = 0 AND d.alias_of IS NULL
           AND (d.related_fetched_at IS NULL OR d.related_fetched_at < @stale)
         GROUP BY d.name ORDER BY COUNT(ic.image_id) DESC, d.post_count DESC LIMIT ${MAX_RELATED_PER_RUN}`,
      );

      const aBatches = Math.ceil(wanted.length / 100);
      ctx.setTotal(aBatches);
      for (let i = 0; i < wanted.length && !signal.aborted; i += 100) {
        await fetchTagMeta(wanted.slice(i, i + 100));
        ctx.advance(1, `查询标签 ${Math.min(i + 100, wanted.length)}/${wanted.length}`);
        done++;
      }

      // ---- C：角色 → 作品
      const related = relatedQuery.pluck().all({ stale }) as string[];
      ctx.setTotal(done + related.length);
      for (let i = 0; i < related.length && !signal.aborted; i++) {
        if (ctx.shouldYield()) {
          yielded = true;
          break;
        }
        let name = related[i]!;
        const r = await client.relatedCopyrights(name, signal);
        const now = iso(nowMs());
        if (!r.tag) {
          db.transaction(() => danbooru.setCopyrights(name, [], now))();
        } else {
          if (r.tag.name !== name) {
            // related_tag 会自动解析别名：结果写到新名上
            db.transaction(() => danbooru.markAlias(name, r.tag!.name, now))();
            name = r.tag.name;
            if (danbooru.needsMeta(name, stale)) await fetchTagMeta([name]);
          }
          const cands = r.related_tags.filter((x) => x.tag.category === 3 && x.frequency >= MIN_FREQ);
          const unknown = cands.map((x) => x.tag.name).filter((n) => danbooru.needsMeta(n, stale));
          if (unknown.length) await fetchTagMeta(unknown); // 为了拿 implication
          const picked = pickCopyrights(
            cands.map((x) => ({ name: x.tag.name, frequency: x.frequency, postCount: x.tag.post_count, implies: danbooru.impliesClosure(x.tag.name) })),
          );
          db.transaction(() => danbooru.setCopyrights(name, picked, iso(nowMs())))();
          if (picked.length) copyrightChars++;
        }
        done++;
        ctx.advance(1, `查询所属作品 ${i + 1}/${related.length}`);
      }

      if (!yielded && !signal.aborted) {
        // ---- B：wiki 其他名字
        const wikiNames = db
          .prepare(
            `SELECT name FROM danbooru_tags WHERE category IN (3, 4) AND not_found = 0 AND alias_of IS NULL
               AND (wiki_fetched_at IS NULL OR wiki_fetched_at < ?)`,
          )
          .pluck()
          .all(stale) as string[];
        const customs = db
          .prepare(
            `SELECT c.id, c.name FROM characters c
             WHERE c.source = 'custom' AND c.danbooru_tag IS NULL
               AND NOT EXISTS (SELECT 1 FROM custom_character_matches m WHERE m.character_id = c.id)
             LIMIT ${ONLINE_MATCH_PER_RUN}`,
          )
          .all() as { id: number; name: string }[];
        ctx.setTotal(done + Math.ceil(wikiNames.length / WIKI_BATCH) + customs.length);

        const fetchWiki = async (names: string[]) => {
          const pages = await client.wikiByTitles(names, signal);
          const now = iso(nowMs());
          const byTitle = new Map(pages.filter((p) => !p.is_deleted).map((p) => [p.title, p.other_names]));
          db.transaction(() => {
            for (const n of names) {
              const list = byTitle.get(n) ?? [];
              danbooru.setOtherNames(n, list, now); // 没有 wiki 也记 wiki_fetched_at
              otherNames += list.length;
            }
          })();
        };
        for (let i = 0; i < wikiNames.length && !signal.aborted; i += WIKI_BATCH) {
          await fetchWiki(wikiNames.slice(i, i + WIKI_BATCH));
          done++;
          ctx.advance(1, `查询别名 ${Math.min(i + WIKI_BATCH, wikiNames.length)}/${wikiNames.length}`);
        }

        // ---- D：自建角色在线匹配
        const insKey = db.prepare("INSERT OR IGNORE INTO tag_name_keys (search_key, tag, kind, source) VALUES (?, ?, 'other_name', 'danbooru')");
        const aliasOf = db.prepare("SELECT alias FROM aliases WHERE owner_type = 'character' AND owner_id = ? ORDER BY position LIMIT 2").pluck();
        for (const c of customs) {
          if (signal.aborted) break;
          const queries = [c.name, ...(aliasOf.all(c.id) as string[])];
          const found: [string, string][] = [];
          for (const q of queries) {
            for (const hit of await client.autocomplete(q, signal)) {
              if (hit.category === 4 && searchKey(hit.antecedent ?? hit.value) === searchKey(q)) found.push([searchKey(q), hit.value]);
            }
          }
          const tags = [...new Set(found.map(([, t]) => t))];
          const need = tags.filter((t) => danbooru.needsMeta(t, stale));
          if (need.length) await fetchTagMeta(need);
          const needWiki = tags.filter((t) => !danbooru.get(t)?.wikiFetchedAt);
          if (needWiki.length) await fetchWiki(needWiki);
          db.transaction(() => {
            for (const [k, t] of found) insKey.run(k, t);
          })();
          done++;
          ctx.advance(1, `匹配自建角色 ${c.name}`);
        }
        completed = !signal.aborted;
      }
    } finally {
      // E：即使前面失败 / 取消了也把已有的结果落库（取消时 JobQueue 马上标 cancelled，这里仍然很快）
      if (!signal.aborted) apply();
    }

    if (yielded) {
      ctx.requeue();
      return `同步 Danbooru：已让出给扫描（更新 ${updatedTags} 个标签 · 作品 ${copyrightChars} 个角色）`;
    }
    if (completed) deps.setLastSyncAt(iso(nowMs()));
    return `同步 Danbooru：更新 ${updatedTags} 个标签 · 作品 ${copyrightChars} 个角色 · 别名 ${otherNames} 条`;
  };
}

/** 有 character 标签在 danbooru_tags 里还没有行（打完标签后要不要自动同步） */
export function hasUncachedCharacterTags(db: Db): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM characters c WHERE c.danbooru_tag IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM danbooru_tags d WHERE d.name = c.danbooru_tag) LIMIT 1`,
    )
    .get();
}
