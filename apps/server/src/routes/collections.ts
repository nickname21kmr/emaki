import type { ListArtistsResponse } from '@emaki/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DataSource } from '../datasource/DataSource.ts';
import { NotFoundError } from '../http/errors.ts';
import { idParam, parse } from '../http/validate.ts';

const kindSchema = z.enum(['doujin', 'artbook']);

/** 合集（T38c） */
export function collectionRoutes(app: FastifyInstance, ds: DataSource): void {
  app.get('/api/collections', (req) => {
    const q = parse(
      z.object({
        kind: kindSchema.optional(),
        characterId: z.string().optional(),
        workId: z.string().optional(),
        seriesKey: z.string().optional(),
        pending: z
          .enum(['true', 'false'])
          .transform((v) => v === 'true')
          .optional(),
        q: z.string().optional(),
      }),
      req.query,
    );
    return ds.listCollections(q);
  });

  app.get('/api/artists', (): Promise<ListArtistsResponse> => ds.listArtists());
  app.post('/api/artists/links', (req) => {
    const body = parse(
      z.object({
        tags: z.array(z.string().min(1).max(200)).min(1).max(50),
        mode: z.enum(['split', 'merge', 'auto']),
        into: z.string().min(1).max(200).optional(),
      }),
      req.body,
    );
    return ds.updateArtistLinks(body);
  });

  app.post('/api/collections/bulk', (req) => {
    const body = parse(
      z.object({
        ids: z.array(z.string()).min(1).max(500),
        action: z.discriminatedUnion('type', [
          z.object({ type: z.literal('review') }),
          z.object({ type: z.literal('addCharacter'), characterId: z.string() }),
          z.object({ type: z.literal('addWork'), workId: z.string() }),
          z.object({ type: z.literal('kind'), value: kindSchema }),
        ]),
      }),
      req.body,
    );
    return ds.bulkCollections(body);
  });

  app.get('/api/collections/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const res = await ds.getCollection(id);
    if (!res) throw new NotFoundError('合集');
    return res;
  });

  app.post('/api/collections', (req) => {
    const body = parse(z.object({ fromImageId: z.string(), kind: kindSchema }), req.body);
    return ds.createCollection(body);
  });

  app.patch('/api/collections/:id', (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(200).nullable().optional(),
        kind: z.union([kindSchema, z.literal('auto')]).optional(),
        coverImageId: z.string().nullable().optional(),
        pageOrder: z.enum(['name', 'mtime']).optional(),
        seriesKey: z.string().max(200).nullable().optional(),
        volumeNo: z.number().min(0).max(9999).nullable().optional(),
        reviewed: z.boolean().optional(),
        manualCharacterIds: z.array(z.string()).max(200).optional(),
        manualWorkIds: z.array(z.string()).max(200).optional(),
      }),
      req.body,
    );
    return ds.updateCollection(id, body);
  });

  app.delete('/api/collections/:id', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.deleteCollection(id);
  });
}
