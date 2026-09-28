/**
 * 只读核对：对一个库文件跑合集判定，逐本打印结果（T38a 验收）。不写库。
 *   npx tsx apps/server/scripts/detect-collections.ts <emaki.sqlite 路径>
 * 输出含真实文件夹名，只放在本机（F:/Claude/.work），不要进仓库。
 */
import Database from 'better-sqlite3';
import { autoKind, decideCollection, dirFeatures, isJudged, orderPages, type DirPage } from '../src/services/collections/detect.ts';
import { parseFolderName } from '../src/services/collections/parseName.ts';

const file = process.argv[2];
if (!file) throw new Error('用法：detect-collections.ts <emaki.sqlite>');
const db = new Database(file, { readonly: true });
if ((db.pragma('user_version', { simple: true }) as number) < 6) throw new Error('需要先完成 T27（库版本 ≥ 6）');

const t0 = performance.now();
const rows = db
  .prepare(
    `SELECT i.id, i.root_id, i.rel_path, i.file_name, i.width, i.height, i.modified_at, i.content_kind, i.content_kind_source,
            i.content_kind_manual, i.tagged_at
     FROM images i JOIN library_roots r ON r.id = i.root_id
     WHERE r.enabled = 1 AND r.removed_at IS NULL AND i.trashed_at IS NULL AND i.missing = 0 AND i.excluded_by IS NULL`,
  )
  .all() as {
  id: number;
  root_id: number;
  rel_path: string;
  file_name: string;
  width: number;
  height: number;
  modified_at: string;
  content_kind: string;
  content_kind_source: string | null;
  content_kind_manual: number;
  tagged_at: string | null;
}[];

const groups = new Map<string, { dir: string; pages: DirPage[] }>();
for (const r of rows) {
  const dir = r.rel_path.length > r.file_name.length ? r.rel_path.slice(0, r.rel_path.length - r.file_name.length - 1) : '';
  if (!dir) continue;
  const key = `${r.root_id}\u0000${dir}`;
  let g = groups.get(key);
  if (!g) groups.set(key, (g = { dir, pages: [] }));
  g.pages.push({
    id: r.id,
    fileName: r.file_name,
    width: r.width,
    height: r.height,
    modifiedAt: r.modified_at,
    kind: r.content_kind,
    judged: isJudged(r),
  });
}

let doujin = 0;
let artbook = 0;
let pagesTotal = 0;
const lines: string[] = [];
for (const { dir, pages } of groups.values()) {
  const leaf = dir.split('/').pop()!;
  const f = dirFeatures(pages);
  const d = decideCollection(leaf, f);
  if (!d) continue;
  const k = autoKind(leaf, f, d.rule);
  const p = parseFolderName(leaf);
  const first = orderPages(pages, d.pageOrder)[0]!;
  if (k.kind === 'doujin') doujin++;
  else artbook++;
  pagesTotal += pages.length;
  lines.push(
    [
      dir,
      d.rule,
      `${k.kind}(${k.source})`,
      pages.length,
      d.pageOrder,
      `first=${first.id}:${first.fileName}`,
      JSON.stringify(p),
    ].join(' | '),
  );
}
const ms = Math.round(performance.now() - t0);
for (const l of lines.sort()) console.log(l);
console.log(`目录 ${groups.size} · 判出 ${doujin + artbook} 本（本子 ${doujin} · 画集 ${artbook}）· 页 ${pagesTotal} · 用时 ${ms} ms`);
