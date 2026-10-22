import type { Db } from '../../db/connection.ts';
import { readSettings } from '../../datasource/sqlite/settings.ts';
import { parseSource, SOURCE_PARSER_VERSION } from './parseSource.ts';

/** 规则版本或解析模式变化时重算未人工确认的来源；返回重算的行数。 */
export function backfillSources(db: Db): number {
  const mode = readSettings(db).tagger.pixivFilenameMode;
  const cur = db.prepare("SELECT value FROM settings WHERE key = 'sourceParserVersion'").pluck().get() as string | undefined;
  const previousMode = db.prepare("SELECT value FROM settings WHERE key = 'sourceParserMode'").pluck().get();
  if (cur !== undefined && Number(JSON.parse(cur)) === SOURCE_PARSER_VERSION && previousMode === JSON.stringify(mode)) return 0;

  const upd = db.prepare(
    'UPDATE images SET source_site = @site, source_post_id = @postId, source_artist = @artist, source_url = @url WHERE id = @id AND source_manual = 0',
  );
  const clearPixiv = db.prepare("DELETE FROM character_suggestions WHERE image_id=? AND source='pixiv'");
  let n = 0;
  // 纯字符串处理，10 万行也不到 1 秒，放在一个事务里
  db.transaction(() => {
    // 先 all() 再写：better-sqlite3 不允许在 iterate() 的同时执行写语句
    for (const r of db.prepare('SELECT id, rel_path, source_site, source_post_id FROM images WHERE source_manual = 0').all() as {
      id: number; rel_path: string; source_site: string | null; source_post_id: string | null;
    }[]) {
      const s = parseSource(r.rel_path, mode);
      // Suggestions from a different post are no longer evidence for this image.
      if (r.source_site === 'pixiv' && (s?.site !== 'pixiv' || s.postId !== r.source_post_id)) clearPixiv.run(r.id);
      upd.run({ id: r.id, site: s?.site ?? null, postId: s?.postId ?? null, artist: s?.artist ?? null, url: s?.url ?? null });
      n++;
    }
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('sourceParserVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(JSON.stringify(SOURCE_PARSER_VERSION));
    db.prepare("INSERT INTO settings (key, value) VALUES ('sourceParserMode', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(mode));
  })();
  return n;
}
