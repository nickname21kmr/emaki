import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import { searchKey } from '@emaki/shared';
import { config } from '../src/config.ts';
import { OFFLINE_CHARACTER_FILE, OFFLINE_CHARACTER_VERSION, costumeBaseTag, identityKey } from '../src/services/catalog/offlineCharacters.ts';
import { httpFetch } from '../src/net/http.ts';

const revision = '53cb576fa9e765a1f685f6c76f20461f358f731a';
const source = `https://huggingface.co/datasets/StoryAura/Danbooru-Dataset-csv/resolve/${revision}/danbooru_character_tags_corrected.csv`;
const sha256 = 'b70c7b78703b7c81716e1d8bbd934345a72b113790432d2be9f58c91c610abb5';
interface CsvRow {
  character_tag: string;
  other_names: string;
  copyright: string;
  parent_tag: string;
  base_character: string;
  post_count: string;
}

async function download(): Promise<Buffer> {
  const res = await httpFetch(source, { signal: AbortSignal.timeout(120_000) });
  if (res.status !== 200) throw new Error(`下载角色快照失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const csvFile = process.argv[2];
const content = csvFile ? await readFile(csvFile) : await download();
if (createHash('sha256').update(content).digest('hex') !== sha256) throw new Error('角色快照校验失败');
const rows = parse(content, { columns: true, bom: true, skip_empty_lines: true }) as CsvRow[];
if (rows.length !== 329747) throw new Error(`角色快照条目数不符：${rows.length}`);
const tagName = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '_');
const worksOf = (row: CsvRow) => [...new Set(row.copyright.split(',').map(value => {
  const work = tagName(value);
  return /^original(?:_?\([^()]+\))?$/.test(work) ? 'original' : work;
}).filter(Boolean))];
const catalog = new Map(rows.map(row => [row.character_tag, { row, works: worksOf(row) }]));

// The snapshot also groups alternate forms. Only collapse a declared costume
// variant whose standard tag has the same stem and work as the parent.
function matchTag(row: CsvRow): string {
  const base = row.base_character;
  if (!base || base !== row.parent_tag) return row.character_tag;
  const parent = catalog.get(base);
  if (!parent || costumeBaseTag(row.character_tag) !== base) return row.character_tag;
  return catalog.get(row.character_tag)!.works.some(work => parent.works.includes(work)) ? base : row.character_tag;
}

await mkdir(config.dataDir, { recursive: true });
const target = path.join(config.dataDir, OFFLINE_CHARACTER_FILE);
const temporary = `${target}.${process.pid}.tmp`;
const db = new Database(temporary);
try {
  db.pragma('journal_mode = DELETE');
  db.exec(`
    CREATE TABLE character(tag TEXT PRIMARY KEY, works TEXT NOT NULL, names TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE name(identity_key TEXT NOT NULL, search_key TEXT NOT NULL, tag TEXT NOT NULL,
      PRIMARY KEY(identity_key, tag)) WITHOUT ROWID;
    CREATE TABLE work(identity_key TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(identity_key, tag)) WITHOUT ROWID;
    CREATE TABLE source(revision TEXT NOT NULL, url TEXT NOT NULL);
  `);
  const addCharacter = db.prepare('INSERT INTO character VALUES (?, ?, ?)');
  const addName = db.prepare('INSERT OR IGNORE INTO name VALUES (?, ?, ?)');
  const addWork = db.prepare('INSERT OR IGNORE INTO work VALUES (?, ?)');
  db.transaction(() => {
    for (const { row, works } of catalog.values()) {
      const names = [...new Set(row.other_names.split(',').map(value => value.trim()).filter(value => value && value.length <= 80))];
      addCharacter.run(row.character_tag, JSON.stringify(works), JSON.stringify(names));
      for (const work of works) addWork.run(identityKey(work), work);
      const tag = matchTag(row);
      for (const name of [row.character_tag, ...names]) {
        const key = searchKey(name);
        if (key && !/^[\x00-\x7f]$/.test(key)) addName.run(identityKey(name), key, tag);
      }
    }
    db.prepare('INSERT INTO source VALUES (?, ?)').run(revision, source);
  })();
  db.exec('CREATE INDEX name_search ON name(search_key, tag);');
  db.pragma(`user_version = ${OFFLINE_CHARACTER_VERSION}`);
  db.exec('ANALYZE; VACUUM;');
  if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('离线角色索引校验失败');
  db.close();
  await rename(temporary, target);
  console.log(`已建立离线角色索引：${catalog.size.toLocaleString()} 条 · ${target}`);
} finally {
  if (db.open) db.close();
  await rm(temporary, { force: true });
}
