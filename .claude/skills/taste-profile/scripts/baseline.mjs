// 从 Danbooru 抽对照样本（公开接口，不需要账号），下载缩略大图，之后交给 baseline-tag.mts 用 WD 打标签。
//   recent：同时期的全站帖子，按你每个时期的存图量配比
//   cn：来源是微博 / B站 / Lofter / 米游社 / 库街区 / 小红书的帖子（中文圈画师），同样配比
//   works：你收得最多的作品，按你在各作品上的张数配比
// 带儿童相关标签、漫画、动图的帖子不要。请求之间留间隔；遇到 Cloudflare 验证就停，不重试、不绕过。
// 用法：node baseline.mjs [--n 1000] [--groups recent,cn,works]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { args, loadIllustrations, openSnapshot, periodsOf } from './lib.mjs';

const { out, get } = args();
const N = Number(get('--n') ?? 1000);
const GROUPS = (get('--groups') ?? 'recent,cn,works').split(',');
const undated = (get('--undated-roots') ?? '').split(',').filter(Boolean).map(Number);
const DIR = path.join(out, 'baseline');
mkdirSync(DIR, { recursive: true });
const UA = { 'User-Agent': 'emaki-taste-profile/1.0 (personal use)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let blocked = false;

async function api(q) {
  if (blocked) return [];
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://danbooru.donmai.us/posts.json?${q}&limit=200&only=id,created_at,source,tag_string_general,tag_string_copyright,rating,file_ext,large_file_url`, {
        headers: UA,
        signal: AbortSignal.timeout(45000),
      });
      const ct = r.headers.get('content-type') ?? '';
      if (r.ok && ct.includes('json')) return await r.json();
      if (!ct.includes('json')) {
        blocked = true;
        console.log('Danbooru 返回了验证页面，停止请求（已经抓到的照常用）');
        return [];
      }
    } catch (e) {
      console.log('请求失败', e.message);
    }
    await sleep(4000 * (i + 1));
  }
  return [];
}
const BAD = /(^|\s)(loli|shota|child|toddler|aged_down|female_child|male_child|comic|4koma|2koma|animated|video|photo_\(medium\)|real_life|text-only_page|multiple_views)(\s|$)/;
const ok = (p) => p.large_file_url && ['jpg', 'png', 'webp', 'jpeg'].includes(p.file_ext) && !BAD.test(` ${p.tag_string_general} `);
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const db = openSnapshot(out);
const rows = loadIllustrations(db, { undatedRoots: undated });
const periods = periodsOf(rows);
const count = {};
for (const r of rows) count[r.per] = (count[r.per] ?? 0) + 1;
const total = rows.length;

// 每个时期对应的 Danbooru 帖子 id 区间（按上传日期查第一帖）；「更早」= 最早时期之前 3 年
const idAt = {};
async function firstId(date) {
  if (idAt[date] !== undefined) return idAt[date];
  const r = await fetch(`https://danbooru.donmai.us/posts.json?tags=date:${date}&limit=1&only=id`, { headers: UA }).then((x) => x.json()).catch(() => []);
  await sleep(800);
  return (idAt[date] = r[0]?.id ?? null);
}
const dated = periods.filter((p) => p !== '更早');
const startOf = (p) => `${p.slice(0, 4)}-${p.endsWith('上') ? '01' : '07'}-01`;
const nextOf = (p) => (p.endsWith('上') ? `${p.slice(0, 4)}-07-01` : `${+p.slice(0, 4) + 1}-01-01`);
const ranges = {};
for (const p of dated) {
  const a = await firstId(startOf(p));
  const b = (await firstId(nextOf(p))) ?? (await fetch('https://danbooru.donmai.us/posts.json?limit=1&only=id', { headers: UA }).then((x) => x.json()))[0]?.id;
  if (a && b) ranges[p] = [a, b];
}
if (periods.includes('更早') && dated.length) {
  const y = +dated[0].slice(0, 4) - 3;
  const a = await firstId(`${y}-01-01`);
  if (a && ranges[dated[0]]) ranges['更早'] = [a, ranges[dated[0]][0]];
}
const quota = Object.fromEntries(Object.keys(ranges).map((p) => [p, Math.round((N * (count[p] ?? 0)) / total)]));

async function recent() {
  const outList = [];
  for (const [per, [a, b]] of Object.entries(ranges)) {
    const need = quota[per];
    const got = [];
    for (let w = 0; w < Math.ceil(need / 25) && !blocked; w++) {
      const start = Math.floor(a + ((b - a) * (w + Math.random() * 0.8)) / Math.ceil(need / 25));
      got.push(...shuffle((await api(`tags=id:${start}..${start + 400}`)).filter(ok)).slice(0, 25));
      await sleep(600);
    }
    outList.push(...got.slice(0, need).map((p) => ({ ...p, per })));
    console.log('recent', per, need, got.length);
  }
  return outList;
}
const CN = ['*weibo*', '*sinaimg*', '*bilibili*', '*hdslb*', '*lofter*', '*miyoushe*', '*kurobbs*', '*xiaohongshu*'];
async function cn() {
  const outList = [];
  for (const [per, [a, b]] of Object.entries(ranges)) {
    const got = new Map();
    for (let c = 0; c < 3 && !blocked; c++) {
      const cur = Math.floor(a + ((b - a) * (c + 1)) / 3);
      for (const src of CN) {
        for (const p of (await api(`tags=source:${src}&page=b${cur}`)).filter((p) => p.id >= a && ok(p))) got.set(p.id, p);
        await sleep(500);
      }
    }
    outList.push(...shuffle([...got.values()]).slice(0, quota[per]).map((p) => ({ ...p, per })));
    console.log('cn', per, quota[per], got.size);
  }
  return outList;
}
async function works() {
  const top = db
    .prepare(
      `SELECT w.name, w.danbooru_tag AS tag, COUNT(DISTINCT v.image_id) AS n FROM works w JOIN v_image_works v ON v.work_id = w.id
       JOIN images i ON i.id = v.image_id WHERE w.danbooru_tag IS NOT NULL AND w.danbooru_tag <> 'original' AND i.content_kind = 'illustration'
       AND i.missing = 0 AND i.excluded_by IS NULL GROUP BY w.id ORDER BY n DESC LIMIT 14`,
    )
    .all();
  const tot = top.reduce((a, w) => a + w.n, 0);
  const outList = [];
  for (const w of top) {
    const need = Math.round((N * w.n) / tot);
    const got = new Map();
    for (let k = 0; k < Math.ceil(need / 120) + 1 && got.size < need * 1.3 && !blocked; k++) {
      for (const p of (await api(`tags=${encodeURIComponent(w.tag)}+order:random`)).filter(ok)) got.set(p.id, p);
      await sleep(600);
    }
    outList.push(...[...got.values()].slice(0, need).map((p) => ({ ...p, per: w.name })));
    console.log('works', w.name, need, got.size);
  }
  return outList;
}

const groups = {};
if (GROUPS.includes('recent')) groups.recent = await recent();
if (GROUPS.includes('cn')) groups.cn = await cn();
if (GROUPS.includes('works')) groups.works = await works();
let i = 0;
const list = Object.entries(groups).flatMap(([g, l]) => l.map((p) => ({ p, g })));
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (i < list.length) {
      const { p, g } = list[i++];
      mkdirSync(path.join(DIR, g), { recursive: true });
      p.file = path.join(DIR, g, p.id + path.extname(new URL(p.large_file_url).pathname));
      if (existsSync(p.file)) continue;
      try {
        const r = await fetch(p.large_file_url, { headers: UA, signal: AbortSignal.timeout(60000) });
        if (r.ok) writeFileSync(p.file, Buffer.from(await r.arrayBuffer()));
      } catch {}
    }
  }),
);
writeFileSync(path.join(DIR, 'meta.json'), JSON.stringify(groups));
console.log('对照样本：', Object.entries(groups).map(([g, l]) => `${g} ${l.length}`).join(' · '), blocked ? '（中途被拦，样本偏少）' : '');
