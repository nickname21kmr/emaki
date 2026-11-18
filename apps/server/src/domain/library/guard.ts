/**
 * 「扫描或识别进行中不能动文件」只有这一处（P4a；以前散在应用内移动、整理到子文件夹、移回、替换、撤销替换、撤销导入 6 处，各写各的）。
 *
 * - 扫描正在跑：一律不行。扫描会把刚挪走的文件当成丢失、把刚换掉的文件当成外部修改；
 * - 识别正在跑、要动的图里有它还会去读的（不在漫画区、没识别过或要重新识别）：不行，等识别结束。
 * action 是给用户看的动作（「移动」「替换」……），拼进提示里。
 */
import type { JobQueue } from '../../core/jobs.ts';
import type { Db } from '../../db/connection.ts';
import { ConflictError } from '../../http/errors.ts';
import { IN_COMIC } from '../../services/classify/comicAreas.ts';

export function assertFilesIdle(ctx: { db: Db; jobs: JobQueue }, ids: readonly number[], action: string): void {
  const running = new Set(
    ctx.jobs
      .list()
      .filter((j) => j.status === 'running')
      .map((j) => j.kind),
  );
  if (running.has('scan')) throw new ConflictError(`正在扫描图库，等扫描结束再${action}`);
  if (
    running.has('tag') &&
    ids.length &&
    ctx.db
      .prepare(
        `SELECT 1 FROM images i WHERE i.id IN (SELECT value FROM json_each(?))
           AND (i.tagged_at IS NULL OR i.retag = 1) AND NOT ${IN_COMIC('i')} LIMIT 1`,
      )
      .get(JSON.stringify(ids))
  ) {
    throw new ConflictError(`正在识别，选中的图里有还没识别完的，等识别结束再${action}`);
  }
}
