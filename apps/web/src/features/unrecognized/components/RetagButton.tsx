import type { MutationResult } from '@emaki/shared';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog, DialogFooter } from '@/components/ui';
import { api } from '@/lib/api';
import { useLiveJobs } from '@/lib/events';
import { formatCount } from '@/lib/format';
import { useMutate, useUnrecognizedSummary } from '@/lib/queries';
import { useTagJob } from '../useTagJob';

/**
 * 「重新识别」：未识别里已经识别过、但没认出角色的插画，用现在的主模型和阈值再认一遍。
 * 用在换过模型、调低过阈值，或者以前的版本认得不好之后。已经归到角色的、放下的都不动。
 * 识别任务在跑时隐藏（旁边的「运行识别」会变成进度）。
 */
export function RetagButton() {
  const { data } = useUnrecognizedSummary();
  const { running } = useTagJob();
  const [open, setOpen] = useState(false);
  const retag = useMutate(
    (): Promise<MutationResult> =>
      api.retagUnrecognized().then((r) => {
        if (r.job) {
          const live = useLiveJobs.getState();
          if (!live.jobs[r.job.id]) live.upsert(r.job);
        }
        return {
          ok: true,
          message: r.job ? `已开始重新识别 ${formatCount(r.marked)} 张，新结果会自动出现在队列里` : '没有需要重新识别的图',
          undoToken: null,
        };
      }),
    { onSuccess: () => setOpen(false) },
  );

  const n = data?.art.retaggable ?? 0;
  if (running || n === 0) return null;
  return (
    <>
      <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => setOpen(true)}>
        重新识别
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title="用现在的模型重新识别？" width={460}>
        <div className="rounded-lg bg-sunken p-4 text-[13px] leading-relaxed text-fg-muted">
          <p>
            未识别里有 <span className="font-medium text-fg tabular">{formatCount(n)}</span>{' '}
            张插画已经识别过、但没认出角色。会用设置里现在的主模型和阈值把它们再认一遍，不管当时用的是哪个模型。
          </p>
          <p className="mt-2">
            已经归到角色的、放下的、漫画都不动。原来的识别建议会换成新的结果。图多的话要跑一阵，在后台进行，中途可以取消，下次运行识别会接着认。
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="primary" loading={retag.isPending} onClick={() => retag.mutate(undefined)}>
            重新识别 {formatCount(n)} 张
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
