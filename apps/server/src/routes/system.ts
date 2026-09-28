import type { PickFolderResponse, ServerEvent } from '@emaki/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventBus } from '../core/events.ts';
import type { DataSource } from '../datasource/DataSource.ts';
import { idParam, parse } from '../http/validate.ts';
import { pickFolder } from '../system/pickFolder.ts';

/** 设置、图库文件夹、后台任务、SSE、撤销 */
export function systemRoutes(app: FastifyInstance, ds: DataSource, bus: EventBus): void {
  // ---------------------------------------------------------- 设置

  // 不经过 DataSource，mock 与 sqlite 通用
  app.post('/api/system/pick-folder', async (): Promise<PickFolderResponse> => ({ path: await pickFolder() }));

  app.get('/api/settings', () => ds.getSettings());

  app.put('/api/settings', (req) => {
    const body = parse(
      z.object({
        tagger: z
          .object({
            model: z.string(),
            device: z.enum(['cpu', 'dml']),
            generalThreshold: z.number().min(0).max(1),
            characterThreshold: z.number().min(0).max(1),
            autoAcceptThreshold: z.number().min(0).max(1),
            batchSize: z.number().int().min(1).max(64),
            legacyModel: z.string().nullable(),
            legacyBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
            skipCameraPhotos: z.boolean(),
            retryOld: z.boolean(),
            keepAwake: z.boolean(),
          })
          .partial()
          .optional(),
        danbooru: z.object({ enabled: z.boolean(), username: z.string() }).partial().optional(),
        dedupe: z.object({ hammingThreshold: z.number().int().min(0).max(64) }).partial().optional(),
        ui: z
          .object({
            theme: z.enum(['system', 'light', 'dark']),
            blurSensitive: z.boolean(),
            density: z.enum(['comfortable', 'compact']),
          })
          .partial()
          .optional(),
        danbooruApiKey: z.string().optional(),
      }),
      req.body,
    );
    return ds.updateSettings(body);
  });

  app.post('/api/library-roots', (req) => {
    const body = parse(z.object({ path: z.string().min(1) }), req.body);
    return ds.addLibraryRoot(body);
  });

  app.patch('/api/library-roots/:id', (req) => {
    const { id } = parse(idParam, req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    return ds.updateLibraryRoot(id, enabled);
  });

  app.delete('/api/library-roots/:id', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.removeLibraryRoot(id);
  });

  // ---------------------------------------------------------- 后台任务

  app.get('/api/jobs', () => ds.listJobs());

  app.post('/api/jobs', (req) => {
    const { kind } = parse(
      z.object({ kind: z.enum(['scan', 'thumbnail', 'tag', 'danbooru-sync', 'dedupe']) }),
      req.body,
    );
    return ds.startJob(kind);
  });

  app.delete('/api/jobs/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    await ds.cancelJob(id);
    return { ok: true };
  });

  // ---------------------------------------------------------- SSE

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const send = (event: ServerEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = bus.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ---------------------------------------------------------- 撤销

  app.post('/api/undo/:id', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.undo(id);
  });
}
