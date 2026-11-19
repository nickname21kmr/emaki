import type { ListTaggerModelsResponse, NetworkCheckResponse, PickFolderResponse, ServerEvent, UndoStatusResponse } from '@emaki/shared';
import * as S from '@emaki/shared/schemas';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import type { EventBus } from '../core/events.ts';
import type { JobData, SettingsData } from '../datasource/DataSource.ts';
import { BadRequestError } from '../http/errors.ts';
import { checkNetwork } from '../net/check.ts';
import { idParam, parse } from '../http/validate.ts';
import { isModelReady } from '../services/tagger/download.ts';
import { DEFAULT_TAGGER_MODEL, findModel, MODEL_NOTES, modelDownloadSize, TAGGER_MODELS } from '../services/tagger/models.ts';
import { pickFolder } from '../system/pickFolder.ts';

/** 设置、图库文件夹、后台任务、SSE、撤销 */
export function systemRoutes(app: FastifyInstance, ds: SettingsData & JobData, bus: EventBus): void {
  // ---------------------------------------------------------- 设置

  // 不经过数据层
  app.post('/api/system/pick-folder', async (): Promise<PickFolderResponse> => ({ path: await pickFolder() }));

  // 真的会联网（演示模式下也是），用来排查连不上 Danbooru
  app.post('/api/system/network-check', (): Promise<NetworkCheckResponse> => checkNetwork());

  app.get('/api/settings', () => ds.getSettings());

  app.get(
    '/api/tagger/models',
    (): ListTaggerModelsResponse =>
      TAGGER_MODELS.map((spec) => ({
        repo: spec.repo,
        label: spec.label,
        sizeBytes: modelDownloadSize(spec),
        characterCount: MODEL_NOTES[spec.repo]?.characterCount ?? 0,
        dataUntil: MODEL_NOTES[spec.repo]?.dataUntil ?? '',
        gpu: spec.gpu,
        note: MODEL_NOTES[spec.repo]?.note ?? '',
        isDefault: spec.repo === DEFAULT_TAGGER_MODEL,
        downloaded: isModelReady(spec, config.modelsDir),
      })),
  );

  app.put('/api/settings', (req) => {
    const body = parse(S.updateSettingsBody, req.body);
    // 模型名必须是注册表里有的，否则要到识别时才报错
    for (const repo of [body.tagger?.model, body.tagger?.legacyModel]) {
      if (repo && !findModel(repo)) throw new BadRequestError(`不认识的识别模型：${repo}`);
    }
    return ds.updateSettings(body);
  });

  // 调低自动采纳阈值后：有多少已有建议达标；用户点按钮再归（可撤销）
  app.get('/api/tagger/promotable', () => ds.promotableSuggestions());
  app.post('/api/tagger/promote', () => ds.promoteSuggestions());

  app.post('/api/library-roots', (req) => {
    return ds.addLibraryRoot(parse(S.addLibraryRootBody, req.body));
  });

  app.get('/api/library-roots', async () => (await ds.getSettings()).libraryRoots);

  app.patch('/api/library-roots/:id', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.updateLibraryRoot(id, parse(S.updateLibraryRootBody, req.body));
  });

  app.delete('/api/library-roots/:id', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.removeLibraryRoot(id);
  });

  // ---------------------------------------------------------- 后台任务

  app.get('/api/jobs', () => ds.listJobs());

  app.post('/api/jobs', (req) => {
    const { kind, refreshPixiv } = parse(S.startJobBody, req.body);
    if (refreshPixiv && kind !== 'pixiv-tags') throw new BadRequestError('刷新 Pixiv 标签只用于补充 Pixiv 角色');
    return ds.startJob(kind, { refreshPixiv });
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

  // ---------------------------------------------------------- 切换 Pixiv 投稿号识别方式

  app.get('/api/settings/source-mode', (req) => ds.previewSourceMode(parse(S.sourceModeParams, req.query).mode));
  app.post('/api/settings/source-mode', (req) => ds.setSourceMode(parse(S.sourceModeParams, req.body).mode));

  // ---------------------------------------------------------- 最近的改动（重启后也能撤回）

  app.get('/api/changes', (req) => ds.listChanges(parse(S.listChangesQuery, req.query).group));
  app.post('/api/changes/:id/revert', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.revertChange(id);
  });

  // ---------------------------------------------------------- 撤销

  // 静态路由优先于 /api/undo/:id，不会被当成 token
  app.post('/api/undo/status', async (req): Promise<UndoStatusResponse> => {
    const { tokens } = parse(S.undoStatusBody, req.body);
    return { status: await ds.undoStatus(tokens) };
  });

  app.post('/api/undo/:id', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.undo(id);
  });
}
