/**
 * T19 / T24 第 7 步（sqlite 专属）：所有可撤销操作「执行 → 撤销 → 状态相同」。
 * 从契约夹具出发（见 fixtures/contract-db.ts），每个用例新建环境；dumpCore 按主键导出核心表，撤销后必须逐行一致。
 * 不可撤销的操作不在这里：移到回收站（bulk trash、resolveDuplicate 真删图）、addLibraryRoot、updateSettings、markCharacterSeen。
 */
import type { MutationResult } from '@emaki/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDataSource } from '../src/datasource/sqlite/SqliteDataSource.ts';
import { sqliteFactory, type ContractEnv, type Kind } from './contract/harness.ts';
import { dumpCore } from './helpers/dump.ts';

let env: ContractEnv;
let ds: SqliteDataSource;
beforeEach(async () => {
  env = await sqliteFactory();
  ds = env.ds as SqliteDataSource;
});
afterEach(() => env.close());

const id = (kind: Kind, mockId: string) => env.id(kind, mockId);
const img = (...xs: string[]) => xs.map((x) => id('image', x));

interface Op {
  name: string;
  /** 在拍快照之前做的准备（例如先建一个合集再改它） */
  setup?: () => Promise<unknown>;
  run: () => Promise<MutationResult>;
}

/** 建一个「角色」文件夹的画集（i1 所在文件夹），返回合集 id */
const makeCollection = async () => (await ds.createCollection({ fromImageId: id('image', 'i1'), kind: 'artbook' })).collection.id;
let collectionId = '';
const withCollection = async () => {
  collectionId = await makeCollection();
};

const OPS: Op[] = [
  // ---------------------------------------------------------------- 图片（T05 / T27）
  { name: 'updateImage 收藏', run: () => ds.updateImage(id('image', 'i2'), { favorite: true }) },
  { name: 'updateImage 分级', run: () => ds.updateImage(id('image', 'i2'), { rating: 'explicit' }) },
  { name: 'updateImage 改角色', run: () => ds.updateImage(id('image', 'i7'), { characterIds: [id('character', 'c3'), id('character', 'c1')] }) },
  { name: 'updateImage 清空角色', run: () => ds.updateImage(id('image', 'i8'), { characterIds: [] }) },
  { name: 'updateImage 改类型', run: () => ds.updateImage(id('image', 'i24'), { kind: 'screenshot' }) },
  {
    name: 'updateImage 恢复自动类型',
    setup: () => ds.updateImage(id('image', 'i33'), { kind: 'photo' }),
    run: () => ds.updateImage(id('image', 'i33'), { kind: 'auto' }),
  },

  // ---------------------------------------------------------------- 批量（T18 / T27）
  { name: 'bulk 归到角色（含已归入的图）', run: () => ds.bulkImages({ ids: img('i1', 'i24', 'i26'), action: { type: 'assign', characterId: id('character', 'c1') } }) },
  { name: 'bulk 从角色移除', run: () => ds.bulkImages({ ids: img('i1', 'i7', 'i9'), action: { type: 'unassign', characterId: id('character', 'c1') } }) },
  { name: 'bulk 排除（含已排除的图）', run: () => ds.bulkImages({ ids: img('i1', 'i2', 'i31'), action: { type: 'exclude' } }) },
  { name: 'bulk 恢复（文件夹 / 标签规则排除的图）', run: () => ds.bulkImages({ ids: img('i31', 'i33'), action: { type: 'restore' } }) },
  {
    name: 'bulk 恢复（单图规则排除的图）',
    setup: () => ds.bulkImages({ ids: img('i2', 'i3'), action: { type: 'exclude' } }),
    run: () => ds.bulkImages({ ids: img('i2', 'i3'), action: { type: 'restore' } }),
  },
  { name: 'bulk 收藏', run: () => ds.bulkImages({ ids: img('i1', 'i2', 'i3'), action: { type: 'favorite', value: true } }) },
  { name: 'bulk 加画师', run: () => ds.bulkImages({ ids: img('i1', 'i2'), action: { type: 'artist', mode: 'add', artists: ['kantoku'] } }) },
  {
    name: 'bulk 换画师',
    setup: () => ds.bulkImages({ ids: img('i1'), action: { type: 'artist', mode: 'add', artists: ['kantoku', 'mignon'] } }),
    run: () => ds.bulkImages({ ids: img('i1', 'i2'), action: { type: 'artist', mode: 'set', artists: ['ふーみ'] } }),
  },
  {
    name: 'bulk 去掉画师',
    setup: () => ds.bulkImages({ ids: img('i1', 'i2'), action: { type: 'artist', mode: 'add', artists: ['kantoku', 'mignon'] } }),
    run: () => ds.bulkImages({ ids: img('i1', 'i2'), action: { type: 'artist', mode: 'remove', artists: ['kantoku'] } }),
  },
  {
    name: '合并画师',
    setup: () => ds.bulkImages({ ids: img('i1', 'i2'), action: { type: 'artist', mode: 'add', artists: ['kantoku', 'mignon'] } }),
    run: () => ds.updateArtistLinks({ tags: ['mignon'], mode: 'merge', into: 'kantoku' }),
  },
  {
    name: '拆开画师',
    setup: async () => {
      await ds.bulkImages({ ids: img('i1'), action: { type: 'artist', mode: 'add', artists: ['kantoku', 'mignon'] } });
      await ds.updateArtistLinks({ tags: ['mignon'], mode: 'merge', into: 'kantoku' });
    },
    run: () => ds.updateArtistLinks({ tags: ['mignon'], mode: 'split' }),
  },
  {
    name: 'bulk 画师改回自动',
    setup: () => ds.bulkImages({ ids: img('i1'), action: { type: 'artist', mode: 'add', artists: ['kantoku'] } }),
    run: () => ds.bulkImages({ ids: img('i1', 'i2'), action: { type: 'artist-auto' } }),
  },
  { name: 'bulk 取消收藏', run: () => ds.bulkImages({ ids: img('i1'), action: { type: 'favorite', value: false } }) },
  { name: 'bulk 放下', run: () => ds.bulkImages({ ids: img('i26', 'i28'), action: { type: 'shelve', value: true } }) },
  { name: 'bulk 归为原创', run: () => ds.bulkImages({ ids: img('i26', 'i28'), action: { type: 'original', value: true } }) },
  {
    name: 'bulk 放回未识别',
    setup: () => ds.bulkImages({ ids: img('i26'), action: { type: 'shelve', value: true } }),
    run: () => ds.bulkImages({ ids: img('i26'), action: { type: 'shelve', value: false } }),
  },
  { name: 'bulk 分级', run: () => ds.bulkImages({ ids: img('i1', 'i6'), action: { type: 'rating', value: 'questionable' } }) },
  { name: 'bulk 改类型', run: () => ds.bulkImages({ ids: img('i1', 'i24', 'i30'), action: { type: 'kind', value: 'meme' } }) },
  {
    name: 'bulk 恢复自动类型',
    setup: () => ds.bulkImages({ ids: img('i2', 'i33'), action: { type: 'kind', value: 'text' } }),
    run: () => ds.bulkImages({ ids: img('i2', 'i33'), action: { type: 'kind', value: 'auto' } }),
  },

  // ---------------------------------------------------------------- 未识别（T15）
  { name: '采纳建议（已有角色）', run: () => ds.acceptSuggestion(id('image', 'i26'), 'yuuka_(blue_archive)') },
  { name: '采纳建议（新建角色）', run: () => ds.acceptSuggestion(id('image', 'i27'), 'test_girl_(emaki_test)') },
  { name: '采纳建议（新建角色并新建作品）', run: () => ds.acceptSuggestion(id('image', 'i30'), 'power_(chainsaw_man)') },

  // ---------------------------------------------------------------- 重复（T16）
  { name: '处理重复组（全部保留，不进回收站）', run: () => ds.resolveDuplicate(id('duplicate', 'd1'), img('i15', 'i37')) },
  { name: '标记不是重复', run: () => ds.ignoreDuplicate(id('duplicate', 'd1')) },

  // ---------------------------------------------------------------- 排除（T17）
  { name: '新建排除：文件夹', run: () => ds.createExclusion({ kind: 'folder', target: 'D:/Pics/角色' }) },
  { name: '新建排除：标签', run: () => ds.createExclusion({ kind: 'tag', target: 'thighhighs' }) },
  { name: '新建排除：角色', run: () => ds.createExclusion({ kind: 'character', target: id('character', 'c2') }) },
  { name: '新建排除：单图', run: () => ds.createExclusion({ kind: 'image', target: id('image', 'i9') }) },
  { name: '删除排除规则：文件夹', run: () => ds.deleteExclusion(id('exclusion', 'x1')) },
  { name: '删除排除规则：标签', run: () => ds.deleteExclusion(id('exclusion', 'x2')) },

  // ---------------------------------------------------------------- 图库文件夹（T02）
  { name: '启用文件夹', run: () => ds.updateLibraryRoot(id('root', 'root2'), { enabled: true }) },
  { name: '停用文件夹', run: () => ds.updateLibraryRoot(id('root', 'root1'), { enabled: false }) },
  { name: '改成按漫画导入', run: () => ds.updateLibraryRoot(id('root', 'root1'), { mode: 'comic', comicRating: 'sensitive' }) },
  {
    name: '改回按插画识别',
    setup: () => ds.updateLibraryRoot(id('root', 'root1'), { mode: 'comic' }),
    run: () => ds.updateLibraryRoot(id('root', 'root1'), { mode: 'auto' }),
  },
  { name: '移除文件夹', run: () => ds.removeLibraryRoot(id('root', 'root1')) },

  // ---------------------------------------------------------------- 角色（T14，characters.test.ts 另有更细的用例）
  { name: '新建自建角色', run: () => ds.createCharacter({ name: '雪之下', workIds: [id('work', 'w3')], aliases: ['yukino'] }) },
  {
    name: '修改角色',
    run: () => ds.updateCharacter(id('character', 'c2'), { name: '新名字', aliases: ['x'], pinned: true, coverImageId: id('image', 'i9'), coverFocus: { x: 0.2, y: 0.8 } }),
  },
  { name: '合并角色', run: () => ds.mergeCharacter(id('character', 'c5'), id('character', 'c4')) },

  // ---------------------------------------------------------------- 合集（T38）
  { name: '新建合集', run: () => ds.createCollection({ fromImageId: id('image', 'i24'), kind: 'doujin' }) },
  {
    name: '重新成册（之前不成册过）',
    setup: async () => ds.deleteCollection(await makeCollection()),
    run: () => ds.createCollection({ fromImageId: id('image', 'i1'), kind: 'doujin' }),
  },
  { name: '合集改名', setup: withCollection, run: () => ds.updateCollection(collectionId, { title: '测试本' }) },
  { name: '合集改类型', setup: withCollection, run: () => ds.updateCollection(collectionId, { kind: 'doujin' }) },
  { name: '合集改页序', setup: withCollection, run: () => ds.updateCollection(collectionId, { pageOrder: 'mtime' }) },
  { name: '合集系列与已整理', setup: withCollection, run: () => ds.updateCollection(collectionId, { seriesKey: 'S', volumeNo: 2, reviewed: true }) },
  {
    name: '合集手动角色与作品',
    setup: withCollection,
    run: () => ds.updateCollection(collectionId, { manualCharacterIds: [id('character', 'c7')], manualWorkIds: [id('work', 'w3')] }),
  },
  { name: '合集封面', setup: withCollection, run: () => ds.updateCollection(collectionId, { coverImageId: id('image', 'i3') }) },
  { name: '不成册', setup: withCollection, run: () => ds.deleteCollection(collectionId) },
  { name: '批量标为已整理', setup: withCollection, run: () => ds.bulkCollections({ ids: [collectionId], action: { type: 'review' } }) },
  { name: '批量改类型', setup: withCollection, run: () => ds.bulkCollections({ ids: [collectionId], action: { type: 'kind', value: 'doujin' } }) },
  {
    name: '批量关联角色',
    setup: withCollection,
    run: () => ds.bulkCollections({ ids: [collectionId], action: { type: 'addCharacter', characterId: id('character', 'c7') } }),
  },
  { name: '批量关联作品', setup: withCollection, run: () => ds.bulkCollections({ ids: [collectionId], action: { type: 'addWork', workId: id('work', 'w2') } }) },
];

describe('执行 → 撤销 → dumpCore 完全一致', () => {
  it.each(OPS.map((op) => [op.name, op] as const))('%s', async (_name, op) => {
    await op.setup?.();
    const before = dumpCore(ds.ctx.db);
    const r = await op.run();
    expect(r.undoToken).toBeTruthy();
    expect(dumpCore(ds.ctx.db)).not.toEqual(before);
    await ds.undo(r.undoToken!);
    expect(dumpCore(ds.ctx.db)).toEqual(before);
  });
});

describe('连续多步：按相反顺序撤销，回到最初', () => {
  it('收藏 → 归类 → 排除 → 改类型，逆序撤销', async () => {
    const before = dumpCore(ds.ctx.db);
    const tokens: string[] = [];
    const push = (r: MutationResult) => tokens.push(r.undoToken!);
    push(await ds.updateImage(id('image', 'i24'), { favorite: true }));
    push(await ds.bulkImages({ ids: img('i24', 'i26'), action: { type: 'assign', characterId: id('character', 'c2') } }));
    push(await ds.bulkImages({ ids: img('i24'), action: { type: 'exclude' } }));
    push(await ds.bulkImages({ ids: img('i26'), action: { type: 'kind', value: 'comic' } }));
    for (const t of tokens.reverse()) await ds.undo(t);
    expect(dumpCore(ds.ctx.db)).toEqual(before);
  });
});

describe('同时改类型和其他字段', () => {
  // updateImage 带 kind 又带其他字段时，所有修改在同一次 mutate 里，一个 token 撤销全部
  it('一个 token 撤销全部修改', async () => {
    const before = dumpCore(ds.ctx.db);
    const r = await ds.updateImage(id('image', 'i2'), { kind: 'comic', favorite: true });
    await ds.undo(r.undoToken!);
    expect(dumpCore(ds.ctx.db)).toEqual(before);
  });
});
