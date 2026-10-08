/**
 * 画师的显示名、推特账号、和「同一个人的不同标签」怎么认（用户 2026-10-04）。
 * 数据来自 Danbooru 的 /artists.json：other_names 里混着日文名、汉字名、昵称、账号名、社团名。
 */

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
const KANJI = /[㐀-鿿豈-﫿]/;

// 平假名 → 罗马字（够用来和标签比读音即可）
const KANA: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o', か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko', さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to', な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no', は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo', や: 'ya', ゆ: 'yu', よ: 'yo', ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo', だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo', ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゔ: 'vu',
};
const SMALL_Y: Record<string, string> = { ゃ: 'ya', ゅ: 'yu', ょ: 'yo' };

/** 假名部分转成罗马字，汉字和别的字符原样留着 */
export function kanaToRomaji(s: string): string {
  const h = s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)); // 片假名 → 平假名
  let out = '';
  for (let i = 0; i < h.length; i++) {
    const c = h[i]!;
    const next = h[i + 1];
    if (c === 'っ') {
      const r = next ? KANA[next] : undefined;
      if (r) out += r[0];
      continue;
    }
    if (c === 'ー') continue;
    const r = KANA[c];
    if (r && next && SMALL_Y[next]) {
      // きゃ → kya，しゃ → sha，ちゃ → cha，じゃ → ja
      const base = r.endsWith('i') ? r.slice(0, -1) : r;
      out += (/(sh|ch|j)$/.test(base) ? base : base + 'y') + SMALL_Y[next]!.slice(1);
      i++;
      continue;
    }
    out += r ?? c;
  }
  return out.toLowerCase();
}

/** 标签去掉括号里的消歧义，拆成读音片段：mishima_kurone → [mishima, kurone]；hiten_(hitenkei) → [hiten] */
const tagTokens = (tag: string) =>
  tag
    .replace(/_\([^)]*\)$/, '')
    .split(/[_\s.-]+/)
    .filter((t) => t.length >= 2);

/**
 * 从 other_names 里挑显示名：只看含日文 / 汉字的；读音和标签对上的片段越多越好，
 * 一样多时有汉字的优先（全名比昵称像），再短的优先（「三嶋くろね」胜过「くろねお姉ちゃん」）。
 * 一个都对不上（天三月这种纯汉字名）时取第一个；没有日文 / 汉字名返回 null。
 */
export function pickDisplayName(tag: string, otherNames: string[], groupName: string | null): string | null {
  const group = groupName?.toLowerCase();
  const cands = otherNames.filter((n) => CJK.test(n) && n.toLowerCase() !== group);
  if (!cands.length) return null;
  const tokens = tagTokens(tag);
  const scored = cands.map((n, i) => {
    const r = kanaToRomaji(n);
    return { n, i, score: tokens.filter((t) => r.includes(t)).length, kanji: KANJI.test(n) ? 1 : 0 };
  });
  scored.sort((a, b) => b.score - a.score || (a.score ? b.kanji - a.kanji || a.n.length - b.n.length : 0) || a.i - b.i);
  return scored[0]!.n;
}

/** 主页链接里的推特账号（twitter.com / x.com），优先还在用的；不要 intent、i、home 这种路径 */
export function twitterOf(urls: { url: string; is_active?: boolean }[]): string | null {
  const re = /^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/(?!intent\b|i\/|home\b|search\b|hashtag\b)([A-Za-z0-9_]{1,15})\/?(?:$|\?)/i;
  const hits = urls.flatMap((u) => {
    const m = re.exec(u.url);
    return m ? [{ name: m[1]!, active: u.is_active !== false }] : [];
  });
  hits.sort((a, b) => Number(b.active) - Number(a.active));
  return hits[0]?.name ?? null;
}

/** 名字规范成可以和标签比较的形式：小写、空格换下划线 */
export const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '_');

/**
 * 顺着「并到 / 改名为」一路找到这个人的代表标签。next 返回下一跳（null = 到头了）。
 * 绕成环（手动合并加撤销顺序乱了、Danbooru 改名互指）时取环里字母序最小的标签，环上每个标签都落到同一个人
 */
export function resolveArtist(tag: string, next: (cur: string) => string | null): string {
  const seen: string[] = [];
  let cur = tag;
  for (;;) {
    const at = seen.indexOf(cur);
    if (at >= 0) return [...seen.slice(at)].sort()[0]!;
    seen.push(cur);
    const to = next(cur);
    if (to === null || to === cur || seen.length > 50) return cur;
    cur = to;
  }
}

export interface ArtistMeta {
  name: string;
  display: string | null;
  names: string[];
  twitter: string | null;
  aliasOf: string | null;
}

/**
 * 同一个人的不同标签归成一组，返回 标签 → 组的代表标签：
 * 0. 用户手动定的（artist_links）优先：拆开的标签自己一组，不跟任何人合；合并的并到指定的人。
 * 1. Danbooru 上改过名的旧标签 → 新标签。
 * 2. 认出来的画师 A 的其他名字 / 社团里写着另一个认出来的画师 B 的标签（个人名和社团名都被认成了画师），
 *    B 并到 A。B 同时被好几个画师写着（几个人的合同社团）就不并；
 *    B 在 Danbooru 上有自己的资料、又没提到 A（两个人，只是 A 那边把同伴也列进了其他名字），也不并。
 */
export function artistGroups(present: string[], meta: Map<string, ArtistMeta>, links: Map<string, string | null> = new Map()): Map<string, string> {
  const canon = (t: string) => resolveArtist(t, (cur) => (links.has(cur) ? (links.get(cur) ?? null) : (meta.get(cur)?.aliasOf ?? null)));
  const tags = [...new Set(present.map(canon))];
  const set = new Set(tags);
  const owners = new Map<string, string[]>();
  for (const a of tags) {
    for (const n of meta.get(a)?.names ?? []) {
      if (n !== a && set.has(n) && !links.has(n)) owners.set(n, [...(owners.get(n) ?? []), a]);
    }
  }
  const mentions = (b: string, a: string) => {
    const mb = meta.get(b);
    if (!mb) return true;
    const ma = meta.get(a);
    return mb.names.includes(a) || (!!ma?.display && (mb.names.includes(ma.display) || mb.display === ma.display));
  };
  const into = new Map<string, string>();
  for (const [b, as] of owners) {
    const uniq = [...new Set(as)];
    // 互相写着对方：保留字母序在前的那个，避免两边互并
    if (uniq.length === 1 && !(into.get(uniq[0]!) === b) && mentions(b, uniq[0]!)) into.set(b, uniq[0]!);
  }
  const out = new Map<string, string>();
  for (const t of present) {
    let c = canon(t);
    for (let i = 0; i < 4 && into.has(c); i++) c = into.get(c)!;
    out.set(t, c);
  }
  return out;
}
