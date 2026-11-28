/**
 * 查询（docs/core-architecture.md 第 6、9 节）：读模型的公开入口。HTTP 的 GET 路由、MCP 的 read_library / read_media、
 * 下一阶段的页面和插件都经这里读（注册表里有名字、输入 schema、scope 和地址）。
 * 计数的口径只在 readmodel/terms.ts；界面上要显示的数读 library.summary（第 6.1 节）。
 */
import { THUMB_WIDTHS, type CustomCharacterMatch, type ID, type ImageDetail, type LibrarySummary, type ThumbWidth } from '@emaki/shared';
import {
  AuditInput,
  CollectionCountsInput,
  CoverCandidatesInput,
  EmptyInput,
  IdInput,
  ListChangesInput,
  ListCharactersInput,
  ListCollectionsInput,
  ListDuplicatesInput,
  ListImagesInput,
  ListUnrecognizedInput,
  ListWorksInput,
  SearchInput,
  TagPhraseInput,
  TagSuggestionsInput,
  ThumbInput,
  TopCharactersInput,
  UndoStatusInput,
  UnrecognizedSummaryInput,
} from '@emaki/shared/schemas';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { describeKindReason, hydrateImages, IMAGE_COLS, type ImageRow } from '../datasource/sqlite/hydrate.ts';
import { imageArtists, listArtistsCached } from '../datasource/sqlite/artists.ts';
import { listImages, type TextMatch } from '../datasource/sqlite/queries/listImages.ts';
import { MIME, parseId, toId } from '../datasource/sqlite/sql.ts';
import { loadSuggestions } from '../datasource/sqlite/suggestions.ts';
import { NotFoundError } from '../http/errors.ts';
import type { FileResponse, ImageFileRow } from '../infra/ports.ts';
import { checkNetwork } from '../net/check.ts';
import { readSettingsView } from '../readmodel/settings.ts';
import { summarize } from '../readmodel/summary.ts';
import { VISIBLE } from '../readmodel/terms.ts';
import { describeAnimation } from '../services/classify/rules.ts';
import { sha256Buffer } from '../services/fs/hash.ts';
import { toAbs } from '../services/fs/paths.ts';
import { htmlAnimationCache, readHtmlAnimation } from '../services/image/htmlAnimation.ts';
import { isModelReady } from '../services/tagger/download.ts';
import { DEFAULT_TAGGER_MODEL, MODEL_NOTES, modelDownloadSize, TAGGER_MODELS } from '../services/tagger/models.ts';
import { requirePose } from './pose.ts';
import { defineQuery, type Engine } from './registry.ts';

/** 查不到就 404（查询返回 null 的那几个） */
function found<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new NotFoundError(what);
  return value;
}

function nearestThumbWidth(w: number): ThumbWidth {
  return THUMB_WIDTHS.find((t) => t >= w) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1]!;
}

export function getImage(e: Engine, id: ID): ImageDetail | null {
  const n = parseId(id);
  if (n === null) return null;
  const row = e.ctx
    .stmt(`SELECT ${IMAGE_COLS}, r.path AS root_path FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ? AND ${VISIBLE}`)
    .get(n) as (ImageRow & { root_path: string }) | undefined;
  if (!row) return null;
  const [item] = hydrateImages(e.ctx.db, [row]);
  const tags = e.ctx
    .stmt(
      'SELECT t.name AS tag, t.category, it.score FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = ? ORDER BY it.score DESC',
    )
    .all(n) as ImageDetail['tags'];
  return {
    ...item!,
    // 反斜杠的原生路径，方便用户复制
    absPath: path.normalize(toAbs(row.root_path, row.rel_path)),
    tags,
    characterSuggestions: loadSuggestions(e.ctx, [n], e.makeCatalog().catalog).get(n) ?? [],
    characterLinks: (
      e.ctx
        .stmt(
          `SELECT character_id, decision, evidence_provider, evidence_score FROM image_characters
           WHERE image_id = ? ORDER BY added_at, character_id`,
        )
        .all(n) as {
        character_id: number;
        decision: 'manual' | 'auto';
        evidence_provider: 'tagger' | 'pixiv' | null;
        evidence_score: number | null;
      }[]
    ).map((r) => ({ characterId: toId(r.character_id), decision: r.decision, source: r.evidence_provider, score: r.evidence_score })),
    kindSource: row.content_kind_manual ? 'manual' : row.content_kind_source,
    kindReason: row.content_kind_manual ? null : describeKindReason(row.content_kind_source, row.content_kind_evidence),
    animatedReason: row.animated ? describeAnimation({ format: row.format, frames: row.frame_count }) : null,
    collection: imageCollection(e, n),
    artists: imageArtists(e.ctx.db, n),
    sourceManual: !!e.ctx.stmt('SELECT source_manual FROM images WHERE id = ?').pluck().get(n),
    artistsManual: !!e.ctx.stmt('SELECT artist_manual FROM images WHERE id = ?').pluck().get(n),
  };
}

/** 看图器「收录于」：pageNo 是可见页里的序号（RV-C-8） */
function imageCollection(e: Engine, imageId: number): ImageDetail['collection'] {
  const r = e.ctx
    .stmt(
      `SELECT c.id, c.kind, c.title, c.volume_no, c.rel_dir,
         (SELECT COUNT(*) FROM v_counted_images x WHERE x.collection_id = c.id AND x.page_no <= i.page_no) AS ord,
         (SELECT COUNT(*) FROM v_counted_images x WHERE x.collection_id = c.id) AS n
       FROM images i JOIN collections c ON c.id = i.collection_id WHERE i.id = ? AND c.state = 'active'`,
    )
    .get(imageId) as
    | {
        id: number;
        kind: 'doujin' | 'artbook' | 'group';
        title: string | null;
        volume_no: number | null;
        rel_dir: string;
        ord: number;
        n: number;
      }
    | undefined;
  if (!r) return null;
  return {
    id: toId(r.id),
    kind: r.kind,
    title: r.title,
    pageNo: Math.max(1, r.ord),
    pageCount: r.n,
    volumeNo: r.volume_no,
    folderName: r.rel_dir.slice(r.rel_dir.lastIndexOf('/') + 1),
  };
}

/** 读图片文件用的行；不要求「可见」（排除页、已处理的重复组也要显示被排除或已删除图片的缩略图） */
function fileRow(e: Engine, id: ID): ImageFileRow | null {
  const n = parseId(id);
  if (n === null) return null;
  return (
    (e.ctx
      .stmt(
        `SELECT i.id, i.sha256, i.format, i.width, i.height, i.file_name, i.rel_path, i.dominant_color, i.modified_at, r.path AS root_path
         FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ?`,
      )
      .get(n) as ImageFileRow | undefined) ?? null
  );
}

/**
 * 地址带版本、而且对得上的缩略图让浏览器缓存多久：30 天。地址里已经带着文件版本，时长只在出错时有意义
 * （外部工具改了文件内容却没动修改时间，地址不变），短一点兜底；到期后浏览器带 ETag 回来问一次（304）就续上
 */
const THUMB_MAX_AGE = 30 * 24 * 3600;

/**
 * 图片 id 稳定（文件内容变了 id 不变），单凭 id 不能让浏览器长期缓存：缺省是按内容 sha 的 ETag + no-cache，每次都回来问。
 * 地址里带了文件版本（version，前端 imageUrl.thumb 的 v = modifiedAt）、和这一行现在的对得上、给出去的又正是请求的那一档时，
 * 这个地址的内容不会再变（换了文件 modifiedAt 就变，地址跟着变），才回长缓存，浏览器之后直接用，不再发请求。
 * - 版本对不上的不算：列表还是旧数据时拿旧版本来要，给出去的已经是新文件，不能缓存在旧地址下（撤销替换以后旧地址还会用到）；
 * - 退回别的档的不算（原图不在，要 960 只有 480）：盘接回来以后要能换成清晰的。ETag 一律按实际给出的档写
 */
export async function getThumbnail(e: Engine, id: ID, width: ThumbWidth, version?: string): Promise<FileResponse | null> {
  const row = fileRow(e, id);
  if (!row) return null;
  if (e.ports.imageFiles) return e.ports.imageFiles.thumbnail(row, width);
  const thumb = await e.thumbs.ensure(row, width);
  if (!thumb) return null;
  // 版本按文件内容认（sha）：图片 id 会被重新分配（删掉一个图库文件夹后新导入的图接着用那些 id），修改时间也常常一样（压缩包里解出来的页）
  const pinned = version === row.sha256.slice(0, 16) && thumb.width === width;
  return {
    kind: 'path',
    contentType: 'image/webp',
    filePath: thumb.file,
    etag: `"${row.sha256.slice(0, 20)}-${thumb.width}"`,
    cacheControl: pinned ? `private, max-age=${THUMB_MAX_AGE}, immutable` : 'private, no-cache',
  };
}

/** 不要求可见；文件不在了返回 null → 404 */
export async function getOriginal(e: Engine, id: ID): Promise<FileResponse | null> {
  const row = fileRow(e, id);
  if (!row) return null;
  if (e.ports.imageFiles) return e.ports.imageFiles.original(row);
  const abs = toAbs(row.root_path, row.rel_path);
  try {
    await access(abs);
  } catch {
    return null;
  }
  const html = row.format === 'html' ? await readHtmlAnimation(abs) : null;
  const sha = html ? sha256Buffer(html) : row.sha256;
  const filePath = html ? await htmlAnimationCache(html, e.ctx.dataDir, sha) : abs;
  return { kind: 'path', contentType: MIME[row.format], filePath, etag: `"${sha.slice(0, 20)}"`, cacheControl: 'private, no-cache' };
}

export async function listCustomCharacterMatches(e: Engine): Promise<CustomCharacterMatch[]> {
  const rows = e.ctx.db
    .prepare(
      `SELECT c.id, c.name, m.danbooru_tag AS tag
    FROM custom_character_matches m JOIN characters c ON c.id = m.character_id
    WHERE c.source = 'custom' AND c.danbooru_tag IS NULL AND m.dismissed = 0 ORDER BY c.name, c.id`,
    )
    .all() as { id: number; name: string; tag: string }[];
  const catalog = e.makeCatalog().catalog;
  return rows.map((r) => {
    const tag = e.danbooru.normalizeTag(r.tag);
    const described = catalog.describeTag(tag);
    return {
      characterId: String(r.id),
      characterName: r.name,
      danbooruTag: tag,
      matchName: described.name,
      workName: described.workName,
      existingCharacterId: described.characterId === null ? null : String(described.characterId),
      existingCharacterName: described.characterId === null ? null : described.name,
    };
  });
}

export const queries = [
  // ---------------------------------------------------------------- 统计
  defineQuery({
    name: 'library.stats',
    summary: '按命名口径数出来的原始计数（界面上显示的数优先读 library.summary）',
    input: EmptyInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/stats' }],
    run: (e) => e.counts().stats,
  }),
  defineQuery({
    name: 'library.summary',
    summary: '侧栏、首页、命令面板、统计条要显示的计数：待处理数、已认出比例、别册张数等，和用户看到的一致',
    input: EmptyInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/summary' }],
    run: (e) => e.results.get('summary', () => summarize(e.counts())) as LibrarySummary,
  }),
  defineQuery({
    name: 'library.contentKinds',
    summary: '别册首页：每一类的张数、最近张数和预览',
    input: EmptyInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/content-kinds' }],
    run: (e) => e.results.get('kinds', () => e.library.listContentKinds()),
  }),
  defineQuery({
    name: 'library.roots',
    summary: '图库文件夹（可用的入库目标）',
    input: EmptyInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/library-roots' }],
    run: (e) => readSettingsView(e.ctx).libraryRoots,
  }),

  // ---------------------------------------------------------------- 作品、角色、画师、搜索
  defineQuery({
    name: 'works.list',
    summary: '作品列表',
    input: ListWorksInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/works' }],
    run: (e, q) => e.library.listWorks(q),
  }),
  defineQuery({
    name: 'works.get',
    summary: '一部作品',
    input: IdInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/works/:id' }],
    run: (e, q) => found(e.library.getWork(q.id), '作品'),
  }),
  defineQuery({
    name: 'characters.list',
    summary: '角色列表（分页）',
    input: ListCharactersInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/characters' }],
    run: (e, q) => e.library.listCharacters(q),
  }),
  defineQuery({
    name: 'characters.top',
    summary: '张数最多的角色',
    input: TopCharactersInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/characters/top' }],
    run: (e, q) => e.library.topCharacters(q),
  }),
  defineQuery({
    name: 'characters.danbooruMatches',
    summary: '等待用户处理的自建角色 ↔ Danbooru 匹配',
    input: EmptyInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/characters/danbooru-matches' }],
    run: (e) => listCustomCharacterMatches(e),
  }),
  defineQuery({
    name: 'characters.get',
    summary: '一个角色：作品、常一起出现的角色',
    input: IdInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/characters/:id' }],
    run: (e, q) => found(e.library.getCharacter(q.id), '角色'),
  }),
  defineQuery({
    name: 'characters.coverCandidates',
    summary: '「换封面」候选：自动封面的排序，前 limit 张',
    input: CoverCandidatesInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/characters/:id/cover-candidates' }],
    run: (e, q) => found(e.library.listCoverCandidates(q.id, q.limit ?? 12), '角色'),
  }),
  defineQuery({
    name: 'artists.list',
    summary: '识别出来的画师（同一个人的不同标签合并），按张数从多到少',
    input: EmptyInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/artists' }],
    // 每次现算约 0.1 秒、结果 800 KB：和重复组一样放进结果缓存（键 'artists'），库里有变化才重算
    run: (e) => listArtistsCached(e.ctx.db, (compute) => e.results.get('artists', compute)),
  }),
  defineQuery({
    name: 'search.all',
    summary: '⌘K 搜索：角色、作品、标签；forAssignment 时也列出还没建档的建议',
    input: SearchInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/search' }],
    run: (e, q) => e.searchQueries.search(q, q.forAssignment ? e.makeCatalog().catalog : undefined),
  }),
  defineQuery({
    name: 'search.tags',
    summary: '一般标签联想（自定义画面）；q 为空是最常见的',
    input: TagSuggestionsInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/tags' }],
    run: (e, q) => e.searchQueries.tagSuggestions(q),
  }),
  defineQuery({
    name: 'search.phrase',
    summary: '一句话拆成标签（图库搜索框的「按标签」）：「两个黑色长发女孩」→ 2girls + black_hair + long_hair，只给库里有的标签，带同时有这些标签的图数',
    input: TagPhraseInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/search/phrase' }],
    // 张数和图库「必含」（tagsAll）是同一个查询，也共用总数缓存
    run: (e, q) =>
      e.searchQueries.tagPhrase(q.q, (tags) => listImages(e.ctx.db, { tagsAll: tags, limit: 1 }, (key, compute) => e.results.get('count:' + key, compute) as number).total),
  }),

  // ---------------------------------------------------------------- 合集
  defineQuery({
    name: 'collections.list',
    summary: '合集列表；kind、membership（folder / selection / post）可多选，sort=recent&limit=50 是最近加图的 50 本',
    input: ListCollectionsInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/collections' }],
    run: (e, q) => e.collectionQueries.list(q),
  }),
  // 写在 collections.get 前面：read_library 按注册的顺序匹配地址，counts 不能被当成 :id
  defineQuery({
    name: 'collections.counts',
    summary: '合集的数目：每一类、每种成员来源的本数、书架格数、页数（q 同列表的搜索）；同一投稿的组图可能几千组，数目不用拉全部列表',
    input: CollectionCountsInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/collections/counts' }],
    run: (e, q) => e.collectionQueries.counts(q),
  }),
  defineQuery({
    name: 'collections.get',
    summary: '一本合集：目次、出场角色、作品、同系列',
    input: IdInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/collections/:id' }],
    run: (e, q) => found(e.collectionQueries.get(q.id), '合集'),
  }),

  // ---------------------------------------------------------------- 图片
  defineQuery({
    name: 'images.list',
    summary: '图片列表（筛选、排序、分页）；图片的状态是三个事实 tagged、characterCount、queue，另有 excluded',
    input: ListImagesInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/images' }],
    run(e, q) {
      // 按姿势类别筛选（实验）：姿势检索关着时 403
      if (q.poseClass || q.posewearPose) requirePose(e);
      return listImages(
        e.ctx.db,
        q,
        (key, compute) => e.results.get('count:' + key, compute) as number,
        // 文字搜索命中的标签、角色、作品：同一个词翻页、重拉时不用每个请求都把标签表扫一遍
        (key, compute) => e.results.get('qtext:' + key, compute) as TextMatch,
      );
    },
  }),
  defineQuery({
    name: 'images.get',
    summary: '一张图的详情：标签、建议、关联的来历、类型的依据、合集、画师',
    input: IdInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/images/:id' }],
    run: (e, q) => found(getImage(e, q.id), '图片'),
  }),
  defineQuery({
    name: 'images.thumbnail',
    summary: '缩略图文件（240 / 480 / 960，webp）',
    input: ThumbInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/images/:id/thumb' }],
    run: async (e, q) => found(await getThumbnail(e, q.id, nearestThumbWidth(q.w ?? 480), q.v), '缩略图'),
  }),
  defineQuery({
    name: 'images.original',
    summary: '原图文件（不要求可见；文件不在了 404）',
    input: IdInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/images/:id/file' }],
    run: async (e, q) => found(await getOriginal(e, q.id), '图片文件'),
  }),

  // ---------------------------------------------------------------- 未识别、重复、排除
  defineQuery({
    name: 'unrecognized.list',
    summary: '未识别列表（大类、分段、主题、别册类型）',
    input: ListUnrecognizedInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/unrecognized' }],
    run: (e, q) => e.unrecognized.list(q),
  }),
  defineQuery({
    name: 'unrecognized.summary',
    summary: '未识别两个大类、四个分段、各主题 / 各类的张数',
    input: UnrecognizedSummaryInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/unrecognized/summary' }],
    run: (e, q) => e.unrecognized.summary(q.artKind),
  }),
  defineQuery({
    name: 'duplicates.list',
    summary: '重复组（一次返回全部）',
    input: ListDuplicatesInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/duplicates' }],
    run: (e, q) => e.results.get(`dups:${q.resolved ? 1 : 0}`, () => e.duplicates.list(q)),
  }),
  defineQuery({
    name: 'exclusions.list',
    summary: '排除规则',
    input: EmptyInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/exclusions' }],
    run: (e) => e.exclusions.list(),
  }),

  // ---------------------------------------------------------------- 任务、最近的改动、撤销、审计
  defineQuery({
    name: 'jobs.list',
    summary: '后台任务（最近 20 条）',
    input: EmptyInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/jobs' }],
    run: (e) => e.ctx.jobs.list(),
  }),
  defineQuery({
    name: 'changes.list',
    summary: '最近的改动：auto 是自动关联、Pixiv 补充和撤回，move 是移动到文件夹（重启后也能撤回）',
    input: ListChangesInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/changes' }],
    run: (e, q) => e.changes.list(q.group),
  }),
  defineQuery({
    name: 'history.undoStatus',
    summary: '一批撤销令牌现在的状态：live 还能撤销、undone 撤销过、expired 不在了',
    input: UndoStatusInput,
    scope: 'read',
    http: [
      { method: 'GET', path: '/api/undo/status' },
      // 一次问的令牌多时地址太长，POST 一直留着
      { method: 'POST', path: '/api/undo/status' },
    ],
    run: (e, q) => ({ status: Object.fromEntries(q.tokens.map((t) => [t, e.ctx.undo.status(t)])) }),
  }),
  defineQuery({
    name: 'audit.list',
    summary: '审计记录：谁（user / assistant / job:<任务> / device:<设备>）执行了哪个命令、结果、撤销令牌、变了哪些事实；新的在前',
    input: AuditInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/audit' }],
    run: (e, q) => ({
      items: e.registry.audit.list(q).map((r) => ({
        id: r.id,
        at: r.at,
        command: r.command,
        actor: r.actor,
        // 手机等设备：界面上显示设备名称（撤销了的设备也还有名字）
        ...(r.actor.startsWith('device:') ? { actorName: e.access.devices.get(r.actor.slice(7))?.name ?? null } : {}),
        status: r.status,
        message: r.message,
        undoToken: r.undo_token,
        changes: r.changes ? (JSON.parse(r.changes) as string[]) : [],
        error: r.error,
      })),
    }),
  }),
  defineQuery({
    name: 'commands.catalog',
    summary: '命令和查询的清单：名字、说明、scope、是否可撤销、是否支持 operationId、HTTP 地址',
    input: EmptyInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/commands' }],
    run: (e) => e.registry.catalog(),
  }),

  // ---------------------------------------------------------------- 设置页
  defineQuery({
    name: 'settings.taggerModels',
    summary: '可选的识别模型（设置页的下拉框）',
    input: EmptyInput,
    scope: 'settings',
    http: [{ method: 'GET', path: '/api/tagger/models' }],
    run: () =>
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
  }),
  defineQuery({
    name: 'system.networkCheck',
    summary: '连一下 Danbooru、Hugging Face 和国内镜像，排查同步失败（真的会联网）',
    input: EmptyInput,
    scope: 'settings',
    http: [
      { method: 'GET', path: '/api/system/network-check' },
      { method: 'POST', path: '/api/system/network-check', legacy: true },
    ],
    run: () => checkNetwork(),
  }),
];
