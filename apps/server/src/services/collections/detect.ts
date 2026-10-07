/**
 * 合集判定（T38a）：纯函数。一个文件夹最多一本；规则与阈值来自 docs/design/m5/collections-detect.reference.cjs
 * （2026-09-27 在真实库副本上判出 64 本：本子 45/45、画集 16/17），「已判定」的口径按 RV-C-1。
 *
 * 三条规则（先中先用）：
 *   A 文件名是页码（≥ 80% 像页码，页码覆盖 ≥ 70%）
 *   B 版心统一 + 下载器编号式文件名 + 书页比例
 *   C 目录名像同人志 / 画集 / 连载，并且结构有一半像书
 * 三道排除：页数 < 8 或 > 2000、杂项目录名单、截图 / 照片 / 表情 / 动图页超过 20%。
 * 改规则要把 DETECTOR_VERSION 加一。
 */
import { CHAPTER, TRANSLATOR } from './parseName.ts';

export const DETECTOR_VERSION = 4;
export const MIN_PAGES = 8;
export const MAX_PAGES = 2000;

const MISC_DIR =
  /^(qq_?images?|tieba|screenshots?|screen ?shots?|pixiv|downloads?|browser|weibo|weixin|wechat|dcim|camera|pictures?|images?|pics?|photos?|tmp|temp|twitter|bili(bili)?|nga|知乎|.*相册|表情.*|二维码|qq|taobao|icons?|share|bdshare|baidunetdisk|bluetooth|截图|截屏|屏幕截图)$/i;
const PAGE_STEM = /^(?:(?:p|page|img|image|scan ?image|pic|scan)[ _-]?)?(\d{1,4}|0\d{4})(?:(?:[ _-]{1,2}|_[a-z]{1,4}_\d+_)(\d{1,4}))?[a-z]?$/i;
const MACHINE_STEM = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,40}|-?\d{6,})$/i;
export const ARTBOOK_NAME =
  /画集|畫集|画册|畫冊|原画集|設定資料集|设定集|設定集|イラスト集|作品集|ビジュアルファンブック|ビジュアルコレクション|visual ?fan ?book|visual ?collection|art ?book|artworks?|illustrations?|fanbook|ファンブック/i;
/** 明确是书的画集名：不含 illustrations / artworks 这类常被用来随手命名存图文件夹的英文词 */
const STRONG_ARTBOOK =
  /画集|畫集|画册|畫冊|原画集|設定資料集|设定集|設定集|イラスト集|作品集|ビジュアルファンブック|ビジュアルコレクション|art ?book|fan ?book|ファンブック/i;
const DOUJIN_EVENT =
  /^\s*(?:\[[^\]]*\]\s*)?[(（]\s*(?:C\d{2,3}|COMIC ?1|例大祭|紅楼夢|红楼梦|FF\d{1,3}|CP\d{1,3}|COMITIA|コミティア|サンクリ|みみけっと|歌姫庭園|僕らのラブライブ)[^)）]*[)）]|^\s*(?:C|FF|CP)\d{2,3}\b/i;
const LEAD_CIRCLE = /^\s*\[[^\]]+\]\s*\S/;
/** 只是装图的通用子目录：images、pages，以及浏览器「另存网页」生成的 xxx_files */
const GENERIC_LEAF = /^(?:images?|imgs?|pics?|pages?|scans?|.+_files|.+\.files)$/i;

/**
 * 判定和起书名用的目录名。最内层是通用名字时（「书名/lkfafw_files/images」），往上找第一个不通用的；
 * 全是通用名字（图库文件夹下直接一个 images）就还用最内层，照旧按杂项目录排除（v2）
 */
export function bookLeaf(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) if (!GENERIC_LEAF.test(parts[i]!.normalize('NFC'))) return parts[i]!;
  return parts.at(-1) ?? '';
}

/** T38c 之后改成从 @emaki/shared 导入 */
export type CollectionKind = 'doujin' | 'artbook';
/** H = 按漫画导入的文件夹：每个子文件夹都成一本，不看 A / B / C */
export type CollectionRule = 'A' | 'B' | 'C' | 'H';
export type PageOrder = 'name' | 'mtime';

export interface DirPage {
  id: number;
  fileName: string;
  width: number;
  height: number;
  modifiedAt: string;
  /** images.content_kind */
  kind: string;
  /** 识别过、手动改过，或按非默认规则判过类型（RV-C-1） */
  judged: boolean;
}

/** RV-C-1：judged = 识别过 || 手动改过类型 || 类型来源不是兜底 */
export const isJudged = (r: { tagged_at: string | null; content_kind_manual: number; content_kind_source: string | null }) =>
  r.tagged_at !== null || r.content_kind_manual === 1 || (r.content_kind_source !== null && r.content_kind_source !== 'default');

export interface DirFeatures {
  n: number;
  seqHits: number;
  seq: number;
  coverage: number;
  uniform: number;
  medianW: number;
  medianAspect: number;
  portrait: number;
  machine: number;
  nonBook: number;
  judged: number;
  comicShare: number | null;
}

const stemOf = (f: string) => f.replace(/\.[^.]+$/, '');
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

export function dirFeatures(pages: DirPage[]): DirFeatures {
  const n = pages.length;
  const nums = new Set<number>();
  let seqHits = 0;
  let machine = 0;
  for (const p of pages) {
    const stem = stemOf(p.fileName);
    const m = PAGE_STEM.exec(stem);
    if (m) {
      seqHits++;
      nums.add(Number(m[1]));
    }
    if (m || MACHINE_STEM.test(stem)) machine++;
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const coverage = sorted.length ? sorted.length / (sorted.at(-1)! - sorted[0]! + 1) : 0;
  const medianW = median(pages.map((p) => p.width));
  const medianAspect = median(pages.map((p) => p.height / p.width));
  const uniform =
    pages.filter((p) => Math.abs(p.width - medianW) / medianW <= 0.03 && Math.abs(p.height / p.width - medianAspect) / medianAspect <= 0.05)
      .length / n;
  const portrait = pages.filter((p) => p.height >= p.width * 1.2).length / n;
  // 文字页不算：书里有后记和招募页
  const nonBook = pages.filter((p) => p.kind === 'screenshot' || p.kind === 'photo' || p.kind === 'meme' || p.kind === 'animated').length / n;
  const judged = pages.filter((p) => p.judged);
  const comic = judged.filter((p) => p.kind === 'comic').length;
  return {
    n,
    seqHits,
    seq: seqHits / n,
    coverage,
    uniform,
    medianW,
    medianAspect,
    portrait,
    machine: machine / n,
    nonBook,
    judged: judged.length,
    comicShare: judged.length ? comic / judged.length : null,
  };
}

export function nameSignals(leaf: string): { doujin: boolean; artbook: boolean; chapter: boolean } {
  const s = leaf.normalize('NFC');
  return {
    doujin: DOUJIN_EVENT.test(s) || TRANSLATOR.test(s) || LEAD_CIRCLE.test(s),
    artbook: ARTBOOK_NAME.test(s),
    chapter: CHAPTER.test(s),
  };
}

/** 按漫画导入的文件夹：两页以上就成一本本子，页序按文件名 */
export const COMIC_MIN_PAGES = 2;
export function decideComicCollection(f: DirFeatures): { rule: CollectionRule; pageOrder: PageOrder } | null {
  return f.n >= COMIC_MIN_PAGES && f.n <= MAX_PAGES ? { rule: 'H', pageOrder: 'name' } : null;
}

export function decideCollection(leaf: string, f: DirFeatures): { rule: CollectionRule; pageOrder: PageOrder } | null {
  if (f.n < MIN_PAGES || f.n > MAX_PAGES || MISC_DIR.test(leaf.normalize('NFC')) || f.nonBook > 0.2) return null;
  let rule: CollectionRule | null = null;
  if (f.seq >= 0.8 && f.coverage >= 0.7) rule = 'A';
  else if (f.uniform >= 0.8 && f.medianAspect >= 1.25 && f.medianAspect <= 1.6 && f.machine >= 0.8) rule = 'B';
  else {
    const sig = nameSignals(leaf);
    if ((sig.doujin || sig.artbook || sig.chapter) && (f.seq >= 0.5 || f.uniform >= 0.6) && f.portrait >= 0.5) rule = 'C';
    // v3：名字明确写着画集 / 作品集的，不要求尺寸统一（画师作品合集是不同时期、不同尺寸的图拼起来的）
    else if (STRONG_ARTBOOK.test(leaf.normalize('NFC')) && f.portrait >= 0.5) rule = 'C';
  }
  if (!rule) return null;
  return { rule, pageOrder: f.seq >= 0.8 ? 'name' : 'mtime' };
}

/** 本子还是画集：已判定页够多就看漫画是否过半，否则按目录名暂定（识别后自动更正） */
export function autoKind(leaf: string, f: DirFeatures, rule: CollectionRule | null): { kind: CollectionKind; source: 'pages' | 'name' | 'root' } {
  if (rule === 'H') return { kind: 'doujin', source: 'root' };
  if (f.judged >= Math.max(3, 0.5 * f.n)) return { kind: (f.comicShare ?? 0) >= 0.5 ? 'doujin' : 'artbook', source: 'pages' };
  const sig = nameSignals(leaf);
  if (sig.artbook) return { kind: 'artbook', source: 'name' };
  if (sig.chapter || sig.doujin || rule === 'B') return { kind: 'doujin', source: 'name' };
  return { kind: 'artbook', source: 'name' };
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byName = (a: DirPage, b: DirPage) =>
  collator.compare(stemOf(a.fileName), stemOf(b.fileName)) || collator.compare(a.fileName, b.fileName) || a.id - b.id;

/** 页序：name = 自然序（0000 → 0000-1 → 0001 → 2 → 10，附页落到最后）；mtime = 文件修改时间 */
export function orderPages<T extends DirPage>(pages: T[], order: PageOrder): T[] {
  return [...pages].sort(
    order === 'name' ? byName : (a, b) => (a.modifiedAt < b.modifiedAt ? -1 : a.modifiedAt > b.modifiedAt ? 1 : byName(a, b)),
  );
}

/** 判定依据写成一行中文 */
export function evidenceOf(
  rule: CollectionRule | null,
  f: DirFeatures,
  kindRes: { kind: CollectionKind; source: 'pages' | 'name' | 'root' },
  leaf = '',
): string {
  if (rule === 'H') return '按漫画导入的文件夹';
  const parts: string[] = [];
  if (rule === 'A') parts.push(`文件名是页码（${f.seqHits}/${f.n}）`);
  else if (rule === 'B') parts.push(`版心统一 ${f.medianW}×${Math.round(f.medianW * f.medianAspect)} · 文件名是下载器编号`);
  else if (rule === 'C') {
    const sig = nameSignals(leaf);
    parts.push(`目录名像${sig.chapter ? '连载' : sig.artbook ? '画集' : '同人志'}`);
  }
  const label = kindRes.kind === 'doujin' ? '本子' : '画集';
  if (kindRes.source === 'pages') parts.push(`${Math.round((f.comicShare ?? 0) * f.judged)}/${f.judged} 页是漫画`);
  else parts.push(`尚未识别，暂按目录名归为${label}`);
  return parts.join(' · ');
}
