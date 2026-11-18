/**
 * 设置、后台任务、撤销、规则、查重和界面小动作的命令（docs/core-architecture.md 第 4.1 节）。
 *
 * - 不可撤销的命令（改设置、启动 / 取消任务、加图库文件夹）在注册表里标成 undoable: false：前端的撤销屏障由此生成（附录 #33）。
 * - 设置（以前在 SqliteDataSource 里）：换 Pixiv 投稿号识别方式走可撤销的 settings.setSourceMode（报告影响了多少张）；
 *   其余设置照常保存，设置监听者和缓存由反应通知（settings.changed）。
 */
import type { ContentKind, ID, Job, JobKind, MutationResult, PromotableSuggestions, RetagResult, Settings, SourceModePreview, StartJobBody, UpdateSettingsBody } from '@emaki/shared';
import {
  CreateExclusionInput,
  EmptyInput,
  IdInput,
  PromoteInput,
  ResolveDuplicateInput,
  SourceModeInput,
  StartJobInput,
  UndoInput,
  UpdateSettingsInput,
} from '@emaki/shared/schemas';
import { done } from '../core/undo.ts';
import { countLinks, evaluateAuto, promotionScope } from '../domain/curation/reevaluate.ts';
import { snapshotSources } from '../domain/evidence/source.ts';
import { applySettingsPatch, readSettings } from '../datasource/sqlite/settings.ts';
import { iso, parseId } from '../datasource/sqlite/sql.ts';
import { BadRequestError } from '../http/errors.ts';
import { snapshotVersion } from '../propagation/versions.ts';
import { readSettingsView } from '../readmodel/settings.ts';
import { HAS_CHARACTER } from '../readmodel/terms.ts';
import { IN_COMIC } from '../services/classify/comicAreas.ts';
import { clearPendingPixivCache, queuePixivImages, resetPixivBackoff } from '../services/pixiv/sync.ts';
import { applySourceChanges, diffSources, markSourcesCurrent } from '../services/source/backfill.ts';
import { findModel } from '../services/tagger/models.ts';
import { resetIoBackoff } from '../services/tagger/readBackoff.ts';
import { pickFolder } from '../system/pickFolder.ts';
import { defineCommand, defineQuery, type Engine } from './registry.ts';

export async function previewSourceMode(e: Engine, mode: 'strict' | 'broad'): Promise<SourceModePreview> {
  const changes = diffSources(e.ctx.db, mode);
  const requeue = changes.filter((c) => c.newPixivPost !== null);
  const cached = new Set(
    e.ctx.db.prepare('SELECT post_id FROM pixiv_artwork_cache WHERE post_id IN (SELECT value FROM json_each(?))').pluck()
      .all(JSON.stringify([...new Set(requeue.map((c) => c.newPixivPost))])) as string[],
  );
  const hasPixivSug = e.ctx.db.prepare("SELECT 1 FROM v_character_suggestions WHERE image_id = ? AND source = 'pixiv' LIMIT 1");
  return {
    mode,
    changed: changes.length,
    suggestionsDropped: changes.filter((c) => c.before.site === 'pixiv' && c.pixivPostChanged && hasPixivSug.get(c.id)).length,
    requeued: requeue.length,
    cached: requeue.filter((c) => cached.has(c.newPixivPost!)).length,
  };
}

/**
 * 切换 Pixiv 投稿号识别方式（设置 → 识别）：报告影响了多少张，可撤销（来源、Pixiv 建议、补充记录、设置一起回去）。
 * 投稿号真的变了的才去掉 Pixiv 建议；切回原来的投稿号时有缓存的马上找回，没缓存的等补充 Pixiv 角色
 */
export async function setSourceMode(e: Engine, mode: 'strict' | 'broad'): Promise<MutationResult> {
  const db = e.ctx.db;
  const before = readSettings(db).tagger.pixivFilenameMode;
  const label = mode === 'broad' ? '宽泛' : '严格';
  if (mode === before) return done(`已经是${label}了`);
  let requeued: number[] = [];
  let changed = 0;
  let dropped = 0;
  const result = e.ctx.mutate((u) => {
    const changes = diffSources(db, mode);
    changed = changes.length;
    // 来源的撤销快照；过期的 Pixiv 证据、检查记录、依据它们的自动决定由反应去掉并记撤销
    snapshotSources(u, changes.map((c) => c.id));
    // 设置只改回这一项，期间改的其他设置不动
    u.sql("UPDATE settings SET value = json_set(value, '$.pixivFilenameMode', ?) WHERE key = 'tagger'", [before]);
    // 来源解析的版本记录（派生数据的版本，含识别方式）一起放回
    snapshotVersion(u, 'source');
    dropped = db.prepare("SELECT COUNT(DISTINCT image_id) FROM v_character_suggestions WHERE source = 'pixiv' AND image_id IN (SELECT value FROM json_each(?))").pluck().get(
      JSON.stringify(changes.filter((c) => c.before.site === 'pixiv' && c.pixivPostChanged).map((c) => c.id)),
    ) as number;
    applySettingsPatch(db, { tagger: { pixivFilenameMode: mode } });
    applySourceChanges(db, changes);
    markSourcesCurrent(db, mode, iso(e.ctx.clock()));
    requeued = changes.filter((c) => c.newPixivPost !== null).map((c) => c.id);
    // 清过期的 Pixiv 建议、重新登记补充、刷新同投稿组、有缓存的马上在本地重新匹配，都由反应做；撤销时重放，同样重跑（附录 #13、#22）
    e.ctx.changed({ type: 'image.sourceChanged', ids: changes.map((c) => c.id) });
    e.ctx.changed({ type: 'settings.changed', sections: ['tagger'], ids: [] });
    return { message: `已改为${label}：${changed} 张图的来源变了` };
  });
  await e.ctx.propagation.idle();
  const found = pixivFound(e, requeued);
  const left = requeued.length - found;
  const notes = [
    dropped && `${dropped} 张的 Pixiv 建议先去掉了（投稿号变了，切回来能找回）`,
    found && `${found} 张从缓存找回了 Pixiv 角色`,
    left > 0 && `${left} 张等「补充 Pixiv 角色」时再查`,
  ].filter(Boolean);
  if (left > 0) e.pipeline.requestPixiv();
  return { ...result, message: `${result.message}${notes.length ? `；${notes.join('，')}` : ''}` };
}

/** 这些图里有 Pixiv 建议或角色关联的张数（切换识别方式后的提示） */
function pixivFound(e: Engine, ids: number[]): number {
  if (!ids.length) return 0;
  return e.ctx.db
    .prepare(
      `SELECT COUNT(DISTINCT i.id) FROM images i
       JOIN pixiv_character_checks p ON p.image_id = i.id AND p.checked_at IS NOT NULL AND p.post_id = i.source_post_id
       WHERE i.id IN (SELECT value FROM json_each(?)) AND (
         EXISTS (SELECT 1 FROM v_character_suggestions cs WHERE cs.image_id = i.id AND cs.source = 'pixiv')
         OR ${HAS_CHARACTER('i')})`,
    )
    .pluck()
    .get(JSON.stringify(ids)) as number;
}

export async function updateSettings(e: Engine, body: UpdateSettingsBody): Promise<Settings> {
  const beforeArtists = readSettings(e.ctx.db).tagger.artists;
  const beforePixiv = readSettings(e.ctx.db).tagger.pixiv;
  const beforeMode = readSettings(e.ctx.db).tagger.pixivFilenameMode;
  const { pixivFilenameMode, ...taggerRest } = body.tagger ?? {};
  // 换识别方式走 setSourceMode（报告影响、可撤销），其余照常保存
  // 设置监听者（识别、Danbooru 等重载配置）和缓存由反应通知（settings.changed）
  e.ctx.apply(() => {
    applySettingsPatch(e.ctx.db, { ...body, ...(body.tagger && { tagger: taggerRest }) } as Parameters<typeof applySettingsPatch>[1]);
    e.ctx.changed({ type: 'settings.changed', sections: Object.keys(body), ids: [] });
  });
  if (pixivFilenameMode !== undefined && pixivFilenameMode !== beforeMode) await setSourceMode(e, pixivFilenameMode);
  const settings = readSettingsView(e.ctx);
  // 调低自动采纳阈值不在保存时动已有建议：设置页显示有多少达标，用户点按钮才归（promoteSuggestions，可撤销）
  // 刚打开「识别画师」：给已识别的图补跑（任务在显卡道里排在识别后面，可以随时取消）
  if (body.tagger?.artists === true && !beforeArtists) {
    e.pipeline.noteManualStart('artists');
    e.ctx.jobs.enqueue('artists');
  }
  // 关掉：正在跑和排队中的补跑一起停（关了开关，设置页的进度和取消按钮也没了）
  if (body.tagger?.artists === false && beforeArtists) {
    for (const j of e.ctx.jobs.list()) if (j.kind === 'artists' && (j.status === 'queued' || j.status === 'running')) e.ctx.jobs.cancel(j.id);
  }
  // 刚打开自动查 Pixiv：把关着时登记下来的图补上
  if (body.tagger?.pixiv === true && !beforePixiv) e.pipeline.requestPixiv();
  // 关掉：停掉自动排上的（排队中和正在跑的）；用户在「未识别」页手动点的照常跑完
  if (body.tagger?.pixiv === false && beforePixiv && !e.pipeline.isPixivManual()) {
    for (const j of e.ctx.jobs.list()) if (j.kind === 'pixiv-tags' && (j.status === 'queued' || j.status === 'running')) e.ctx.jobs.cancel(j.id);
  }
  return settings;
}

/** 按当前阈值和角色目录计算可补采纳的建议（和补采纳命令同一轮评估，只是不写） */
export async function promotableSuggestions(e: Engine, kind?: ContentKind): Promise<PromotableSuggestions> {
  const threshold = readSettings(e.ctx.db).tagger.autoAcceptThreshold;
  const db = e.ctx.db;
  return { ...countLinks(evaluateAuto(db, promotionScope(db, kind), new Map(), e.catalogNow())), threshold };
}

export async function retagUnrecognized(e: Engine): Promise<RetagResult> {
  e.unrecognized.markRetag();
  // 之前标过、还没跑完的也算：只要有等着重新识别的，就启动识别任务
  const pending = e.ctx.stmt(`SELECT COUNT(*) AS n FROM images i WHERE i.retag = 1 AND NOT ${IN_COMIC('i')}`).get() as { n: number };
  return { marked: pending.n, job: pending.n ? await startJob(e, 'tag') : null };
}

export async function startJob(e: Engine, kind: JobKind, options: Pick<StartJobBody, 'refreshPixiv'> = {}): Promise<Job> {
  if (options.refreshPixiv && kind !== 'pixiv-tags') throw new BadRequestError('刷新 Pixiv 标签只用于补充 Pixiv 角色');
  if (kind === 'pixiv-tags') {
    // Repeated starts must not reset checks or invalidate cache during an active run.
    const active = e.ctx.jobs.list().find(j => j.kind === kind && (j.status === 'running' || j.status === 'queued'));
    if (active) return active;
    queuePixivImages(e.ctx);
    if (options.refreshPixiv) clearPendingPixivCache(e.ctx);
    resetPixivBackoff();
  }
  if (kind === 'scan') e.requests.requestFull();
  // 用户手动点的：之前读不到、正在退避的图也马上重试（比如刚把移动硬盘插回去）
  if (kind === 'tag' || kind === 'artists') resetIoBackoff();
  e.pipeline.noteManualStart(kind);
  // 手动扫描时正在跑监听触发的增量扫描：它开始时已经取走了请求，不再排一次的话这次全量扫描就被吞了
  return e.ctx.jobs.enqueue(kind, { requeueIfRunning: kind === 'scan' });
}

export async function cancelJob(e: Engine, id: ID): Promise<void> {
  // 排队中的任务被取消时 runner 不会执行，pipeline 收不到「被取消」：这里先记下暂停，免得识别一结束又排上
  const job = e.ctx.jobs.list().find((j) => j.id === id);
  if (job && (job.status === 'queued' || job.status === 'running')) e.pipeline.notePaused(job.kind);
  e.ctx.jobs.cancel(id);
  // 识别完追加排上的那一轮 Pixiv 也一起取消，不然取消后马上又开始请求 pixiv.net
  if (job?.kind === 'pixiv-tags') for (const j of e.ctx.jobs.list()) if (j.kind === 'pixiv-tags' && j.status === 'queued') e.ctx.jobs.cancel(j.id);
}

export const systemCommands = [
  // ---------------------------------------------------------------- 设置
  defineCommand({
    name: 'settings.update',
    summary: '改图库设置（按节深合并；换 Pixiv 投稿号识别方式时报告影响、可撤销那一步）',
    input: UpdateSettingsInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [
      { method: 'PATCH', path: '/api/settings' },
      { method: 'PUT', path: '/api/settings', legacy: true },
    ],
    run(e, body) {
      // 模型名必须是注册表里有的，否则要到识别时才报错
      for (const repo of [body.tagger?.model, body.tagger?.legacyModel]) {
        if (repo && !findModel(repo)) throw new BadRequestError(`不认识的识别模型：${repo}`);
      }
      return updateSettings(e, body as UpdateSettingsBody);
    },
  }),
  defineCommand({
    name: 'settings.setSourceMode',
    summary: '切换 Pixiv 投稿号识别方式（strict / broad）：报告影响了多少张，可撤销',
    input: SourceModeInput,
    scope: 'settings',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/settings/source-mode' }],
    run: (e, input) => setSourceMode(e, input.mode),
  }),

  // ---------------------------------------------------------------- 规则
  defineCommand({
    name: 'visibility.createRule',
    summary: '新建排除规则（单张、文件夹、标签、角色）：命中的图由反应排除',
    input: CreateExclusionInput,
    scope: 'rules',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/exclusions' }],
    tx: (e, body) => e.exclusions.create(body.kind, body.target),
  }),
  defineCommand({
    name: 'visibility.deleteRule',
    summary: '删掉一条排除规则（恢复它排除的图）',
    input: IdInput,
    scope: 'rules',
    undoable: true,
    idempotent: true,
    http: [{ method: 'DELETE', path: '/api/exclusions/:id' }],
    tx: (e, input) => e.exclusions.delete(input.id),
  }),

  // ---------------------------------------------------------------- 查重
  defineCommand({
    name: 'duplicates.resolve',
    summary: '处理一个重复组：保留 keepIds，其余移到回收站并把整理信息合并过去；batch 相同的几次（「全部处理」）只算一次撤销',
    input: ResolveDuplicateInput,
    scope: 'organize-files',
    undoable: true,
    idempotent: true,
    mcp: { destructive: true },
    http: [{ method: 'POST', path: '/api/duplicates/:id/resolve' }],
    run: (e, input) => e.duplicates.resolve(input.id, input.keepIds, input.batch),
  }),
  defineCommand({
    name: 'duplicates.ignore',
    summary: '把一个重复组标为「不是重复」',
    input: IdInput,
    scope: 'duplicates',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/duplicates/:id/ignore' }],
    tx: (e, input) => e.duplicates.ignore(input.id),
  }),

  // ---------------------------------------------------------------- 后台任务
  defineCommand({
    name: 'jobs.start',
    summary: '启动一个后台任务（扫描、缩略图、识别、查重、同步 Danbooru、识别画师、补充 Pixiv 角色）；可能覆盖全库，只在用户要求这个范围时用',
    input: StartJobInput,
    scope: 'jobs',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/jobs' }],
    run: (e, input) => startJob(e, input.kind, { refreshPixiv: input.refreshPixiv }),
  }),
  defineCommand({
    name: 'jobs.cancel',
    summary: '取消一个后台任务（取消识别、画师补跑、Pixiv 补充之后不再自动续跑，直到手动开始）',
    input: IdInput,
    scope: 'jobs',
    undoable: false,
    idempotent: true,
    http: [{ method: 'DELETE', path: '/api/jobs/:id' }],
    async run(e, input) {
      await cancelJob(e, input.id);
      return { ok: true as const };
    },
  }),
  defineCommand({
    name: 'unrecognized.retag',
    summary: '未识别里识别过、没认出角色、没放下的插画全部标记为重新识别，并启动识别任务',
    input: EmptyInput,
    scope: 'jobs',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/unrecognized/retag' }],
    run: (e) => retagUnrecognized(e),
  }),

  // ---------------------------------------------------------------- 撤销、最近的改动
  defineCommand({
    name: 'history.undo',
    summary: '撤销一次操作（令牌在这次启动内有效；冲突时拒绝）',
    input: UndoInput,
    scope: 'history',
    undoable: false,
    barrier: false,
    idempotent: false,
    http: [{ method: 'POST', path: '/api/undo/:token' }],
    run: (e, input) => e.ctx.undo.run(input.token),
  }),
  defineCommand({
    name: 'history.revertChange',
    summary: '撤回一条最近的改动（自动关联、Pixiv 补充、自动撤回、移动到文件夹），重启后也能撤回，撤回本身也可撤销',
    input: IdInput,
    scope: 'history',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/changes/:id/revert' }],
    run(e, input) {
      // 移回原处要动文件
      if (e.ctx.stmt('SELECT kind FROM change_log WHERE id = ?').pluck().get(parseId(input.id)) === 'move') e.requireLibraryFiles('移回文件');
      return e.changes.revert(input.id);
    },
  }),

  // ---------------------------------------------------------------- 界面
  defineCommand({
    name: 'system.pickFolder',
    summary: '由后端弹出系统「选择文件夹」对话框（演示模式也会弹，但添加文件夹会被拒绝）；取消时 path 为 null',
    input: EmptyInput,
    scope: 'ui',
    undoable: false,
    barrier: false,
    idempotent: false,
    http: [{ method: 'POST', path: '/api/system/pick-folder' }],
    run: async () => ({ path: await pickFolder() }),
  }),
];

export const systemQueries = [
  defineQuery({
    name: 'settings.get',
    summary: '图库设置和图库文件夹',
    input: EmptyInput,
    scope: 'settings',
    http: [{ method: 'GET', path: '/api/settings' }],
    run: (e) => readSettingsView(e.ctx),
  }),
  defineQuery({
    name: 'settings.sourceModePreview',
    summary: '切换 Pixiv 投稿号识别方式前先数影响',
    input: SourceModeInput,
    scope: 'settings',
    http: [{ method: 'GET', path: '/api/settings/source-mode' }],
    run: (e, input) => previewSourceMode(e, input.mode),
  }),
  defineQuery({
    name: 'settings.promotable',
    summary: '按当前阈值可以补采纳的模型建议（和补采纳命令同一轮评估，只是不写）',
    input: PromoteInput,
    scope: 'settings',
    http: [{ method: 'GET', path: '/api/tagger/promotable' }],
    run: (e, input) => promotableSuggestions(e, input.kind),
  }),
];
