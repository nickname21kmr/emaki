import type { Job, LibraryStats } from '@emaki/shared';
import { Check } from 'lucide-react';
import { CoverFan } from '@/components/media/CoverFan';
import { JobFilmstrip } from '@/components/media/JobFilmstrip';
import { Progress } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useRunningJob } from '@/lib/events';
import { formatBytes, formatCount, formatPercent, formatRelative } from '@/lib/format';
import { useImagesInfinite } from '@/lib/queries';
import { RunTaggerButton } from '@/features/unrecognized/components/RunTaggerButton';
import { parseEta, type ImportPhase } from '../utils';

/**
 * 首次导入专门状态（HO-2）：左边一句话讲清楚现在在干什么，右边五张刚入库的图扇形展开，底下四步进度。
 * 导入期间顶部横幅隐藏，进度只在这里出现一次。缩略图和识别在两条道里并行，两步可以同时「进行中」。
 */
export function ImportPanel({ stats, phase }: { stats: LibraryStats; phase: Exclude<ImportPhase, null> }) {
  const imp = stats.recentImport!;
  const N = formatCount(imp.count);
  const latest = useImagesInfinite({ sort: 'addedAt' }).data?.pages[0]?.items.slice(0, 5) ?? [];
  const scanJob = useRunningJob('scan');
  const thumbJob = useRunningJob('thumbnail');
  const tagJob = useRunningJob('tag');
  const dedupeJob = useRunningJob('dedupe');
  const eta = parseEta(tagJob?.message);
  // 识别进度用统计算：任务让出或重启后 job.total 会从剩余数重新计
  const tagged = Math.max(0, imp.count - stats.pendingTagCount);
  const tagV = Math.min(1, tagged / Math.max(1, imp.count));
  const frac = (j: Job | null) => (j?.total ? j.progress / j.total : null);

  const copy: Record<typeof phase, [string, string]> = {
    scanning: ['正在扫描文件夹', `已经发现 ${N} 张。扫描完会生成缩略图，同时在本机识别角色；原文件不会被移动。`],
    thumbnails: [`正在为 ${N} 张生成缩略图`, '缩略图做好后会自动开始识别角色。'],
    tagging: [
      `正在认出 ${N} 张图里的角色`,
      `识别在这台电脑上进行${eta ? `，这一轮大约还要 ${eta}` : ''}。可以先去图库逛逛，认出来的角色会陆续出现在下面。`,
    ],
    paused: [`还有 ${formatCount(stats.pendingTagCount)} 张没识别`, '识别没有在运行（服务重启过，或者模型还没下载）。点继续，会从上次停下的地方接着来。'],
    deduping: ['最后一步：查找重复', '识别已完成，正在比对相似的图。'],
  };

  type Step = { title: string; note: string; v: number | null; now: boolean; done: boolean };
  const scanning = !!scanJob;
  const steps: Step[] = [
    { title: '扫描文件', note: scanning ? `已发现 ${N} 张` : `${N} 张 · ${formatBytes(stats.totalBytes)}`, v: scanning ? frac(scanJob) : 1, now: scanning, done: !scanning },
    {
      title: '生成缩略图',
      note: thumbJob?.total ? `${formatCount(thumbJob.progress)} / ${formatCount(thumbJob.total)}` : scanning ? '扫描后开始' : '完成',
      v: thumbJob ? frac(thumbJob) : scanning ? 0 : 1,
      now: !!thumbJob,
      done: !thumbJob && !scanning,
    },
    {
      title: '识别角色',
      note: phase === 'paused' ? `已暂停 · ${formatPercent(tagV)}` : `${formatCount(tagged)} / ${N} · ${formatPercent(tagV)}${eta ? ` · 约 ${eta}` : ''}`,
      v: tagV,
      now: !!tagJob || phase === 'paused',
      done: stats.pendingTagCount === 0,
    },
    { title: '查找重复', note: dedupeJob ? '进行中' : '识别完成后自动开始', v: dedupeJob ? frac(dedupeJob) : 0, now: !!dedupeJob, done: false },
  ];

  return (
    <section className="group/fan relative grid animate-rise grid-cols-[minmax(0,1fr)_340px] gap-x-8 overflow-hidden rounded-[20px] bg-raised p-7 shadow-card ring-1 ring-line max-lg:grid-cols-1">
      <div key={phase} className="animate-fade-in">
        <div className="text-[12px] font-medium text-fg-subtle">首次导入 · {formatRelative(imp.at)}</div>
        <h2 className="mt-2 text-[24px] leading-tight font-semibold tracking-tight">{copy[phase][0]}</h2>
        <p className="mt-2 max-w-[46ch] text-[13.5px] leading-relaxed text-fg-muted">{copy[phase][1]}</p>
        {phase === 'paused' && <RunTaggerButton className="mt-5" variant="primary" label="继续识别" />}
      </div>
      {latest.length >= 3 && (
        <div className="w-[300px] self-center justify-self-center max-lg:hidden">
          <CoverFan
            count={latest.length >= 5 ? 5 : 3}
            covers={latest.map((i) => ({ imageId: i.id, rating: i.rating, color: i.dominantColor, focus: null }))}
          />
        </div>
      )}
      <ol className="col-span-full mt-7 grid grid-cols-4 gap-6 max-lg:grid-cols-2">
        {steps.map((s, i) => (
          <li key={s.title}>
            <div className="flex items-baseline gap-2.5">
              <span className={cn('numeral w-[18px] text-[28px]', s.now ? 'text-shu' : 'text-fg-subtle', s.done && 'opacity-60')}>{i + 1}</span>
              <span className={cn('text-[13px]', s.now || s.done ? 'font-semibold' : 'font-medium text-fg-muted')}>{s.title}</span>
              {s.done && (
                <span className="flex size-4 items-center justify-center rounded-full bg-ok-soft text-ok">
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
              )}
            </div>
            <div className="mt-1 pl-7 text-[12px] text-fg-muted tabular">{s.note}</div>
            <Progress className="mt-3 h-[3px]" value={s.v} tone={s.now ? 'shu' : 'ink'} glint={s.now && i === 2 && !!tagJob} />
            {i === 2 && tagJob && <JobFilmstrip jobId={tagJob.id} className="mt-2.5" />}
          </li>
        ))}
      </ol>
    </section>
  );
}
