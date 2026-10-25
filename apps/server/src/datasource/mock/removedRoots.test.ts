/**
 * mock 的移除图库文件夹：图留着，重新添加同一个路径时整理结果回来（sqlite 那边见 roots.test.ts，契约夹具的路径在本机不存在，所以单独测）。
 */
import { expect, it } from 'vitest';
import { mockFactory } from '../../../test/contract/harness.ts';

it('移除后重新添加同一个文件夹：同一个 id，角色和收藏都回来', async () => {
  const { ds } = await mockFactory();
  await ds.updateImage('i1', { characterIds: ['c4'], favorite: true });
  const before = (await ds.getSettings()).libraryRoots.find((r) => r.id === 'root1')!;
  const r = await ds.removeLibraryRoot('root1');
  expect(r.message).toBe('已移除文件夹：D:/Pics。磁盘上的文件没动，30 天内重新添加它能找回整理结果');
  expect(await ds.getImage('i1')).toBeNull();

  const added = await ds.addLibraryRoot({ path: 'D:/Pics' });
  expect(added.message).toMatch(/^已添加文件夹（找回了 \d+ 张图以前的整理结果），开始扫描：D:\/Pics$/);
  const after = (await ds.getSettings()).libraryRoots.find((x) => x.path === 'D:/Pics')!;
  expect(after).toMatchObject({ id: 'root1', imageCount: before.imageCount, importedAt: before.importedAt });
  expect(await ds.getImage('i1')).toMatchObject({ characterIds: ['c4'], favorite: true });
});
