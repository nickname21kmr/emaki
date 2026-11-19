/**
 * 只读查询的整体结果，存成快照：id 换回夹具 id，去掉封面、主色这类按选图规则会变的字段。
 * 快照最早是 mock 和 sqlite 两边逐字段一致时的结果（mock 去掉前的交叉比对）。改了行为就看 diff 确认后更新快照。
 */
import { describe, expect, it } from 'vitest';
import type { DataSource } from '../../src/datasource/DataSource.ts';
import { canon, sqliteFactory, type ContractEnv } from './harness.ts';

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

describe('只读查询', () => {
  for (const q of QUERIES) {
    it(`${q.title}（${q.task}）`, async () => {
      const env = await sqliteFactory();
      try {
        expect(strip(canon(env, await q.run(env.ds, env)))).toMatchSnapshot();
      } finally {
        await env.close();
      }
    });
  }
});
