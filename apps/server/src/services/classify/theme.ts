/**
 * 「没认出」的画面主题与「像插画的程度」（T27 补充）：纯函数，mock、sqlite、seed 共用。
 *
 * 一图一组，按固定先后取第一条命中的：不像插画 > 多人 > 泳装 > 兽耳 > 女仆·和服 > 腿·足 > 胸 > 其他。
 * 存进 images.theme；「漫画」「不像插画」「敏感」在查询时由 resolveTheme / THEME_EXPR 叠加，改分级、改类型后当场换组。
 * 规则改动要把 rules.ts 的 CLASSIFIER_VERSION 加一（同一套回填）。
 */
import type { BrowseTheme, ContentKind, Rating, UnrecognizedTheme } from '@emaki/shared';
import { COVER_TAG_WEIGHTS, coverQuality } from '../covers/quality.ts';

export type StoredTheme = 'odd' | 'multi' | 'swim' | 'kemono' | 'costume' | 'legs' | 'chest' | 'other';

const TEXT_LANG = [
  'chinese_text', 'english_text', 'japanese_text', 'korean_text', 'simplified_chinese_text', 'traditional_chinese_text', 'mixed-language_text',
];
const ODD_MALE_HINTS = ['parody', 'subtitled', 'realistic', 'facial_hair', 'meme'];
const MULTI = ['multiple_girls', '2girls', '3girls', '4girls', '5girls', '6+girls', 'multiple_boys', '2boys', '3boys'];
const SWIM = ['swimsuit', 'bikini', 'one-piece_swimsuit', 'school_swimsuit', 'competition_swimsuit', 'slingshot_swimsuit'];
const KEMONO = ['animal_ears', 'cat_ears', 'fox_ears', 'rabbit_ears', 'wolf_ears', 'dog_ears', 'horse_ears', 'fake_animal_ears'];
const COSTUME = ['maid', 'maid_headdress', 'maid_apron', 'japanese_clothes', 'kimono', 'miko', 'hakama', 'hakama_skirt', 'yukata'];
const LEG_FOCUS = ['thigh_focus', 'feet_focus', 'foot_focus', 'ass_focus', 'soles', 'toes'];
const LEG_BARE = ['feet', 'barefoot', 'legs'];
const LEGWEAR = [
  'thighhighs', 'pantyhose', 'black_pantyhose', 'white_pantyhose', 'black_thighhighs', 'white_thighhighs', 'kneehighs', 'fishnet_thighhighs',
  'fishnet_pantyhose', 'thighband_pantyhose', 'garter_straps', 'zettai_ryouiki', 'bare_legs',
];
const CLOSE = ['upper_body', 'portrait', 'close-up'];
const CHEST = ['cleavage', 'huge_breasts', 'breast_focus', 'sideboob', 'underboob', 'breasts_squeezed_together', 'cleavage_cutout'];

/** 主题规则和 art_score 用到的全部标签名（回填时只读这些，RV-T-6） */
export const THEME_TAG_NAMES: readonly string[] = [
  ...new Set([
    'no_humans', '1boy', 'male_focus', '1girl', 'large_breasts',
    ...TEXT_LANG, ...ODD_MALE_HINTS, ...MULTI, ...SWIM, ...KEMONO, ...COSTUME, ...LEG_FOCUS, ...LEG_BARE, ...LEGWEAR, ...CLOSE, ...CHEST,
    ...Object.keys(COVER_TAG_WEIGHTS),
  ]),
];

/**
 * 浏览筛选（多归属）：任一组标签达到阈值就算。阈值和 classifyTheme 一致，但不排先后、不排除半身像。
 * sqlite 的 listImages 和 mock 都用这张表。
 */
export const THEME_FILTERS: Record<BrowseTheme, [readonly string[], number][]> = {
  legs: [
    [LEG_FOCUS, 0.5],
    [LEG_BARE, 0.6],
    [LEGWEAR, 0.7],
  ],
  chest: [
    [CHEST, 0.6],
    [['large_breasts'], 0.8],
  ],
  swim: [[SWIM, 0.6]],
  kemono: [[KEMONO, 0.7]],
  costume: [[COSTUME, 0.7]],
  multi: [[MULTI, 0.6]],
};

export function matchesBrowseTheme(theme: BrowseTheme, tags: readonly { tag: string; score: number }[]): boolean {
  return THEME_FILTERS[theme].some(([names, th]) => tags.some((t) => t.score >= th && names.includes(t.tag)));
}

/** 像插画的程度 = 不计角色时的封面质量分 */
export function artScore(img: { w: number; h: number; fileName: string }, tags: [string, number][]): number {
  return Math.round(coverQuality({ ...img, fav: 0, cs: 0, others: 0 }, tags));
}

export function classifyTheme(tags: [string, number][] | null, score: number | null): StoredTheme | null {
  if (tags === null) return null;
  const m = new Map(tags);
  const T = (k: string) => m.get(k) ?? 0;
  const any = (keys: string[], th: number) => keys.some((k) => T(k) >= th);

  const male = Math.max(T('1boy'), T('male_focus')) >= 0.6 && T('1girl') < 0.5 && (any(ODD_MALE_HINTS, 0.35) || any(TEXT_LANG, 0.35));
  if (T('no_humans') >= 0.6 || (score !== null && score <= -30) || male) return 'odd';
  if (any(MULTI, 0.6) || (T('1boy') >= 0.6 && T('1girl') >= 0.6)) return 'multi';
  if (any(SWIM, 0.6)) return 'swim';
  if (any(KEMONO, 0.7)) return 'kemono';
  if (any(COSTUME, 0.7)) return 'costume';
  if (any(LEG_FOCUS, 0.5) || any(LEG_BARE, 0.6) || (any(LEGWEAR, 0.7) && !any(CLOSE, 0.5))) return 'legs';
  if (any(CHEST, 0.6) || T('large_breasts') >= 0.8) return 'chest';
  return 'other';
}

export function resolveTheme(x: { kind: ContentKind; rating: Rating; theme: StoredTheme | null }): UnrecognizedTheme {
  if (x.kind === 'comic') return 'comic';
  if (x.theme === 'odd') return 'odd';
  if (x.rating === 'questionable' || x.rating === 'explicit') return 'nsfw';
  return x.theme ?? 'other';
}
