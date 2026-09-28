/**
 * 把随仓库分发的中文词库导入 tag_i18n / tag_name_keys / tag_renames。版本没变就跳过。
 */
import { searchKey } from '@emaki/shared';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { config } from '../../config.ts';
import type { Db } from '../../db/connection.ts';
import { stripZhQualifier } from './humanize.ts';

interface ZhDictFile {
  format: 1;
  source: string;
  revision: string;
  license: string;
  generatedAt: string;
  /** tag → [category, zh | null, aliases, copyrightGuess | null, postCount] */
  tags: Record<string, [number, string | null, string[], string | null, number]>;
  renames: Record<string, string>;
}

/** key 为空、或纯 ASCII 且长度 < 2 的跳过 */
const usable = (k: string) => !!k && !(/^[\x00-\x7f]*$/.test(k) && k.length < 2);

export function importDictIfNeeded(
  db: Db,
  file = path.join(config.assetsDir, 'i18n/danbooru-zh.json.gz'),
  log: (m: string) => void = console.log,
): { imported: boolean; count: number; ms: number } {
  const t0 = performance.now();
  let dict: ZhDictFile;
  try {
    dict = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as ZhDictFile;
  } catch (err) {
    log(`读取中文词库失败，只能显示英文名：${(err as Error).message}`);
    return { imported: false, count: 0, ms: 0 };
  }
  const version = `${dict.source}@${dict.revision}#${dict.format}`;
  const cur = db.prepare("SELECT value FROM settings WHERE key = 'i18n.dictVersion'").pluck().get() as string | undefined;
  if (cur && JSON.parse(cur) === version) {
    log('中文词库已是最新');
    return { imported: false, count: 0, ms: performance.now() - t0 };
  }

  const insTag = db.prepare('INSERT INTO tag_i18n (tag, category, zh, aliases, copyright_guess, post_count) VALUES (?, ?, ?, ?, ?, ?)');
  const insKey = db.prepare("INSERT OR IGNORE INTO tag_name_keys (search_key, tag, kind, source) VALUES (?, ?, ?, 'dict')");
  const insRename = db.prepare("INSERT OR IGNORE INTO tag_renames (old_name, new_name, source) VALUES (?, ?, 'dict')");
  let count = 0;
  db.transaction(() => {
    db.exec("DELETE FROM tag_i18n; DELETE FROM tag_name_keys WHERE source = 'dict'; DELETE FROM tag_renames WHERE source = 'dict';");
    for (const [tag, [category, zh, aliases, guess, postCount]] of Object.entries(dict.tags)) {
      insTag.run(tag, category, zh, JSON.stringify(aliases), guess, postCount);
      if (zh) {
        const k = searchKey(stripZhQualifier(zh));
        if (usable(k)) insKey.run(k, tag, 'zh');
      }
      for (const a of aliases) {
        const k = searchKey(a);
        if (usable(k)) insKey.run(k, tag, 'alias');
      }
      const k = searchKey(tag);
      if (usable(k)) insKey.run(k, tag, 'tag');
      count++;
    }
    for (const [oldName, newName] of Object.entries(dict.renames)) insRename.run(oldName, newName);
    db.prepare("INSERT INTO settings (key, value) VALUES ('i18n.dictVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      JSON.stringify(version),
    );
  })();
  const ms = performance.now() - t0;
  log(`导入中文词库 ${count} 条，耗时 ${ms.toFixed(0)} ms`);
  return { imported: true, count, ms };
}
