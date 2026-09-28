/**
 * 中文名覆盖率：WD14 的角色标签里有多少离线就能显示中文名、猜到作品。
 *   npx tsx apps/server/scripts/zh-coverage.ts <selected_tags.csv>
 */
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { CopyrightResolver } from '../src/services/catalog/copyrights.ts';
import { DanbooruCatalog } from '../src/services/danbooru/catalog.ts';
import { importDictIfNeeded } from '../src/services/i18n/dict.ts';
import { SqliteLocalizer } from '../src/services/i18n/localizer.ts';
import { parseSelectedTags } from '../src/services/tagger/labels.ts';

const file = process.argv[2];
if (!file) {
  console.error('用法：npx tsx apps/server/scripts/zh-coverage.ts <selected_tags.csv>');
  process.exit(1);
}
const labels = parseSelectedTags(readFileSync(file, 'utf8'));
const db = openDatabase(':memory:');
migrate(db);
importDictIfNeeded(db);
const danbooru = new DanbooruCatalog(db, CopyrightResolver.fromAsset(db));
const loc = new SqliteLocalizer(db, danbooru);

const sources = new Map<string, number>();
let withWork = 0;
const names = labels.characterIdx.map((i) => labels.names[i]!);
for (const tag of names) {
  const s = loc.characterName(tag).source;
  sources.set(s, (sources.get(s) ?? 0) + 1);
  if (danbooru.copyrights(tag).length) withWork++;
}
const pct = (n: number) => `${((n / names.length) * 100).toFixed(1)}%`;
console.log(`角色标签 ${names.length} 个`);
for (const [s, n] of sources) console.log(`  ${s.padEnd(15)} ${String(n).padStart(5)}  ${pct(n)}`);
console.log(`有作品：${withWork}（${pct(withWork)}）`);
