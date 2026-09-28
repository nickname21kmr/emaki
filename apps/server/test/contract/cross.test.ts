/**
 * 交叉比对：mock 和 sqlite 跑同一组只读查询，把 id 换回 mock id 后应当完全相同。
 * 只比较两边都 ready 的接口；忽略有意差异的字段（见 README.md）。
 */
import { describe, expect, it } from 'vitest';
import type { DataSource } from '../../src/datasource/DataSource.ts';
import { canon, mockFactory, sqliteFactory, type ContractEnv } from './harness.ts';
import { SQLITE_READY } from './ready.ts';

// covers / coverColor：作品封面具体是哪几张、封面主色，两边的兜底选图本来就不同（有意差异，见 README）
const IGNORED = new Set(['newCount', 'coverImageId', 'coverRating', 'dominantColor', 'color', 'customMatchableCount', 'covers', 'coverColor']);

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (typeof v !== 'object' || v === null) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !IGNORED.has(k)).map(([k, x]) => [k, strip(x)]));
}

const QUERIES: { task: string; title: string; run: (ds: DataSource, e: ContractEnv) => Promise<unknown> }[] = [
  { task: 'T02', title: 'getSettings', run: (ds) => ds.getSettings() },
  { task: 'T13', title: 'getStats', run: (ds) => ds.getStats() },
  { task: 'T13', title: 'listWorks', run: (ds) => ds.listWorks({}) },
  { task: 'T13', title: 'listCharacters', run: (ds) => ds.listCharacters({ limit: 200 }) },
  { task: 'T13', title: 'topCharacters', run: (ds) => ds.topCharacters({ limit: 9 }) },
  { task: 'T13', title: 'getCharacter c1', run: (ds, e) => ds.getCharacter(e.id('character', 'c1')) },
  { task: 'T34a', title: 'unrecognizedSummary', run: (ds) => ds.unrecognizedSummary() },
];

describe('mock 与 sqlite 结果一致', () => {
  for (const q of QUERIES) {
    (SQLITE_READY.has(q.task) ? it : it.skip)(`${q.title}（${q.task}）`, async () => {
      const [m, s] = await Promise.all([mockFactory(), sqliteFactory()]);
      try {
        const a = strip(canon(m, await q.run(m.ds, m)));
        const b = strip(canon(s, await q.run(s.ds, s)));
        expect(b).toEqual(a);
      } finally {
        await m.close();
        await s.close();
      }
    });
  }
});
