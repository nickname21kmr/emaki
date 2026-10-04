/**
 * 这次读不到的图（IO：被占用、掉线、解码超时；ENOENT：文件不在了，常见是移动硬盘拔掉了）：这段时间内不再挑它，
 * 免得每次扫描都为它重新加载模型。识别任务和画师补跑共用。用户手动开始识别 / 识别画师时清掉（resetIoBackoff）
 */
import type { HostItemResult } from './protocol.ts';

const IO_BACKOFF = 30 * 60_000;
const ioBackoff = new Map<number, number>();
/** 同一张图连续这么多次 IO 失败（坏扇区、怎么都解不出来）就记成失败，不再无限重试 */
const IO_MAX_FAILS = 3;
const ioFails = new Map<number, number>();

/** 清掉退避记录（用户手动开始识别时、测试） */
export const resetIoBackoff = () => ioBackoff.clear();

/** 还在退避期内的图 id（JSON 数组，给 SQL 的 json_each） */
export const skipIds = (): string => {
  const now = Date.now();
  const ids: number[] = [];
  for (const [id, until] of ioBackoff) {
    if (until > now) ids.push(id);
    else ioBackoff.delete(id);
  }
  return JSON.stringify(ids);
};

/** 拼进 WHERE：排除退避中的图，参数 @skip 传 skipIds() */
export const NOT_SKIPPED = 'i.id NOT IN (SELECT value FROM json_each(@skip))';

/** 写库前调用：读不了的图记退避；同一张连续 IO 失败到上限的改成 DECODE（记成识别失败）。原地改 results */
export function noteReadFailures(results: HostItemResult[]): void {
  for (const [k, r] of results.entries()) {
    if (r.ok || (r.code !== 'IO' && r.code !== 'ENOENT')) continue;
    ioBackoff.set(r.id, Date.now() + IO_BACKOFF);
    if (r.code !== 'IO') continue;
    const n = (ioFails.get(r.id) ?? 0) + 1;
    ioFails.set(r.id, n);
    if (n >= IO_MAX_FAILS) {
      ioFails.delete(r.id);
      results[k] = { ...r, code: 'DECODE', message: `连续 ${n} 次读不了，不再重试（${r.message}）` };
    }
  }
}
