/**
 * 把随仓库分发的中文词库导入 tag_i18n / tag_name_keys / tag_renames（写表在编目模块 domain/catalog/nameIndex.ts）。版本没变就跳过。
 */
import { readFileSync, statSync } from 'node:fs';
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

/** 上次核对过的词库文件（settings 的 i18n.dictFile）：文件的签名，和当时库里记的词库版本 */
interface CheckedFile {
  signature: string;
  version: string;
}

/** 文件的签名：大小和修改时间。读不到是 null */
function signatureOf(file: string): string | null {
  try {
    const st = statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

function readSetting<T>(db: Db, key: string): T | undefined {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function writeSetting(db: Db, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export function importDictIfNeeded(
  db: Db,
  file = path.join(config.assetsDir, 'i18n/danbooru-zh.json.gz'),
  log: (m: string) => void = console.log,
): { imported: boolean; count: number; ms: number } {
  const t0 = performance.now();
  const cur = readSetting<string>(db, 'i18n.dictVersion');
  // 版本号写在文件里面，要把整份词库解压、解析出来才看得到（每次启动 0.1–0.17 秒）。文件没动过（大小、修改时间和上次核对时一样）、
  // 库里记的版本也还是当时那个，就不用再读。签名在读文件之前取：读的中途文件被换掉的话，记下的是旧签名，下次启动会重新核对。
  // 版本也要对上：迁移想强制重新导入时会删掉 i18n.dictVersion（036 这样做过）
  const signature = signatureOf(file);
  const checked = readSetting<CheckedFile>(db, 'i18n.dictFile');
  if (signature !== null && cur !== undefined && checked?.signature === signature && checked.version === cur) {
    log('中文词库已是最新');
    return { imported: false, count: 0, ms: performance.now() - t0 };
  }

  let dict: ZhDictFile;
  try {
    dict = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as ZhDictFile;
  } catch (err) {
    log(`读取中文词库失败，只能显示英文名：${(err as Error).message}`);
    return { imported: false, count: 0, ms: 0 };
  }
  const version = `${dict.source}@${dict.revision}#${dict.format}`;
  const remember = () => {
    if (signature !== null) writeSetting(db, 'i18n.dictFile', { signature, version } satisfies CheckedFile);
  };
  if (cur === version) {
    remember();
    log('中文词库已是最新');
    return { imported: false, count: 0, ms: performance.now() - t0 };
  }

  let count = 0;
  db.transaction(() => {
    count = replaceDictionary(db, dict.tags, dict.renames);
    writeSetting(db, 'i18n.dictVersion', version);
    remember();
  })();
  const ms = performance.now() - t0;
  log(`导入中文词库 ${count} 条，耗时 ${ms.toFixed(0)} ms`);
  return { imported: true, count, ms };
}
