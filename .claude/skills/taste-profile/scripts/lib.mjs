// 个人喜好分析：各脚本共用的路径、读库、时期划分、统计单元
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(SKILL_DIR, '../../..');
const require = createRequire(path.join(REPO, 'apps/server/package.json'));
export const Database = require('better-sqlite3');

/** 命令行参数：--out 目录、--data Emaki 数据目录、--private 等开关 */
export function args() {
  const a = process.argv.slice(2);
  const get = (k) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const dataDir = path.resolve(get('--data') ?? process.env.EMAKI_DATA_DIR ?? path.join(REPO, 'data'));
  const out = path.resolve(get('--out') ?? path.join(dataDir, 'profile'));
  mkdirSync(out, { recursive: true });
  return { dataDir, out, private: a.includes('--private'), get, has: (k) => a.includes(k) };
}

export const readJson = (f, fallback = null) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback);
export const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v));

/** 快照（snapshot.mjs 生成）；只读打开，search_key 和服务端一样 */
export function openSnapshot(out) {
  const f = path.join(out, 'lib.sqlite');
  if (!existsSync(f)) throw new Error(`没有快照 ${f}，先运行 snapshot.mjs`);
  const db = new Database(f, { readonly: true });
  return db;
}

// ---------------------------------------------------------------- 文本
export const searchKey = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[\s_\-·・]+/g, '')
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));

/** 涉及未成年的标签：带这些标签的图整张不参与任何统计 */
export const MINOR = /(^|_)(loli|shota|child|children|toddler|aged_down|kindergarten|elementary_school|female_child|male_child)(_|$)/;
export const MALE = ['1boy', '2boys', '3boys', 'multiple_boys', 'male_focus', 'bara', 'muscular_male', 'yaoi'];
export const isFemaleOnly = (tags) => !MALE.some((t) => tags.has(t)) && ['1girl', '2girls', '3girls', 'multiple_girls'].some((t) => tags.has(t));
export const isNsfw = (rating) => rating === 'questionable' || rating === 'explicit';

// ---------------------------------------------------------------- 时间
/**
 * 保存时间：文件名里的时间戳优先（iPhone 导出的 2023_01_12_21_51_57_…、QQ 的 Image_<毫秒>），
 * 否则用文件修改时间。exact = 精确到秒、可以用来看几点存的。
 */
export function savedAt(fileName, modifiedAt) {
  let m = /^(20\d\d)_(\d\d)_(\d\d)_(\d\d)_(\d\d)_(\d\d)_/.exec(fileName);
  if (m) return { t: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(), exact: true };
  m = /^Image_(1[5-9]\d{11})\./.exec(fileName);
  if (m) return { t: +m[1], exact: true };
  const t = Date.parse(modifiedAt);
  return Number.isFinite(t) ? { t, exact: false } : { t: null, exact: false };
}
export const halfYear = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}${d.getMonth() < 6 ? '上' : '下'}`;
};

// ---------------------------------------------------------------- 图
/**
 * 图库里计入的插画。period：按半年；修改时间早于 --since（默认 2018）或者文件夹被标为「时间不可信」的，归到「更早」。
 * 有的备份复制时把修改时间改成了复制那天：那种文件夹用 --undated-roots 1,3 指定，整体算「更早」。
 */
export function loadIllustrations(db, { undatedRoots = [], since = 2018 } = {}) {
  const rows = db
    .prepare(
      `SELECT i.id, i.root_id, i.file_name, i.modified_at, i.rating, COALESCE(i.tagger_model, '') AS model, i.tagged_at,
        i.width, i.height, i.added_at
       FROM images i JOIN library_roots r ON r.id = i.root_id
       WHERE r.enabled = 1 AND r.removed_at IS NULL AND i.missing = 0 AND i.trashed_at IS NULL AND i.excluded_by IS NULL
         AND i.content_kind = 'illustration'`,
    )
    .all();
  for (const r of rows) {
    const s = undatedRoots.includes(r.root_id) ? { t: null, exact: false } : savedAt(r.file_name, r.modified_at);
    r.t = s.t !== null && new Date(s.t).getFullYear() >= since ? s.t : null;
    r.exact = s.exact && r.t !== null;
    r.per = r.t === null ? '更早' : halfYear(r.t);
    r.wd = r.model.includes('wd');
  }
  // 开头零星的几个半年（不到 1%、也不到 200 张，多半是修改时间不准的老文件）并进「更早」
  const cnt = {};
  for (const r of rows) cnt[r.per] = (cnt[r.per] ?? 0) + 1;
  const min = Math.max(200, rows.length * 0.01);
  const firstBig = periodsOf(rows).find((p) => p !== '更早' && cnt[p] >= min);
  for (const r of rows) if (r.per !== '更早' && firstBig && periodKey(r.per) < periodKey(firstBig)) r.per = '更早';
  return rows;
}
const periodKey = (p) => +p.slice(0, 4) * 2 + (p.endsWith('上') ? 0 : 1);
export function periodsOf(rows) {
  const set = new Set(rows.map((r) => r.per));
  const dated = [...set].filter((p) => p !== '更早').sort((a, b) => periodKey(a) - periodKey(b));
  return [...(set.has('更早') ? ['更早'] : []), ...dated];
}

/**
 * 统计单元（WD 口径）：识别模型换过（WD → PixAI）时两个模型打标签的习惯不同，直接混在一起会把「换模型」当成「口味变了」。
 * WD 打过的图用库里的标签，权重 1；别的模型打的图用 wd-sample.json 里重打的抽样，权重 = 这个时期该模型的张数 / 抽样张数。
 * 没有抽样文件时退回每张图自己的标签（mixed = true，报告里要说明）。
 */
export function loadUnits(db, rows, out, { threshold = 0.5 } = {}) {
  const sample = readJson(path.join(out, 'wd-sample.json'), null);
  const tagName = new Map(db.prepare("SELECT id, name FROM tags WHERE category = 'general'").all().map((t) => [t.id, t.name]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const units = new Map();
  const otherPer = {};
  for (const r of rows) if (!r.wd && r.tagged_at) otherPer[r.per] = (otherPer[r.per] ?? 0) + 1;
  const samplePer = {};
  if (sample) for (const id of Object.keys(sample)) if (byId.has(+id) && !byId.get(+id).wd) samplePer[byId.get(+id).per] = (samplePer[byId.get(+id).per] ?? 0) + 1;
  // 有别的模型的图、但没有抽样的时期：只能用它们自己的标签（口径混用，报告里要注明）
  const uncovered = Object.fromEntries(Object.entries(otherPer).filter(([p]) => !samplePer[p]));
  const mixed = Object.keys(uncovered).length > 0 && rows.some((r) => r.wd);
  for (const r of rows) {
    if (!r.tagged_at) continue;
    if (r.wd || !samplePer[r.per]) units.set(r.id, { id: r.id, per: r.per, w: 1, rating: r.rating, tags: new Set(), fromDb: true });
  }
  for (const it of db.prepare('SELECT image_id i, tag_id t FROM image_tags WHERE score >= ?').iterate(threshold)) {
    const u = units.get(it.i);
    if (!u) continue;
    const n = tagName.get(it.t);
    if (n) u.tags.add(n);
  }
  if (sample) {
    for (const [id, v] of Object.entries(sample)) {
      const r = byId.get(+id);
      if (!r || r.wd || !samplePer[r.per]) continue; // 抽样之后又被 WD 重打过的不算
      units.set(r.id, { id: r.id, per: r.per, w: (otherPer[r.per] ?? 0) / samplePer[r.per], rating: v.rating, tags: new Set(v.tags), sampled: true });
    }
  }
  const all = [...units.values()];
  const minorW = all.filter((u) => [...u.tags].some((t) => MINOR.test(t))).reduce((a, u) => a + u.w, 0);
  const U = all.filter((u) => ![...u.tags].some((t) => MINOR.test(t)));
  return { U, mixed, uncovered, sampled: !!sample, minorShare: minorW / (minorW + U.reduce((a, u) => a + u.w, 0) || 1) };
}

export const share = (us, pred) => {
  let s = 0, t = 0;
  for (const u of us) {
    t += u.w;
    if (pred(u)) s += u.w;
  }
  return t ? s / t : 0;
};
export const has = (n) => (u) => u.tags.has(n);
export const any = (...ns) => (u) => ns.some((n) => u.tags.has(n));
export const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
