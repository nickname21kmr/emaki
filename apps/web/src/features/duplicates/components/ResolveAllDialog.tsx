import type { ID, MutationResult } from '@emaki/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, Dialog, DialogFooter, Progress, Segmented } from '@/components/ui';
import { api } from '@/lib/api';
import { formatBytes, formatCount } from '@/lib/format';
import { errorMessage, invalidateAll, useCanUndoTrash, useMutate } from '@/lib/queries';

export interface ResolvePlan {
  id: ID;
  /** 完全一样（sha256 相同）；默认只一键处理这种 */
  exact: boolean;
  keepIds: ID[];
  trashCount: number;
  bytes: number;
}

interface BatchResult extends MutationResult {
  tokens: string[];
  failed: string | null;
}

/**
 * 「全部按推荐处理」的二次确认。
 *
 * 后端没有批量接口，这里逐组调用 resolveDuplicate，把每组的 undoToken 收起来，
 * 最后给一个「撤销」一次性倒序撤回全部。
 */
export function ResolveAllDialog({
  open,
  onOpenChange,
  plans,
  skipped = 0,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plans: ResolvePlan[];
  /** 「可能是同一套」的组数：差分 / 连拍多半是有意留的，不跟着一键处理 */
  skipped?: number;
  /** 处理成功的组 id（让页面先把它们藏起来，不用等刷新） */
  onDone: (ids: ID[]) => void;
}) {
  const client = useQueryClient();
  const canUndo = useCanUndoTrash();
  const [progress, setProgress] = useState(0);
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  // 默认只处理完全一样的：相似的组里常有同一张图的不同版本（调色、加字、改尺寸），留给人逐组看
  const [scope, setScope] = useState<'exact' | 'all'>('exact');
  useEffect(() => {
    if (!open) return;
    setScope('exact');
    setStopping(false);
  }, [open]);
  const exactCount = plans.filter((p) => p.exact).length;
  const chosen = scope === 'exact' ? plans.filter((p) => p.exact) : plans;

  const undoAll = async (tokens: string[]) => {
    try {
      for (const token of [...tokens].reverse()) await api.undo(token);
      toast(`已撤销，${tokens.length} 组重复回到待处理`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      await invalidateAll(client);
    }
  };

  const run = useMutate(
    async (list: ResolvePlan[]): Promise<BatchResult> => {
      const tokens: string[] = [];
      const done: ID[] = [];
      let trashed = 0;
      setProgress(0);
      stopRef.current = false;
      for (const plan of list) {
        // 点了「停止」：当前这一组做完就停，已经处理的保留
        if (stopRef.current) {
          onDone(done);
          return {
            ok: true,
            message: `已停止：处理了 ${done.length} 组，${trashed} 张移到回收站，其余 ${list.length - done.length} 组没动`,
            undoToken: null,
            tokens,
            failed: '已停止',
          };
        }
        try {
          const res = await api.resolveDuplicate(plan.id, plan.keepIds);
          if (res.undoToken) tokens.push(res.undoToken);
          done.push(plan.id);
          trashed += plan.trashCount;
          setProgress(done.length);
        } catch (err) {
          // 一组都没成功就当失败抛出去；做了一部分就停下，把已完成的报告出来
          if (!done.length) throw err;
          onDone(done);
          return {
            ok: true,
            message: `已处理 ${done.length} 组，其余中断：${errorMessage(err)}`,
            undoToken: null,
            tokens,
            failed: errorMessage(err),
          };
        }
      }
      onDone(done);
      return {
        ok: true,
        message: `已处理 ${done.length} 组，${trashed} 张移到回收站`,
        undoToken: null,
        tokens,
        failed: null,
      };
    },
    {
      silent: true,
      onSuccess: (res) => {
        const notify = res.failed ? toast.warning : toast.success;
        notify(res.message, res.tokens.length ? { action: { label: '撤销', onClick: () => void undoAll(res.tokens) } } : {});
        onOpenChange(false);
      },
    },
  );

  const totalTrash = chosen.reduce((n, p) => n + p.trashCount, 0);
  const totalBytes = chosen.reduce((n, p) => n + p.bytes, 0);
  const running = run.isPending;

  return (
    <Dialog
      open={open}
      // 处理中不让点外面关掉，避免误以为已经取消；要中途停下用「停止」
      onOpenChange={(v) => !running && onOpenChange(v)}
      title="全部按推荐处理？"
      description="每组保留「建议保留」的那张（你手动调整过的组按你的选择），其余移到系统回收站，不会永久删除。默认只处理完全一样的文件。"
      width={500}
    >
      <Segmented<'exact' | 'all'>
        className="mb-3"
        value={scope}
        onChange={setScope}
        disabled={running}
        options={[
          { value: 'exact', label: `只处理完全一样的 · ${formatCount(exactCount)} 组` },
          { value: 'all', label: `也处理相似的 · ${formatCount(plans.length)} 组` },
        ]}
      />
      {scope === 'all' && plans.length > exactCount && (
        <p className="mb-3 text-[12.5px] leading-relaxed text-warn">
          相似的 {formatCount(plans.length - exactCount)} 组里可能有同一张图的不同版本（调色、加字、换尺寸），一起处理时每组只留推荐的那张。拿不准的话建议逐组看。
        </p>
      )}
      <div className="grid grid-cols-3 divide-x divide-line rounded-lg bg-sunken py-4">
        <Stat value={formatCount(chosen.length)} label="组重复" />
        <Stat value={formatCount(totalTrash)} label="张移到回收站" />
        <Stat value={formatBytes(totalBytes)} label="可释放" />
      </div>
      {skipped > 0 && (
        <p className="mt-3 text-[12.5px] leading-relaxed text-fg-muted">
          另有 {formatCount(skipped)} 组标着「可能是同一套」，多半是差分或连拍，不在这次处理里，请逐组确认。
        </p>
      )}

      <div className="mt-4 min-h-9">
        {running ? (
          <div className="animate-fade-in">
            <div className="mb-2 flex items-baseline justify-between text-[12.5px] text-fg-muted tabular">
              <span>正在处理…</span>
              <span>
                {progress} / {chosen.length}
              </span>
            </div>
            <Progress value={chosen.length ? progress / chosen.length : 0} tone="shu" />
          </div>
        ) : (
          <p className="flex items-center gap-2 text-[12.5px] leading-relaxed text-fg-muted">
            <Undo2 className="size-4 shrink-0 text-fg-subtle" />
            {canUndo
              ? '处理完成后，提示里的「撤销」可以把这些组一次性恢复原样。'
              : '文件会移到系统回收站，可以在回收站里还原；这一步不能在 Emaki 里撤销。'}
          </p>
        )}
      </div>

      <DialogFooter>
        {running ? (
          <Button
            variant="ghost"
            disabled={stopping}
            onClick={() => {
              stopRef.current = true;
              setStopping(true);
            }}
          >
            {stopping ? '正在停止…' : '停止'}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
        )}
        <Button variant="primary" loading={running} disabled={!chosen.length} onClick={() => run.mutate(chosen)}>
          处理 {formatCount(chosen.length)} 组
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-3">
      <span className="numeral text-[34px] text-fg tabular">{value}</span>
      <span className="text-[12px] text-fg-muted">{label}</span>
    </div>
  );
}
