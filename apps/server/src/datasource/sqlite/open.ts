/**
 * 打开图库：建库 / 迁移、启动时的回填和收拢、把识别 / Pixiv / Danbooru / 画师 / 查重各阶段接进后台任务链、首次扫描。
 * SqliteDataSource 只管创建各模块和转发请求；这里决定它们怎么连起来、启动时先做什么。
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.ts';
import type { EventBus } from '../../core/events.ts';
import { openDatabase } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { refreshPlannerStats } from '../../db/plannerStats.ts';
import { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import { CopyrightResolver } from '../../services/catalog/copyrights.ts';
import { backfillClassification } from '../../services/classify/backfill.ts';
import { DanbooruCatalog } from '../../services/danbooru/catalog.ts';
import { DanbooruClient } from '../../services/danbooru/client.ts';
import { createDanbooruSyncRunner, hasUncachedArtists, hasUncachedCharacterTags } from '../../services/danbooru/sync.ts';
import { importDictIfNeeded } from '../../services/i18n/dict.ts';
import { SqliteLocalizer, type Localizer } from '../../services/i18n/localizer.ts';
import { relocalizeAll } from '../../services/i18n/relocalize.ts';
import { refreshPixivAliases } from '../../services/pixiv/aliases.ts';
import { createPixivDiscovery } from '../../services/pixiv/discovery.ts';
import { pendingPixivCount, queuePixivImages, queueUnseenPixivAnimations, syncPixivCharacters } from '../../services/pixiv/sync.ts';
import { backfillSources } from '../../services/source/backfill.ts';
import { syncRootModes } from '../../services/classify/rootMode.ts';
import { ARTIST_MODEL, artistPendingCount, createArtistJobRunner } from '../../services/tagger/artists.ts';
import { isModelReady } from '../../services/tagger/download.ts';
import { findModel } from '../../services/tagger/models.ts';
import { createTagStage } from '../../services/tagger/tagJob.ts';
import { consolidateCharacterTags, consolidateWorkTags } from './consolidate.ts';
import { applyExclusionRules } from './exclusions.ts';
import { getDanbooruApiKey, patchSettingsInternal, readSettings } from './settings.ts';
import { SqliteDataSource, type SqliteOpenOptions } from './SqliteDataSource.ts';

/**
 * T01：打开 / 创建 `${dataDir}/emaki.sqlite`，开启 WAL 和外键，跑迁移（db/migrate.ts），
 * 创建 UndoStack 和 JobQueue（runner 由 T07 接上 services/*）。
 */
export async function openSqliteDataSource(bus: EventBus, dataDir: string, opts: SqliteOpenOptions = {}): Promise<SqliteDataSource> {
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(opts.memory ? ':memory:' : path.join(dataDir, 'emaki.sqlite'));
  migrate(db, { backupDir: opts.memory ? undefined : dataDir, log: (m) => console.log(m) });
  db.pragma('optimize = 0x10002'); // 长连接：打开时一次，之后每小时一次
  // 启动时不精确数 image_tags（冷缓存下 2 秒多）；识别跑完、每小时那次照常数
  if (refreshPlannerStats(db, { skipImageTags: true })) console.log('[db] 行数变化较大，已重新采样查询统计');
  const ds = new SqliteDataSource(db, bus, dataDir, opts);
  ds.purgeRemovedRoots();
  // 来源解析规则升级后重算；投稿号变了的重新登记 Pixiv 补充
  backfillSources(db, (changes) => ds.settings.requeuePixivAfterSourceChange(changes));
  // 内容类型 / 主题 / 质量分（T27）：规则版本过期的行在 HTTP 监听前同步重算；EMAKI_CLASSIFY=0 跳过（全部按插画统计，保持旧值）
  if (process.env.EMAKI_CLASSIFY !== '0') {
    const r = backfillClassification(db);
    if (r.rows) console.log(`[classify] 重算图片类型 ${r.rows} 张，用时 ${r.ms} ms`);
  }
  // 合集（T38b）：分类回填之后、HTTP 监听之前全量重算一次
  if (process.env.EMAKI_COLLECTIONS !== '0') {
    const r = ds.collections.refreshAll();
    console.log(`合集：${r.active} 本（新建 ${r.created} · 删除 ${r.removed} · 更新 ${r.updated}）· ${Math.round(r.ms)} ms`);
  }
  if (opts.autoJobs !== false) ds.startWatching();
  ds.autoTag = opts.autoJobs !== false;
  // 识别角色（T10）。T11 / T20 之后在这里继续 register
  // 角色 → 作品的完整回退链 + 标签规范化（改名、服装变体归本体）来自 Danbooru 缓存（T11）
  const danbooru = new DanbooruCatalog(db, CopyrightResolver.fromAsset(db));
  // 中文名（T12）：随仓库分发的词库，版本变了才重新导入；导入后全库重算显示名
  const dict = opts.importDict === false ? { imported: false } : importDictIfNeeded(db);
  const localizer: Localizer = new SqliteLocalizer(db, danbooru);
  if (dict.imported) db.transaction(() => relocalizeAll(db, localizer))();
  const makeCatalog = () => ({
    catalog: new CharacterCatalog(db, { copyrights: danbooru, localizer, normalizeTag: (t) => danbooru.normalizeTag(t) }),
    copyrights: danbooru,
  });
  ds.danbooru = danbooru;
  ds.makeCatalog = makeCatalog;
  // 同一个角色被拆成好几个的收拢（换模型后的改名、服装变体归本体；用户 2026-09-28）。已经收拢过就什么也不做
  const merged = consolidateCharacterTags(db, {
    normalizeTag: (t) => danbooru.normalizeTag(t),
    localizer,
    merge: (from, to) => void ds.characters.merge(String(from), String(to)),
    log: (m) => console.log(`[角色] ${m}`),
  });
  if (merged.merged || merged.renamed) console.log(`[角色] 收拢拆开的角色：合并 ${merged.merged} 个，改标签 ${merged.renamed} 个`);
  // 作品同理：Danbooru 改过名的版权标签，新旧两个名字各建了一部（用户 2026-09-29）
  const works = consolidateWorkTags(db, { canonicalize: (t) => danbooru.canonicalize(t), localizer });
  if (works.merged || works.renamed) console.log(`[作品] 收拢改过名的作品：合并 ${works.merged} 部，改标签 ${works.renamed} 部`);
  ds.characters.associateAutomatic();
  ds.pipeline.register({
    tag: createTagStage({
      db,
      bus,
      modelsDir: config.modelsDir,
      getTaggerSettings: () => readSettings(db).tagger,
      makeCatalog,
      afterBatchInTx: (ids) => {
        applyExclusionRules(ds.ctx, { imageIds: ids });
        queuePixivImages(ds.ctx, ids);
      },
      log: (m) => console.info(`[tag] ${m}`),
    }),
    pixiv: {
      // 识别后自动查 Pixiv 会联网，设置里打开才排；待查的图照常登记（只写本地），打开后接着补
      enabled: () => readSettings(db).tagger.pixiv,
      pendingCount: () => pendingPixivCount(ds.ctx),
      run: async (job) => {
        const settings = readSettings(db).danbooru;
        if (settings.enabled && pendingPixivCount(ds.ctx) > 0) {
          try {
            await refreshPixivAliases(db, danbooru, new DanbooruClient({
              login: settings.username || undefined, apiKey: getDanbooruApiKey(db) ?? undefined,
            }), job);
          } catch (error) {
            job.signal.throwIfAborted();
            console.warn(`[pixiv-tags] 别名补全失败，本轮使用已有词库：${String(error)}`);
          }
        }
        const discovery = settings.enabled ? createPixivDiscovery(db, danbooru, new DanbooruClient({
          login: settings.username || undefined, apiKey: getDanbooruApiKey(db) ?? undefined,
        })) : undefined;
        const result = await syncPixivCharacters(ds.ctx, job, makeCatalog, undefined, 1000, discovery);
        ds.characters.associateAutomatic();
        return result;
      },
    },
    danbooru: {
      shouldRunAfterTag: () => readSettings(db).danbooru.enabled && (hasUncachedCharacterTags(db) || hasUncachedArtists(db)),
      run: createDanbooruSyncRunner({
        db,
        danbooru,
        getCatalog: () => makeCatalog().catalog,
        localizer,
        relocalizeAll,
        getDanbooru: () => ({ ...readSettings(db).danbooru, apiKey: getDanbooruApiKey(db) }),
        associateCustomCharacters: () => ds.characters.associateAutomatic(),
        setLastSyncAt: (at) => patchSettingsInternal(db, 'danbooru', { lastSyncAt: at }),
      }),
    },
  });
  ds.pipeline.register({
    artists: {
      enabled: () => readSettings(db).tagger.artists,
      // 模型没下载（主模型用 WD 的人）时不自动续补，免得静默下载 1 GB、离线时反复失败；手动打开 / 点补跑才下
      isReady: () => isModelReady(findModel(ARTIST_MODEL)!, config.modelsDir),
      pendingCount: () => artistPendingCount(db),
      run: createArtistJobRunner({
        db,
        modelsDir: config.modelsDir,
        getDevice: () => {
          const t = readSettings(db).tagger;
          return { device: t.device, batchSize: t.batchSize };
        },
      }),
    },
  });
  // 查重（T16）
  ds.pipeline.register({ dedupe: ds.dedupe });
  // 从没查过重，或查重之后又有新缩略图（重启丢了进程里的标记）→ 下次有机会就查（T26）
  const lastRunAt = readSettings(db).dedupe.lastRunAt;
  const lastThumb = db.prepare('SELECT MAX(thumb_at) FROM images').pluck().get() as string | null;
  if (lastThumb !== null && (lastRunAt === null || lastThumb > lastRunAt || ds.dedupe.needsRecheck())) ds.pipeline.markDedupeDirty();
  // 搜索的标签张数（T20）：打标签结束标记过期，下次搜索时刷新
  // register 是覆盖式的：识别结束、扫描结束后的钩子都写在这一处
  ds.pipeline.register({
    afterTag: () => {
      ds.searchQueries.markStale();
      ds.refreshCollections('tag');
    },
    // 扫描有变化才重算合集（RV-C-9）：延后重扫大约 3 秒一次，没变化时不要全量读库
    afterScan: (s) => {
      // 扫描按开始时的导入方式判类型：中途切换过的、在磁盘上移进移出漫画文件夹的，按现在的设置改过来
      const synced = syncRootModes(db);
      if (synced) ds.ctx.invalidate('all');
      if (synced || s.added + s.updated + s.moved + s.missing + s.restored > 0) ds.refreshCollections('scan');
    },
  });
  // Register old animations locally as well; network scheduling still follows
  // the user's Pixiv setting and the normal pipeline.
  queueUnseenPixivAnimations(ds.ctx);
  const roots = db.prepare('SELECT COUNT(*) FROM library_roots WHERE enabled = 1 AND removed_at IS NULL').pluck().get() as number;
  if (opts.autoJobs !== false && !process.env.EMAKI_NO_AUTOSCAN && roots > 0) {
    ds.requests.requestFull();
    ds.ctx.jobs.enqueue('scan');
  }
  // 上次没正常退出时留下的待移文件：现在移进系统回收站（撤销栈已经随重启清空了）
  void ds.pendingTrash.flushAll();
  return ds;
}
