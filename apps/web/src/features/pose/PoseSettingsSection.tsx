import { formatEta, type Job, type PoseStatus } from '@emaki/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, CircleAlert, Copy, Download, FolderInput, FolderOpen, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Dialog, DialogFooter, Field, IconButton, Input, Progress, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount } from '@/lib/format';
import { useSettings } from '@/lib/queries';
import { BlockRow, SettingsCard, SettingsSection } from '@/features/settings/components/SettingsSection';
import { useActiveJob, useCancelJob, useNow, useSaveSettings } from '@/features/settings/hooks';
import { estimateRemaining, JOB_VERB, jobFraction } from '@/features/settings/jobMeta';
import { poseApi, usePoseStatus } from './client';

/**
 * 设置 → 姿势检索 · 实验。从上往下就是新用户要走的路：开启 → 准备模型（同意后下载，或从本机复制）→ 看提取、匹配的进度；
 * 下面是可选的几项（补充姿势标签、用新的找人模型重新提取、封面），最后折起来的「高级」放全部重算和原型数据的导入。
 * 打开后服务端自动排「提取姿势」，提取时顺便匹配随包的 PoseWear 姿势目录；关掉停下任务、藏起图库里的姿势入口，已提取的数据保留。
 */
export function PoseSettingsSection() {
  const enabled = useSettings().data?.pose?.enabled ?? false;
  const save = useSaveSettings();
  const status = usePoseStatus();
  const client = useQueryClient();
  const s = status.data;
  const ready = s?.models.ready ?? false;
  // 模型没准备好时点开关：先准备模型，准备好了自动打开
  const [wantOn, setWantOn] = useState(false);
  const [prepare, setPrepare] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: ['pose'] });
  // 出错时 toast 报原因，返回 false；完了重新读状态
  const run: Run = async (fn) => {
    try {
      const r = await fn();
      toast(r.message);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      void refresh();
    }
  };

  // 下载完自动打开；下载失败或取消（从下载中变过去的）就算了
  const dl = s?.models.download.state;
  const lastDl = useRef(dl);
  useEffect(() => {
    const stopped = lastDl.current === 'running' && (dl === 'failed' || dl === 'cancelled');
    lastDl.current = dl;
    if (!wantOn) return;
    if (enabled) setWantOn(false);
    else if (ready) {
      setWantOn(false);
      save({ pose: { enabled: true } });
    } else if (stopped) setWantOn(false);
  }, [wantOn, ready, enabled, dl, save]);

  const switchHint = enabled
    ? '关闭会停下提取和匹配，图库里不再显示按姿势；已提取的姿势保留。'
    : wantOn
      ? '模型准备好后自动打开。'
      : ready
        ? '打开后在后台提取姿势，提取时顺便匹配姿势目录，不用再点别的。'
        : `要先准备姿势模型（约 ${formatBytes(s ? missingSize(s.models.files) : 0)}，见下一行）；现在打开会先带你准备。`;

  return (
    <SettingsSection id="pose" description="按人物的姿势给插画归类，在图库里按姿势找图。模型在本机运行，不上传图片。">
      <SettingsCard>
        <Field label="开启姿势检索" hint={switchHint}>
          <Switch
            label="开启姿势检索"
            checked={enabled || wantOn}
            disabled={!s}
            onCheckedChange={(on) => {
              if (on && !ready) {
                setWantOn(true);
                setPrepare(true);
              } else {
                setWantOn(false);
                save({ pose: { enabled: on } });
              }
            }}
          />
        </Field>
        {status.isError && (
          <div role="alert" className="flex items-center gap-3 py-3 text-[12.5px] text-danger">
            <CircleAlert className="size-3.5 shrink-0" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 break-words">{status.error.message}</span>
            <Button size="sm" variant="outline" loading={status.isFetching} onClick={() => void status.refetch()}>
              重试
            </Button>
          </div>
        )}
        {s && (
          <ModelRow
            status={s}
            run={run}
            prepare={prepare}
            onPrepareHandled={() => setPrepare(false)}
            // 没开始准备就关了对话框：开关回到关
            onCancelIntent={() => setWantOn(false)}
            onCopied={() => {
              if (!wantOn) return;
              setWantOn(false);
              save({ pose: { enabled: true } });
            }}
          />
        )}
        {s && enabled && ready && <ExtractRow status={s} run={run} />}
        {s && enabled && <MatchRow status={s} run={run} />}
        {s && enabled && (
          <>
            <Kicker>可选</Kicker>
            <PoseTagsRow status={s} run={run} />
            {ready && s.counts.outdated > 0 && <ReextractRow status={s} run={run} />}
            <CoversRow status={s} run={run} />
            <Advanced status={s} run={run} />
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

type Run = (fn: () => Promise<{ message: string }>) => Promise<boolean>;

const MODEL_NOTE = '动漫人物检测找人（deepghs/anime_person_detection，MIT），DWPose 读全身骨架（yzd-v/DWPose，Apache-2.0）；都来自 Hugging Face。';
const CREDIT = '姿势目录来自 PoseWear（MIT），姿势参考出自 AI Pose Gallery；封面图片不随软件提供。';

/** 还要下的模型文件一共多大（已经在的不算） */
const missingSize = (files: PoseStatus['models']['files']) => files.filter((f) => !f.present).reduce((n, f) => n + f.size, 0);

/** 卡片里的小标题（「可选」） */
function Kicker({ children }: { children: ReactNode }) {
  return <div className="pt-4 pb-1 text-[11.5px] font-medium tracking-wide text-fg-subtle">{children}</div>;
}

/** 后台任务的进度：动词、张数、剩余时间，旁边取消 */
function JobProgress({ job }: { job: Job }) {
  const cancel = useCancelJob();
  const queued = job.status === 'queued';
  const now = useNow(job.status === 'running');
  const left = estimateRemaining(job, now);
  const eta = left != null ? formatEta(left / 1000) : null;
  return (
    <div className="flex h-9 items-center gap-2">
      <div className="w-56">
        <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[11.5px] leading-none tabular">
          <span className="shrink-0 font-medium text-fg">{queued ? '排队中' : JOB_VERB[job.kind]}</span>
          <span className="truncate text-fg-muted">
            {queued
              ? '等前面的任务'
              : job.total
                ? `${formatCount(job.progress)} / ${formatCount(job.total)}${eta ? ` · 剩余约 ${eta}` : ''}`
                : '准备中…'}
          </span>
        </div>
        <Progress value={queued ? null : jobFraction(job)} tone="shu" />
      </div>
      <IconButton size="sm" label="取消任务" disabled={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
        <X />
      </IconButton>
    </div>
  );
}

function ModelRow({
  status,
  run,
  prepare,
  onPrepareHandled,
  onCancelIntent,
  onCopied,
}: {
  status: PoseStatus;
  run: Run;
  /** 从开关进来：先问下载还是复制 */
  prepare: boolean;
  onPrepareHandled: () => void;
  /** 从开关进来、又没准备就关了对话框 */
  onCancelIntent: () => void;
  onCopied: () => void;
}) {
  const m = status.models;
  const d = m.download;
  const [consent, setConsent] = useState(false);
  const [copying, setCopying] = useState(false);
  // 复制对话框是从开关那条路打开的：取消时开关回到关
  const [copyForIntent, setCopyForIntent] = useState(false);
  const total = missingSize(m.files);
  const downloading = d.state === 'running';

  let state;
  if (m.ready) {
    state = (
      <div className="flex min-w-0 items-center gap-3">
        <Badge tone="ok" dot>
          已就绪
        </Badge>
        <span className="min-w-0 truncate font-mono text-[11px] text-fg-subtle" title={m.dir}>
          {m.dir}
        </span>
      </div>
    );
  } else if (downloading) {
    const frac = d.total > 0 ? d.received / d.total : null;
    state = (
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[11.5px] leading-none tabular">
            <span className="truncate font-medium">正在下载 {d.file ?? ''}</span>
            <span className="shrink-0 text-fg-muted">
              {d.total > 0 ? `${formatBytes(d.received)} / ${formatBytes(d.total)}` : '连接中…'}
            </span>
          </div>
          <Progress value={frac} tone="shu" />
        </div>
        <IconButton size="sm" label="取消下载（已下的部分留着，下次接着下）" onClick={() => void run(poseApi.cancelDownload)}>
          <X />
        </IconButton>
      </div>
    );
  } else {
    const missing = m.files.filter((f) => !f.present);
    state = (
      <div className="space-y-3">
        <p className="text-[12.5px] text-fg-muted">
          还缺 {missing.map((f) => f.name).join('、')}
          {d.state === 'cancelled' && ' · 下载已取消，再点下载会接着下'}
        </p>
        {d.state === 'failed' && d.message && <p className="text-[12.5px] break-words text-danger">下载失败：{d.message}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" icon={<Download />} onClick={() => setConsent(true)}>
            {d.state === 'failed' || d.state === 'cancelled' ? '继续下载…' : `下载模型（约 ${formatBytes(total)}）…`}
          </Button>
          <Button variant="outline" size="sm" icon={<FolderInput />} onClick={() => setCopying(true)}>
            从本机复制…
          </Button>
        </div>
      </div>
    );
  }

  return (
    <BlockRow label="姿势模型" hint={MODEL_NOTE}>
      {state}
      <ConsentDialog
        open={consent || prepare}
        onOpenChange={(open) => {
          setConsent(open);
          if (!open && prepare) {
            onPrepareHandled();
            onCancelIntent();
          }
        }}
        files={m.files.filter((f) => !f.present)}
        intro={prepare ? '打开姿势检索要先准备两个模型，下好后自动打开。' : null}
        onAgree={() => {
          setConsent(false);
          if (prepare) onPrepareHandled();
          void run(poseApi.download);
        }}
        onCopy={() => {
          setConsent(false);
          if (prepare) {
            onPrepareHandled();
            setCopyForIntent(true);
          }
          setCopying(true);
        }}
      />
      <PathDialog
        open={copying}
        onOpenChange={(open) => {
          setCopying(open);
          if (open) return;
          if (copyForIntent) onCancelIntent();
          setCopyForIntent(false);
        }}
        title="从本机复制姿势模型"
        description="已经下好的模型：文件夹里要有 dw-ll_ucoco_384.onnx；找人模型（model.onnx、threshold.json）放在同一个文件夹，或者 person_detect_v1.1_m / anime_person_v1.1_m 子文件夹里。复制后校验 sha256。"
        fields={[{ key: 'path', label: '文件夹', value: m.localSource ?? '', pick: true }]}
        submit="复制"
        onSubmit={async (v) => {
          const ok = await run(() => poseApi.copy(v.path!));
          if (ok) onCopied();
          return ok;
        }}
      />
    </BlockRow>
  );
}

/** 下载前确认：从哪下、多大、下完做什么；也可以改成从本机复制 */
function ConsentDialog({
  open,
  onOpenChange,
  files,
  intro,
  onAgree,
  onCopy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: PoseStatus['models']['files'];
  intro: string | null;
  onAgree: () => void;
  onCopy: () => void;
}) {
  const total = files.reduce((n, f) => n + f.size, 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="下载姿势模型" width={500}>
      {intro && <p className="mb-3 text-[13px] leading-relaxed">{intro}</p>}
      <ul className="space-y-2.5 text-[13px] leading-relaxed">
        <li>
          从 Hugging Face（deepghs/anime_person_detection、yzd-v/DWPose）下载约 {formatBytes(total)}：
          <span className="text-fg-muted">
            {files.map((f) => `${f.name} ${formatBytes(f.size)}`).join(' + ')}
          </span>
          。连不上时改用 hf-mirror 镜像。
        </li>
        <li className="text-fg-muted">在后台下载，可以随时取消，下次接着下；下完校验 sha256。</li>
        <li className="text-fg-muted">模型只在本机运行，不上传图片。</li>
      </ul>
      <DialogFooter>
        <Button variant="ghost" className="mr-auto" icon={<FolderInput />} onClick={onCopy}>
          已经有了，从本机复制…
        </Button>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button variant="primary" onClick={onAgree}>
          同意并下载
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function ExtractRow({ status, run }: { status: PoseStatus; run: Run }) {
  const live = useActiveJob('pose');
  const job = live ?? status.job;
  const c = status.counts;
  return (
    <Field
      label="提取姿势"
      hint={
        <span className="tabular">
          已提取 {formatCount(c.processed)} / {formatCount(c.eligible)} 张插画 · 找到人物的 {formatCount(c.withPerson)} 张。新加的图会自动提取。
        </span>
      }
    >
      {job ? (
        <JobProgress job={job} />
      ) : c.pending > 0 ? (
        <Button size="sm" variant="secondary" onClick={() => void run(() => poseApi.extract().then(() => ({ message: '已开始提取姿势' })))}>
          提取剩下的 {formatCount(c.pending)} 张
        </Button>
      ) : (
        <span className="text-[12.5px] text-fg-subtle">都提取过了</span>
      )}
    </Field>
  );
}

/** 匹配姿势目录：提取时顺便做；标签、骨架换过或姿势目录升级后「重新匹配姿势」自动补 */
function MatchRow({ status, run }: { status: PoseStatus; run: Run }) {
  const live = useActiveJob('pose-match');
  const m = status.posewear.match;
  const job = live ?? m.job;
  return (
    <Field
      label="匹配姿势"
      hint={
        <span className="tabular">
          已匹配 {formatCount(m.matched)} / {formatCount(m.eligible)} 张
          {m.pending > 0 && `，还有 ${formatCount(m.pending)} 张等重新匹配`}。提取时顺便匹配，标签或骨架换过后自动重新匹配。
        </span>
      }
    >
      {job ? (
        <JobProgress job={job} />
      ) : m.pending > 0 ? (
        <Button size="sm" variant="secondary" onClick={() => void run(() => poseApi.rematch(false).then(() => ({ message: '已开始重新匹配姿势' })))}>
          重新匹配 {formatCount(m.pending)} 张
        </Button>
      ) : (
        <span className="text-[12.5px] text-fg-subtle">{m.eligible > 0 ? '都匹配过了' : '等提取'}</span>
      )}
    </Field>
  );
}

/** 姿势标签的低分：新识别的图顺便收；识别过的旧图点「补充」重跑识别模型（只收低分） */
function PoseTagsRow({ status, run }: { status: PoseStatus; run: Run }) {
  const live = useActiveJob('pose-tags');
  const t = status.tags;
  const job = live ?? t.job;
  const can = t.pending - t.missingModel;
  return (
    <Field
      label="补充姿势标签"
      hint={
        <span className="tabular">
          识别时顺便记下和姿势有关、分数偏低的标签，匹配时多一份依据，按姿势找图更准。识别过的旧图要补一次，每张约 0.5 秒。已收 {formatCount(t.eligible - t.pending)} /{' '}
          {formatCount(t.eligible)} 张
          {t.missingModel > 0 && ` · ${formatCount(t.missingModel)} 张用的识别模型不在本机`}
        </span>
      }
    >
      {job ? (
        <JobProgress job={job} />
      ) : can > 0 ? (
        <Button size="sm" variant="secondary" onClick={() => void run(poseApi.backfillTags)}>
          补充 {formatCount(can)} 张（约 {formatEta(t.estimateSeconds) ?? '—'}）
        </Button>
      ) : (
        <span className="text-[12.5px] text-fg-subtle">{t.pending > 0 ? '识别模型不在本机，补不了' : '都收过了'}</span>
      )}
    </Field>
  );
}

/** 旧的找人模型（YOLOX）提取的：照常能用，重提要点一下 */
function ReextractRow({ status, run }: { status: PoseStatus; run: Run }) {
  const n = status.counts.outdated;
  return (
    <Field
      label="用新的找人模型重新提取"
      hint={`${formatCount(n)} 张是旧的找人模型（YOLOX）提取的，照常能用；新的模型找人更全，重叠的两个人也分得开。`}
    >
      {status.rerun ? (
        <span className="text-[12.5px] text-fg-subtle">跟着「提取姿势」重提中</span>
      ) : (
        <Button size="sm" variant="outline" onClick={() => void run(poseApi.reextract)}>
          重新提取 {formatCount(n)} 张
        </Button>
      )}
    </Field>
  );
}

/** 封面：PoseWear 的线稿，用户自己给（放进 pose-covers/ 或从 PoseWear 文件夹导入）；没有的画小木偶 */
function CoversRow({ status, run }: { status: PoseStatus; run: Run }) {
  const c = status.posewear.covers;
  const [importing, setImporting] = useState(false);
  const copyDir = () =>
    void copyText(c.dir)
      .then(() => toast('已复制文件夹路径'))
      .catch(() => toast.error('复制失败'));
  return (
    <BlockRow
      label="封面"
      hint={
        <>
          按姿势找图里，每个姿势的封面用 PoseWear 的线稿。Emaki 不带这些图，没有封面的姿势按骨架画一个小人。
          有 PoseWear 的线稿的话，原样（不改文件名）放进下面这个文件夹，或者从 PoseWear 文件夹导入（复制进数据目录）。
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[12.5px] text-fg-muted tabular">
            有封面 {formatCount(c.found)} / {formatCount(c.total)} 个姿势
          </span>
          <span className="min-w-0 truncate rounded-sm bg-sunken px-2 py-1 font-mono text-[11px] text-fg-muted" title={c.dir}>
            {c.dir}
          </span>
          <IconButton size="sm" label="复制文件夹路径" onClick={copyDir}>
            <Copy />
          </IconButton>
        </div>
        <Button size="sm" variant="outline" icon={<FolderInput />} onClick={() => setImporting(true)}>
          从 PoseWear 文件夹导入封面…
        </Button>
        <p className="text-[11.5px] leading-relaxed text-fg-subtle">{CREDIT}</p>
      </div>
      <PathDialog
        open={importing}
        onOpenChange={setImporting}
        title="从 PoseWear 文件夹导入封面"
        description="选 PoseWear 文件夹（里面有 p/t、p/i 线稿；平铺的也认）。复制进数据目录，再导一次会替换。"
        fields={[{ key: 'path', label: 'PoseWear 文件夹', value: status.posewear.defaults.folder ?? '', pick: true }]}
        submit="导入"
        onSubmit={(v) => run(() => poseApi.importPoseWear({ path: v.path! }))}
      />
    </BlockRow>
  );
}

/** 折起来的「高级」：全部重新匹配、51 类，本机有原型数据时的几个导入 */
function Advanced({ status, run }: { status: PoseStatus; run: Run }) {
  const [open, setOpen] = useState(false);
  const showClasses = useSettings().data?.pose?.showClasses ?? false;
  const save = useSaveSettings();
  const pw = status.posewear;
  return (
    <div className="py-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-ml-2 flex h-8 items-center gap-1 rounded-sm px-2 text-[12.5px] text-fg-muted hover:bg-hover hover:text-fg"
      >
        高级
        <ChevronDown className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mb-2 animate-fade-in divide-y divide-line">
          <Field label="全部重新匹配" hint="按现在的骨架和标签把提取过的图全部重算一遍。平时不用点：标签、骨架换过或姿势目录升级后会自动补。">
            <Button size="sm" variant="outline" onClick={() => void run(() => poseApi.rematch(true).then(() => ({ message: '已开始全部重新匹配' })))}>
              全部重新匹配
            </Button>
          </Field>
          <Field label="显示 51 类" hint="早先按骨架聚出来的 51 类：图库里多一个「按人偶挑」，看图器里多一行「姿势类」。数据一直保留。">
            <Switch label="显示 51 类" checked={showClasses} onCheckedChange={(on) => save({ pose: { showClasses: on } })} />
          </Field>
          {status.prototype && <PrototypeRow defaults={status.prototype} run={run} />}
          {status.tags.prototype && <TagsImportRow path={status.tags.prototype} run={run} />}
          {(pw.defaults.assignmentsPath || pw.defaults.pairsPath) && <MatchesImportRow defaults={pw.defaults} run={run} />}
        </div>
      )}
    </div>
  );
}

function PrototypeRow({ defaults, run }: { defaults: NonNullable<PoseStatus['prototype']>; run: Run }) {
  const [open, setOpen] = useState(false);
  return (
    <Field label="导入原型的姿势数据" hint="姿势原型跑好的骨架和 51 类的归类，只导本图库里有的图；导过再导结果不变，已经用新模型提取的不覆盖。">
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        导入…
      </Button>
      <PathDialog
        open={open}
        onOpenChange={setOpen}
        title="导入原型的姿势数据"
        description="骨架点（keypoints_lib.npz）和归类结果（assignments.json）。"
        fields={[
          { key: 'keypointsPath', label: '骨架点', value: defaults.keypointsPath },
          { key: 'assignmentsPath', label: '归类结果', value: defaults.assignmentsPath },
        ]}
        submit="导入"
        onSubmit={(v) => run(() => poseApi.importPrototype({ keypointsPath: v.keypointsPath!, assignmentsPath: v.assignmentsPath! }))}
      />
    </Field>
  );
}

function TagsImportRow({ path, run }: { path: string; run: Run }) {
  const [open, setOpen] = useState(false);
  return (
    <Field label="导入原型的姿势标签低分" hint="原型算好的低分姿势标签，导入后这些图就不用再补充姿势标签。只导本图库里有的图，已经收过的不覆盖。">
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        导入…
      </Button>
      <PathDialog
        open={open}
        onOpenChange={setOpen}
        title="导入原型的姿势标签低分"
        description="只导本图库里有的图，已经收过的不覆盖。"
        fields={[{ key: 'path', label: 'pose_tags_lowthr.npz', value: path }]}
        submit="导入"
        onSubmit={(v) => run(() => poseApi.importTagsLow(v.path!))}
      />
    </Field>
  );
}

function MatchesImportRow({ defaults, run }: { defaults: PoseStatus['posewear']['defaults']; run: Run }) {
  const [open, setOpen] = useState(false);
  return (
    <Field label="导入原型的匹配结果" hint="原型跑好的单人、双人匹配。Emaki 自己会匹配，这个只是开发时的捷径；之后骨架、标签换过时照样重新匹配。">
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        导入…
      </Button>
      <PathDialog
        open={open}
        onOpenChange={setOpen}
        title="导入原型的匹配结果"
        description="单人：assignments_multi_weighted.json（assignments_multi.json、旧的 assignments.json 也认）。双人：pose-pair 的 assignments.json。填了哪份换哪份，另一份不动。"
        fields={[
          { key: 'assignmentsPath', label: '单人匹配结果', value: defaults.assignmentsPath ?? '', optional: true },
          { key: 'pairsPath', label: '双人匹配结果', value: defaults.pairsPath ?? '', optional: true },
        ]}
        submit="导入"
        onSubmit={(v) =>
          run(() =>
            poseApi.importPoseWearMatches({
              ...(v.assignmentsPath ? { assignmentsPath: v.assignmentsPath } : {}),
              ...(v.pairsPath ? { pairsPath: v.pairsPath } : {}),
            }),
          )
        }
      />
    </Field>
  );
}

/** 填一两个本机路径再提交（复制模型、导入共用） */
function PathDialog({
  open,
  onOpenChange,
  title,
  description,
  fields,
  submit,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** optional：可以空着；pick：旁边有「选择…」（弹系统的选文件夹窗口） */
  fields: { key: string; label: string; value: string; optional?: boolean; pick?: boolean }[];
  submit: string;
  /** 成功返回 true，对话框才关 */
  onSubmit: (values: Record<string, string>) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const value = (k: string) => values[k] ?? fields.find((f) => f.key === k)!.value;
  const go = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (await onSubmit(Object.fromEntries(fields.map((f) => [f.key, value(f.key).trim()])))) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} width={560}>
      <form onSubmit={(e) => void go(e)} className="space-y-3">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="mb-1 block text-[12px] text-fg-muted">{f.label}</span>
            <span className="flex items-center gap-2">
              <Input
                value={value(f.key)}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                spellCheck={false}
                className="min-w-0 flex-1 font-mono text-[12px]"
              />
              {f.pick && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  icon={<FolderOpen />}
                  onClick={() =>
                    void api
                      .pickFolder()
                      .then(({ path }) => path && setValues((v) => ({ ...v, [f.key]: path })))
                      .catch((e: Error) => toast.error(e.message))
                  }
                >
                  选择…
                </Button>
              )}
            </span>
          </label>
        ))}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={fields.some((f) => !f.optional && !value(f.key).trim())}>
            {submit}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
