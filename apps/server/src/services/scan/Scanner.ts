/**
 * 扫描器：把启用的图库文件夹同步进 images 表。只读文件头并算 sha256，不解码像素（那是 T04）。
 *
 * - 新文件 → 插入
 * - 内容变化 → 原地更新（保留 id，角色 / 收藏 / 排除都还在），清空像素和打标签结果
 * - 移动 / 改名（跨目录、跨根都算）→ 只改路径，保留 id
 * - 文件消失 → missing = 1（不删行）；根目录不可访问、子目录读失败、扫描被取消时绝不做丢失判定
 * - 读不了的文件写进 scan_errors，文件没变之前不再重试
 */
import { readFile, stat } from 'node:fs/promises';
import type { EventBus } from '../../core/events.ts';
import type { JobContext } from '../../core/jobs.ts';
import type { Db } from '../../db/connection.ts';
import { normalizeRootPath } from '../../datasource/sqlite/settings.ts';
import { sha256Buffer, sha256File } from '../fs/hash.ts';
import { baseName, isoFromMs, parentRel, pathKey, toAbs } from '../fs/paths.ts';
import { walkImages, type WalkEntry } from '../fs/walk.ts';
import { probeImage } from '../image/probe.ts';
import { backfillClassification } from '../classify/backfill.ts';
import { ComicAreas } from '../classify/comicAreas.ts';
import { classifyContent, CLASSIFIER_VERSION } from '../classify/rules.ts';
import { backfillSources } from '../source/backfill.ts';
import { parseSource } from '../source/parseSource.ts';
import type { ScanRequests, ScanScope } from './ScanRequests.ts';

export interface ScanSummary {
  added: number;
  updated: number;
  moved: number;
  missing: number;
  restored: number;
  errors: number;
  deferred: number;
  unreachable: string[];
  newIds: number[];
}

export interface DiskEntry extends WalkEntry {
  rootId: number;
}

export interface DbRow {
  id: number;
  root_id: number;
  rel_path: string;
  file_name: string;
  bytes: number;
  modified_at: string;
  sha256: string;
  missing: number;
  trashed_at: string | null;
}

export interface Classified {
  changed: { row: DbRow; entry: DiskEntry }[];
  fresh: DiskEntry[];
  gone: DbRow[];
  restored: number[];
}

const fileKey = (rootId: number, relPath: string) => `${rootId}\n${relPath}`;
const MAX_BUFFERED = 64 * 1024 * 1024; // 64 MiB 以内整个读进内存（sha + probe 共用一份）
const FLUSH_ROWS = 200;
const FLUSH_MS = 1000;
const EMIT_MS = 3000;

/** 纯函数：对比磁盘和库，分出 changed / fresh / gone / restored */
export function classify(
  disk: Map<string, DiskEntry>,
  dbRows: DbRow[],
  failedDirs: Map<number, string[]>,
  scanErrors: Map<string, { bytes: number; modified_at: string }>,
): Classified {
  const out: Classified = { changed: [], fresh: [], gone: [], restored: [] };
  const seen = new Set<string>();
  const underFailed = (row: DbRow) =>
    (failedDirs.get(row.root_id) ?? []).some((d) => d === '' || row.rel_path.startsWith(d + '/'));

  for (const row of dbRows) {
    const k = fileKey(row.root_id, row.rel_path);
    const entry = disk.get(k);
    if (!entry) {
      if (!underFailed(row)) out.gone.push(row);
      continue;
    }
    seen.add(k);
    if (row.bytes === entry.bytes && row.modified_at === isoFromMs(entry.mtimeMs)) {
      if (row.missing || row.trashed_at) out.restored.push(row.id);
    } else {
      out.changed.push({ row, entry });
    }
  }
  for (const [k, entry] of disk) {
    if (seen.has(k)) continue;
    const err = scanErrors.get(k);
    if (err && err.bytes === entry.bytes && err.modified_at === isoFromMs(entry.mtimeMs)) continue; // 没变，不再重试
    out.fresh.push(entry);
  }
  return out;
}

export function formatScanSummary(s: ScanSummary): string {
  let msg = `扫描完成：新增 ${s.added} · 更新 ${s.updated} · 移动 ${s.moved} · 丢失 ${s.missing} · 无法读取 ${s.errors}`;
  if (s.restored) msg += ` · 恢复 ${s.restored}`;
  if (s.deferred) msg += ` · 延后 ${s.deferred}`;
  if (s.unreachable.length) msg += ` · 无法访问：${s.unreachable.join('、')}`;
  return msg;
}

interface RootRow {
  id: number;
  path: string;
  last_scan_at: string | null;
}

type Op =
  | { t: 'insert'; p: Record<string, unknown> }
  | { t: 'content'; p: Record<string, unknown> }
  | { t: 'meta'; p: Record<string, unknown> }
  | { t: 'move'; p: Record<string, unknown> }
  | { t: 'error'; p: Record<string, unknown> };

export class Scanner {
  private readonly settleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly d: {
      db: Db;
      bus: EventBus;
      dataDir: string;
      requests: ScanRequests;
      /** T17：在每批写入的同一个事务里，对新插入的图应用排除规则 */
      onNewImagesInTx?: (ids: number[]) => void;
      /** 「刚修改过、可能还在写入」的判定窗口，默认 2000 ms；单元测试传 0 */
      settleMs?: number;
      now?: () => number;
      /** 测试注入：替换遍历（模拟读取失败）；默认 walkImages */
      walk?: typeof walkImages;
    },
  ) {
    this.settleMs = d.settleMs ?? 2000;
    this.now = d.now ?? Date.now;
  }

  /** 从 goneIds 里去掉其实还在、或者这时判断不了的（根不可访问、读出错但不是 ENOENT） */
  private async confirmGone(goneIds: Set<number>, rows: DbRow[], rootById: Map<number, RootRow>): Promise<void> {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const rootOk = new Map<number, boolean>();
    const ids = [...goneIds];
    for (let i = 0; i < ids.length; i += 32) {
      await Promise.all(
        ids.slice(i, i + 32).map(async (id) => {
          const row = byId.get(id);
          const root = row && rootById.get(row.root_id);
          if (!row || !root) return;
          if (!rootOk.has(root.id)) rootOk.set(root.id, await stat(root.path).then((x) => x.isDirectory(), () => false));
          if (!rootOk.get(root.id)) {
            goneIds.delete(id);
            return;
          }
          const gone = await stat(toAbs(root.path, row.rel_path)).then(
            () => false,
            (err: NodeJS.ErrnoException) => err.code === 'ENOENT' || err.code === 'ENOTDIR',
          );
          if (!gone) goneIds.delete(id);
        }),
      );
    }
  }

  async scan(ctx: JobContext): Promise<ScanSummary> {
    const { db } = this.d;
    const summary: ScanSummary = { added: 0, updated: 0, moved: 0, missing: 0, restored: 0, errors: 0, deferred: 0, unreachable: [], newIds: [] };

    // ---- 阶段 0：请求
    const req = this.d.requests.take();
    const roots = db
      .prepare('SELECT id, path, last_scan_at FROM library_roots WHERE enabled = 1 AND removed_at IS NULL ORDER BY id')
      .all() as RootRow[];
    const rootById = new Map(roots.map((r) => [r.id, r]));
    // 按漫画导入的范围（整个图库文件夹或里面的子文件夹）：入库就归漫画、用选的分级
    let comics = ComicAreas.load(db);
    // 第一次扫描的文件夹：记下首次导入时间（开始时就写，首页能在扫描过程中进入「刚导入」状态）
    const markImported = db.prepare('UPDATE library_roots SET imported_at = ? WHERE id = ? AND imported_at IS NULL');
    for (const r of roots) if (r.last_scan_at === null) markImported.run(isoFromMs(this.now()), r.id);
    let scopes: ScanScope[] = req.full
      ? roots.map((r) => ({ rootId: r.id, relDir: '', recursive: true }))
      : req.scopes.filter((s) => rootById.has(s.rootId));

    // ---- 阶段 1：可达性（U 盘没插、网络盘断开 → 整个根跳过，不标丢失）
    const reachable = new Set<number>();
    for (const r of roots) {
      if (!scopes.some((s) => s.rootId === r.id)) continue;
      const ok = await stat(r.path).then((s) => s.isDirectory(), () => false);
      if (ok) reachable.add(r.id);
      else summary.unreachable.push(r.path);
    }
    scopes = scopes.filter((s) => reachable.has(s.rootId));

    // ---- 阶段 2：遍历
    ctx.setMessage('正在遍历文件夹…');
    const disk = new Map<string, DiskEntry>();
    const failedDirs = new Map<number, string[]>();
    let dataDirNorm: string | null = null;
    try {
      dataDirNorm = normalizeRootPath(this.d.dataDir);
    } catch {
      /* 测试里 dataDir 可能是相对路径，忽略 */
    }
    for (const scope of scopes) {
      if (ctx.signal.aborted) break;
      const root = rootById.get(scope.rootId)!;
      const rootKey = pathKey(root.path);
      const skipAbs = [
        ...(dataDirNorm ? [dataDirNorm] : []),
        ...roots.filter((o) => o.id !== root.id && pathKey(o.path).startsWith(rootKey + '/')).map((o) => o.path),
      ];
      for await (const e of (this.d.walk ?? walkImages)(root.path, {
        startRel: scope.relDir,
        recursive: scope.recursive,
        skipAbs,
        signal: ctx.signal,
        onDirError: (rel) => {
          const list = failedDirs.get(root.id) ?? [];
          list.push(rel);
          failedDirs.set(root.id, list);
        },
      })) {
        disk.set(fileKey(root.id, e.relPath), { ...e, rootId: root.id });
        if (disk.size % 500 === 0) ctx.setMessage(`正在遍历：已发现 ${disk.size} 个文件`);
      }
    }

    // ---- 阶段 3：读库
    const scopeRows = db.prepare(
      `SELECT id, root_id, rel_path, file_name, bytes, modified_at, sha256, missing, trashed_at
       FROM images
       WHERE root_id = @rootId
         AND (@prefix = '' OR substr(rel_path, 1, length(@prefix)) = @prefix)
         AND (@recursive = 1 OR instr(substr(rel_path, length(@prefix) + 1), '/') = 0)`,
    );
    const dbRows: DbRow[] = [];
    const seenIds = new Set<number>();
    for (const s of scopes) {
      const prefix = s.relDir === '' ? '' : s.relDir + '/';
      for (const r of scopeRows.all({ rootId: s.rootId, prefix, recursive: s.recursive ? 1 : 0 }) as DbRow[]) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          dbRows.push(r);
        }
      }
    }
    const missingRows = db
      .prepare('SELECT id, root_id, rel_path, file_name, bytes, modified_at, sha256, missing, trashed_at FROM images WHERE missing = 1')
      .all() as DbRow[];
    const scanErrors = new Map<string, { bytes: number; modified_at: string }>();
    for (const r of db.prepare('SELECT root_id, rel_path, bytes, modified_at FROM scan_errors').all() as {
      root_id: number;
      rel_path: string;
      bytes: number;
      modified_at: string;
    }[]) {
      scanErrors.set(fileKey(r.root_id, r.rel_path), r);
    }

    // ---- 阶段 4：分类
    const c = classify(disk, dbRows, failedDirs, scanErrors);

    // 移动候选 = 本次消失的 ∪ 全库早就丢失的
    const candidates = new Map<number, DbRow>();
    for (const r of [...c.gone, ...missingRows]) candidates.set(r.id, r);
    const goneIds = new Set(c.gone.map((r) => r.id));
    const ops: Op[] = [];
    const takeCandidate = (row: DbRow) => {
      candidates.delete(row.id);
      goneIds.delete(row.id);
    };

    // ---- 阶段 5：快速移动匹配（文件名 + 大小 + mtime，不读文件；整个目录改名走这条）
    const quick = new Map<string, DbRow[]>();
    for (const r of candidates.values()) {
      const k = `${r.file_name}\n${r.bytes}\n${r.modified_at}`;
      quick.set(k, [...(quick.get(k) ?? []), r]);
    }
    const remainingFresh: DiskEntry[] = [];
    const quickMoves: { row: DbRow; entry: DiskEntry }[] = [];
    for (const e of c.fresh) {
      const hits = quick.get(`${baseName(e.relPath)}\n${e.bytes}\n${isoFromMs(e.mtimeMs)}`)?.filter((r) => candidates.has(r.id));
      if (hits?.length === 1) {
        takeCandidate(hits[0]!);
        ops.push({ t: 'move', p: this.moveParams(hits[0]!.id, e) });
        quickMoves.push({ row: hits[0]!, entry: e });
        summary.moved++;
      } else {
        remainingFresh.push(e);
      }
    }
    // 按漫画导入的子文件夹整个改名、挪走了：设置跟过去，不然整本掉出漫画、被送去识别
    if (followComicFolders(db, quickMoves, disk)) comics = ComicAreas.load(db);

    // ---- 阶段 6：读文件（sha256 + 文件头）
    const work: ({ kind: 'changed'; row: DbRow; entry: DiskEntry } | { kind: 'fresh'; entry: DiskEntry })[] = [
      ...c.changed.map((x) => ({ kind: 'changed' as const, ...x })),
      ...remainingFresh.map((entry) => ({ kind: 'fresh' as const, entry })),
    ];
    ctx.setTotal(work.length);
    const nowIso = isoFromMs(this.now());

    const stmts = {
      insert: db.prepare(`INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256,
          source_site, source_post_id, source_artist, source_url, added_at, modified_at,
          camera, content_kind, content_kind_source, content_kind_evidence, content_kind_version, rating)
        VALUES (@rootId, @relPath, @fileName, @width, @height, @bytes, @format, @sha256,
          @site, @postId, @artist, @url, @addedAt, @modifiedAt,
          @camera, @kind, @kindSource, @kindEvidence, @kindVersion, @rating)`),
      // 内容变了要重新识别：标签、主题、质量分都清空；手动改过的类型保留（BI-14 ②：按没有标签重判）
      content: db.prepare(`UPDATE images SET width=@width, height=@height, bytes=@bytes, format=@format, sha256=@sha256, modified_at=@modifiedAt,
          dhash=NULL, dominant_color=NULL, thumb_at=NULL, decode_error=NULL, tagged_at=NULL, tagger_model=NULL,
          missing=0, trashed_at=NULL, camera=@camera, theme=NULL, art_score=NULL, content_kind_version=@kindVersion,
          content_kind=CASE WHEN content_kind_manual=1 THEN content_kind ELSE @kind END,
          content_kind_source=CASE WHEN content_kind_manual=1 THEN content_kind_source ELSE @kindSource END,
          content_kind_evidence=CASE WHEN content_kind_manual=1 THEN content_kind_evidence ELSE @kindEvidence END
        WHERE id=@id`),
      meta: db.prepare('UPDATE images SET bytes=@bytes, modified_at=@modifiedAt, missing=0, trashed_at=NULL WHERE id=@id'),
      move: db.prepare(`UPDATE images SET root_id=@rootId, rel_path=@relPath, file_name=@fileName, modified_at=@modifiedAt, missing=0, trashed_at=NULL,
          source_site=COALESCE(@site, source_site), source_post_id=COALESCE(@postId, source_post_id),
          source_artist=COALESCE(@artist, source_artist), source_url=COALESCE(@url, source_url)
        WHERE id=@id`),
      error: db.prepare(`INSERT INTO scan_errors (root_id, rel_path, bytes, modified_at, error, at) VALUES (@rootId, @relPath, @bytes, @modifiedAt, @error, @at)
        ON CONFLICT(root_id, rel_path) DO UPDATE SET bytes=excluded.bytes, modified_at=excluded.modified_at, error=excluded.error, at=excluded.at`),
    };
    // 以前读失败、这次成功入库的文件：清掉失败记录
    const clearError = db.prepare('DELETE FROM scan_errors WHERE root_id = @rootId AND rel_path = @relPath');

    let lastFlush = Date.now();
    let lastEmit = Date.now();
    const flush = async () => {
      if (!ops.length) return;
      const batch = ops.splice(0, ops.length);
      db.transaction(() => {
        const newIds: number[] = [];
        const movedIds: number[] = [];
        for (const op of batch) {
          const info = stmts[op.t].run(op.p);
          if (op.t === 'insert') {
            newIds.push(Number(info.lastInsertRowid));
            clearError.run({ rootId: op.p.rootId, relPath: op.p.relPath });
          } else if (op.t === 'move') movedIds.push(op.p.id as number);
        }
        // 移动后路径变了：用已有的标签按新路径重判类型（BI-14 ①）
        if (movedIds.length) backfillClassification(db, { ids: movedIds });
        if (newIds.length) {
          summary.newIds.push(...newIds);
          this.d.onNewImagesInTx?.(newIds); // TODO(T17)：排除规则
        }
      })();
      lastFlush = Date.now();
      if (Date.now() - lastEmit >= EMIT_MS) {
        lastEmit = Date.now();
        this.d.bus.emit({ type: 'library-changed', reason: 'scan' });
      }
      await new Promise((r) => setImmediate(r)); // 让出事件循环，HTTP / SSE 别卡住
    };

    // 按 sha + 大小找移动候选（取 id 最小的）
    const bySha = (sha: string, bytes: number) => {
      let best: DbRow | undefined;
      for (const r of candidates.values()) if (r.sha256 === sha && r.bytes === bytes && (!best || r.id < best.id)) best = r;
      return best;
    };

    let done = 0;
    const processOne = async (item: (typeof work)[number]) => {
      const e = item.entry;
      const root = rootById.get(e.rootId)!;
      const abs = toAbs(root.path, e.relPath);
      const age = this.now() - e.mtimeMs;
      // 可能还在写入：下次再看（mtime 在未来的文件——时钟不同步——不算，否则会被一直延后）
      if (age >= 0 && age < this.settleMs) {
        this.d.requests.addDirty({ rootId: e.rootId, relDir: parentRel(e.relPath), recursive: false });
        summary.deferred++;
        return;
      }
      let buf: Buffer | null = null;
      let sha: string;
      try {
        if (e.bytes <= MAX_BUFFERED) {
          buf = await readFile(abs);
          if (buf.length !== e.bytes) {
            this.d.requests.addDirty({ rootId: e.rootId, relDir: parentRel(e.relPath), recursive: false });
            summary.deferred++;
            return;
          }
          sha = sha256Buffer(buf);
        } else {
          sha = await sha256File(abs);
        }
      } catch (err) {
        ops.push({ t: 'error', p: this.errorParams(e, `读取失败：${(err as Error).message}`, nowIso) });
        summary.errors++;
        return;
      }
      let probe;
      try {
        // 优先传 Buffer：绕开 260 字符长路径问题，sharp 也不会占着文件句柄
        probe = await probeImage(buf ?? abs);
      } catch (err) {
        ops.push({ t: 'error', p: this.errorParams(e, (err as Error).message, nowIso) });
        summary.errors++;
        return;
      }
      const common = { width: probe.width, height: probe.height, bytes: e.bytes, format: probe.format, sha256: sha, modifiedAt: isoFromMs(e.mtimeMs) };
      // 入库 / 内容变化时按文件名、路径、尺寸、格式、相机判一次类型；打标签后 writer 会再按标签重判
      const cls = classifyContent({
        fileName: baseName(e.relPath),
        relPath: e.relPath,
        width: probe.width,
        height: probe.height,
        format: probe.format,
        camera: probe.camera,
        tags: null,
        comicRoot: !!comics.of(e.rootId, e.relPath),
      });
      const kindCols = { camera: probe.camera, kind: cls.kind, kindSource: cls.source, kindEvidence: cls.evidence, kindVersion: CLASSIFIER_VERSION };
      if (item.kind === 'changed') {
        if (sha === item.row.sha256) ops.push({ t: 'meta', p: { id: item.row.id, bytes: e.bytes, modifiedAt: common.modifiedAt } });
        else ops.push({ t: 'content', p: { id: item.row.id, ...common, ...kindCols } });
        summary.updated++;
      } else {
        const cand = bySha(sha, e.bytes);
        if (cand) {
          takeCandidate(cand);
          ops.push({ t: 'move', p: this.moveParams(cand.id, e) });
          summary.moved++;
        } else {
          const src = parseSource(e.relPath);
          const addedAt =
            root.last_scan_at === null ? isoFromMs(Math.min(e.birthtimeMs || e.mtimeMs, e.mtimeMs)) : nowIso;
          ops.push({
            t: 'insert',
            p: {
              rootId: e.rootId,
              relPath: e.relPath,
              fileName: baseName(e.relPath),
              ...common,
              ...kindCols,
              site: src?.site ?? null,
              postId: src?.postId ?? null,
              artist: src?.artist ?? null,
              url: src?.url ?? null,
              addedAt,
              // 按漫画导入的不识别，分级用导入时选的
              rating: comics.of(e.rootId, e.relPath)?.rating ?? 'general',
            },
          });
          summary.added++;
        }
      }
    };

    let next = 0;
    const concurrency = Math.max(1, Number(process.env.EMAKI_SCAN_CONCURRENCY ?? 2));
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < work.length && !ctx.signal.aborted) {
          const item = work[next++]!;
          await processOne(item);
          done++;
          ctx.advance(1, `${done}/${work.length} · ${baseName(item.entry.relPath)}`);
          if (ops.length >= FLUSH_ROWS || Date.now() - lastFlush >= FLUSH_MS) await flush();
        }
      }),
    );
    await flush();

    // ---- 阶段 7 / 8：丢失、恢复
    // 标丢失之前再确认一遍：根还能访问、文件确实不在了（ENOENT）才算。遍历时读不到的文件（移动硬盘中途断开又接上）
    // 这里一般能读到，就留到下次扫描，不标丢失
    if (!ctx.signal.aborted && goneIds.size) {
      ctx.setMessage(`正在确认 ${goneIds.size} 个找不到的文件…`);
      await this.confirmGone(goneIds, c.gone, rootById);
    }
    const aborted = ctx.signal.aborted;
    db.transaction(() => {
      if (!aborted && goneIds.size) {
        summary.missing = db
          .prepare('UPDATE images SET missing=1 WHERE id IN (SELECT value FROM json_each(?)) AND missing=0')
          .run(JSON.stringify([...goneIds])).changes;
      }
      if (c.restored.length) {
        db.prepare('UPDATE images SET missing=0, trashed_at=NULL WHERE id IN (SELECT value FROM json_each(?))').run(
          JSON.stringify(c.restored),
        );
        summary.restored = c.restored.length;
      }
    })();

    // ---- 阶段 9：收尾
    if (!aborted) {
      const setScan = db.prepare('UPDATE library_roots SET last_scan_at = ? WHERE id = ?');
      // 整个根都扫过（全量扫描，或新添加文件夹时的整根扫描）才更新「上次扫描」
      for (const s of scopes) if (s.relDir === '' && s.recursive) setScan.run(nowIso, s.rootId);
      // 已遍历范围里、文件已不在的 scan_errors 行删掉
      const delErr = db.prepare('DELETE FROM scan_errors WHERE root_id = ? AND rel_path = ?');
      for (const [k] of scanErrors) {
        if (disk.has(k)) continue;
        const [rootIdStr, relPath] = k.split('\n') as [string, string];
        const rootId = Number(rootIdStr);
        const covered = scopes.some(
          (s) =>
            s.rootId === rootId &&
            (s.relDir === '' || relPath.startsWith(s.relDir + '/')) &&
            (s.recursive || !relPath.slice(s.relDir ? s.relDir.length + 1 : 0).includes('/')),
        );
        if (covered) delErr.run(rootId, relPath);
      }
    }
    backfillSources(db);
    this.d.bus.emit({ type: 'library-changed', reason: 'scan' });
    return summary;
  }

  private moveParams(id: number, e: DiskEntry) {
    const src = parseSource(e.relPath);
    return {
      id,
      rootId: e.rootId,
      relPath: e.relPath,
      fileName: baseName(e.relPath),
      modifiedAt: isoFromMs(e.mtimeMs),
      site: src?.site ?? null,
      postId: src?.postId ?? null,
      artist: src?.artist ?? null,
      url: src?.url ?? null,
    };
  }

  private errorParams(e: DiskEntry, error: string, at: string) {
    return { rootId: e.rootId, relPath: e.relPath, bytes: e.bytes, modifiedAt: isoFromMs(e.mtimeMs), error, at };
  }
}

/**
 * 按漫画导入的子文件夹（comic_folders）在磁盘上改名、挪位置时跟过去：按快速移动匹配到的页投票，
 * 一半以上的页去了同一个文件夹、原来的文件夹这次一张都没有了才跟。返回改了几个
 */
export function followComicFolders(db: Db, moves: { row: DbRow; entry: DiskEntry }[], disk: Map<string, DiskEntry>): number {
  if (!moves.length) return 0;
  const folders = db.prepare('SELECT root_id, rel_dir FROM comic_folders').all() as { root_id: number; rel_dir: string }[];
  if (!folders.length) return 0;
  const live = db
    .prepare("SELECT COUNT(*) FROM images WHERE root_id = ? AND missing = 0 AND trashed_at IS NULL AND substr(rel_path, 1, length(?) + 1) = ? || '/'")
    .pluck();
  const upd = db.prepare('UPDATE OR IGNORE comic_folders SET root_id = ?, rel_dir = ? WHERE root_id = ? AND rel_dir = ?');
  let n = 0;
  for (const f of folders) {
    const prefix = `${f.rel_dir}/`;
    const votes = new Map<string, { rootId: number; dir: string; n: number }>();
    for (const { row, entry } of moves) {
      if (row.root_id !== f.root_id || !row.rel_path.startsWith(prefix)) continue;
      // 文件夹里面的相对位置不变，前面换了：'旧名/v1/1.png' → '新名/v1/1.png'
      const rest = row.rel_path.slice(f.rel_dir.length);
      if (!entry.relPath.endsWith(rest)) continue;
      const dir = entry.relPath.slice(0, -rest.length);
      const k = `${entry.rootId}\n${dir}`;
      const v = votes.get(k) ?? { rootId: entry.rootId, dir, n: 0 };
      v.n++;
      votes.set(k, v);
    }
    const best = [...votes.values()].sort((a, b) => b.n - a.n)[0];
    if (!best || best.n * 2 < (live.get(f.root_id, f.rel_dir, f.rel_dir) as number)) continue;
    if ([...disk.values()].some((e) => e.rootId === f.root_id && e.relPath.startsWith(prefix))) continue;
    n += upd.run(best.rootId, best.dir, f.root_id, f.rel_dir).changes;
  }
  return n;
}
