import { Emblem } from '@/components/ui/Emblem';
import type { Job, JobKind, LibraryRoot, MutationResult, Settings } from '@emaki/shared';
import { ArrowLeft, ArrowRight, Check, ScanFace } from 'lucide-react';
import { sectionNumber } from '@/features/settings/sections';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Progress, Segmented, Skeleton, Switch } from '@/components/ui';
import { LibraryRootsEditor } from '@/features/settings/components/LibraryRootsEditor';
import { useMergedJobs } from '@/features/settings/hooks';
import { isActiveJob, jobFraction, JOB_LABEL } from '@/features/settings/jobMeta';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useServerEvents } from '@/lib/events';
import { formatCount } from '@/lib/format';
import { useMutate, useSettings, useStartJob, useStats } from '@/lib/queries';

const STEPS = [
  { title: '选择文件夹', hint: '插画放在哪里' },
  { title: '识别设置', hint: '怎么认出角色' },
  { title: '开始整理', hint: '扫描与识别' },
] as const;

type Strictness = 'loose' | 'balanced' | 'strict';
const STRICTNESS: Record<Strictness, { characterThreshold: number; autoAcceptThreshold: number }> = {
  loose: { characterThreshold: 0.25, autoAcceptThreshold: 0.75 },
  balanced: { characterThreshold: 0.35, autoAcceptThreshold: 0.85 },
  strict: { characterThreshold: 0.5, autoAcceptThreshold: 0.92 },
};

/**
 * 首次使用引导（/welcome，在 AppShell 之外）：选文件夹 → 识别设置 → 开始整理。
 * 纸张卡片左栏竖排三个步骤，右栏是当前步骤；和其他页面同一套「绘卷」语言。
 */
export function WelcomePage() {
  // AppShell 之外的页面也要订阅 SSE，第三步的进度才会动
  useServerEvents();
  const settings = useSettings().data;
  const [step, setStep] = useState(0);

  return (
    <div className="flex min-h-full items-start justify-center bg-canvas px-4 py-10 sm:items-center">
      <div className="w-full max-w-[960px] overflow-hidden rounded-[var(--radius-sheet)] bg-sheet shadow-[var(--shadow-sheet)]">
        <header className="px-8 pt-8 pb-7 sm:px-10">
          <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] text-fg-subtle uppercase">
            <Emblem size={32} />
            Emaki
          </div>
          <h1 className="mt-3 text-[28px] font-semibold tracking-tight">把你的插画收进来</h1>
          <p className="mt-1.5 text-[14px] text-fg-muted">Emaki 只读取文件：不会移动、改名或上传任何图片。</p>
        </header>

        <div className="grid border-t border-line md:grid-cols-[260px_minmax(0,1fr)]">
          <StepRail step={step} />
          <section key={step} className="min-h-[440px] animate-rise px-8 py-8 sm:px-10">
            {!settings ? (
              <Skeleton className="h-40 w-full rounded-xl" />
            ) : step === 0 ? (
              <FoldersStep roots={settings.libraryRoots} onNext={() => setStep(1)} />
            ) : step === 1 ? (
              <TaggerStep settings={settings} onBack={() => setStep(0)} onNext={() => setStep(2)} />
            ) : (
              <StartStep onBack={() => setStep(0)} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function StepRail({ step }: { step: number }) {
  return (
    <ol className="flex gap-6 border-b border-line bg-raised/60 px-8 py-6 md:flex-col md:gap-7 md:border-r md:border-b-0 md:py-9 md:pr-6 md:pl-10">
      {STEPS.map((s, i) => {
        const current = i === step;
        const done = i < step;
        return (
          <li key={s.title} className="flex items-center gap-4" aria-current={current ? 'step' : undefined}>
            <span
              className={cn(
                'numeral w-10 text-[34px] leading-none transition-colors duration-500',
                current ? 'text-fg' : 'text-fg-subtle',
              )}
            >
              {sectionNumber(i)}
            </span>
            <div className="min-w-0">
              <div
                className={cn(
                  'flex items-center gap-2 text-[14px] font-semibold tracking-tight',
                  done && 'text-fg-subtle',
                  !current && !done && 'text-fg-muted',
                )}
              >
                {current && <span className="size-1.5 shrink-0 rounded-full bg-shu" aria-hidden />}
                {s.title}
                {done && <Check className="size-3.5 text-ok" aria-label="已完成" />}
              </div>
              <div className="mt-0.5 hidden text-xs text-fg-subtle sm:block">{s.hint}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StepFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6">{children}</div>;
}

// ---------------------------------------------------------------- 一

function FoldersStep({ roots, onNext }: { roots: LibraryRoot[]; onNext: () => void }) {
  return (
    <div>
      <h2 className="text-[17px] font-semibold tracking-tight">存放插画的文件夹</h2>
      <p className="mt-1.5 mb-6 max-w-lg text-[13px] leading-relaxed text-fg-muted">
        可以添加多个，子文件夹会一起扫描。移动硬盘拔掉后，里面的图片只是暂时隐藏，不会删除记录。
      </p>
      <LibraryRootsEditor roots={roots} />
      <StepFooter>
        <span className="text-xs text-fg-subtle">{roots.length ? `已添加 ${roots.length} 个文件夹` : '至少添加一个文件夹'}</span>
        <Button variant="primary" trailing={<ArrowRight />} disabled={!roots.length} onClick={onNext}>
          下一步
        </Button>
      </StepFooter>
    </div>
  );
}

// ---------------------------------------------------------------- 二

function strictnessOf(s: Settings): Strictness {
  const t = s.tagger.characterThreshold;
  return t <= 0.3 ? 'loose' : t >= 0.45 ? 'strict' : 'balanced';
}

function TaggerStep({ settings, onBack, onNext }: { settings: Settings; onBack: () => void; onNext: () => void }) {
  const [gpu, setGpu] = useState(settings.tagger.device === 'dml');
  const [strictness, setStrictness] = useState<Strictness>(() => strictnessOf(settings));
  // 界面上默认打开；保存时写入 danbooru.enabled
  const [danbooru, setDanbooru] = useState(true);
  const [blur, setBlur] = useState(settings.ui.blurSensitive);
  const save = useMutate(
    () =>
      api
        .updateSettings({
          tagger: { device: gpu ? 'dml' : 'cpu', ...STRICTNESS[strictness] },
          danbooru: { enabled: danbooru },
          ui: { blurSensitive: blur },
        })
        .then((): MutationResult => ({ ok: true, message: '已保存识别设置', undoToken: null })),
    { silent: true, onSuccess: onNext },
  );

  return (
    <div>
      <h2 className="text-[17px] font-semibold tracking-tight">识别设置</h2>
      <p className="mt-1.5 mb-4 max-w-lg text-[13px] leading-relaxed text-fg-muted">
        角色识别用本地的 WD14 模型，全部在这台电脑上完成。这些选项之后都可以在设置里改。
      </p>

      <div className="divide-y divide-line">
        <Option title="用显卡加速识别" hint="DirectML，支持大部分 NVIDIA / AMD / Intel 显卡；不可用时会自动改用 CPU。">
          <Switch checked={gpu} onCheckedChange={setGpu} label="用显卡加速识别" />
        </Option>
        <Option title="识别严格度" hint="越严格，自动归类越少、需要你确认的越多；宽松则相反。">
          <Segmented
            value={strictness}
            onChange={setStrictness}
            options={[
              { value: 'loose', label: '宽松' },
              { value: 'balanced', label: '平衡' },
              { value: 'strict', label: '严格' },
            ]}
          />
        </Option>
        <Option
          title="联网同步 Danbooru 标签资料"
          hint="只发送标签名、下载公开的标签信息，用来把角色归到作品、支持别名搜索。不上传图片。"
        >
          <Switch checked={danbooru} onCheckedChange={setDanbooru} label="联网同步 Danbooru 标签资料" />
        </Option>
        <Option title="敏感分级默认模糊" hint="较敏感和限制级的图先模糊显示，悬停或点开再看清。">
          <Switch checked={blur} onCheckedChange={setBlur} label="敏感分级默认模糊" />
        </Option>
      </div>

      <StepFooter>
        <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack}>
          上一步
        </Button>
        <Button variant="primary" trailing={<ArrowRight />} loading={save.isPending} onClick={() => save.mutate(undefined)}>
          下一步
        </Button>
      </StepFooter>
    </div>
  );
}

function Option({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-0.5 max-w-md text-xs leading-relaxed text-fg-muted">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- 三

const PIPELINE: JobKind[] = ['scan', 'thumbnail', 'tag'];

function StartStep({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const stats = useStats().data;
  const { jobs } = useMergedJobs();
  const startTag = useStartJob(() => '已开始识别角色');

  // 每类任务取最近的一次
  const latest = useMemo(() => {
    const map = new Map<JobKind, Job>();
    for (const j of jobs) if (PIPELINE.includes(j.kind) && !map.has(j.kind)) map.set(j.kind, j);
    return map;
  }, [jobs]);
  const busy = jobs.some(isActiveJob);
  const tagRunning = !!latest.get('tag') && isActiveJob(latest.get('tag')!);
  const scanned = latest.get('scan')?.status === 'done';
  const empty = scanned && !busy && stats?.imageCount === 0;

  return (
    <div>
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight">开始整理</h2>
          <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-fg-muted">
            扫描、生成缩略图会在后台进行。现在就可以进入 Emaki，新图会陆续出现。
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="numeral text-[52px] leading-none tabular">{formatCount(stats?.imageCount ?? 0)}</div>
          <div className="mt-1 text-xs text-fg-subtle">张已入库</div>
        </div>
      </div>

      {empty ? (
        <div className="mt-8 rounded-xl bg-warn-soft px-5 py-4 text-[13px] text-warn">
          这个文件夹里没有找到图片（支持 jpg / png / webp / gif / avif / bmp）
        </div>
      ) : (
        <ul className="mt-8 flex flex-col gap-5">
          {PIPELINE.map((kind) => (
            <JobLine key={kind} kind={kind} job={latest.get(kind) ?? null} />
          ))}
        </ul>
      )}

      <div className="mt-8 flex flex-col items-start gap-2">
        <Button
          variant="outline"
          icon={<ScanFace />}
          loading={startTag.isPending || tagRunning}
          disabled={empty}
          onClick={() => startTag.mutate('tag')}
        >
          开始识别角色
        </Button>
        <p className="text-xs text-fg-subtle">第一次会下载约 1.3 GB 的识别模型，之后离线可用。</p>
      </div>

      <StepFooter>
        <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack}>
          {empty ? '返回上一步' : '管理文件夹'}
        </Button>
        <Button variant="primary" trailing={<ArrowRight />} onClick={() => navigate('/')}>
          进入 Emaki
        </Button>
      </StepFooter>
    </div>
  );
}

function JobLine({ kind, job }: { kind: JobKind; job: Job | null }) {
  const active = !!job && isActiveJob(job);
  const status = !job
    ? '等待中'
    : job.status === 'queued'
      ? '排队中'
      : job.status === 'running'
        ? job.total
          ? `${formatCount(job.progress)} / ${formatCount(job.total)}`
          : '进行中'
        : job.status === 'done'
          ? '完成'
          : job.status === 'failed'
            ? '失败'
            : '已取消';
  return (
    <li>
      <div className="mb-2 flex items-baseline justify-between gap-4 text-[13px]">
        <span className={cn('font-medium', !job && 'text-fg-muted')}>{JOB_LABEL[kind]}</span>
        <span className={cn('tabular text-xs', job?.status === 'failed' ? 'text-danger' : 'text-fg-subtle')}>{status}</span>
      </div>
      <Progress tone="shu" value={!job ? 0 : active ? jobFraction(job) : job.status === 'done' ? 1 : 0} />
      {job?.status === 'failed' && <p className="mt-1.5 text-xs text-danger">{job.message}</p>}
    </li>
  );
}
