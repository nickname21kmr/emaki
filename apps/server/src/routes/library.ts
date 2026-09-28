import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DataSource } from '../datasource/DataSource.ts';
import { NotFoundError } from '../http/errors.ts';
import { idParam, parse, qBool, qNumber } from '../http/validate.ts';

/** 统计、作品、角色、搜索 */
export function libraryRoutes(app: FastifyInstance, ds: DataSource): void {
  app.get('/api/stats', () => ds.getStats());
  app.get('/api/content-kinds', () => ds.listContentKinds());

  // ---------------------------------------------------------- 作品

  app.get('/api/works', (req) => {
    const q = parse(z.object({ sort: z.enum(['imageCount', 'recent', 'name']).optional() }), req.query);
    return ds.listWorks(q);
  });

  app.get('/api/works/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const work = await ds.getWork(id);
    if (!work) throw new NotFoundError('作品');
    return work;
  });

  // ---------------------------------------------------------- 角色

  const workFilter = z.string().min(1).optional();

  app.get('/api/characters', (req) => {
    const q = parse(
      z.object({
        workId: workFilter,
        q: z.string().optional(),
        sort: z.enum(['imageCount', 'recent', 'name', 'newCount']).optional(),
        source: z.enum(['danbooru', 'custom']).optional(),
        includeOther: qBool.optional(),
        cursor: z.string().optional(),
        limit: qNumber.min(1).max(200).optional(),
      }),
      req.query,
    );
    return ds.listCharacters(q);
  });

  app.get('/api/characters/top', (req) => {
    const q = parse(z.object({ limit: qNumber.min(1).max(50).optional(), workId: workFilter }), req.query);
    return ds.topCharacters(q);
  });

  app.get('/api/characters/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const res = await ds.getCharacter(id);
    if (!res) throw new NotFoundError('角色');
    return res;
  });

  // 「换封面」候选（CB-7）
  app.get('/api/characters/:id/cover-candidates', (req) => {
    const { id } = parse(idParam, req.params);
    const { limit } = parse(z.object({ limit: qNumber.min(1).max(48).optional() }), req.query);
    return ds.listCoverCandidates(id, limit ?? 12);
  });

  app.post('/api/characters', (req) => {
    const body = parse(
      z.object({
        name: z.string().min(1).max(100),
        workIds: z.array(z.string()).default([]),
        aliases: z.array(z.string()).optional(),
        danbooruTag: z.string().nullable().optional(),
      }),
      req.body,
    );
    return ds.createCharacter(body);
  });

  app.patch('/api/characters/:id', (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        name: z.string().max(100).optional(),
        aliases: z.array(z.string()).optional(),
        danbooruTag: z.string().nullable().optional(),
        workIds: z.array(z.string()).optional(),
        coverImageId: z.string().nullable().optional(),
        coverFocus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable().optional(),
        pinned: z.boolean().optional(),
      }),
      req.body,
    );
    return ds.updateCharacter(id, body);
  });

  app.post('/api/characters/:id/seen', async (req) => {
    const { id } = parse(idParam, req.params);
    await ds.markCharacterSeen(id);
    return { ok: true };
  });

  app.post('/api/characters/:id/merge', (req) => {
    const { id } = parse(idParam, req.params);
    const { targetId } = parse(z.object({ targetId: z.string().min(1) }), req.body);
    return ds.mergeCharacter(id, targetId);
  });

  // ---------------------------------------------------------- 搜索

  app.get('/api/search', (req) => {
    const q = parse(z.object({ q: z.string().default(''), limit: qNumber.min(1).max(50).optional() }), req.query);
    return ds.search(q);
  });
}
