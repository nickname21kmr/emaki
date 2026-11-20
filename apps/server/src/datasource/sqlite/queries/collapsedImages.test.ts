import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { ListImagesQuery } from '@emaki/shared';
import { EventBus } from '../../../core/events.ts';
import { makeTmpDir } from '../../../../test/helpers/tmp.ts';
import { SqliteDataSource } from '../../../../test/helpers/client.ts';
import { useWholeCollapseForTests } from './collapsedImages.ts';

let ds: SqliteDataSource, dir: string;
beforeEach(async () => {
  dir = makeTmpDir('collapsed-fast');
  ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
  ds.ctx.db.prepare('INSERT INTO library_roots (id,path) VALUES (1,?)').run(dir);
});
afterEach(async () => {
  useWholeCollapseForTests(false);
  await ds.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** 伪随机但固定：同样的种子每次一样 */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/** 60 张图：入库时间、文件名（大小写混着）、体积都故意有并列；6 组组图，有的设了封面；一部分收藏、一部分全年龄 */
async function library() {
  const r = rng(7);
  const ins = ds.ctx.db.prepare(
    `INSERT INTO images (id,root_id,rel_path,file_name,width,height,bytes,format,sha256,added_at,modified_at,favorite,rating,tagged_at)
     VALUES (?,1,?,?,?,?,?,'png',?,?,?,?,?,'2026-01-01')`,
  );
  for (let id = 1; id <= 60; id++) {
    const name = `${['a', 'B', 'c', 'D'][Math.floor(r() * 4)]}_${Math.floor(r() * 20)}.png`;
    ins.run(
      id,
      `${id}/${name}`,
      name,
      r() < 0.5 ? 800 : 1200,
      1000,
      [100, 200, 200, 300][Math.floor(r() * 4)],
      'sha-' + id,
      `2026-01-${String(1 + Math.floor(r() * 10)).padStart(2, '0')}`,
      `2026-02-${String(1 + Math.floor(r() * 5)).padStart(2, '0')}`,
      r() < 0.4 ? 1 : 0,
      r() < 0.5 ? 'general' : 'sensitive',
    );
  }
  const groups = [
    [3, 17, 44],
    [5, 6],
    [9, 21, 33, 48, 59],
    [12, 13, 14],
    [25, 40],
    [51, 52, 53, 54],
  ];
  for (const [k, ids] of groups.entries()) {
    const g = await ds.createCollection({ imageIds: ids.map(String), title: '组' + k, kind: 'group' });
    if (k % 2 === 0) await ds.updateCollection(g.collection.id, { coverImageId: String(ids.at(-1)) });
  }
}

/** 从头翻到尾，每页记下这一页的 id、组信息和计数 */
async function walk(q: ListImagesQuery, limit: number) {
  const pages = [];
  let cursor: string | undefined;
  do {
    const page = await ds.listImages({ ...q, limit, cursor });
    pages.push({
      items: page.items.map((i) => [i.id, i.collectionGroup ? [i.collectionGroup.id, i.collectionGroup.count, i.collectionGroup.total, i.collectionGroup.memberIds.join(','), i.collectionGroup.allFavorite] : null]),
      total: page.total,
      displayTotal: page.displayTotal,
    });
    cursor = page.nextCursor ?? undefined;
  } while (cursor && pages.length < 200);
  return pages;
}

describe('收拢的快速路径', () => {
  it('每种排序、方向、筛选、页大小下，和整体分组的写法逐页一样', async () => {
    await library();
    const filters: ListImagesQuery[] = [{}, { favorite: true }, { rating: ['general'] }, { orientation: 'landscape' }, { includeWholeCollections: true, favorite: true }];
    let checked = 0;
    for (const sort of ['addedAt', 'modifiedAt', 'fileName', 'bytes'] as const)
      for (const order of ['asc', 'desc'] as const)
        for (const f of filters)
          for (const limit of [1, 4, 7, 100]) {
            const q: ListImagesQuery = { ...f, sort, order, collapseCollections: true };
            useWholeCollapseForTests(true);
            const want = await walk(q, limit);
            useWholeCollapseForTests(false);
            const got = await walk(q, limit);
            expect(got, JSON.stringify({ sort, order, f, limit })).toEqual(want);
            checked++;
          }
    expect(checked).toBe(4 * 2 * 5 * 4);
  });

  it('收拢后的总张数和格数：组图成员算进 total，一组只算一格', async () => {
    await library();
    const page = await ds.listImages({ collapseCollections: true, limit: 5 });
    expect(page.total).toBe(60);
    // 6 组共 19 张，收拢后变成 6 格
    expect(page.displayTotal).toBe(60 - 19 + 6);
  });
});
