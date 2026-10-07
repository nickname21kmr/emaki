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
/** 括号里的备注：页数（159P）、下载来源、日期范围、自整理 / 截止 */
const NOTE_IN_PARENS = /\d+\s*P\b|ex-?hentai|e-?hentai|nhentai|\d{4}[.\-/]\d{1,2}|自整理|截止|按.{0,8}排序/i;
const ARTIST_ARTBOOK =/^(.{2,20}?)\s*(?:画集|畫集|イラスト集|作品集|原画集)\s*(.*)$/;

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
  if (par && par[1] && NOTE_IN_PARENS.test(par[2]!)) {
    // 括号里是下载来源、页数、日期这类备注，不是原作，去掉不记
    s = par[1];
  } else if (par && par[1]) {
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
    const tail = ab[2]!.trim();
    if (/^\d{1,3}$/.test(tail)) {
      // 「FANTIA 作品集 2」：后面只是卷号，书名保留整串，不拿前半当画师（常是平台名）
      volumeNo ??= Number(tail);
      seriesKey ??= s.slice(0, s.length - tail.length).trim();
    } else {
      artist = ab[1]!;
      if (tail) s = tail;
    }
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


// ---------------------------------------------------------------- 按漫画导入的文件夹

const N = String.raw`(\d{1,4}(?:\.\d{1,2})?)`;
/** 整套的范围、完结状态：「Vol.01-Vol.11」「第1-5卷」「1-11卷」「全10卷」「[未完]」。表示整套，不是某一卷 */
const RANGE = new RegExp(
  String.raw`[\[(（【]?\s*(?:v(?:ol(?:ume)?)?[._\s]*\d+\s*[-~～]\s*(?:v(?:ol(?:ume)?)?[._\s]*)?\d+|第?\s*\d+\s*[-~～]\s*\d+\s*[卷巻册冊集话話回章]?|全\s*\d+\s*[卷巻册冊集话話回章]|未完|完结|完結|连载中|連載中)\s*[\])）】]?`,
  'gi',
);
/** 话数：第3话 / 3話 / 第3回 / 第3章 / Chapter 3 / Ch.3 / Ep.3（同一段里有卷又有话时取话） */
const CHAPTER_MARKS = [new RegExp(String.raw`(?:第\s*)?${N}\s*[话話回章]`), new RegExp(String.raw`(?<![a-z])(?:ch(?:apter)?|ep(?:isode)?)[._\s]*${N}`, 'i')];
/** 卷号：Vol.3 / Volume 3 / v03 / VOL_03 / 第3卷 / 3卷 / 卷3（巻、册、冊、集也算） */
const VOLUME_MARKS = [
  new RegExp(String.raw`(?<![a-z])v(?:ol(?:ume)?)?[._\s]*${N}(?![\d])`, 'i'),
  new RegExp(String.raw`第\s*${N}\s*[卷巻册冊集]`),
  new RegExp(String.raw`(?:^|[^\d.])${N}\s*[卷巻册冊](?![\d])`),
  new RegExp(String.raw`^[卷巻册冊]\s*${N}$`),
];
/** 整段只是一个数（「001」「02」）：在漫画文件夹里就是第几卷 / 第几话 */
const PURE_NUMBER = /^\d{1,4}(?:\.\d{1,2})?$/;
/** 只是装图的子目录名（和 detect.ts 的 GENERIC_LEAF 一致） */
const GENERIC_DIR = /^(?:images?|imgs?|pics?|pages?|scans?|.+_files|.+\.files)$/i;

const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 一 ~ 九十九 */
function cnNumber(s: string): number | null {
  const m = /^([一二两三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(s);
  if (!m || !s) return null;
  if (!m[2]) return m[1] && !m[3] ? CN_DIGIT[m[1]]! : null;
  return (m[1] ? CN_DIGIT[m[1]]! : 1) * 10 + (m[3] ? CN_DIGIT[m[3]]! : 0);
}
/** 「第十二话」「卷三」里的中文数字换成阿拉伯数字 */
const arabic = (s: string) =>
  s
    .replace(/第([一二两三四五六七八九十]{1,3})(?=\s*[卷巻册冊集话話回章])/g, (all, n: string) => {
      const v = cnNumber(n);
      return v === null ? all : `第${v}`;
    })
    .replace(/^([卷巻册冊])([一二两三四五六七八九十]{1,3})$/, (all, w: string, n: string) => {
      const v = cnNumber(n);
      return v === null ? all : `${w}${v}`;
    });

const firstMatch = (res: RegExp[], s: string): RegExpExecArray | null => {
  for (const re of res) {
    const m = re.exec(s);
    if (m) return m;
  }
  return null;
};

/** 系列名：去掉范围、卷号、话数、压缩包扩展名和书名外面的方括号；只剩数字或空的算没有 */
function seriesText(seg: string): string | null {
  const s = seg
    .replace(/\.(zip|rar|7z|cbz|cbr)$/i, '')
    .replace(RANGE, ' ')
    .replace(new RegExp(String.raw`(?<![a-z])(?:v(?:ol(?:ume)?)?|ch(?:apter)?|ep(?:isode)?)[._\s]*\d{1,4}(?:\.\d{1,2})?`, 'gi'), ' ')
    .replace(/第\s*\d{1,4}(?:\.\d{1,2})?\s*[卷巻册冊集话話回章]/g, ' ')
    .replace(/(?:^|\s)\d{1,4}(?:\.\d{1,2})?\s*[卷巻册冊话話回章](?=\s|$)/g, ' ')
    .replace(/^[卷巻册冊]\s*\d{1,4}$/, ' ')
    .replace(/[\[(（【]\s*[\])）】]/g, ' ')
    .replace(/\s+/g, ' ')
    // 去掉编号后留下的连接符：「书名_Vol.04」「书名 - 第3话」
    .replace(/^[\s_\-.·・~～]+|[\s_\-.·・~～]+$/g, '')
    .trim();
  if (!s || PURE_NUMBER.test(s)) return null;
  const title = parseFolderName(s).title;
  // 「[作者][书名][出版社]」剥完作者、出版社还剩「[书名]」：去掉方括号
  const bracket = title ? /^\[([^\]]+)\]/.exec(title) : null;
  return clean(bracket ? bracket[1] : title);
}

/**
 * 按漫画导入的文件夹（library_roots.content_mode = 'comic'）里一本的书名、系列、卷号。
 * - 卷号 / 话数：从最里层往外找第一个带编号的目录（话优先于卷、「001」这种纯数字也算）；
 *   碰到写着范围的目录（「Vol.01-Vol.11」）就停，那一层是整套，不是某一卷。
 * - 系列名：从带编号的那一层往外找第一个去掉编号后还有字的目录名（「第001话 出会い」的副标题不算）；
 *   都没有就用图库文件夹自己的名字。没有编号的书就用最里层的目录名。
 * - title 和连载一样写系列名，第几卷看 volumeNo。
 */
export function parseComicDir(dir: string, rootPath: string): ParsedFolderName {
  const parts = dir
    .split('/')
    .filter((s) => s && !GENERIC_DIR.test(s.normalize('NFC')))
    .map((s) => arabic(s.normalize('NFC')));
  let volumeNo: number | null = null;
  let at = -1;
  /** 带话数的那一层：只取话数前面的部分当系列名候选 */
  let chapterHead: string | null = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const raw = parts[i]!;
    const s = raw.replace(RANGE, ' ').trim();
    const ch = firstMatch(CHAPTER_MARKS, s);
    const vol = ch ? null : firstMatch(VOLUME_MARKS, s);
    const n = ch ? Number(ch[1]) : vol ? Number(vol[1]) : PURE_NUMBER.test(s) ? Number(s) : parseFolderName(s).volumeNo;
    if (n !== null && !Number.isNaN(n)) {
      volumeNo = n;
      at = i;
      // 「Series A 第12话 副标题」：系列名只取话数前面的部分
      if (ch) chapterHead = s.slice(0, ch.index);
      break;
    }
    // 这一层写着范围（整套）：卷号不往外找了
    if (s !== raw.trim()) break;
  }

  let series: string | null = null;
  if (at >= 0) {
    for (let i = at; i >= 0 && !series; i--) {
      const seg = i === at && chapterHead !== null ? chapterHead : parts[i]!;
      series = seriesText(seg);
    }
  } else {
    for (let i = parts.length - 1; i >= 0 && !series; i--) series = seriesText(parts[i]!);
  }
  series ??= seriesText(rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? '');

  let byline: ParsedFolderName | null = null;
  for (let i = parts.length - 1; i >= 0 && !byline; i--) {
    const p = parseFolderName(parts[i]!.replace(RANGE, ' '));
    if (p.circle || p.artist) byline = p;
  }
  const leaf = parseFolderName(parts.at(-1) ?? '');
  return {
    title: series ?? leaf.title,
    event: leaf.event,
    circle: byline?.circle ?? null,
    artist: byline?.artist ?? null,
    parody: null,
    translator: leaf.translator,
    seriesKey: volumeNo !== null ? series : null,
    volumeNo,
  };
}
