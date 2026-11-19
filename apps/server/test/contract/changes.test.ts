/**
 * 移动预览、切换 Pixiv 识别方式、最近的改动。
 * 移动预览以前拿 mock 和 sqlite 互相对照，现在写成固定的期望值（推算见 test/fixtures/contract-db.ts）。
 */
import { describe, expect, it } from 'vitest';
import { canon, sqliteFactory, type ContractEnv } from './harness.ts';

const run = async <T>(fn: (env: ContractEnv) => Promise<T>): Promise<T> => {
  const env = await sqliteFactory();
  try {
    return await fn(env);
  } finally {
    await env.close();
  }
};

describe('移动预览', () => {
  it.each([
    // c1 计入的 8 张都在「角色/」下
    ['按角色，目标是它们现在的文件夹', { characterId: 'c1', dir: '角色' }, { ids: [], alreadyThere: 8, inCollection: 0, otherCharacters: 0 }],
    ['按角色，移到新文件夹', { characterId: 'c6', dir: '联动' }, { ids: ['i21', 'i22'], alreadyThere: 0, inCollection: 0, otherCharacters: 0 }],
    // i32 本来就在 memes/
    ['选中的图', { ids: ['i1', 'i21', 'i24', 'i32'], dir: 'memes' }, { ids: ['i1', 'i21', 'i24'], alreadyThere: 1, inCollection: 0, otherCharacters: 0 }],
  ])('%s', async (_t, q, expected) => {
    const got = await run(async (env) => {
      const body = {
        rootId: env.id('root', 'root1'),
        dir: q.dir,
        ...('characterId' in q ? { characterId: env.id('character', q.characterId!) } : { ids: q.ids!.map((i) => env.id('image', i)) }),
      };
      const p = await env.ds.previewMove(body);
      return { ...p, ids: p.ids.map((id) => env.back('image', id)).sort() };
    });
    expect(got).toEqual(expected);
  });

  it('联动角色的图都还属于别的角色时如实报出来', async () => {
    // c1 的 i7 还有 c2、i8 还有 c3
    const n = await run(async (env) =>
      canon(env, await env.ds.previewMove({ characterId: env.id('character', 'c1'), rootId: env.id('root', 'root1'), dir: '别处' })).otherCharacters,
    );
    expect(n).toBe(2);
  });
});

for (const [name, factory] of [['sqlite', sqliteFactory]] as const) {
  describe(`${name} 切换 Pixiv 识别方式、最近的改动`, () => {
    it('先数影响，切换报告张数、可撤销；切到同一个不动', async () => {
      const env = await factory();
      try {
        expect(await env.ds.previewSourceMode('broad')).toEqual({ mode: 'broad', changed: 0, suggestionsDropped: 0, requeued: 0, cached: 0 });
        const r = await env.ds.setSourceMode('broad');
        expect(r).toMatchObject({ ok: true, message: '已改为宽泛：0 张图的来源变了', undoToken: expect.any(String) });
        expect((await env.ds.getSettings()).tagger.pixivFilenameMode).toBe('broad');
        expect(await env.ds.setSourceMode('broad')).toMatchObject({ message: '已经是宽泛了', undoToken: null });
        await env.ds.undo(r.undoToken!);
        expect((await env.ds.getSettings()).tagger.pixivFilenameMode).toBe('strict');
      } finally {
        await env.close();
      }
    });

    it('没有自动改动时列表是空的；不认识的记录 404', async () => {
      const env = await factory();
      try {
        expect(await env.ds.listChanges('auto')).toEqual([]);
        expect(await env.ds.listChanges('move')).toEqual([]);
        await expect(env.ds.revertChange('999')).rejects.toThrow('找不到这条改动记录');
      } finally {
        await env.close();
      }
    });
  });
}
