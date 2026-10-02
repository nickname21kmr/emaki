// 个人喜好分析：读快照（和可选的 WD 抽样、Danbooru 对照），算出报告要用的全部数字，写 out/data.json。
// 用法：node analyze.mjs [--private] [--undated-roots 1,2] [--out 目录]
//   --private：加上尺度、部位、画面关系、服装（只给本人看）；默认不算
import path from 'node:path';
import { any, args, has, isFemaleOnly, isNsfw, loadIllustrations, loadUnits, median, MINOR, openSnapshot, periodsOf, readJson, share, SKILL_DIR, writeJson } from './lib.mjs';

const A = args();
const undated = (A.get('--undated-roots') ?? '').split(',').filter(Boolean).map(Number);
const db = openSnapshot(A.out);
const DAY = 86400000;
const rows = loadIllustrations(db, { undatedRoots: undated });
const byId = new Map(rows.map((r) => [r.id, r]));
const P = periodsOf(rows);
const { U, mixed, uncovered, sampled, minorShare } = loadUnits(db, rows, A.out);
const W = U.reduce((a, u) => a + u.w, 0);
const perW = {};
for (const u of U) perW[u.per] = (perW[u.per] ?? 0) + u.w;
const i18n = new Map(db.prepare('SELECT tag, zh, post_count AS pc FROM tag_i18n').all().map((t) => [t.tag, t]));
const zh = (n) => i18n.get(n)?.zh ?? n.replace(/_/g, ' ');
const D = { generatedAt: new Date().toISOString(), periods: P, perW, mixedModels: mixed, uncovered, sampled, minorShare, private: A.private };

// ---------------------------------------------------------------- 概况
const kinds = Object.fromEntries(
  db
    .prepare(
      `SELECT i.content_kind k, COUNT(*) n FROM images i JOIN library_roots r ON r.id = i.root_id
       WHERE r.enabled = 1 AND r.removed_at IS NULL AND i.missing = 0 AND i.trashed_at IS NULL AND i.excluded_by IS NULL GROUP BY 1`,
    )
    .all()
    .map((r) => [r.k, r.n]),
);
const days = new Map();
for (const r of rows) if (r.t !== null) days.set(new Date(r.t).toDateString(), (days.get(new Date(r.t).toDateString()) ?? 0) + 1);
// 图上带儿童相关标签的，角色统计里也不算
const minorIds = new Set();
for (const r of db.prepare("SELECT it.image_id AS i, t.name AS n FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.score >= 0.5 AND t.category = 'general'").iterate())
  if (MINOR.test(r.n)) minorIds.add(r.i);
const imgChars = new Map();
for (const r of db.prepare('SELECT image_id i, character_id c FROM image_characters').iterate()) {
  if (!byId.has(r.i) || minorIds.has(r.i)) continue;
  (imgChars.get(r.c) ?? imgChars.set(r.c, []).get(r.c)).push(byId.get(r.i));
}
D.overview = {
  images: Object.values(kinds).reduce((a, b) => a + b, 0),
  illustrations: rows.length,
  kinds,
  characters: imgChars.size,
  works: db.prepare('SELECT COUNT(DISTINCT v.work_id) FROM v_image_works v').pluck().get(),
  activeDays: days.size,
  medianPerDay: median([...days.values()]),
  first: rows.filter((r) => r.t).reduce((a, r) => Math.min(a, r.t), Infinity),
  last: rows.filter((r) => r.t).reduce((a, r) => Math.max(a, r.t), 0),
};

// ---------------------------------------------------------------- 节奏
const exact = rows.filter((r) => r.exact);
const monthly = {};
for (const r of rows) if (r.t) monthly[new Date(r.t).toISOString().slice(0, 7)] = (monthly[new Date(r.t).toISOString().slice(0, 7)] ?? 0) + 1;
const hour = Array(24).fill(0), hourNsfw = Array(24).fill(0), weekday = Array(7).fill(0), weekdayNsfw = Array(7).fill(0);
for (const r of exact) {
  const d = new Date(r.t);
  hour[d.getHours()]++;
  weekday[d.getDay()]++;
  if (isNsfw(r.rating)) {
    hourNsfw[d.getHours()]++;
    weekdayNsfw[d.getDay()]++;
  }
}
// 一轮连续存图（间隔 30 分钟以内）：从头到尾尺度变不变
const sorted = [...exact].sort((a, b) => a.t - b.t);
const sessions = [];
let cur = [];
for (const r of sorted) {
  if (cur.length && r.t - cur[cur.length - 1].t > 30 * 60000) {
    sessions.push(cur);
    cur = [];
  }
  cur.push(r);
}
if (cur.length) sessions.push(cur);
const pos = Array.from({ length: 5 }, () => [0, 0]);
for (const s of sessions.filter((s) => s.length >= 12))
  s.forEach((r, k) => {
    const q = Math.min(4, Math.floor((k / s.length) * 5));
    pos[q][0]++;
    if (isNsfw(r.rating)) pos[q][1]++;
  });
D.rhythm = { monthly, hour, hourNsfw, weekday, weekdayNsfw, sessionPos: pos, sessions: sessions.length, exactCount: exact.length };

// ---------------------------------------------------------------- 作品、角色
const perCount = {};
for (const r of rows) perCount[r.per] = (perCount[r.per] ?? 0) + 1;
const workRows = db.prepare('SELECT id, name, danbooru_tag AS tag FROM works').all();
const workImgs = new Map();
for (const r of db.prepare('SELECT image_id i, work_id w FROM v_image_works').iterate()) {
  if (!byId.has(r.i)) continue;
  (workImgs.get(r.w) ?? workImgs.set(r.w, []).get(r.w)).push(byId.get(r.i));
}
D.works = workRows
  .map((w) => ({ id: w.id, name: w.name, tag: w.tag, n: workImgs.get(w.id)?.length ?? 0, per: P.map((p) => (workImgs.get(w.id) ?? []).filter((r) => r.per === p).length / (perCount[p] || 1)) }))
  .filter((w) => w.n > 0)
  .sort((a, b) => b.n - a.n)
  .slice(0, 16);
const chars = db
  .prepare(
    `SELECT c.id, c.name, c.danbooru_tag AS tag, dt.post_count AS pc,
      (SELECT w.id FROM character_works cw JOIN works w ON w.id = cw.work_id WHERE cw.character_id = c.id ORDER BY cw.position LIMIT 1) AS wid,
      (SELECT w.name FROM character_works cw JOIN works w ON w.id = cw.work_id WHERE cw.character_id = c.id ORDER BY cw.position LIMIT 1) AS work
     FROM characters c LEFT JOIN danbooru_tags dt ON dt.name = c.danbooru_tag`,
  )
  .all();
for (const c of chars) c.imgs = imgChars.get(c.id) ?? [];
const coverOf = (c) => c.imgs.find((r) => r.rating === 'general')?.id ?? null;
D.characters = chars
  .filter((c) => c.imgs.length)
  .sort((a, b) => b.imgs.length - a.imgs.length)
  .slice(0, 40)
  .map((c) => ({ id: c.id, name: c.name, work: c.work, n: c.imgs.length, per: P.map((p) => c.imgs.filter((r) => r.per === p).length), cover: coverOf(c) }));

// 每个角色的主发色：单人图里投票
const HAIR = ['white_hair', 'grey_hair', 'black_hair', 'blonde_hair', 'brown_hair', 'pink_hair', 'red_hair', 'blue_hair', 'light_blue_hair', 'purple_hair', 'green_hair', 'aqua_hair', 'orange_hair'];
const tagIdOf = (n) => db.prepare('SELECT id FROM tags WHERE name = ?').pluck().get(n);
const withTag = (n) => new Set(db.prepare('SELECT image_id FROM image_tags WHERE tag_id = ? AND score >= 0.5').pluck().all(tagIdOf(n) ?? -1));
const solo = withTag('solo');
const hairSets = Object.fromEntries(HAIR.map((h) => [h, withTag(h)]));
const boys = new Set(['1boy', '2boys', 'multiple_boys', 'male_focus'].flatMap((n) => [...withTag(n)]));
for (const c of chars) {
  const s = c.imgs.filter((r) => solo.has(r.id));
  const vote = HAIR.map((h) => [h, s.filter((r) => hairSets[h].has(r.id)).length]).sort((a, b) => b[1] - a[1]);
  c.hair = s.length >= 2 && vote[0][1] / s.length >= 0.35 ? vote[0][0] : null;
  // 男性角色：单人图（不够就看全部图）里六成以上画了男性。用户大多不收，留在比较里只会占满「跳过的」列表
  const base = s.length >= 2 ? s : c.imgs;
  c.male = base.length > 0 && base.filter((r) => boys.has(r.id)).length / base.length >= 0.6;
}

// 扣除人气：同一部作品里，按 Danbooru 帖子数分配「应得张数」，看实际存了多少（只在挂了作品、帖子数 ≥ 300 的角色之间分）
// 只在同一组角色之间分配（比如只在贴了性格原型的角色之间），男性角色、吉祥物不拉低别人的「应得」
const popOf = (keep) => {
  const pool = chars.filter((c) => c.pc >= 300 && c.wid && keep(c));
  const wt = {};
  for (const c of pool) {
    const w = (wt[c.wid] ??= { n: 0, pc: 0 });
    w.n += c.imgs.length;
    w.pc += c.pc;
  }
  return pool
    .filter((c) => wt[c.wid].n >= 100)
    .map((c) => {
      const exp = (wt[c.wid].n * c.pc) / wt[c.wid].pc;
      return { id: c.id, name: c.name, work: c.work, tag: c.tag, hair: c.hair, n: c.imgs.length, pc: c.pc, exp, ratio: (c.imgs.length + 1) / (exp + 1) };
    });
};
const pop = popOf((c) => !c.male);
const arch = readJson(path.join(SKILL_DIR, 'archetypes.json')).archetypes;
const archOf = new Map(Object.entries(arch).flatMap(([k, v]) => v.tags.map((t) => [t, k])));
const boot = (list) => {
  const vals = [];
  for (let b = 0; b < 400; b++) {
    let n = 0, e = 0;
    for (let k = 0; k < list.length; k++) {
      const r = list[Math.floor(Math.random() * list.length)];
      n += r.n;
      e += r.exp;
    }
    vals.push(n / e);
  }
  vals.sort((a, b) => a - b);
  return [vals[10], vals[389]];
};
const group = (list, key) => {
  const g = {};
  for (const r of list) {
    const k = key(r);
    if (k) (g[k] ??= []).push(r);
  }
  return Object.entries(g)
    .filter(([, l]) => l.length >= 5)
    .map(([k, l]) => {
      const n = l.reduce((a, r) => a + r.n, 0), exp = l.reduce((a, r) => a + r.exp, 0);
      const [lo, hi] = boot(l);
      const top = [...l].sort((a, b) => b.ratio - a.ratio);
      return { key: k, ratio: n / exp, lo, hi, chars: l.length, n, exp, over: top.filter((t) => t.n >= 30).slice(0, 4).map((t) => t.name), under: top.filter((t) => t.exp >= 30).slice(-3).map((t) => t.name) };
    })
    .sort((a, b) => b.ratio - a.ratio);
};
D.popularity = {
  hidden: pop.filter((p) => p.n >= 30).sort((a, b) => b.ratio - a.ratio).slice(0, 15),
  skipped: pop.filter((p) => p.exp >= 50).sort((a, b) => a.ratio - b.ratio).slice(0, 15),
  archetypes: group(popOf((c) => archOf.has(c.tag)), (r) => archOf.get(r.tag)).map((a) => ({ ...a, desc: arch[a.key].desc })),
  hair: group(popOf((c) => !!c.hair && !c.male), (r) => r.hair).map((h) => ({ ...h, zh: zh(h.key) })),
};
// 发色：按角色算（每个角色算一次）和「出现过 → 存到 20 张以上」的转化率
const hl = {};
for (const c of chars.filter((c) => c.hair && c.imgs.length)) {
  const h = (hl[c.hair] ??= { chars: 0, fav: 0 });
  h.chars++;
  if (c.imgs.length >= 20) h.fav++;
}
const nChars = Object.values(hl).reduce((a, h) => a + h.chars, 0);
D.hairByCharacter = Object.entries(hl)
  .map(([k, v]) => ({ name: k, zh: zh(k), share: v.chars / nChars, conv: v.fav / v.chars, chars: v.chars }))
  .sort((a, b) => b.share - a.share);

// ---------------------------------------------------------------- 标签：和 Danbooru 比
// 全站口径：你这里的比例 ÷ Danbooru 帖子比例，再用一组常见标签的中位数校准到 ×1（人工标签和模型的习惯不同，只能看相对高低）
const rawLift = (n) => {
  const pc = i18n.get(n)?.pc;
  return pc ? share(U, has(n)) / (pc / 9_000_000) : null;
};
const COMMON = ['1girl', 'solo', 'long_hair', 'looking_at_viewer', 'smile', 'blush', 'open_mouth', 'short_hair', 'simple_background', 'shirt', 'skirt', 'long_sleeves', 'holding', 'dress', 'jewelry', 'closed_mouth', 'white_background', 'hair_ornament', 'large_breasts'];
const norm = median(COMMON.map(rawLift).filter(Boolean)) ?? 1;
const lift = (n) => {
  const r = rawLift(n);
  return r === null ? null : r / norm;
};
const tagRow = (n) => ({ name: n, zh: zh(n), share: share(U, has(n)), lift: lift(n), per: P.map((p) => share(U.filter((u) => u.per === p), has(n))) });

// 对照组（baseline-tag.mts 生成）：同一个 WD 模型打的标签，只比画女性角色的图
const BL = (readJson(path.join(A.out, 'baseline-wd.json'), []) ?? []).map((b) => ({ ...b, w: 1, tags: new Set(b.tags) })).filter((b) => ![...b.tags].some((t) => MINOR.test(t)));
const FEM = U.filter((u) => isFemaleOnly(u.tags));
const groups = { 你: FEM };
for (const g of ['recent', 'cn', 'works']) {
  const l = BL.filter((b) => b.group === g && isFemaleOnly(b.tags));
  if (l.length >= 100) groups[g] = l;
}
// 中文平台有审查，公开的图几乎没有较敏感以上：外观、镜头只在「全年龄 / 轻微」里比
const SAFE = Object.fromEntries(Object.entries(groups).map(([k, l]) => [k, l.filter((u) => !isNsfw(u.rating))]));
const cmp = (pred, src = SAFE) => Object.fromEntries(Object.entries(src).map(([k, l]) => [k, share(l, pred)]));
D.baselines = Object.fromEntries(Object.entries(groups).map(([k, l]) => [k, l.length]));

const HAIR_ALL = [...HAIR, 'multicolored_hair', 'colored_inner_hair', 'streaked_hair', 'gradient_hair'];
const singleHair = (l) => l.filter((u) => u.tags.has('solo') && HAIR.filter((h) => u.tags.has(h)).length === 1);
const SOLO = Object.fromEntries(Object.entries(SAFE).map(([k, l]) => [k, singleHair(l)]));
const EYES = ['purple_eyes', 'blue_eyes', 'red_eyes', 'yellow_eyes', 'green_eyes', 'brown_eyes', 'pink_eyes', 'grey_eyes', 'black_eyes', 'aqua_eyes', 'orange_eyes', 'heterochromia'];
const STYLE = ['very_long_hair', 'long_hair', 'medium_hair', 'short_hair', 'twintails', 'ponytail', 'side_ponytail', 'braid', 'hair_bun', 'double_bun', 'single_side_bun', 'ahoge', 'bob_cut', 'blunt_bangs', 'drill_hair', 'hair_over_one_eye', 'sidelocks'];
D.looks = {
  hair: HAIR_ALL.map((n) => ({ ...tagRow(n), vs: HAIR.includes(n) ? cmp(has(n), SOLO) : null })).filter((r) => r.share >= 0.005),
  eyes: EYES.map((n) => ({ ...tagRow(n), vs: cmp(has(n)) })).filter((r) => r.share >= 0.005),
  style: STYLE.map(tagRow).filter((r) => r.share >= 0.005),
  expressions: ['blush', 'smile', 'open_mouth', 'closed_mouth', 'parted_lips', 'pout', 'smug', 'expressionless', 'frown', 'tears', 'closed_eyes', 'one_eye_closed', 'tongue_out', 'grin'].map(tagRow).filter((r) => r.share >= 0.004),
};

// 镜头：每个维度按优先级只算一种
const DIM = {
  视线: [['回头看你', (u) => u.tags.has('looking_back') && u.tags.has('looking_at_viewer')], ['看着你', any('looking_at_viewer')], ['闭着眼', any('closed_eyes')], ['没在看你', () => true]],
  景别: [['局部特写', any('lower_body', 'head_out_of_frame', 'foot_focus', 'feet_only', 'thigh_focus', 'ass_focus')], ['脸部特写', any('close-up', 'portrait')], ['上半身', any('upper_body')], ['七分身', any('cowboy_shot')], ['全身', any('full_body')], ['远景', any('wide_shot', 'very_wide_shot')], ['未标注', () => true]],
  俯仰: [['仰拍', any('from_below')], ['俯拍', any('from_above')], ['平视', () => true]],
  朝向: [['背后', any('from_behind')], ['侧面', any('from_side', 'profile')], ['正面', () => true]],
  谁在拍: [['第一人称', any('pov', 'pov_hands')], ['自拍 / 镜子', any('selfie', 'mirror', 'reflection', 'holding_phone')], ['朝你伸手 / 靠近', any('reaching_towards_viewer', 'outstretched_hand', 'incoming_hug', 'leaning_forward')], ['旁观', () => true]],
  镜头语言: [['透视夸张', any('foreshortening', 'fisheye', 'perspective')], ['倾斜构图', any('dutch_angle')], ['景深虚化', any('depth_of_field', 'blurry_background', 'blurry_foreground', 'bokeh')], ['普通', () => true]],
};
const first = (u, list) => {
  for (const [lab, test] of list) if (test(u)) return lab;
  return null;
};
D.camera = Object.fromEntries(Object.entries(DIM).map(([d, list]) => [d, list.map(([lab]) => ({ label: lab, ...cmp((u) => first(u, list) === lab) }))]));
D.cameraByRating = Object.fromEntries(
  Object.entries(DIM).map(([d, list]) => [
    d,
    list.map(([lab]) => ({ label: lab, sfw: share(FEM.filter((u) => !isNsfw(u.rating)), (u) => first(u, list) === lab), nsfw: share(FEM.filter((u) => isNsfw(u.rating)), (u) => first(u, list) === lab) })),
  ]),
);

// 偏爱 / 避开（全站口径）、和中文圈比
// 来源痕迹、截图聊天这类和画面口味无关的标签不进偏爱 / 变化列表
const SKIP = /(_username|_text|watermark|signature|artist_name|web_address|logo|commentary|translat|screenshot|chat|grabbing$|^1girl$|^solo$|^comic$|_\()/;
const counts = new Map();
for (const u of U) for (const t of u.tags) counts.set(t, (counts.get(t) ?? 0) + u.w);
const minN = Math.max(30, W * 0.002);
const lifts = [...counts]
  .filter(([t, n]) => n >= minN && !SKIP.test(t) && !MINOR.test(t) && (i18n.get(t)?.pc ?? 0) >= 2000)
  .map(([t]) => ({ name: t, zh: zh(t), share: share(U, has(t)), lift: lift(t) }));
D.loves = [...lifts].sort((a, b) => b.lift - a.lift).slice(0, 30);
D.avoids = [...lifts].sort((a, b) => a.lift - b.lift).slice(0, 20);
const ref = SAFE.recent ?? null;
if (SAFE.cn) {
  const vocab = new Set([...SAFE.你, ...SAFE.cn].flatMap((u) => [...u.tags]));
  const rowsCn = [...vocab]
    .filter((t) => !SKIP.test(t) && !MINOR.test(t))
    .map((t) => ({ name: t, zh: zh(t), you: share(SAFE.你, has(t)), cn: share(SAFE.cn, has(t)), recent: ref ? share(ref, has(t)) : null }))
    .filter((r) => Math.max(r.you, r.cn) >= 0.03)
    .map((r) => ({ ...r, ratio: (r.you + 0.002) / (r.cn + 0.002) }));
  D.vsCn = { more: [...rowsCn].sort((a, b) => b.ratio - a.ratio).slice(0, 25), less: [...rowsCn].sort((a, b) => a.ratio - b.ratio).slice(0, 25) };
}

// 口味变化：前三分之一的时期 vs 后三分之一
const datedP = P.filter((p) => p !== '更早');
const k3 = Math.max(1, Math.round(datedP.length / 3));
const early = [...(P.includes('更早') ? ['更早'] : []), ...datedP.slice(0, k3)], late = datedP.slice(-k3);
const Ue = U.filter((u) => early.includes(u.per)), Ul = U.filter((u) => late.includes(u.per));
const shifts = [...counts]
  .filter(([t, n]) => n >= minN && !SKIP.test(t) && !MINOR.test(t))
  .map(([t]) => ({ name: t, zh: zh(t), early: share(Ue, has(t)), late: share(Ul, has(t)) }))
  .filter((r) => Math.max(r.early, r.late) >= 0.03)
  .map((r) => ({ ...r, diff: r.late - r.early }));
D.shift = { early, late, rising: [...shifts].sort((a, b) => b.diff - a.diff).slice(0, 15), falling: [...shifts].sort((a, b) => a.diff - b.diff).slice(0, 15) };
D.ratingByPer = Object.fromEntries(P.map((p) => [p, Object.fromEntries(['general', 'sensitive', 'questionable', 'explicit'].map((r) => [r, share(U.filter((u) => u.per === p), (u) => u.rating === r)]))]));

// ---------------------------------------------------------------- 入坑节奏（只用精确到秒的保存时间）
const arcs = [];
const firstT = sorted[0]?.t ?? 0;
for (const c of chars) {
  const ts = c.imgs.filter((r) => r.exact).map((r) => r.t).sort((a, b) => a - b);
  if (ts.length < 60) continue;
  let best = 0, bestAt = 0, start = null;
  for (let a = 0, b = 0; b < ts.length; b++) {
    while (ts[b] - ts[a] > 30 * DAY) a++;
    if (start === null && b - a + 1 >= 3) start = ts[a];
    if (b - a + 1 > best) {
      best = b - a + 1;
      bestAt = ts[a];
    }
  }
  if (start - firstT < 45 * DAY) continue; // 数据一开始就在收的，看不出入坑时间
  arcs.push({ name: c.name, work: c.work, n: ts.length, start: new Date(start).toISOString().slice(0, 10), peak: new Date(bestAt).toISOString().slice(0, 10), toPeak: Math.round((bestAt - start) / DAY), peakShare: best / ts.length, tail: ts.filter((t) => t > bestAt + 180 * DAY).length / ts.length });
}
D.arcs = { list: arcs.sort((a, b) => b.n - a.n).slice(0, 30), toPeak: median(arcs.map((a) => a.toPeak)), peakShare: median(arcs.map((a) => a.peakShare)), tail: median(arcs.map((a) => a.tail)), n: arcs.length, slow: arcs.filter((a) => a.toPeak >= 180).length };

// ---------------------------------------------------------------- 反复保存：同一张（或几乎同一张）隔了一周以上又存了一次
const dup = new Map();
for (const r of db.prepare('SELECT m.group_id g, m.image_id i FROM duplicate_members m JOIN duplicate_groups d ON d.id = m.group_id WHERE d.ignored = 0').iterate()) {
  const im = byId.get(r.i);
  if (im?.exact) (dup.get(r.g) ?? dup.set(r.g, []).get(r.g)).push(im);
}
const resaved = [...dup.values()].filter((g) => g.length >= 2).map((g) => g.sort((a, b) => a.t - b.t)).filter((g) => g[g.length - 1].t - g[0].t > 7 * DAY);
const reIds = new Set(resaved.map((g) => g[0].id));
const inDup = new Set([...dup.values()].flat().map((r) => r.id));
const Ure = U.filter((u) => reIds.has(u.id)), Ubase = U.filter((u) => !inDup.has(u.id) && byId.get(u.id)?.exact);
D.resave = {
  n: resaved.length,
  medGap: median(resaved.map((g) => (g[g.length - 1].t - g[0].t) / DAY)),
  overYear: resaved.filter((g) => g[g.length - 1].t - g[0].t > 365 * DAY).length,
  nsfw: share(Ure, (u) => isNsfw(u.rating)),
  base: share(Ubase, (u) => isNsfw(u.rating)),
  up:
    Ure.length >= 50
      ? [...counts.keys()]
          .filter((t) => !SKIP.test(t) && !MINOR.test(t))
          .map((t) => ({ name: t, zh: zh(t), re: share(Ure, has(t)), base: share(Ubase, has(t)) }))
          .filter((r) => r.re >= 0.02)
          .map((r) => ({ ...r, lift: (r.re + 0.002) / (r.base + 0.002) }))
          .sort((a, b) => b.lift - a.lift)
          .slice(0, 15)
      : [],
};

// ---------------------------------------------------------------- 最像你的图：标签在你这里比对照组多多少（对数平均），全年龄的单人插画
const refU = ref ?? null;
const logLift = new Map();
for (const [t, n] of counts) {
  if (n < Math.max(20, W * 0.004) || SKIP.test(t)) continue;
  const you = share(U, has(t));
  const base = refU ? share(refU, has(t)) : (i18n.get(t)?.pc ?? 0) / 9_000_000 / norm;
  logLift.set(t, Math.log((you + 0.003) / (base + 0.003)));
}
const NOTART = ['photo_(medium)', 'realistic', 'cosplay', 'text_focus', 'fake_screenshot', 'multiple_views', 'chinese_text', 'japanese_text', 'english_text', 'speech_bubble', 'phone_screen', 'comic', 'meme', 'border', 'watermark', 'web_address', 'twitter_username', 'weibo_username', 'artist_name', 'signature'];
D.mostYou = U.filter((u) => !u.sampled && u.rating === 'general' && u.tags.size >= 18 && u.tags.has('solo') && !NOTART.some((t) => u.tags.has(t)))
  .map((u) => {
    let s = 0, n = 0;
    for (const t of u.tags)
      if (logLift.has(t)) {
        s += logLift.get(t);
        n++;
      }
    return { id: u.id, s: s / Math.max(n, 1) };
  })
  .sort((a, b) => b.s - a.s)
  .slice(0, 16);

// ---------------------------------------------------------------- 私密（--private）
if (A.private) {
  const NS = U.filter((u) => isNsfw(u.rating)), SF = U.filter((u) => !isNsfw(u.rating));
  const orient = (u) => {
    if (['1boy', '2boys', 'multiple_boys', 'hetero', 'male_focus'].some((t) => u.tags.has(t))) return '与男性';
    const girls = ['2girls', '3girls', '4girls', 'multiple_girls'].some((t) => u.tags.has(t));
    if (u.tags.has('yuri') || (girls && ['kiss', 'hug', 'holding_hands', 'looking_at_another'].some((t) => u.tags.has(t)))) return '女女';
    return girls ? '多名女性（无互动）' : '独自一人';
  };
  const dist = (l) => {
    const d = {};
    let t = 0;
    for (const u of l) {
      d[orient(u)] = (d[orient(u)] ?? 0) + u.w;
      t += u.w;
    }
    return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v / t]));
  };
  const LADDER = [
    ['性行为场景', ['sex', 'vaginal', 'anal', 'fellatio', 'oral', 'paizuri', 'handjob', 'footjob', 'cum', 'penis', 'masturbation', 'fingering']],
    ['半裸 / 全裸', ['nude', 'completely_nude', 'topless', 'bottomless', 'nipples', 'breasts_out', 'pussy', 'naked_towel']],
    ['内衣 / 走光', ['underwear', 'panties', 'bra', 'lingerie', 'underwear_only', 'pantyshot', 'upskirt', 'panties_under_pantyhose', 'garter_belt']],
    ['泳装 / 紧身', ['swimsuit', 'bikini', 'one-piece_swimsuit', 'leotard', 'playboy_bunny', 'bodysuit', 'latex']],
    ['强调身材', ['cleavage', 'sideboob', 'underboob', 'breast_press', 'huge_breasts', 'skindentation', 'thick_thighs']],
    ['露肩 / 露腰', ['bare_shoulders', 'midriff', 'navel', 'off_shoulder', 'crop_top', 'backless_outfit', 'bare_back', 'strapless']],
  ];
  const levelOf = (u) => LADDER.find(([, tags]) => tags.some((t) => u.tags.has(t)))?.[0] ?? '完整着装';
  const levels = ['完整着装', ...[...LADDER].reverse().map((l) => l[0])];
  const PARTS = {
    胸部: ['cleavage', 'large_breasts', 'breast_focus', 'sideboob', 'underboob', 'breast_press'],
    腿与大腿: ['thighs', 'thick_thighs', 'thigh_gap', 'thigh_focus', 'legs', 'skindentation', 'crossed_legs'],
    足部: ['feet', 'foot_focus', 'soles', 'toes', 'barefoot', 'no_shoes', 'shoes_removed'],
    臀部: ['ass', 'ass_focus', 'butt_crack', 'thong'],
    腰腹: ['navel', 'midriff', 'stomach', 'groin', 'wide_hips'],
    肩背与腋下: ['bare_shoulders', 'bare_back', 'back', 'armpits', 'collarbone', 'backless_outfit'],
    裙下与内衣: ['pantyshot', 'upskirt', 'panties', 'underwear', 'panties_under_pantyhose', 'skirt_lift'],
  };
  const WEAR = ['pantyhose', 'black_pantyhose', 'white_pantyhose', 'thighhighs', 'black_thighhighs', 'white_thighhighs', 'garter_straps', 'thighband_pantyhose', 'fishnets', 'lingerie', 'white_bra', 'black_bra', 'bikini', 'micro_bikini', 'one-piece_swimsuit', 'leotard', 'highleg_leotard', 'playboy_bunny', 'bodysuit', 'maid', 'nun', 'china_dress', 'backless_dress', 'sweater_dress', 'oversized_shirt', 'see-through', 'wet_clothes', 'collar', 'choker', 'elbow_gloves', 'kimono', 'nurse', 'office_lady'];
  const POSE = ['sitting', 'lying', 'on_back', 'on_stomach', 'on_side', 'kneeling', 'squatting', 'wariza', 'seiza', 'knees_up', 'spread_legs', 'crossed_legs', 'leaning_forward', 'bent_over', 'all_fours', 'arms_up', 'stretching', 'standing', 'on_bed', 'hugging_own_legs'];
  D.private = {
    nsfwShare: share(U, (u) => isNsfw(u.rating)),
    orientation: { all: dist(U), nsfw: dist(NS) },
    ladder: levels.map((l) => ({ name: l, share: share(U, (u) => levelOf(u) === l) })),
    ladderPer: Object.fromEntries(P.map((p) => [p, Object.fromEntries(levels.map((l) => [l, share(U.filter((u) => u.per === p), (u) => levelOf(u) === l)]))])),
    levels,
    parts: Object.entries(PARTS).map(([name, list]) => ({ name, share: share(U, any(...list)), sfw: share(SF, any(...list)), nsfw: share(NS, any(...list)) })).sort((a, b) => b.share - a.share),
    wear: WEAR.map(tagRow).filter((r) => r.share >= 0.003 && r.lift !== null).sort((a, b) => b.lift - a.lift),
    poses: POSE.map(tagRow).filter((r) => r.share >= 0.004 && r.lift !== null).sort((a, b) => b.lift - a.lift),
  };
}

writeJson(path.join(A.out, 'data.json'), D);
const pc = (x) => (x * 100).toFixed(1) + '%';
console.log(`插画 ${rows.length}（统计单元 ${Math.round(W)}${mixed ? '，识别模型混用且没有 WD 抽样' : sampled ? '，含 WD 抽样' : ''}） · 时期 ${P.join(' ')}`);
console.log('对照组', JSON.stringify(D.baselines), '· 排除儿童相关', pc(minorShare));
console.log('写出', path.join(A.out, 'data.json'));
