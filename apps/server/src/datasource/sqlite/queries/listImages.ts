import { collectionCandidates } from './collectionCandidates.ts';
import { collapsedImages, decideCollapse } from './collapsedImages.ts';
/**
 * 图片列表：筛选、排序、游标分页：
 * 不传 status = 除 excluded 以外的全部；orientation 阈值 1.05 / 0.95；默认 desc；random 忽略 order。
 *
 * 用 keyset 游标而不是 offset：扫描期间不断插入新图，offset 分页会让无限滚动出现重复或漏图。
 */
import { searchKey, TAG_FILTER_MIN_SCORE, type ImageItem, type ImageSort, type ListImagesQuery, type Page } from '@emaki/shared';
import { tagsOfArtist } from '../artists.ts';
import type { Db } from '../../../db/connection.ts';
import { hydrateImages, IMAGE_COLS, loadImageItems, type ImageRow } from '../hydrate.ts';
import { THEME_FILTERS } from '../../../services/classify/theme.ts';
import { ANIMATED_SQL, ART_KINDS_SQL, HAS_CHARACTER, IMAGE_IN_WORK, LIVE_IMAGES, UNRECOGNIZED } from '../../../readmodel/terms.ts';
import { decodeCursor, encodeCursor, parseId } from '../sql.ts';

const EMPTY_PAGE: Page<ImageItem> = { items: [], nextCursor: null, total: 0 };

const SORT_EXPR: Record<Exclude<ImageSort, 'random'>, string> = {
  page: 'i.page_no',
  addedAt: 'i.added_at',
  modifiedAt: 'i.modified_at',
  fileName: 'i.file_name COLLATE NOCASE', // better-sqlite3 不支持自定义 collation，按 NOCASE 排
  bytes: 'i.bytes',
};
const SORT_FIELD: Record<Exclude<ImageSort, 'random'>, keyof ImageRow> = {
  page: 'page_no',
  addedAt: 'added_at',
  modifiedAt: 'modified_at',
  fileName: 'file_name',
  bytes: 'bytes',
};
/** 确定性的伪随机顺序；带 seed 时换一种顺序（同一个 seed 结果相同） */
const RANDOM_EXPR = '((i.id * 2654435761) % 4294967296)';
const SEEDED_RANDOM_EXPR = '(((i.id + @seed) * 2654435761) % 4294967296)';

const isKeyset = (x: unknown): x is [string | number, number] =>
  Array.isArray(x) && x.length === 2 && (typeof x[0] === 'string' || typeof x[0] === 'number') && typeof x[1] === 'number';
const isOffset = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;

/** 图库文字搜索命中的标签、角色、作品 id */
export interface TextMatch {
  tagIds: number[];
  characterIds: number[];
  workIds: number[];
}

/** 图库文字搜索命中的标签、角色、作品 id（qk 已经是 searchKey） */
function matchText(db: Db, qk: string): TextMatch {
  const tagIds = db
    .prepare(
      `SELECT id FROM tags WHERE instr(search_key(name), @qk) > 0
       UNION SELECT t.id FROM tag_name_keys k JOIN tags t ON t.name = k.tag WHERE k.kind = 'zh' AND instr(k.search_key, @qk) > 0`,
    )
    .pluck()
    .all({ qk }) as number[];
  const owners = (type: 'character' | 'work', table: 'characters' | 'works') =>
    db
      .prepare(
        `SELECT id FROM ${table} WHERE instr(search_key(name), @qk) > 0 OR instr(search_key(COALESCE(danbooru_tag, '')), @qk) > 0
         UNION SELECT owner_id FROM aliases WHERE owner_type = '${type}' AND instr(search_key, @qk) > 0`,
      )
      .pluck()
      .all({ qk }) as number[];
  const workIds = owners('work', 'works');
  const characterIds = [
    ...new Set([
      ...owners('character', 'characters'),
      ...(db
        .prepare('SELECT character_id FROM character_works WHERE work_id IN (SELECT value FROM json_each(?))')
        .pluck()
        .all(JSON.stringify(workIds)) as number[]),
    ]),
  ];
  return { tagIds, characterIds, workIds };
}

/** 总数缓存（T22）：key 是去掉分页和排序的查询条件；不传就每次现算 */
export type CountCache = (key: string, compute: () => number) => number;
/**
 * 文字搜索命中哪些标签、角色、作品的缓存：key 是搜索键（searchKey 之后的 q）；不传就每次现算。
 * 现算要对 1.5 万个标签逐个调 search_key、再扫 20 多万行中文名（40–150 ms），而同一个词翻页、重拉时每个请求都要用。
 * 结果只和标签、角色、作品、别名、词库有关，和哪张图收藏了、放下了、什么分级无关
 */
export type TextMatchCache = (key: string, compute: () => TextMatch) => TextMatch;

export function listImages(db: Db, q: ListImagesQuery, counts?: CountCache, texts?: TextMatchCache): Page<ImageItem> {
  // 翻页查询和数总数用两套写法（T22）：翻页沿排序索引走，用 EXISTS 找够一页就停；
  // 数总数要看完所有命中的图，用 IN（先按作品 / 标签索引把命中的图 id 找出来）快得多。其余条件两边一样。
  // 只对命中很多的条件这样分；角色命中的图很少，两边都用 IN
  const where = [LIVE_IMAGES];
  const countWhere = [LIVE_IMAGES];
  const both = (...conds: string[]) => {
    where.push(...conds);
    countWhere.push(...conds);
  };
  const p: Record<string, unknown> = {};

  switch (q.status) {
    case undefined:
      // 加号：不让 SQLite 拿 excluded_by 的索引驱动查询（几乎全是 NULL，走它就得整表排序；T22 复测踩到过）
      both('+i.excluded_by IS NULL');
      break;
    case 'excluded':
      both('i.excluded_by IS NOT NULL');
      break;
    // 与 hydrate 的 status 同一口径：别册里的图算 recognized；unrecognized 含放下的（T27 补充、BI-9）
    case 'recognized':
      both(
        '+i.excluded_by IS NULL',
        `(${HAS_CHARACTER('i')} OR i.original_at IS NOT NULL OR NOT (${ART_KINDS_SQL}))`,
      );
      break;
    case 'unrecognized':
      both('+i.excluded_by IS NULL', ART_KINDS_SQL, UNRECOGNIZED);
      break;
  }
  if (q.similarTo) {
    const source = parseId(q.similarTo);
    if (source === null) return EMPTY_PAGE;
    p.similarIds = JSON.stringify(collectionCandidates(db, source));
    both('i.id IN (SELECT value FROM json_each(@similarIds))');
  }
  if (q.imageIds) { both('i.id IN (SELECT value FROM json_each(@imageIds))'); p.imageIds = JSON.stringify(q.imageIds.map(parseId).filter(n => n !== null)); }
  if (q.characterId) {
    const cid = parseId(q.characterId);
    if (cid === null) return EMPTY_PAGE;
    // 翻页也用 IN：一个角色最多一千多张，先按 idx_ic_character_image 取出来再排序是毫秒级；
    // 沿排序索引逐张探测，小角色或加了画面 / 搜索时每一页都要扫遍全库（0.1–1.3 秒）
    both('i.id IN (SELECT image_id FROM image_characters WHERE character_id = @cid)');
    p.cid = cid;
  }
  if (q.workId) {
    const wid = parseId(q.workId);
    if (wid === null) return EMPTY_PAGE;
    where.push(IMAGE_IN_WORK);
    countWhere.push('i.id IN (SELECT image_id FROM v_image_works WHERE work_id = @workId)');
    p.workId = wid;
  }
  if (q.rating?.length) {
    both('i.rating IN (SELECT value FROM json_each(@ratings))');
    p.ratings = JSON.stringify(q.rating);
  }
  if (Array.isArray(q.kind) && q.kind.length) {
    // 只筛一种时写成等号，命中 idx_images_kind_live
    if (q.kind.length === 1) {
      both('i.content_kind = @kind');
      p.kind = q.kind[0];
    } else {
      both('i.content_kind IN (SELECT value FROM json_each(@kinds))');
      p.kinds = JSON.stringify(q.kind);
    }
  }
  // 是否动图（D5）：和类型是两个维度。只看动图时按入库时间翻页走部分索引 idx_images_animated_live（字面条件，见 ANIMATED_SQL）
  if (q.animated !== undefined) both(q.animated ? ANIMATED_SQL : 'i.animated = 0');
  // 合集（T38c）：具体 id = 这一本的页；none = 不在合集里的图
  let collection: number | null = null;
  if (q.collectionId === 'none') both('i.collection_id IS NULL');
  else if (q.collectionId !== undefined) {
    collection = parseId(q.collectionId);
    if (collection === null) return EMPTY_PAGE;
    both('i.collection_id = @col');
    p.col = collection;
  }
  if (q.rated) both('(i.tagged_at IS NOT NULL OR i.rating_manual = 1)');
  if (q.favorite !== undefined) {
    both('i.favorite = @fav');
    p.fav = q.favorite ? 1 : 0;
  }
  if (q.original !== undefined) both(q.original ? 'i.original_at IS NOT NULL' : 'i.original_at IS NULL');
  if (q.artist) {
    // 同一个人的不同标签（旧名、社团名）一起算
    p.artists = JSON.stringify(tagsOfArtist(db, q.artist));
    both('i.id IN (SELECT ia.image_id FROM image_artists ia WHERE ia.artist IN (SELECT value FROM json_each(@artists)))');
  }
  if (q.poseClass) {
    // 姿势类别（实验，domain/pose/）：归到这一类的图
    both('i.id IN (SELECT image_id FROM image_poses WHERE class_id = @poseClass)');
    p.poseClass = q.poseClass;
  }
  if (q.posewearPose) {
    // PoseWear 姿势（实验，domain/pose/posewear.ts）：匹配到这个姿势的图（不只是主要姿势）；双人的差分不单独出现；
    // 只看可靠的：去掉低置信（lowtag+skel）
    both(`i.id IN (SELECT image_id FROM image_posewear_members WHERE pose_id = @pwPose AND variant_of IS NULL${q.posewearReliable ? ' AND low = 0' : ''})`);
    p.pwPose = q.posewearPose;
  }
  if (q.theme) {
    // 任一组标签达到阈值（THEME_FILTERS）。先把标签名换成 id，SQL 里不再联 tags 表；
    // 按 image_id 走 image_tags 主键，每张只看自己的几十个标签
    const idOf = db.prepare('SELECT id FROM tags WHERE name IN (SELECT value FROM json_each(?))').pluck();
    const groups = THEME_FILTERS[q.theme].flatMap(([names, th], k) => {
      const ids = idOf.all(JSON.stringify(names)) as number[];
      if (!ids.length) return [];
      p[`thn${k}`] = JSON.stringify(ids);
      p[`ths${k}`] = th;
      return [`(it.tag_id IN (SELECT value FROM json_each(@thn${k})) AND it.score >= @ths${k})`];
    });
    where.push(groups.length ? `EXISTS (SELECT 1 FROM image_tags it WHERE it.image_id = i.id AND (${groups.join(' OR ')}))` : '0');
    countWhere.push(groups.length ? `i.id IN (SELECT it.image_id FROM image_tags it WHERE ${groups.join(' OR ')})` : '0');
    // 等重新识别的图（文件内容变了）还留着旧标签，不算
    both('i.tagged_at IS NOT NULL');
  }
  if (q.tags?.length || q.tagsAll?.length || q.tagsNone?.length) {
    // 自定义画面：标签分数够才算有。和 theme 一样先把名字换成 id
    const idsOf = (names: string[]) =>
      db
        .prepare("SELECT id FROM tags WHERE category = 'general' AND name IN (SELECT value FROM json_each(?))")
        .pluck()
        .all(JSON.stringify([...new Set(names)])) as number[];
    p.ctagMin = TAG_FILTER_MIN_SCORE;
    const has = (param: string) => ({
      page: `EXISTS (SELECT 1 FROM image_tags it WHERE it.image_id = i.id AND it.tag_id ${param} AND it.score >= @ctagMin)`,
      count: `i.id IN (SELECT it.image_id FROM image_tags it WHERE it.tag_id ${param} AND it.score >= @ctagMin)`,
    });
    if (q.tags?.length) {
      // 任一：认不出的标签不算，一个都认不出就没有图
      const ids = idsOf(q.tags);
      if (!ids.length) return EMPTY_PAGE;
      p.ctags = JSON.stringify(ids);
      const c = has('IN (SELECT value FROM json_each(@ctags))');
      where.push(c.page);
      countWhere.push(c.count);
    }
    if (q.tagsAll?.length) {
      // 必含：每个一条，走 (tag_id, score, image_id) 索引；有一个认不出就没有图
      const ids = idsOf(q.tagsAll);
      if (ids.length < new Set(q.tagsAll).size) return EMPTY_PAGE;
      ids.forEach((id, k) => {
        p[`call${k}`] = id;
        const c = has(`= @call${k}`);
        where.push(c.page);
        countWhere.push(c.count);
      });
    }
    if (q.tagsNone?.length) {
      // 不含：认不出的标签本来就没有图有，忽略
      const ids = idsOf(q.tagsNone);
      if (ids.length) {
        p.cnone = JSON.stringify(ids);
        const c = has('IN (SELECT value FROM json_each(@cnone))');
        where.push(`NOT ${c.page}`);
        countWhere.push(c.count.replace('i.id IN', 'i.id NOT IN'));
      }
    }
    // 只看识别过的图：文件内容变了等重新识别的图还留着旧标签，不能拿旧标签算
    both('i.tagged_at IS NOT NULL');
  }
  if (q.orientation === 'landscape') both('i.width > i.height * 1.05');
  if (q.orientation === 'portrait') both('i.width < i.height * 0.95');
  if (q.orientation === 'square') both('i.width <= i.height * 1.05 AND i.width >= i.height * 0.95');
  const qk = q.q ? searchKey(q.q) : '';
  if (qk) {
    // 文件名、标签（英文名或中文名）、角色（名字、别名、日文名）、作品（名字、别名；作品下的角色也算）。
    // 以前只看文件名和英文标签，「ミカ」「未花」「蔚蓝档案」都搜不到（用户 2026-09-29）
    const m = texts ? texts(qk, () => matchText(db, qk)) : matchText(db, qk);
    p.qk = qk;
    p.qtags = JSON.stringify(m.tagIds);
    p.qchars = JSON.stringify(m.characterIds);
    p.qworks = JSON.stringify(m.workIds);
    where.push(`(instr(search_key(i.file_name), @qk) > 0
      OR EXISTS (SELECT 1 FROM image_tags it WHERE it.image_id = i.id AND it.tag_id IN (SELECT value FROM json_each(@qtags)))
      OR EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id AND ic.character_id IN (SELECT value FROM json_each(@qchars)))
      OR EXISTS (SELECT 1 FROM image_copyrights x WHERE x.image_id = i.id AND x.work_id IN (SELECT value FROM json_each(@qworks)))
      OR (i.original_at IS NOT NULL AND EXISTS (SELECT 1 FROM works ow WHERE ow.danbooru_tag = 'original' AND ow.id IN (SELECT value FROM json_each(@qworks)))))`);
    // 数总数：标签、角色、作品几支先看（按索引找出命中的图），都不中才对文件名调 search_key。
    // 写成 CASE WHEN 才一定短路；OR 不保证，文件名那支每一行都会先算一遍（q=girl 数一次 230 → 110 ms）。
    // 翻页的写法（上面）不跟着改：那边是逐行 EXISTS，排到文件名前面，命中少的搜索反而可能更慢，没量过
    countWhere.push(`(CASE
      WHEN i.id IN (SELECT it.image_id FROM image_tags it WHERE it.tag_id IN (SELECT value FROM json_each(@qtags))) THEN 1
      WHEN i.id IN (SELECT ic.image_id FROM image_characters ic WHERE ic.character_id IN (SELECT value FROM json_each(@qchars))) THEN 1
      WHEN i.id IN (SELECT x.image_id FROM image_copyrights x WHERE x.work_id IN (SELECT value FROM json_each(@qworks))) THEN 1
      WHEN i.original_at IS NOT NULL AND EXISTS (SELECT 1 FROM works ow WHERE ow.danbooru_tag = 'original' AND ow.id IN (SELECT value FROM json_each(@qworks))) THEN 1
      ELSE instr(search_key(i.file_name), @qk) > 0 END)`);
  }

  const from = 'FROM images i';
  const w = where.join(' AND ');
  const countSql = `SELECT COUNT(*) AS n ${from} WHERE ${countWhere.join(' AND ')}`;
  const count = () => (db.prepare(countSql).get(p) as { n: number }).n;
  const { cursor: _c, limit: _l, sort: _s, order: _o, seed: _seed, ...filters } = q;
  const total = counts ? counts(JSON.stringify(filters), count) : count();
  const limit = Math.min(Math.max(q.limit ?? 60, 1), 200);
  // page 只在看某一本时按页序，否则当入库时间
  // 按姿势类别筛选、没指定排序时按离代表骨架的距离（近的在前，游标用偏移：距离不在图片行里）
  // 按 PoseWear 姿势筛选、没指定排序时按匹配名次（原型按 0.6·骨架相似 + 0.4·标签分排好的，低置信的不另外往后挪）
  const byPose = !q.sort && (q.posewearPose ? 'poseRank' : q.poseClass ? 'poseDistance' : null);
  const sort: ImageSort | 'poseDistance' | 'poseRank' = byPose || (q.sort === 'page' && collection === null ? 'addedAt' : (q.sort ?? 'addedAt'));

  if (!q.collectionId && !q.poseClass && !q.posewearPose && decideCollapse(q.collapseCollections, q.cursor, total)) return collapsedImages(db, q, w, countWhere.join(' AND '), p, total);

  if (sort === 'random' || sort === 'poseDistance' || sort === 'poseRank') {
    const offset = decodeCursor(q.cursor, isOffset) ?? 0;
    const order =
      sort === 'poseDistance'
        ? `(SELECT ip.distance FROM image_poses ip WHERE ip.image_id = i.id) ${q.order === 'desc' ? 'DESC' : 'ASC'}`
        : sort === 'poseRank'
          ? `(SELECT pw.rank FROM image_posewear_members pw WHERE pw.image_id = i.id AND pw.pose_id = @pwPose) ${q.order === 'desc' ? 'DESC' : 'ASC'}`
          : q.seed !== undefined
          ? SEEDED_RANDOM_EXPR
          : RANDOM_EXPR;
    // 先只排 id，再按 id 取整行。带着 28 列一起排的话，翻得越深（OFFSET 越大）排序器里留的行越多：
    // 9 万张的库随机翻到第 6 万张那页 290 → 90 ms，结果一样
    const ids = db
      .prepare(`SELECT i.id ${from} WHERE ${w} ORDER BY ${order}, i.id LIMIT @lim OFFSET @off`)
      .pluck()
      .all({ ...p, ...(sort === 'random' && q.seed !== undefined ? { seed: q.seed } : {}), lim: limit + 1, off: offset }) as number[];
    const hasMore = ids.length > limit;
    if (hasMore) ids.pop();
    return { items: loadImageItems(db, ids), nextCursor: hasMore ? encodeCursor(offset + limit) : null, total };
  }

  const expr = SORT_EXPR[sort];
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const cmp = dir === 'ASC' ? '>' : '<';
  const c = decodeCursor(q.cursor, isKeyset);
  // 展开写法，不用行值比较：表达式必须和 ORDER BY 完全一致（包括 COLLATE NOCASE）
  const cursorSql = c ? ` AND (${expr} ${cmp} @cv OR (${expr} = @cv AND i.id ${cmp} @cid2))` : '';
  const rows = db
    .prepare(`SELECT ${IMAGE_COLS} ${from} WHERE ${w}${cursorSql} ORDER BY ${expr} ${dir}, i.id ${dir} LIMIT @lim`)
    .all({ ...p, ...(c ? { cv: c[0], cid2: c[1] } : {}), lim: limit + 1 }) as ImageRow[];
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  const nextCursor = hasMore && last ? encodeCursor([last[SORT_FIELD[sort]], last.id]) : null;
  return { items: hydrateImages(db, rows), nextCursor, total };
}
