/**
 * 文字脚本判断：简体 / 繁体 / 日文 / 拉丁。opencc 的字典约 6 MB，首次用时才加载并复用。
 */
import * as OpenCC from 'opencc-js';

const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const HAN = /\p{Script=Han}/u;

let cn2tw: ((s: string) => string) | undefined;
let jp2cn: ((s: string) => string) | undefined;
const toTw = (s: string) => (cn2tw ??= OpenCC.Converter({ from: 'cn', to: 'tw' }))(s);

/** 繁体 / 日文新字体 → 简体。含假名的字符串只会转汉字部分，所以调用方别拿它转日文名 */
export const toSimplified = (s: string) => (jp2cn ??= OpenCC.Converter({ from: 'jp', to: 'cn' }))(s);
export const hasKana = (s: string) => KANA.test(s);
export const isHanName = (s: string) => HAN.test(s) && !KANA.test(s) && !HANGUL.test(s);
/** 含简体特有字、且没有繁体 / 日文新字体：圣园未花 ✓，聖園彌香 ✗，博麗霊夢 ✗ */
export const isSimplifiedZh = (s: string) => isHanName(s) && toTw(s) !== s && toSimplified(s) === s;
/** 简繁同形：未花、初音 */
export const isNeutralHan = (s: string) => isHanName(s) && toTw(s) === s && toSimplified(s) === s;
export const isLatinName = (s: string) => /^[\x20-\x7e]+$/.test(s) && /[a-z]/i.test(s);
