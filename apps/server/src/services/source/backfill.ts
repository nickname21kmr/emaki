import type { Db } from '../../db/connection.ts';
import { parseSource, SOURCE_PARSER_VERSION } from './parseSource.ts';

/** settings 里的 sourceParserVersion 和当前规则版本不同时，对所有行重算 source_* 并写回版本号；返回重算的行数 */
export function backfillSources(db: Db): number {
  const cur = db.prepare("SELECT value FROM settings WHERE key = 'sourceParserVersion'").pluck().get() as string | undefined;
  if (cur !== undefined && Number(JSON.parse(cur)) === SOURCE_PARSER_VERSION) return 0;

  const upd = db.prepare(
    'UPDATE images SET source_site = @site, source_post_id = @postId, source_artist = @artist, source_url = @url WHERE id = @id',
  );
  let n = 0;
  // 纯字符串处理，10 万行也不到 1 秒，放在一个事务里
  db.transaction(() => {
    // 先 all() 再写：better-sqlite3 不允许在 iterate() 的同时执行写语句
    for (const r of db.prepare('SELECT id, rel_path FROM images').all() as { id: number; rel_path: string }[]) {
      const s = parseSource(r.rel_path);
      upd.run({ id: r.id, site: s?.site ?? null, postId: s?.postId ?? null, artist: s?.artist ?? null, url: s?.url ?? null });
      n++;
    }
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('sourceParserVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(JSON.stringify(SOURCE_PARSER_VERSION));
  })();
  return n;
}
