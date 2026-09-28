import type { JobKind } from '@emaki/shared';
import { formatBytes } from '@/lib/format';
import { EASE_OUT } from '@/lib/motion';

/** 和 CSS 里的 --ease-out-soft 一致，给 motion 用 */
export const EASE_OUT_SOFT = EASE_OUT;

/** 按时段问候；深夜单独一档，免得凌晨两点还说「早上好」 */
export function greeting(hour = new Date().getHours()): string {
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 迷你柱状图的日期：back = 距今天几天 */
export function dayLabel(back: number, now = new Date()): string {
  if (back === 0) return '今天';
  if (back === 1) return '昨天';
  const d = new Date(now);
  d.setDate(d.getDate() - back);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY[d.getDay()]}`;
}

export const JOB_LABEL: Record<JobKind, string> = {
  scan: '正在扫描图库',
  thumbnail: '正在生成缩略图',
  tag: '正在识别角色',
  'danbooru-sync': '正在同步 Danbooru',
  dedupe: '正在查找重复',
};

/** 把 formatBytes 的结果拆成「数字 + 单位」，数字用大号衬线、单位用小字 */
export function splitBytes(bytes: number): { value: number; unit: string; digits: 0 | 1 } {
  const [num = '0', unit = 'B'] = formatBytes(bytes).split(' ');
  return { value: Number(num), unit, digits: num.includes('.') ? 1 : 0 };
}

export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** 首次导入进行到哪一步（HO-2）；null = 不是导入态（没有 7 天内的首次导入，或者全都做完了） */
export type ImportPhase = 'scanning' | 'thumbnails' | 'tagging' | 'paused' | 'deduping' | null;

export function importPhase(
  stats: import('@emaki/shared').LibraryStats,
  jobs: { scan: unknown; thumbnail: unknown; tag: unknown; dedupe: unknown },
): ImportPhase {
  if (!stats.recentImport) return null;
  if (jobs.scan) return 'scanning';
  if (jobs.tag) return 'tagging';
  if (jobs.thumbnail) return 'thumbnails';
  if (stats.pendingTagCount > 0 && stats.untaggedCount > 0) return 'paused';
  if (jobs.dedupe) return 'deduping';
  return null;
}

/** 从任务消息里取「剩余约 X」 */
export const parseEta = (msg: string | null | undefined): string | null => /剩余约\s*([^·]+?)\s*(?:·|$)/.exec(msg ?? '')?.[1]?.trim() ?? null;
