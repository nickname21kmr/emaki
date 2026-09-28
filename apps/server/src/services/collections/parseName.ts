/**
 * 合集文件夹名解析（T38a）：从「[汉化组] (C95) [社团 (作者)] 标题 (原作)」这类同人志命名里拆出各段。
 * 正则逐字来自 docs/design/m5/collections-detect.reference.cjs；解析步骤的顺序不能换（04-round2 T38a 第 1 节）。
 * 所有字段都是 NFC、已 trim，空串存 null。十六进制 / uuid 名的 title 为 null（界面显示「无题 #前 6 位」）。
 */

export interface ParsedFolderName {
  title: string | null;
  event: string | null;
  circle: string | null;
  artist: string | null;
  parody: string | null;
  translator: string | null;
  seriesKey: string | null;
  volumeNo: number | null;
}

export const HEX_NAME = /^(?:[0-9a-f]{16,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const FORMAT_TAG = /\s*[\[(（]\s*(?:jpg|png|webp)[^\])）]*[\])）]\s*/gi;
export const TRANSLATOR = /[\[【]([^\]】]*(?:汉化|漢化|翻訳|翻译|中国翻訳|中國翻譯|嵌字|字幕组|個人漢化|个人汉化)[^\]】]*)[\]】]/;
const EVENT_HEAD = /^[(（]\s*([^)）]+?)\s*[)）]\s*/;
const EVENT_WORD = /^(?:C|FF|CP)\d{2,3}$|COMIC|例大祭|紅楼夢|红楼梦|COMITIA|コミティア|サンクリ/i;
const EVENT_BRACKET = /^\[\s*((?:C|FF|CP)\d{2,3})\s*\]\s*/i;
const EVENT_BARE = /^((?:C|FF|CP)\d{2,3})\b\s*/i;
const CIRCLE_SQUARE = /^\[\s*([^\]]+?)\s*\]\s*/;
const CIRCLE_LENTICULAR = /^【\s*([^】]+?)\s*】\s*/;
const CIRCLE_INNER = /^(.*?)\s*[(（]\s*([^)）]+)\s*[)）]$/;
const TRAIL_TAG = /^(.*\S)\s*\[([^\]]+)\]\s*$/;
const VOLUME_TAIL = /^(.*?)\s*(?:[(（](\d{1,3})[)）]|\s(上|中|下|前編|後編|前篇|后篇|後篇))\s*$/;
const PARODY_TAIL = /^(.*?)\s*[(（]\s*([^)）]+)\s*[)）]\s*$/;
export const CHAPTER = /^(.*?)\s*(?:第\s*)?(\d{1,4})\s*[话話回章]\s*$/;
const ARTIST_ARTBOOK = /^(.{2,20}?)\s*(?:画集|畫集|イラスト集|作品集|原画集)\s*(.*)$/;

const VOLUME_WORD: Record<string, number> = { 上: 1, 前編: 1, 前篇: 1, 中: 2, 下: 3, 後編: 2, 后篇: 2, 後篇: 2 };

const clean = (x: string | null | undefined): string | null => {
  const t = x?.normalize('NFC').trim();
  return t ? t : null;
};

export function parseFolderName(leaf: string): ParsedFolderName {
  const nfc = leaf.normalize('NFC').trim();
  // (1)
  let s = nfc;
  const hex = HEX_NAME.test(s);
  let event: string | null = null;
  let circle: string | null = null;
  let artist: string | null = null;
  let parody: string | null = null;
  let translator: string | null = null;
  let seriesKey: string | null = null;
  let volumeNo: number | null = null;

  // (2) 格式标记 [JPG_30P] / (JPG)，整体被《》包住时去掉书名号
  s = s.replace(FORMAT_TAG, ' ').trim();
  s = s.replace(/^《(.+)》$/, '$1');

  // (3) 汉化组可以出现在任意位置
  const tl = TRANSLATOR.exec(s);
  if (tl) {
    translator = tl[1]!.trim();
    s = s.replace(tl[0], ' ').trim();
  }

  // (4) 展会：(C95) / [C83] / C83
  const head = EVENT_HEAD.exec(s);
  const ev = head && EVENT_WORD.test(head[1]!) ? head : (EVENT_BRACKET.exec(s) ?? EVENT_BARE.exec(s));
  if (ev) {
    event = ev[1]!;
    s = s.slice(ev[0].length);
  }

  // (5) 社团：[社团 (作者)] / 【社团】
  const cm = CIRCLE_SQUARE.exec(s) ?? CIRCLE_LENTICULAR.exec(s);
  if (cm) {
    const inner = CIRCLE_INNER.exec(cm[1]!);
    if (inner) {
      circle = inner[1]!;
      artist = inner[2]!;
    } else circle = cm[1]!;
    s = s.slice(cm[0].length);
  }

  // (6) 结尾的 [某家族社] 算汉化组
  const trail = TRAIL_TAG.exec(s);
  if (trail && !translator) {
    translator = trail[2]!.trim();
    s = trail[1]!;
  }

  // (7) 卷号：(1) / 上 / 下
  const vol = VOLUME_TAIL.exec(s);
  if (vol && vol[1]) {
    volumeNo = vol[2] ? Number(vol[2]) : (VOLUME_WORD[vol[3]!] ?? null);
    s = vol[1];
  }

  // (8) 原作：结尾的 (…)
  const par = PARODY_TAIL.exec(s);
  if (par && par[1]) {
    parody = par[2]!;
    s = par[1];
  }

  // (9) 连载：第 N 话
  const ch = CHAPTER.exec(s);
  if (ch && ch[1]) {
    volumeNo = Number(ch[2]);
    seriesKey = ch[1].trim();
    s = ch[1];
  }

  // (10)
  if (volumeNo !== null && !seriesKey) seriesKey = s.trim();

  // (11) 「某画师画集 副题」
  const ab = ARTIST_ARTBOOK.exec(s);
  if (ab && !artist && !circle) {
    artist = ab[1]!;
    if (ab[2]) s = ab[2];
  }

  // (12)
  s = s.trim();
  if (!s && circle) {
    s = circle;
    circle = null;
  }
  return {
    title: hex ? null : clean(s || nfc),
    event: clean(event),
    circle: clean(circle),
    artist: clean(artist),
    parody: clean(parody),
    translator: clean(translator),
    seriesKey: clean(seriesKey),
    volumeNo,
  };
}
