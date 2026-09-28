/** 数字 / 日期 / 体积的中文格式化。 */

const nf = new Intl.NumberFormat('zh-CN');

/** 6163 → "6,163" */
export const formatCount = (n: number) => nf.format(n);

/** 12345 → "1.2 万"；小于 1 万原样带千分位 */
export function formatCompact(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')} 亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')} 万`;
  return nf.format(n);
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

/** "3 分钟前" / "昨天" / "2 个月前" */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '从未';
  const diff = (Date.parse(iso) - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return '刚刚';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86_400 * 30) return rtf.format(Math.round(diff / 86_400), 'day');
  // 月和年向零取整：4 年 8 个月是「4 年前」，不是「5 年前」（HO-B6）
  if (abs < 86_400 * 365) return rtf.format(Math.trunc(diff / (86_400 * 30)) || Math.sign(diff), 'month');
  return rtf.format(Math.trunc(diff / (86_400 * 365)), 'year');
}

const df = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
const dtf = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const formatDate = (iso: string) => df.format(new Date(iso));
export const formatDateTime = (iso: string) => dtf.format(new Date(iso));

export const formatPercent = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;

export const RATING_LABEL = {
  general: '全年龄',
  sensitive: '轻微',
  questionable: '较敏感',
  explicit: '限制级',
} as const;

export const isSensitive = (rating: keyof typeof RATING_LABEL) => rating === 'questionable' || rating === 'explicit';

/** 1920×1080 */
export const formatDimensions = (w: number, h: number) => `${w}×${h}`;

const CJK_DIGIT = '〇一二三四五六七八九';
const WEEKDAY = '日一二三四五六';

function cjkNumber(n: number): string {
  if (n < 10) return CJK_DIGIT[n]!;
  const t = Math.floor(n / 10);
  const o = n % 10;
  return (t === 1 ? '' : CJK_DIGIT[t]!) + '十' + (o ? CJK_DIGIT[o]! : '');
}

/** 2026-09-27 → 「二〇二六年九月二十七日　星期日」（中间是全角空格 U+3000），首页的卷首 kicker 用 */
export function toCjkDate(d: Date): string {
  const y = [...String(d.getFullYear())].map((c) => CJK_DIGIT[Number(c)]!).join('');
  return `${y}年${cjkNumber(d.getMonth() + 1)}月${cjkNumber(d.getDate())}日　星期${WEEKDAY[d.getDay()]!}`;
}
