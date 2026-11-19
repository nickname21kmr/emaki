/**
 * 一句话 → 标签：「两个黑色长发女孩」→ 2girls + black_hair + long_hair。
 *
 * 先 searchKey 归一化（去空格、下划线，转小写），再在整句上做最少代价切分（动态规划，不是逐段贪心）：
 * 每一段可以是词库里的词（标签名 / 中文名 / 别名）、「颜色 + 部位」组合、人数词、性别词、虚词，认不出的字按字计大代价。
 * 这样「白发红瞳」里词库没有的「红瞳」也能拆成 红 + 瞳 → red_eyes，「女仆」不会被拆成 女 + 仆。
 * 人数和性别分开写时（「两个黑发女孩」）最后再合到一起：2girls，而不是 2girls + 1girl。
 * 只输出 has() 认可的标签（调用方传库里有图的那些）。
 */
import { searchKey } from '@emaki/shared';

export interface PhraseDictEntry {
  tag: string;
  /** 已经 searchKey 过的：标签名、中文名（这两个优先）和别名 */
  primary: string[];
  aliases: string[];
  /** 张数，同一个词对上几个标签时取张数多的 */
  count: number;
}

export interface PhraseDict {
  byKey: Map<string, { tag: string; rank: number; count: number }>;
  tags: Set<string>;
  maxLen: number;
}

export function buildPhraseDict(entries: Iterable<PhraseDictEntry>): PhraseDict {
  const byKey: PhraseDict['byKey'] = new Map();
  const tags = new Set<string>();
  let maxLen = 1;
  const put = (key: string, tag: string, rank: number, count: number) => {
    if (!key) return;
    const cur = byKey.get(key);
    // 中文名 / 标签名压过别名（「白髪」既是 white_hair 又是 grey_hair 的别名）；同级取张数多的
    if (cur && (cur.rank < rank || (cur.rank === rank && cur.count >= count))) return;
    byKey.set(key, { tag, rank, count });
    maxLen = Math.max(maxLen, key.length);
  };
  for (const e of entries) {
    tags.add(e.tag);
    for (const k of e.primary) put(k, e.tag, 0, e.count);
    for (const k of e.aliases) put(k, e.tag, 1, e.count);
  }
  return { byKey, tags, maxLen: Math.min(maxLen, 24) };
}

// ---------------------------------------------------------------- 规则词表

/** 虚词：跳过，不算没认出 */
const FILLERS = ['的', '和', '与', '跟', '及', '还有', '并且', '穿着', '穿', '戴着', '戴', '拿着', '拿', '握着', '在', '一些', '有', '着', '是', '很', '，', ',', '、', '。', '.', ';', '；', '+', '&', '/', 'and', 'with', 'the', 'of'];

/** 颜色 → 每个部位依次试的标签（取第一个库里有的） */
const COLOURS: [string[], { hair: string[]; eyes: string[] }][] = [
  [['黑'], { hair: ['black_hair'], eyes: ['black_eyes'] }],
  [['白'], { hair: ['white_hair', 'grey_hair'], eyes: ['white_eyes'] }],
  [['金'], { hair: ['blonde_hair'], eyes: ['yellow_eyes'] }],
  [['黄'], { hair: ['blonde_hair'], eyes: ['yellow_eyes'] }],
  [['银'], { hair: ['silver_hair', 'grey_hair'], eyes: ['silver_eyes', 'grey_eyes'] }],
  [['灰'], { hair: ['grey_hair'], eyes: ['grey_eyes'] }],
  [['红', '赤'], { hair: ['red_hair'], eyes: ['red_eyes'] }],
  [['粉', '桃'], { hair: ['pink_hair'], eyes: ['pink_eyes'] }],
  [['浅蓝', '天蓝'], { hair: ['light_blue_hair', 'blue_hair'], eyes: ['light_blue_eyes', 'blue_eyes'] }],
  [['水'], { hair: ['aqua_hair', 'light_blue_hair'], eyes: ['aqua_eyes'] }],
  [['蓝', '青', '碧'], { hair: ['blue_hair'], eyes: ['blue_eyes'] }],
  [['绿'], { hair: ['green_hair'], eyes: ['green_eyes'] }],
  [['紫'], { hair: ['purple_hair'], eyes: ['purple_eyes'] }],
  [['棕', '褐', '茶'], { hair: ['brown_hair'], eyes: ['brown_eyes'] }],
  [['橙', '橘'], { hair: ['orange_hair'], eyes: ['orange_eyes'] }],
];
const HAIR_WORDS = ['头发', '发色', '发', '髪'];
const EYE_WORDS = ['眼睛', '眼瞳', '瞳孔', '眼', '瞳', '眸', '目'];
/** 发长；「长直」后面不写「发」也算（黑长直） */
const LENGTHS: [string, string[]][] = [
  ['长直', ['long_hair', 'straight_hair']],
  ['超长', ['very_long_hair']],
  ['中长', ['medium_hair']],
  ['长', ['long_hair']],
  ['短', ['short_hair']],
];

const NUMBERS: [string, number][] = [
  ['一', 1], ['1', 1], ['单', 1],
  ['两', 2], ['二', 2], ['2', 2], ['双', 2],
  ['三', 3], ['3', 3], ['四', 4], ['4', 4], ['五', 5], ['5', 5],
  ['六', 6], ['6', 6], ['七', 7], ['7', 7], ['八', 8], ['8', 8], ['九', 9], ['9', 9], ['十', 10],
  // 0 = 很多人
  ['多', 0], ['几', 0], ['一群', 0], ['一堆', 0], ['群', 0],
];
const CLASSIFIERS = ['个', '名', '位', '人'];
type Gender = 'girl' | 'boy';
const GENDERS: [string, Gender][] = [
  ['女孩子', 'girl'], ['女孩', 'girl'], ['女生', 'girl'], ['少女', 'girl'], ['女性', 'girl'], ['女人', 'girl'], ['女子', 'girl'], ['姑娘', 'girl'], ['妹子', 'girl'], ['女', 'girl'],
  ['男孩子', 'boy'], ['男孩', 'boy'], ['男生', 'boy'], ['少年', 'boy'], ['男性', 'boy'], ['男人', 'boy'], ['男子', 'boy'], ['男', 'boy'],
];

/** n 个 girl / boy 对应的标签；0 = 很多人 */
function countTag(n: number, g: Gender): string {
  const s = g === 'girl' ? 'girls' : 'boys';
  if (n === 0) return `multiple_${s}`;
  if (n === 1) return `1${g}`;
  return n >= 6 ? `6+${s}` : `${n}${s}`;
}

// ---------------------------------------------------------------- 切分

type Seg =
  | { kind: 'tags'; tags: string[] }
  | { kind: 'count'; n: number; gender?: Gender; /** 「单人」这种本身也是词：没有性别时用它 */ fallback?: string }
  | { kind: 'gender'; gender: Gender }
  | { kind: 'filler' };

/** 每段的代价：认不出一个字 10，其余按段数算，越长越整的切法越便宜 */
const COST = { tags: 1, count: 1, gender: 0.9, filler: 1.2, miss: 10 };

const startsAt = (s: string, i: number, words: readonly string[]) => words.filter((w) => s.startsWith(w, i));

/** 从 i 开始的所有候选段：[长度, 段] */
function candidates(s: string, i: number, dict: PhraseDict, has: (tag: string) => boolean): [number, Seg][] {
  const out: [number, Seg][] = [];
  for (let len = Math.min(dict.maxLen, s.length - i); len >= 1; len--) {
    const hit = dict.byKey.get(s.slice(i, i + len));
    if (hit) out.push([len, { kind: 'tags', tags: [hit.tag] }]);
  }
  for (const w of startsAt(s, i, FILLERS)) out.push([w.length, { kind: 'filler' }]);
  for (const [w, gender] of GENDERS) if (s.startsWith(w, i)) out.push([w.length, { kind: 'gender', gender }]);

  // 颜色 (色)(的)(长 / 短)(发 / 眼)：「黑色长发」「红瞳」「金色的眼睛」
  for (const [words, parts] of COLOURS) {
    for (const c of startsAt(s, i, words)) {
      let j = i + c.length;
      if (s.startsWith('色', j)) j++;
      if (s.startsWith('的', j)) j++;
      const len = LENGTHS.find(([w]) => s.startsWith(w, j));
      const k = j + (len?.[0].length ?? 0);
      const pick = (list: string[]) => list.find(has);
      const hair = [pick(parts.hair), ...(len?.[1] ?? [])].filter((t): t is string => !!t && has(t));
      if (hair.length) {
        for (const w of startsAt(s, k, HAIR_WORDS)) out.push([k + w.length - i, { kind: 'tags', tags: hair }]);
        if (len?.[0] === '长直') out.push([k - i, { kind: 'tags', tags: hair }]);
      }
      if (!len) {
        for (const w of startsAt(s, k, EYE_WORDS)) {
          const t = pick(parts.eyes);
          if (t) out.push([k + w.length - i, { kind: 'tags', tags: [t] }]);
        }
      }
    }
  }

  // 人数：数字 + 量词（两个、2名、单人），后面可以直接跟性别（两个女孩、一男一女）
  for (const [w, n] of NUMBERS) {
    if (!s.startsWith(w, i)) continue;
    const j = i + w.length;
    const cls = CLASSIFIERS.find((c) => s.startsWith(c, j));
    const k = j + (cls?.length ?? 0);
    const fallback = cls ? dict.byKey.get(s.slice(i, k))?.tag : undefined;
    if (cls) out.push([k - i, { kind: 'count', n, fallback }]);
    for (const [g, gender] of GENDERS) if (s.startsWith(g, k)) out.push([k + g.length - i, { kind: 'count', n, gender }]);
  }
  return out;
}

export interface PhraseParse {
  tags: string[];
  rest: string;
}

export function parseTagPhrase(text: string, dict: PhraseDict, has: (tag: string) => boolean = (t) => dict.tags.has(t)): PhraseParse {
  // 按空格分开归一化再接起来（「black hair」照样能对上 blackhair），记下原来空格的位置，没认出的字在那里断开
  const breaks = new Set<number>();
  let s = '';
  for (const part of text.slice(0, 100).split(/\s+/)) {
    if (s) breaks.add(s.length);
    s += searchKey(part);
  }
  const n = s.length;
  // best[i] = 前 i 个字的最小代价和最后一段
  const best: { cost: number; from: number; seg: Seg | null }[] = [{ cost: 0, from: 0, seg: null }];
  for (let i = 1; i <= n; i++) best.push({ cost: Infinity, from: 0, seg: null });
  for (let i = 0; i < n; i++) {
    const here = best[i]!.cost;
    if (here === Infinity) continue;
    const relax = (to: number, cost: number, seg: Seg | null) => {
      if (here + cost < best[to]!.cost) best[to] = { cost: here + cost, from: i, seg };
    };
    relax(i + 1, COST.miss, null);
    for (const [len, seg] of candidates(s, i, dict, has)) {
      if (seg.kind !== 'tags' || seg.tags.some(has)) relax(i + len, COST[seg.kind], seg);
    }
  }
  // 倒着取回切分
  const segs: { seg: Seg | null; text: string; at: number }[] = [];
  for (let i = n; i > 0; i = best[i]!.from) segs.unshift({ seg: best[i]!.seg, text: s.slice(best[i]!.from, i), at: best[i]!.from });

  // 没认出的字连成几段
  const rest: string[] = [];
  let run = '';
  for (const x of segs) {
    if (x.seg || breaks.has(x.at)) {
      if (run) rest.push(run);
      run = '';
    }
    if (!x.seg) run += x.text;
  }
  if (run) rest.push(run);

  // 人数和性别：分开写的配成一对（「两个黑发女孩」）；单独的性别词 = 1girl / 1boy
  // 第 k 个没写男女的人数词配第 k 个性别词；配过对的性别词不再单独出 1girl
  const genders = segs.flatMap((x) => (x.seg?.kind === 'gender' ? [x.seg.gender] : []));
  const bare = segs.filter((x) => x.seg?.kind === 'count' && !x.seg.gender).length;
  const tags: string[] = [];
  const add = (t: string | undefined) => t && has(t) && !tags.includes(t) && tags.push(t);
  let c = 0;
  let g = 0;
  for (const { seg } of segs) {
    if (seg?.kind === 'tags') seg.tags.forEach(add);
    else if (seg?.kind === 'count') {
      if (seg.gender) add(countTag(seg.n, seg.gender));
      else if (c < genders.length) add(countTag(seg.n, genders[c++]!));
      // 没写男女：「单人」本身是词就用它（solo），否则按女孩算（图库里女孩占绝大多数）
      else add(seg.n === 1 && seg.fallback ? seg.fallback : countTag(seg.n, 'girl'));
    } else if (seg?.kind === 'gender' && g++ >= bare) add(countTag(1, seg.gender));
  }
  return { tags, rest: rest.join(' ') };
}
