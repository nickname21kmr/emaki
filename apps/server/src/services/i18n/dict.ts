/**
 * 把随仓库分发的中文词库导入 tag_i18n / tag_name_keys / tag_renames（写表在编目模块 domain/catalog/nameIndex.ts）。版本没变就跳过。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { config } from '../../config.ts';
import type { Db } from '../../db/connection.ts';
import { replaceDictionary, type DictEntry } from '../../domain/catalog/nameIndex.ts';

interface ZhDictFile {
  format: 1;
  source: string;
  revision: string;
  license: string;
  generatedAt: string;
  /** tag → [category, zh | null, aliases, copyrightGuess | null, postCount] */
  tags: Record<string, DictEntry>;
  renames: Record<string, string>;
}

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

  let count = 0;
  db.transaction(() => {
    count = replaceDictionary(db, dict.tags, dict.renames);
    db.prepare("INSERT INTO settings (key, value) VALUES ('i18n.dictVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      JSON.stringify(version),
    );
  })();
  const ms = performance.now() - t0;
  log(`导入中文词库 ${count} 条，耗时 ${ms.toFixed(0)} ms`);
  return { imported: true, count, ms };
}
