import { afterEach, beforeEach, expect, it } from 'vitest';
import { sqliteFactory, type ContractEnv } from '../../../test/contract/harness.ts';

let env: ContractEnv;
beforeEach(async () => {
  env = await sqliteFactory();
});
afterEach(() => env.close());

it('边翻页边采纳每页第一张：遍历到的图集合 = 初始未识别集合（键集分页不漏图）', async () => {
  const initial = new Set<string>();
  let c: string | undefined;
  do {
    const p = await env.ds.listUnrecognized({ limit: 2, cursor: c });
    p.items.forEach((x) => initial.add(x.image.id));
    c = p.nextCursor ?? undefined;
  } while (c);

  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.ds.listUnrecognized({ limit: 2, cursor });
    page.items.forEach((x) => seen.add(x.image.id));
    const first = page.items[0];
    if (first) await env.ds.acceptSuggestion(first.image.id, 'hina_(blue_archive)');
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual(initial);
});

/** 「没认出」按像插画的程度排：分数相同按 id 倒序；键集分页不重不漏（T34a） */
it('没认出：按 art_score 倒序、同分 id 倒序，翻页不重不漏', async () => {
  const db = (env.ds as unknown as { ctx: { db: import('better-sqlite3').Database } }).ctx.db;
  db.exec('DELETE FROM character_suggestions');
  const six = ['i24', 'i25', 'i26', 'i27', 'i28', 'i29'].map((x) => Number(env.id('image', x)));
  const scores = [10, 10, 5, 5, 5, 0];
  six.forEach((id, k) => db.prepare("UPDATE images SET theme = 'legs', rating = 'general', art_score = ? WHERE id = ?").run(scores[k], id));
  (env.ds as unknown as { ctx: { invalidate: (s: string) => void } }).ctx.invalidate('all');
  const got: { id: number; s: number }[] = [];
  let cursor: string | undefined;
  do {
    const p = await env.ds.listUnrecognized({ bucket: 'unsure', theme: 'legs', limit: 2, cursor });
    expect(p.total).toBe(6);
    for (const x of p.items) got.push({ id: Number(x.image.id), s: scores[six.indexOf(Number(x.image.id))]! });
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(got.map((g) => g.id))).toEqual(new Set(six));
  expect(got).toHaveLength(6);
  for (let k = 1; k < got.length; k++) {
    expect(got[k]!.s).toBeLessThanOrEqual(got[k - 1]!.s);
    if (got[k]!.s === got[k - 1]!.s) expect(got[k]!.id).toBeLessThan(got[k - 1]!.id);
  }
});

it('放下的：最近放下的在前，翻页不重不漏（T34a）', async () => {
  const ids = ['i24', 'i25', 'i26', 'i27', 'i28'].map((x) => env.id('image', x));
  for (const id of ids) await env.ds.bulkImages({ ids: [id], action: { type: 'shelve', value: true } });
  const got: string[] = [];
  let cursor: string | undefined;
  do {
    const p = await env.ds.listUnrecognized({ bucket: 'shelved', limit: 2, cursor });
    expect(p.total).toBe(5);
    got.push(...p.items.map((x) => x.image.id));
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(got)).toEqual(new Set(ids));
  expect(got).toHaveLength(5);
});
