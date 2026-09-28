/**
 * 生成随仓库分发的中文词库 apps/server/assets/i18n/danbooru-zh.json.gz。
 *   npm run build:zh-dict -w @emaki/server
 *
 * 来源：ame-la/danbooru-tags-data-zh（MIT），固定修订号。只有 1 star、单人维护，所以不在运行时联网取。
 */
import { searchKey } from '@emaki/shared';
import { parse } from 'csv-parse/sync';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { config } from '../src/config.ts';
import { httpFetch } from '../src/net/http.ts';

const HF_REV = '1b0900609723e8704c5b69329ed9fde65f5457d5';
const GH_REV = '5805e4700f52dbe66567b84a157e29a41b3a5bcc';
const HF = process.env.HF_ENDPOINT ?? 'https://huggingface.co';
const BASES = [
  `${HF}/datasets/ame-la/danbooru-tags-data-zh/resolve/${HF_REV}/`,
  `https://hf-mirror.com/datasets/ame-la/danbooru-tags-data-zh/resolve/${HF_REV}/`,
  `https://raw.githubusercontent.com/amenorira/danbooru-tags-data-zh/${GH_REV}/`,
  `https://cdn.jsdelivr.net/gh/amenorira/danbooru-tags-data-zh@${GH_REV}/`,
];
/** [文件, category, 最少行数] */
const FILES = [
  ['character.csv', 4, 30000],
  ['copyright.csv', 3, 7000],
  ['general.csv', 0, 25000],
] as const;

type Row = { tag: string; category: number; zh: string | null; aliases: string[]; count: number; notes: string };

async function fetchText(rel: string): Promise<string> {
  const errors: string[] = [];
  for (const base of BASES) {
    try {
      const res = await httpFetch(base + rel, { headers: { 'User-Agent': 'Emaki-build/0.1' }, signal: AbortSignal.timeout(60_000) });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      errors.push(`${base}：${(err as Error).message}`);
    }
  }
  throw new Error(`下载 ${rel} 失败：${errors.join('；')}`);
}

const clean = (s: string) => s.trim().replace(/^['"]+|['"]+$/g, '').trim();

async function load(file: string, category: number, minRows: number): Promise<Row[]> {
  const records = parse(await fetchText(`tags/${file}`), {
    columns: true,
    bom: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  if (records.length < minRows) throw new Error(`${file} 只有 ${records.length} 行，少于 ${minRows}`);
  return records.map((r) => {
    const tag = clean(r.tag ?? '');
    const aliases = [...new Set((r.aliases ?? '').split('|').map(clean))].filter((a) => a && a !== tag && a.length <= 40);
    return { tag, category, zh: clean(r.zh ?? '') || null, aliases, count: Number(r.count) || 0, notes: r.notes ?? '' };
  });
}

const [chars, cops, general] = await Promise.all(FILES.map(([f, c, n]) => load(f, c, n)));

// 作品反查：tag / zh / alias 的 searchKey → copyright tag（按 count 降序，先到先得）
const copTags = new Set(cops!.map((c) => c.tag));
const copKey = new Map<string, string>();
for (const c of [...cops!].sort((a, b) => b.count - a.count)) {
  for (const k of [c.tag, c.zh ?? '', ...c.aliases].map(searchKey)) if (k && !copKey.has(k)) copKey.set(k, c.tag);
}

function guessCopyright(r: Row): string | null {
  // a. 限定词
  const q = /_\(([^()]+)\)$/.exec(r.tag)?.[1];
  if (q) {
    if (copTags.has(q)) return q;
    const hit = copKey.get(searchKey(q));
    if (hit) return hit;
  }
  // b. notes 里第一个《…》
  const book = /《([^》]+)》/.exec(r.notes)?.[1];
  if (book) {
    const hit = copKey.get(searchKey(book));
    if (hit) return hit;
  }
  // c. notes 开头到「中的 / 的 / 旗下 / 所属」之前，或第一个词
  const head = /^(.+?)(中的|旗下|所属|的)/.exec(r.notes)?.[1];
  const first = r.notes.split(/[\s,，、。]+/)[0];
  for (const cand of [head, first]) {
    if (!cand) continue;
    const hit = copKey.get(searchKey(cand));
    if (hit) return hit;
  }
  return null;
}

const tags: Record<string, [number, string | null, string[], string | null, number]> = {};
for (const r of [...general!, ...cops!, ...chars!]) {
  if (!r.tag) continue;
  tags[r.tag] = [r.category, r.zh, r.aliases, r.category === 4 ? guessCopyright(r) : null, r.count];
}

// 旧名映射：角色 aliases 里像标签的（含下划线、本身不是词库 tag）→ 该行 tag
const renames: Record<string, string> = {};
const OLD_TAG = /^[a-z0-9_().:'!&/+-]+$/;
for (const r of chars!) {
  for (const a of r.aliases) if (OLD_TAG.test(a) && a.includes('_') && !(a in tags) && !(a in renames)) renames[a] = r.tag;
}

const data = {
  format: 1,
  source: 'ame-la/danbooru-tags-data-zh',
  revision: HF_REV,
  license: 'MIT',
  generatedAt: new Date().toISOString(),
  tags,
  renames,
};
const outDir = path.join(config.assetsDir, 'i18n');
await mkdir(outDir, { recursive: true });
const gz = gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 });
await writeFile(path.join(outDir, 'danbooru-zh.json.gz'), gz);

let license = '';
try {
  license = await fetchText('LICENSE');
} catch {
  license = '（下载 LICENSE 失败，请参考数据集页面的 MIT 许可）';
}
await writeFile(
  path.join(outDir, 'NOTICE.md'),
  `# 中文词库来源

\`danbooru-zh.json.gz\` 由 \`apps/server/scripts/build-zh-dict.ts\` 从下面的数据集生成（精简了字段）：

- 数据集：ame-la/danbooru-tags-data-zh
  - Hugging Face：https://huggingface.co/datasets/ame-la/danbooru-tags-data-zh（修订 ${HF_REV}）
  - GitHub：https://github.com/amenorira/danbooru-tags-data-zh（commit ${GH_REV}）
- 许可证：MIT（全文见下）
- 生成时间：${data.generatedAt}
- 数据根据 Danbooru 公开的标签信息整理。

备选（未采用）：EhTagTranslation（CC BY-NC-SA 3.0，不能随本仓库分发）；byzod Tags-zh-full-pack（MIT，但数据陈旧）。

## 许可证全文

\`\`\`
${license.trim()}
\`\`\`
`,
);

const withZh = (rows: Row[]) => `${((rows.filter((r) => r.zh).length / rows.length) * 100).toFixed(1)}%`;
console.log(`character ${chars!.length}（有中文 ${withZh(chars!)}） · copyright ${cops!.length}（${withZh(cops!)}） · general ${general!.length}（${withZh(general!)}）`);
console.log(`有作品猜测的角色 ${chars!.filter((r) => tags[r.tag]?.[3]).length} · 旧名映射 ${Object.keys(renames).length} · gz ${(gz.length / 1048576).toFixed(2)} MB`);
