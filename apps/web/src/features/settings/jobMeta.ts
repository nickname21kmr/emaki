import type { Job, JobKind, JobStatus } from '@emaki/shared';
import { CloudDownload, Copy, FolderSearch, Image as ImageIcon, ScanFace, type LucideIcon } from 'lucide-react';

export const JOB_LABEL: Record<JobKind, string> = {
  scan: '扫描图库',
  thumbnail: '生成缩略图',
  tag: '识别角色',
  'danbooru-sync': '同步 Danbooru',
  dedupe: '查找重复',
};

/** 进度条旁边的动词，比「进行中」更具体 */
export const JOB_VERB: Record<JobKind, string> = {
  scan: '扫描中',
  thumbnail: '生成中',
  tag: '识别中',
  'danbooru-sync': '同步中',
  dedupe: '查找中',
};

export const JOB_ICON: Record<JobKind, LucideIcon> = {
  scan: FolderSearch,
  thumbnail: ImageIcon,
  tag: ScanFace,
  'danbooru-sync': CloudDownload,
  dedupe: Copy,
};

/** 「运行任务」菜单里的顺序：按日常使用频率 */
export const JOB_KINDS: JobKind[] = ['scan', 'tag', 'dedupe', 'danbooru-sync', 'thumbnail'];

type Tone = 'neutral' | 'shu' | 'ok' | 'warn' | 'danger';

export const JOB_STATUS: Record<JobStatus, { label: string; tone: Tone }> = {
  queued: { label: '排队中', tone: 'neutral' },
  running: { label: '进行中', tone: 'shu' },
  done: { label: '完成', tone: 'ok' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

export const isActiveJob = (job: Job) => job.status === 'running' || job.status === 'queued';

/** 0~1；总量未知时为 null（进度条显示不确定态） */
export const jobFraction = (job: Job): number | null =>
  job.total ? Math.min(1, Math.max(0, job.progress / job.total)) : null;

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
}

/** 按目前的平均速度估算剩余时间；刚开始样本太少时不估，免得数字乱跳 */
export function estimateRemaining(job: Job, now: number): number | null {
  if (job.status !== 'running' || !job.total || !job.startedAt || job.progress <= 0) return null;
  const elapsed = now - Date.parse(job.startedAt);
  if (elapsed < 1500) return null;
  return ((job.total - job.progress) * elapsed) / job.progress;
}
