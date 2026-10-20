/**
 * mock 的查重处理：和 sqlite 一样把副本上手动做的整理并到保留的图上（sqlite 那边见 DedupeService.test.ts）。
 * 契约测试跑不了 sqlite 的「真的移到回收站」，所以单独测。
 */
import { expect, it } from 'vitest';
import { mockFactory } from '../../../test/contract/harness.ts';

it('处理重复组：副本上的角色、收藏、原创、手动分级、手动画师、手动来源并到保留的图上；撤销后还原', async () => {
  const { ds } = await mockFactory();
  await ds.updateImage('i37', { characterIds: ['c4', 'c1'], favorite: true, rating: 'questionable' });
  await ds.bulkImages({ ids: ['i37'], action: { type: 'original', value: true } });
  await ds.bulkImages({ ids: ['i37'], action: { type: 'artist', mode: 'add', artists: ['kantoku'] } });
  await ds.updateImage('i37', { source: { url: 'https://www.pixiv.net/artworks/98785437', artist: 'Killy' } });
  const before = await ds.getImage('i15');
  expect(before!.sourceManual).toBe(false);

  const r = await ds.resolveDuplicate('d1', ['i15']);
  const kept = (await ds.getImage('i15'))!;
  expect([...kept.characterIds].sort()).toEqual(['c1', 'c4']);
  expect(kept).toMatchObject({ favorite: true, original: true, rating: 'questionable', artistsManual: true, sourceManual: true });
  expect(kept.source).toMatchObject({ site: 'pixiv', postId: '98785437', artist: 'Killy' });
  expect(kept.artists.map((a) => a.tag)).toEqual(['kantoku']);

  await ds.undo(r.undoToken!);
  expect(await ds.getImage('i15')).toEqual(before);
});

it('处理重复组：副本归为原创时，保留的图也挂到「原创」作品上；撤销后去掉', async () => {
  const { ds } = await mockFactory();
  await ds.bulkImages({ ids: ['i37'], action: { type: 'original', value: true } });
  const wid = (await ds.getStats()).originalWorkId!;
  const inOriginal = async () => (await ds.listImages({ workId: wid })).items.map((x) => x.id);
  expect(await inOriginal()).toEqual(['i37']);
  const before = await ds.getImage('i15');

  const r = await ds.resolveDuplicate('d1', ['i15']);
  expect((await ds.getImage('i15'))!.original).toBe(true);
  expect(await inOriginal()).toEqual(['i15']);

  await ds.undo(r.undoToken!);
  expect(await ds.getImage('i15')).toEqual(before);
  expect(await inOriginal()).toEqual(['i37']);
});
