import { BROWSE_THEMES, CUSTOM_THEME_LIMITS, THUMB_WIDTHS, UNRECOGNIZED_ANNEX_KINDS, UNRECOGNIZED_AREAS, UNRECOGNIZED_BUCKETS, UNRECOGNIZED_THEMES, type ThumbWidth } from '@emaki/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import type { DataSource, FileResponse } from '../datasource/DataSource.ts';
import { NotFoundError } from '../http/errors.ts';
import { idParam, kindSchema, parse, qBool, qKinds, qList, qNumber, ratingSchema } from '../http/validate.ts';

const tagList = qList(z.string().min(1).max(100)).refine((a) => a.length <= CUSTOM_THEME_LIMITS.tags, '标签太多');

/** 图片、未识别、重复、排除 */
export function imageRoutes(app: FastifyInstance, ds: DataSource): void {
  app.get('/api/images', (req) => {
    const q = parse(
      z.object({
        characterId: z.string().optional(),
        workId: z.string().optional(),
        status: z.enum(['recognized', 'unrecognized', 'excluded']).optional(),
        rating: qList(ratingSchema).optional(),
        q: z.string().optional(),
        orientation: z.enum(['portrait', 'landscape', 'square']).optional(),
        theme: z.enum(BROWSE_THEMES).optional(),
        tags: tagList.optional(),
        tagsAll: tagList.optional(),
        tagsNone: tagList.optional(),
        favorite: qBool.optional(),
        original: qBool.optional(),
        kind: qKinds.optional(),
        rated: qBool.optional(),
        seed: qNumber.min(0).max(1073741823).optional(),
        sort: z.enum(['addedAt', 'modifiedAt', 'fileName', 'bytes', 'random', 'page']).optional(),
        collectionId: z.string().min(1).optional(),
        artist: z.string().min(1).max(200).optional(),
        order: z.enum(['asc', 'desc']).optional(),
        cursor: z.string().optional(),
        limit: qNumber.min(1).max(200).optional(),
      }),
      req.query,
    );
    return ds.listImages(q);
  });

  app.post('/api/images/bulk', (req) => {
    const body = parse(
      z.object({
        ids: z.array(z.string()).min(1).max(5000),
        action: z.discriminatedUnion('type', [
          z.object({ type: z.literal('assign'), characterId: z.string() }),
          z.object({ type: z.literal('unassign'), characterId: z.string() }),
          z.object({ type: z.literal('exclude') }),
          z.object({ type: z.literal('restore') }),
          z.object({ type: z.literal('favorite'), value: z.boolean() }),
          z.object({ type: z.literal('shelve'), value: z.boolean() }),
          z.object({ type: z.literal('original'), value: z.boolean() }),
          z.object({ type: z.literal('rating'), value: ratingSchema }),
          z.object({ type: z.literal('kind'), value: z.union([kindSchema, z.literal('auto')]) }),
          z.object({ type: z.literal('trash') }),
          z.object({
            type: z.literal('artist'),
            mode: z.enum(['add', 'remove', 'set']),
            artists: z.array(z.string().trim().min(1).max(200)).max(10),
          }),
          z.object({ type: z.literal('artist-auto') }),
        ]),
      }),
      req.body,
    );
    return ds.bulkImages(body);
  });

  app.post('/api/images/move', (req) => {
    const body = parse(
      z
        .object({
          ids: z.array(z.string()).min(1).max(5000).optional(),
          characterId: z.string().optional(),
          rootId: z.string().min(1),
          dir: z.string().max(400),
        })
        .refine((b) => (b.ids === undefined) !== (b.characterId === undefined), '要么给 ids，要么给 characterId'),
      req.body,
    );
    return ds.moveImages(body);
  });

  app.get('/api/images/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const img = await ds.getImage(id);
    if (!img) throw new NotFoundError('图片');
    return img;
  });

  app.patch('/api/images/:id', (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        characterIds: z.array(z.string()).optional(),
        rating: ratingSchema.optional(),
        favorite: z.boolean().optional(),
        kind: z.union([kindSchema, z.literal('auto')]).optional(),
      }),
      req.body,
    );
    return ds.updateImage(id, body);
  });

  app.get('/api/images/:id/thumb', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { w } = parse(z.object({ w: qNumber.optional() }), req.query);
    const width = nearestThumbWidth(w ?? 480);
    const file = await ds.getThumbnail(id, width);
    if (!file) throw new NotFoundError('缩略图');
    // 缩略图按 id 永久缓存；图片内容变了会换 id（见 ARCHITECTURE.md「缩略图」）
    return sendFile(req, reply, file, 'public, max-age=31536000, immutable');
  });

  app.get('/api/images/:id/file', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const file = await ds.getOriginal(id);
    if (!file) throw new NotFoundError('图片文件');
    return sendFile(req, reply, file, 'private, max-age=3600');
  });

  app.post('/api/images/:id/reveal', async (req) => {
    const { id } = parse(idParam, req.params);
    await ds.revealImage(id);
    return { ok: true };
  });

  // ---------------------------------------------------------- 未识别

  app.get('/api/unrecognized', (req) => {
    const q = parse(
      z.object({
        cursor: z.string().optional(),
        limit: qNumber.min(1).max(200).optional(),
        area: z.enum(UNRECOGNIZED_AREAS).optional(),
        bucket: z.enum(UNRECOGNIZED_BUCKETS).optional(),
        theme: z.enum(UNRECOGNIZED_THEMES).optional(),
        kind: z.enum(UNRECOGNIZED_ANNEX_KINDS).optional(),
      }),
      req.query,
    );
    return ds.listUnrecognized(q);
  });

  app.get('/api/unrecognized/summary', () => ds.unrecognizedSummary());

  app.post('/api/unrecognized/retag', () => ds.retagUnrecognized());

  app.post('/api/unrecognized/:id/accept', (req) => {
    const { id } = parse(idParam, req.params);
    const { danbooruTag } = parse(z.object({ danbooruTag: z.string().min(1) }), req.body);
    return ds.acceptSuggestion(id, danbooruTag);
  });

  // ---------------------------------------------------------- 重复

  // 重复组一次返回全部（真实库 5000 多组、约 6 MB）：数据源缓存命中时返回同一个对象，序列化结果也跟着复用（T22）
  const serialized = new WeakMap<object, string>();
  app.get('/api/duplicates', async (req, reply) => {
    const q = parse(z.object({ resolved: qBool.optional() }), req.query);
    const groups = await ds.listDuplicates(q);
    let body = serialized.get(groups);
    if (body === undefined) {
      body = JSON.stringify(groups);
      serialized.set(groups, body);
    }
    return reply.type('application/json; charset=utf-8').send(body);
  });

  app.post('/api/duplicates/:id/resolve', (req) => {
    const { id } = parse(idParam, req.params);
    const { keepIds } = parse(z.object({ keepIds: z.array(z.string()).min(1) }), req.body);
    return ds.resolveDuplicate(id, keepIds);
  });

  app.post('/api/duplicates/:id/ignore', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.ignoreDuplicate(id);
  });

  // ---------------------------------------------------------- 排除

  app.get('/api/exclusions', () => ds.listExclusions());

  app.post('/api/exclusions', (req) => {
    const body = parse(
      z.object({ kind: z.enum(['image', 'folder', 'tag', 'character']), target: z.string().min(1) }),
      req.body,
    );
    return ds.createExclusion(body);
  });

  app.delete('/api/exclusions/:id', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.deleteExclusion(id);
  });
}

function nearestThumbWidth(w: number): ThumbWidth {
  return THUMB_WIDTHS.find((t) => t >= w) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1]!;
}

/** 数据源可以给 etag（sqlite：内容 sha）和自己的缓存策略；mock 不带 etag，走默认的 immutable */
function sendFile(req: FastifyRequest, reply: FastifyReply, file: FileResponse, defaultCache: string) {
  reply.header('Cache-Control', file.cacheControl ?? defaultCache);
  if (file.etag) {
    reply.header('ETag', file.etag);
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === file.etag)) return reply.code(304).send();
  }
  reply.type(file.contentType);
  return file.kind === 'buffer' ? reply.send(file.body) : reply.send(createReadStream(file.filePath));
}
