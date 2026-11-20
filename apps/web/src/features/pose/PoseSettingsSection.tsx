import type { PoseStatus } from '@emaki/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Download, FolderInput, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Dialog, DialogFooter, Field, IconButton, Input, Progress, Switch } from '@/components/ui';
import { formatBytes, formatCount } from '@/lib/format';
import { useSettings } from '@/lib/queries';
import { BlockRow, SettingsCard, SettingsSection } from '@/features/settings/components/SettingsSection';
import { JobProgressInline } from '@/features/settings/components/JobAction';
import { useActiveJob, useSaveSettings } from '@/features/settings/hooks';
import { poseApi, usePoseStatus } from './client';

/**
 * 设置 → 姿势检索 · 实验。模型要用户自己准备（同意后下载，或从本机文件夹复制），准备好才能打开。
 * 打开后服务端自动排「提取姿势」；关掉停下任务、藏起图库里的姿势入口，已提取的数据保留。
 */
export function PoseSettingsSection() {
  const enabled = useSettings().data?.pose?.enabled ?? false;
  const save = useSaveSettings();
  const status = usePoseStatus();
  const client = useQueryClient();
  const s = status.data;
  const ready = s?.models.ready ?? false;
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

  return (
    <SettingsSection id="pose" description="按人物的姿势给插画归类，在图库里按姿势找图。模型在本机运行，不上传图片。">
      <SettingsCard>
        <Field
          label="开启姿势检索"
          hint={ready || enabled ? '关闭会停下提取，图库里不再显示按姿势；已提取的姿势保留。' : '先在下面准备好姿势模型。'}
        >
          <Switch
            label="开启姿势检索"
            checked={enabled}
            // 模型没准备好时打不开，但开着的总能关
            disabled={!s || (!ready && !enabled)}
            onCheckedChange={(on) => save({ pose: { enabled: on } })}
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
        {s && <ModelRow status={s} run={run} />}
        {s && enabled && ready && <ExtractRow status={s} run={run} />}
        {s && enabled && s.prototype && <ImportRow defaults={s.prototype} run={run} />}
      </SettingsCard>
    </SettingsSection>
  );
}

type Run = (fn: () => Promise<{ message: string }>) => Promise<boolean>;

const MODEL_NOTE = 'YOLOX-L 找人，DWPose 读全身骨架；来自 Hugging Face（yzd-v/DWPose，Apache-2.0）。';

function ModelRow({ status, run }: { status: PoseStatus; run: Run }) {
  const m = status.models;
  const d = m.download;
  const [consent, setConsent] = useState(false);
  const [copying, setCopying] = useState(false);
  const total = m.files.reduce((n, f) => n + f.size, 0);
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
          缺 {missing.map((f) => f.name).join('、')}
          {d.state === 'cancelled' && ' · 下载已取消，再点下载会接着下'}
        </p>
        {d.state === 'failed' && d.message && <p className="text-[12.5px] break-words text-danger">下载失败：{d.message}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" icon={<Download />} onClick={() => setConsent(true)}>
            {d.state === 'failed' || d.state === 'cancelled' ? '继续下载…' : `下载模型（约 ${formatBytes(total)}）…`}
          </Button>
          {m.localSource && (
            <Button variant="outline" size="sm" icon={<FolderInput />} onClick={() => setCopying(true)}>
              从本机复制…
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <BlockRow label="姿势模型" hint={MODEL_NOTE}>
      {state}
      <ConsentDialog
        open={consent}
        onOpenChange={setConsent}
        files={m.files}
        onAgree={() => {
          setConsent(false);
          void run(poseApi.download);
        }}
      />
      {m.localSource && (
        <PathDialog
          open={copying}
          onOpenChange={setCopying}
          title="从本机复制姿势模型"
          description="文件夹里要有 yolox_l.onnx 和 dw-ll_ucoco_384.onnx，复制后校验 sha256。"
          fields={[{ key: 'path', label: '文件夹', value: m.localSource }]}
          submit="复制"
          onSubmit={(v) => run(() => poseApi.copy(v.path!))}
        />
      )}
    </BlockRow>
  );
}

/** 下载前确认：从哪下、多大、下完做什么 */
function ConsentDialog({
  open,
  onOpenChange,
  files,
  onAgree,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: PoseStatus['models']['files'];
  onAgree: () => void;
}) {
  const total = files.reduce((n, f) => n + f.size, 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="下载姿势模型" width={500}>
      <ul className="space-y-2.5 text-[13px] leading-relaxed">
        <li>
          从 Hugging Face（yzd-v/DWPose）下载约 {formatBytes(total)}：
          <span className="text-fg-muted">
            {files.map((f) => `${f.name} ${formatBytes(f.size)}`).join(' + ')}
          </span>
          。连不上时改用 hf-mirror 镜像。
        </li>
        <li className="text-fg-muted">在后台下载，可以随时取消，下次接着下；下完校验 sha256。</li>
        <li className="text-fg-muted">模型只在本机运行，不上传图片。下完后再打开开关。</li>
      </ul>
      <DialogFooter>
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
          已提取 {formatCount(c.processed)} / {formatCount(c.eligible)} 张 · 找到人物 {formatCount(c.withPerson)} · 归了类的 {formatCount(c.classified)}
        </span>
      }
    >
      {job ? (
        <JobProgressInline job={job} />
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

function ImportRow({ defaults, run }: { defaults: NonNullable<PoseStatus['prototype']>; run: Run }) {
  const [open, setOpen] = useState(false);
  return (
    <Field label="导入已有的姿势数据" hint="姿势原型跑好的结果，只导本图库里有的图；导过再导结果不变。">
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        导入…
      </Button>
      <PathDialog
        open={open}
        onOpenChange={setOpen}
        title="导入已有的姿势数据"
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

/** 填一两个本机路径再提交（复制模型、导入原型共用） */
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
  fields: { key: string; label: string; value: string }[];
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
            <Input
              value={value(f.key)}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              spellCheck={false}
              className="font-mono text-[12px]"
            />
          </label>
        ))}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={fields.some((f) => !value(f.key).trim())}>
            {submit}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
