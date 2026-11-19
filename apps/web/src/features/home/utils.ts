import { JOB_LABEL as JOB_NAME, type JobKind, type LibrarySummary } from '@emaki/shared';
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

/** 横幅上的「正在……」：任务名只有一份（packages/shared 的 JOB_LABEL） */
export const JOB_LABEL = Object.fromEntries(Object.entries(JOB_NAME).map(([k, v]) => [k, `正在${v}`])) as Record<JobKind, string>;

/** 把 formatBytes 的结果拆成「数字 + 单位」，数字用大号衬线、单位用小字 */
export function splitBytes(bytes: number): { value: number; unit: string; digits: 0 | 1 } {
  const [num = '0', unit = 'B'] = formatBytes(bytes).split(' ');
  return { value: Number(num), unit, digits: num.includes('.') ? 1 : 0 };
}

/** 首次导入进行到哪一步（HO-2）；null = 不是导入态（没有 7 天内的首次导入，或者全都做完了） */
export type ImportPhase = 'scanning' | 'thumbnails' | 'tagging' | 'paused' | 'deduping' | null;

export function importPhase(
  summary: Pick<LibrarySummary, 'recentImport' | 'triage'>,
  jobs: { scan: unknown; thumbnail: unknown; tag: unknown; dedupe: unknown },
): ImportPhase {
  if (!summary.recentImport) return null;
  if (jobs.scan) return 'scanning';
  if (jobs.tag) return 'tagging';
  if (jobs.thumbnail) return 'thumbnails';
  // 只看这次导入的文件夹里还有没有没识别的，库里别处的不算
  if (summary.recentImport.pending > 0 && summary.triage.waiting > 0) return 'paused';
  if (jobs.dedupe) return 'deduping';
  return null;
}

