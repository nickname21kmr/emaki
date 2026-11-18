/**
 * 编目、合集的命令（docs/core-architecture.md 第 2.4 节）。写入在编目模块（domain/catalog/）和合集模块里；
 * 同步的命令由命令层开事务和撤销记录（模块里的 ctx.mutate 并进来），整理到子文件夹这类动文件的自己管撤销（run）。
 */
import {
  ArtistLinksInput,
  CharacterVerificationInput,
  CollectionsInput,
  CreateCharacterInput,
  CreateCollectionInput,
  IdInput,
  LinkCollectionsInput,
  MergeCharacterInput,
  SetCollectionKindInput,
  UpdateCharacterInput,
  UpdateCollectionInput,
} from '@emaki/shared/schemas';
import { setArtistLinks } from '../domain/catalog/artists.ts';
import { artistLinksMessage, linkTags, planArtistLinks } from '../datasource/artistEdits.ts';
import { artistNames, linkGroups, tagNames } from '../datasource/sqlite/artists.ts';
import { iso } from '../datasource/sqlite/sql.ts';
import { BadRequestError } from '../http/errors.ts';
import { defineCommand } from './registry.ts';

export const catalogCommands = [
  defineCommand({
    name: 'catalog.createCharacter',
    summary: '新建角色（自建；给了 Danbooru 标签就绑上并按 Danbooru 补作品）。先查名字、别名和作品，避免重复；未核实的标签留空',
    input: CreateCharacterInput,
    scope: 'catalog',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/characters' }],
    tx: (e, input) => e.characters.create(input),
  }),
  defineCommand({
    name: 'catalog.updateCharacter',
    summary: '改角色：名字、别名、作品、Danbooru 标签（null 解绑）、封面、封面焦点、置顶',
    input: UpdateCharacterInput,
    scope: 'catalog',
    undoable: true,
    idempotent: true,
    http: [{ method: 'PATCH', path: '/api/characters/:id' }],
    tx: (e, { id, ...body }) => e.characters.update(id, body),
  }),
  defineCommand({
    name: 'catalog.mergeCharacter',
    summary: '把角色 id 合并进 targetId（关联、否决、别名都搬过去）',
    input: MergeCharacterInput,
    scope: 'catalog',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/characters/:id/merge' }],
    mcp: { destructive: true },
    tx: (e, input) => e.characters.merge(input.id, input.targetId),
  }),
  defineCommand({
    name: 'catalog.verifyCharacter',
    summary: '保存查证过的角色身份关系（identity：形态或同一人物指向 characterTag）或常用名（name），sources 是出处链接',
    input: CharacterVerificationInput,
    scope: 'catalog',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/characters/verification' }],
    tx: (e, input) => e.characters.verify(input, e.localizer),
  }),
  defineCommand({
    name: 'catalog.markSeen',
    summary: '进角色页时清掉「+N」新图角标',
    input: IdInput,
    scope: 'ui',
    undoable: false,
    barrier: false,
    idempotent: false,
    http: [{ method: 'POST', path: '/api/characters/:id/seen' }],
    run(e, input) {
      e.characters.markSeen(input.id);
      return { ok: true as const };
    },
  }),
  defineCommand({
    name: 'catalog.linkArtists',
    summary: '画师的自动合并猜错了时手动改：split 各自单独算一个人，merge 并到 into 所在的人，auto 去掉手动设置',
    input: ArtistLinksInput,
    scope: 'catalog',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/artists/links' }],
    tx(e, body, u) {
      const db = e.ctx.db;
      const into = body.mode === 'merge' ? body.into?.trim() : undefined;
      if (body.mode === 'merge' && !into) throw new BadRequestError('要合并到哪位画师？');
      const given = linkTags(body.tags, into);
      const { groups } = linkGroups(db, [...given, ...(into ? [into] : [])]);
      const tags = planArtistLinks(body.mode, given, into, groups);
      const names = body.mode === 'split' ? tagNames(db, tags) : artistNames(db, given);
      const intoName = into ? artistNames(db, [into])[0] : undefined;
      setArtistLinks(db, u, body.mode, tags, into ?? null, iso(e.ctx.clock()));
      return { message: artistLinksMessage(body.mode, names, intoName) };
    },
  }),

  // ---------------------------------------------------------------- 合集
  defineCommand({
    name: 'collections.create',
    summary: '建合集：fromImageId 把这张图所在的文件夹做成合集，imageIds 收录任意图片（kind 默认 group）；organizeFiles 同时整理到子文件夹',
    input: CreateCollectionInput,
    scope: 'collections',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/collections' }],
    run(e, body) {
      if (body.organizeFiles) e.requireLibraryFiles('整理到子文件夹');
      return e.collectionQueries.create(body);
    },
  }),
  defineCommand({
    name: 'collections.update',
    summary:
      '改合集：增删成员、改名（null 恢复自动名）、类型（auto 恢复自动）、封面、页序、系列、已整理、出场角色和作品；organizeFiles 整理到子文件夹',
    input: UpdateCollectionInput,
    scope: 'collections',
    undoable: true,
    idempotent: true,
    http: [{ method: 'PATCH', path: '/api/collections/:id' }],
    run(e, { id, ...body }) {
      if (body.organizeFiles) e.requireLibraryFiles('整理到子文件夹');
      return e.collectionQueries.update(id, body);
    },
  }),
  defineCommand({
    name: 'collections.dissolve',
    summary: '解散 / 不成册（图片都还在；文件夹书留一行 dismissed，自动判定不会再建）',
    input: IdInput,
    scope: 'collections',
    undoable: true,
    idempotent: true,
    http: [{ method: 'DELETE', path: '/api/collections/:id' }],
    tx: (e, input) => e.collectionQueries.dismiss(input.id),
  }),
  defineCommand({
    name: 'collections.review',
    summary: '把这些合集标为已整理',
    input: CollectionsInput,
    scope: 'collections',
    undoable: true,
    idempotent: true,
    tx: (e, input) => e.collectionQueries.bulk({ ids: input.ids, action: { type: 'review' } }),
  }),
  defineCommand({
    name: 'collections.setKind',
    summary: '改这些合集的类型（本子、画集、组图）',
    input: SetCollectionKindInput,
    scope: 'collections',
    undoable: true,
    idempotent: true,
    tx: (e, input) => e.collectionQueries.bulk({ ids: input.ids, action: { type: 'kind', value: input.value } }),
  }),
  defineCommand({
    name: 'collections.link',
    summary: '给这些合集加出场角色（characterId，或 tag 按建议建档）或作品（workId）。这是合集的事实，不改图上的角色',
    input: LinkCollectionsInput,
    scope: 'collections',
    undoable: true,
    idempotent: true,
    tx: (e, input) =>
      e.collectionQueries.bulk({
        ids: input.ids,
        action:
          input.characterId !== undefined
            ? { type: 'addCharacter', characterId: input.characterId }
            : input.tag !== undefined
              ? { type: 'addCharacterTag', danbooruTag: input.tag }
              : { type: 'addWork', workId: input.workId! },
      }),
  }),
];
