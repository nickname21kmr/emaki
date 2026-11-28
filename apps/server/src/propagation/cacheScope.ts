/**
 * 一次提交让哪些缓存失效（提交后反应 invalidateCaches 用，docs/core-architecture.md 第 5.2 节）。
 *
 * 以前任何一次写入都把全部缓存清空：点一下收藏，角色和作品的张数、统计、别册、标签张数全部重算（真实库合计一秒多）。
 * 这里按内部的变化类型（changes.ts）写明它改得到哪些缓存，一次提交取各条变化的并集。
 * 只给查清楚了的几种类型写了窄的规则；其余类型、以及一条变化都没声明的提交（不声明变化的命令），一律全部失效，和以前一样。
 * RULES 是完整的映射：加了新的变化类型这里不补就过不了类型检查，拿不准就写 EVERYTHING。
 *
 * 结果缓存（SqliteDataSource.results）里现在有这些键，规则里按「可以留下的」列，没列到的（包括以后新加的键）一律失效：
 *   counts / summary  统计那一遍扫描、汇总接口
 *   kinds             别册首页（每类的张数和预览，预览带分级）
 *   count:<筛选>      图片列表的总数（键里是筛选条件的 JSON）
 *   dups:0 / dups:1   重复组（带完整的图片条目：收藏、分级、所在队列）
 *   artists           画师列表（封面按分级挑）
 *   qtext:<搜索键>    图库文字搜索命中的标签、角色、作品
 *   assign:candidates 归类弹窗里还没建档的候选（证据里认不出角色的标签）
 */
import type { Change, ChangeType } from './changes.ts';

/** 派生缓存（角色 / 作品的张数和封面，datasource/sqlite/derived.ts）怎么办 */
type DerivedEffect =
  /** 整份失效 */
  | 'drop'
  /** 张数不受影响；改到的图正是某个角色 / 作品现在的封面时才整份失效（封面怎么挑、封面的分级跟着变） */
  | 'covers'
  /** 图 ↔ 角色变了：只重算这些图涉及的角色和作品的张数 */
  | 'links'
  /** 原创标记变了：只重算「原创」作品和这些图手动指定的作品的张数 */
  | 'original'
  /** 只是看过了：只重算这些角色的「+N」 */
  | 'seen'
  /** 改不到它 */
  | 'keep';

type KeyMatch = (key: string) => boolean;

interface Rule {
  readonly derived: DerivedEffect;
  /** 未识别汇总（各分段、各主题的张数） */
  readonly unrecognized: boolean;
  /** 搜索的标签张数（tags.image_count）：只和「图有哪些标签」「图计不计入」有关 */
  readonly tagCounts: boolean;
  /** 结果缓存里可以留下的键 */
  readonly keep: readonly KeyMatch[];
}

const key =
  (...names: string[]): KeyMatch =>
  (k) =>
    names.includes(k);
const prefix =
  (p: string): KeyMatch =>
  (k) =>
    k.startsWith(p);
/** 图片总数里，筛选条件没出现这些词的（词要小写；条件的值里碰巧有这个词也算出现，多删不要紧） */
const countsWithout =
  (...words: string[]): KeyMatch =>
  (k) => {
    if (!k.startsWith('count:')) return false;
    const lower = k.toLowerCase();
    return !words.some((w) => lower.includes(w));
  };

/** 归类弹窗的候选在结果缓存里的键（datasource/sqlite/search.ts 用同一个） */
export const ASSIGN_CANDIDATES_KEY = 'assign:candidates';
/** 文字搜索的命中、归类弹窗的候选：只和标签、角色、作品、证据有关，图上的收藏、分级、放下改不到 */
const NAME_LOOKUPS: readonly KeyMatch[] = [prefix('qtext:'), key(ASSIGN_CANDIDATES_KEY)];

const EVERYTHING: Rule = { derived: 'drop', unrecognized: true, tagCounts: true, keep: [] };
/** 别的都失效，只有标签张数不用重数：这种变化不动图的标签，也不动图计不计入 */
const NOT_TAG_COUNTS: Rule = { ...EVERYTHING, tagCounts: false };

/** 每种变化改得到哪些缓存 */
const RULES: Record<ChangeType, Rule> = {
  // 文件、文件夹、可见性、证据：什么都可能变
  'image.added': EVERYTHING,
  'image.gone': EVERYTHING,
  'image.returned': EVERYTHING,
  'image.fileChanged': EVERYTHING,
  'image.moved': EVERYTHING,
  'image.trashed': EVERYTHING,
  'image.restored': EVERYTHING,
  'root.visibilityChanged': EVERYTHING,
  'evidence.changed': EVERYTHING,
  'visibility.changed': EVERYTHING,
  'library.opened': EVERYTHING,

  'root.modeChanged': NOT_TAG_COUNTS,
  'image.kindChanged': NOT_TAG_COUNTS,
  'image.animatedChanged': NOT_TAG_COUNTS,
  'image.sourceChanged': NOT_TAG_COUNTS,
  'curation.autoRequested': NOT_TAG_COUNTS,
  'curation.artistsChanged': NOT_TAG_COUNTS,
  'catalog.characterChanged': NOT_TAG_COUNTS,
  'catalog.merged': NOT_TAG_COUNTS,
  'catalog.bindingChanged': NOT_TAG_COUNTS,
  // 规则变了本身不改结果；结果变了另有 visibility.changed
  'visibility.rulesChanged': NOT_TAG_COUNTS,
  'collections.changed': NOT_TAG_COUNTS,
  'duplicates.changed': NOT_TAG_COUNTS,
  'settings.changed': NOT_TAG_COUNTS,

  // 归类、原创：角色和作品的张数只重算涉及的那几个；统计、总数、未识别汇总都和「认没认出」有关，全部重算
  'curation.charactersChanged': { derived: 'links', unrecognized: true, tagCounts: false, keep: [] },
  'curation.originalChanged': { derived: 'original', unrecognized: true, tagCounts: false, keep: [] },
  'curation.autoOriginalChanged': { derived: 'original', unrecognized: true, tagCounts: false, keep: [] },
  // 否决不进角色、作品的张数（用户去掉角色时和 charactersChanged 一起声明）；建议少了，未识别的分段会变
  'curation.vetoesChanged': { derived: 'keep', unrecognized: true, tagCounts: false, keep: [] },

  // 收藏：只有带收藏筛选的总数、重复组里的图片条目会变；自动封面优先挑收藏的，所以改到现在的封面图时角色和作品重算
  'curation.favoriteChanged': {
    derived: 'covers',
    unrecognized: false,
    tagCounts: false,
    keep: [key('counts', 'summary', 'kinds'), countsWithout('favorite'), ...NAME_LOOKUPS],
  },
  // 分级：带分级筛选的总数、别册的预览、重复组、画师封面会变；未识别「没认出」里敏感的单独一组，也跟着变。封面同上
  'curation.ratingChanged': {
    derived: 'covers',
    unrecognized: true,
    tagCounts: false,
    keep: [key('counts', 'summary'), countsWithout('rating', 'rated'), ...NAME_LOOKUPS],
  },
  // 放下：待处理、放下的张数（统计和未识别汇总）会变；角色、作品、别册不看放没放下。总数一律重算
  'curation.shelvedChanged': { derived: 'keep', unrecognized: true, tagCounts: false, keep: [key('kinds'), ...NAME_LOOKUPS] },
  // 姿势数据只有按姿势筛的图库列表在读
  'pose.changed': {
    derived: 'keep',
    unrecognized: false,
    tagCounts: false,
    keep: [key('counts', 'summary', 'kinds'), prefix('dups:'), countsWithout('pose')],
  },
  // 看过了：只动这个角色的「+N」，别的缓存都留着
  'catalog.characterSeen': { derived: 'seen', unrecognized: false, tagCounts: false, keep: [() => true] },
};

/** 一次提交的失效范围（ctx.invalidate 的参数） */
export interface CacheScope {
  /** 全部失效：下面几项都按「全部」填好了，监听者看这一项就可以走整份失效 */
  readonly everything: boolean;
  readonly derived: {
    /** 整份失效 */
    readonly all: boolean;
    /** 收藏、分级变了的图：其中有现在的封面图才整份失效 */
    readonly covers: readonly number[];
    /** 角色关联变了的图：重算涉及的角色和作品 */
    readonly links: readonly number[];
    /** 原创标记变了的图：重算「原创」作品和它们手动指定的作品 */
    readonly original: readonly number[];
    /** 刚看过的角色：重算它们的「+N」 */
    readonly seen: readonly number[];
  };
  readonly unrecognized: boolean;
  readonly tagCounts: boolean;
  /** 结果缓存里这个键要不要失效 */
  drops(key: string): boolean;
}

/** 全部失效 */
export const EVERYTHING_SCOPE: CacheScope = {
  everything: true,
  derived: { all: true, covers: [], links: [], original: [], seen: [] },
  unrecognized: true,
  tagCounts: true,
  drops: () => true,
};

/**
 * 这次提交声明的变化（事务里的全部，含反应声明的）→ 失效范围。
 * 一条变化都没有（不声明变化的命令、后台只写了自己的表）、或者有不认识的类型：全部失效
 */
export function cacheScope(changes: readonly Change[]): CacheScope {
  if (!changes.length) return EVERYTHING_SCOPE;
  const rules: Rule[] = [];
  const ids = { covers: new Set<number>(), links: new Set<number>(), original: new Set<number>(), seen: new Set<number>() };
  let all = false;
  for (const c of changes) {
    const rule = (RULES as Partial<Record<string, Rule>>)[c.type];
    if (!rule) return EVERYTHING_SCOPE;
    rules.push(rule);
    switch (rule.derived) {
      case 'drop':
        all = true;
        break;
      case 'covers':
      case 'links':
      case 'original':
        for (const id of c.ids) ids[rule.derived].add(id);
        break;
      case 'seen':
        for (const id of 'characterIds' in c ? c.characterIds : []) ids.seen.add(id);
        break;
      case 'keep':
        break;
    }
  }
  const unrecognized = rules.some((r) => r.unrecognized);
  const tagCounts = rules.some((r) => r.tagCounts);
  // 一个键要每条变化都说可以留才留
  const keeps = [...new Set(rules.map((r) => r.keep))];
  const drops = (k: string) => !keeps.every((keep) => keep.some((match) => match(k)));
  if (all && unrecognized && tagCounts && keeps.some((keep) => !keep.length)) return EVERYTHING_SCOPE;
  return {
    everything: false,
    derived: all
      ? EVERYTHING_SCOPE.derived
      : { all: false, covers: [...ids.covers], links: [...ids.links], original: [...ids.original], seen: [...ids.seen] },
    unrecognized,
    tagCounts,
    drops,
  };
}
