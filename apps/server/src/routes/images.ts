import { THUMB_WIDTHS, type ThumbWidth } from '@emaki/shared';
import * as S from '@emaki/shared/schemas';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import type { DuplicateData, ExclusionData, FileResponse, ImageData, UnrecognizedData } from '../datasource/DataSource.ts';
import { NotFoundError } from '../http/errors.ts';
import { idParam, parse, qNumber } from '../http/validate.ts';

/** 图片、未识别、重复、排除 */
export function imageRoutes(app: FastifyInstance, ds: ImageData & UnrecognizedData & DuplicateData & ExclusionData): void {
  app.post('/api/images/import', (req) => ds.importImages(parse(S.importImagesBody, req.body)));
  app.post('/api/images/:id/replace', (req) => ds.replaceImage(parse(idParam, req.params).id, parse(S.replaceImageBody, req.body)));
  app.get('/api/images', (req) => ds.listImages(parse(S.listImagesQuery, req.query)));
  app.post('/api/images/bulk', (req) => ds.bulkImages(parse(S.bulkImagesBody, req.body)));

  // 按角色移动时前端先拿 preview 的 ids 再提交，服务端只移确认过的这些
  app.post('/api/images/move/preview', (req) => ds.previewMove(parse(S.movePreviewBody, req.body)));
  app.post('/api/images/move', (req) => ds.moveImages(parse(S.moveImagesBody, req.body)));

  app.get('/api/images/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const img = await ds.getImage(id);
    if (!img) throw new NotFoundError('图片');
    return img;
  });

  app.patch('/api/images/:id', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.updateImage(id, parse(S.updateImageBody, req.body));
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

  app.get('/api/unrecognized', (req) => ds.listUnrecognized(parse(S.listUnrecognizedQuery, req.query)));

  app.get('/api/unrecognized/summary', (req) => ds.unrecognizedSummary(parse(S.unrecognizedSummaryQuery, req.query)));

  app.post('/api/unrecognized/retag', () => ds.retagUnrecognized());

  app.post('/api/unrecognized/:id/accept', (req) => {
    const { id } = parse(idParam, req.params);
    // danbooruTags：同一张图一次采纳多条，一条撤销
    const body = parse(S.acceptSuggestionBody, req.body);
    return 'danbooruTags' in body ? ds.acceptSuggestions(id, body.danbooruTags) : ds.acceptSuggestion(id, body.danbooruTag);
  });

  // ---------------------------------------------------------- 重复

  // 重复组一次返回全部（真实库 5000 多组、约 6 MB）：数据源缓存命中时返回同一个对象，序列化结果也跟着复用（T22）
  const serialized = new WeakMap<object, string>();
  app.get('/api/duplicates', async (req, reply) => {
    const q = parse(S.listDuplicatesQuery, req.query);
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
    const { keepIds, batch } = parse(S.resolveDuplicateBody, req.body);
    return ds.resolveDuplicate(id, keepIds, batch);
  });

  app.post('/api/duplicates/:id/ignore', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.ignoreDuplicate(id);
  });

  // ---------------------------------------------------------- 排除

  app.get('/api/exclusions', () => ds.listExclusions());

  app.post('/api/exclusions', (req) => ds.createExclusion(parse(S.createExclusionBody, req.body)));

  app.delete('/api/exclusions/:id', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.deleteExclusion(id);
  });
}

function nearestThumbWidth(w: number): ThumbWidth {
  return THUMB_WIDTHS.find((t) => t >= w) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1]!;
}

/** 数据源可以给 etag（内容 sha）和自己的缓存策略；不给就走默认的缓存策略 */
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
