/**
 * 旧 HTTP 地址的兼容层（docs/core-architecture.md 第 4.1 节，附录 #33）：一个地址对好几个命令的，在这里把参数转成命令。
 * 网页和旧调用者照常能用；新代码直接用命令（POST /api/commands/:name）。以后可以删的都列在 COMPAT_ROUTES 里。
 *
 * 请求体的 schema 由命令的 schema 拼出来（不另抄一份）：例如批量操作的 favorite 动作，value 就是 curation.setFavorite 的 value。
 */
import type { BulkCollectionsBody, BulkImagesBody, UpdateImageBody } from '@emaki/shared';
import {
  ImageIds,
  LinkCollectionsInput,
  SetArtistsInput,
  SetCollectionKindInput,
  SetFavoriteInput,
  SetKindInput,
  SetOriginalInput,
  SetRatingInput,
  SetShelvedInput,
  SourceEdit,
  CollectionIds,
} from '@emaki/shared/schemas';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Call, Registry } from '../commands/registry.ts';
import { currentActor } from '../propagation/actor.ts';
import { callOf, sendCommand } from './routes.ts';
import { parse } from './validate.ts';

/** 批量操作的每个动作 → 命令（动作的参数取自命令的 schema） */
export const BULK_IMAGE_ACTIONS = {
  assign: { command: 'curation.link', params: z.object({ characterId: z.string() }) },
  assignTag: { command: 'curation.link', params: z.object({ danbooruTag: z.string().trim().min(1).max(200) }) },
  unassign: { command: 'curation.unlink', params: z.object({ characterId: z.string() }) },
  exclude: { command: 'visibility.excludeImages', params: z.object({}) },
  restore: { command: 'visibility.restoreImages', params: z.object({}) },
  favorite: { command: 'curation.setFavorite', params: SetFavoriteInput.pick({ value: true }) },
  shelve: { command: 'curation.setShelved', params: SetShelvedInput.pick({ value: true }) },
  original: { command: 'curation.setOriginal', params: SetOriginalInput.pick({ value: true }) },
  rating: { command: 'curation.setRating', params: SetRatingInput.pick({ value: true }) },
  kind: { command: 'curation.setKind', params: SetKindInput.pick({ value: true }) },
  trash: { command: 'library.trash', params: z.object({}) },
  artist: { command: 'curation.setArtists', params: SetArtistsInput.pick({ mode: true, artists: true }) },
  'artist-auto': { command: 'curation.resetArtists', params: z.object({}) },
} as const;
type BulkAction = keyof typeof BULK_IMAGE_ACTIONS;

const bulkActionSchema = z.discriminatedUnion(
  'type',
  Object.entries(BULK_IMAGE_ACTIONS).map(([type, a]) => a.params.extend({ type: z.literal(type) })) as unknown as [
    z.ZodObject<{ type: z.ZodLiteral<BulkAction> }>,
    ...z.ZodObject<{ type: z.ZodLiteral<BulkAction> }>[],
  ],
);
export const BulkImagesSchema = z.object({ ids: ImageIds, action: bulkActionSchema });

/** POST /api/images/bulk → 一个命令 */
export function bulkImagesCall(body: BulkImagesBody): Call {
  const { ids, action: a } = body;
  const command = BULK_IMAGE_ACTIONS[a.type].command;
  switch (a.type) {
    case 'assign':
      return { name: command, input: { ids, characterId: a.characterId } };
    case 'assignTag':
      return { name: command, input: { ids, tags: [a.danbooruTag] } };
    case 'unassign':
      return { name: command, input: { ids, characterId: a.characterId } };
    case 'favorite':
    case 'shelve':
    case 'original':
    case 'rating':
    case 'kind':
      return { name: command, input: { ids, value: a.value } };
    case 'artist':
      return { name: command, input: { ids, mode: a.mode, artists: a.artists } };
    default:
      return { name: command, input: { ids } };
  }
}

export const UpdateImageSchema = z.object({
  source: SourceEdit.optional(),
  characterIds: z.array(z.string()).optional(),
  rating: SetRatingInput.shape.value.optional(),
  favorite: z.boolean().optional(),
  kind: SetKindInput.shape.value.optional(),
});

/**
 * PATCH /api/images/:id → 几个命令合成一次操作（一个令牌撤销全部）。
 * 顺序决定提示文案（后面的优先）：来源 < 类型 < 角色 < 分级 < 收藏，和以前一样
 */
export function updateImageCalls(id: string, body: UpdateImageBody): Call[] {
  const ids = [id];
  const calls: Call[] = [];
  if (body.source !== undefined) calls.push({ name: 'curation.setSource', input: { id, source: body.source } });
  if (body.kind !== undefined) calls.push({ name: 'curation.setKind', input: { ids, value: body.kind } });
  if (body.characterIds) calls.push({ name: 'curation.replace', input: { id, characterIds: body.characterIds } });
  if (body.rating) calls.push({ name: 'curation.setRating', input: { ids, value: body.rating } });
  if (body.favorite !== undefined) calls.push({ name: 'curation.setFavorite', input: { ids, value: body.favorite } });
  return calls;
}

export const AcceptSchema = z.union([
  z.object({ danbooruTag: z.string().min(1) }),
  z.object({ danbooruTags: z.array(z.string().min(1)).min(1).max(20) }),
]);

/** POST /api/unrecognized/:id/accept → curation.link（采纳建议） */
export function acceptCall(id: string, body: z.infer<typeof AcceptSchema>): Call {
  return {
    name: 'curation.link',
    input: { ids: [id], tags: 'danbooruTags' in body ? body.danbooruTags : [body.danbooruTag], accept: true },
  };
}

export const BulkCollectionsSchema = z.object({
  ids: CollectionIds,
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('review') }),
    z.object({ type: z.literal('addCharacter'), characterId: z.string() }),
    z.object({ type: z.literal('addCharacterTag'), danbooruTag: LinkCollectionsInput.shape.tag.unwrap() }),
    z.object({ type: z.literal('addWork'), workId: z.string() }),
    z.object({ type: z.literal('kind'), value: SetCollectionKindInput.shape.value }),
  ]),
});

/** POST /api/collections/bulk → 一个命令 */
export function bulkCollectionsCall(body: BulkCollectionsBody): Call {
  const { ids, action: a } = body;
  switch (a.type) {
    case 'review':
      return { name: 'collections.review', input: { ids } };
    case 'kind':
      return { name: 'collections.setKind', input: { ids, value: a.value } };
    case 'addCharacter':
      return { name: 'collections.link', input: { ids, characterId: a.characterId } };
    case 'addCharacterTag':
      return { name: 'collections.link', input: { ids, tag: a.danbooruTag } };
    case 'addWork':
      return { name: 'collections.link', input: { ids, workId: a.workId } };
  }
}

/** 兼容层的地址（GET /api/commands 不列它们；以后可以删，见报告和 ARCHITECTURE.md） */
export const COMPAT_ROUTES: { method: string; path: string; commands: string[] }[] = [
  {
    method: 'PATCH',
    path: '/api/images/:id',
    commands: ['curation.setSource', 'curation.setKind', 'curation.replace', 'curation.setRating', 'curation.setFavorite'],
  },
  { method: 'POST', path: '/api/images/bulk', commands: [...new Set(Object.values(BULK_IMAGE_ACTIONS).map((a) => a.command))] },
  { method: 'POST', path: '/api/unrecognized/:id/accept', commands: ['curation.link'] },
  { method: 'POST', path: '/api/collections/bulk', commands: ['collections.review', 'collections.setKind', 'collections.link'] },
];

export function compatRoutes(app: FastifyInstance, registry: Registry): void {
  const run = async (reply: Parameters<typeof sendCommand>[0], calls: Call[], opts: ReturnType<typeof callOf>) => {
    const result = await registry.batch(calls, { ...opts, actor: currentActor() });
    return sendCommand(reply, registry.meta(result), result);
  };
  app.patch('/api/images/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    return run(reply, updateImageCalls(id, parse(UpdateImageSchema, req.body) as UpdateImageBody), callOf(req));
  });
  app.post('/api/images/bulk', (req, reply) =>
    run(reply, [bulkImagesCall(parse(BulkImagesSchema, req.body) as BulkImagesBody)], callOf(req)),
  );
  app.post('/api/unrecognized/:id/accept', (req, reply) => {
    const { id } = req.params as { id: string };
    return run(reply, [acceptCall(id, parse(AcceptSchema, req.body))], callOf(req));
  });
  app.post('/api/collections/bulk', (req, reply) =>
    run(reply, [bulkCollectionsCall(parse(BulkCollectionsSchema, req.body) as BulkCollectionsBody)], callOf(req)),
  );
}
