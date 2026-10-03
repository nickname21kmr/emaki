/**
 * 画师（用户 2026-10-04）：PixAI 输出里的 style 类就是 Danbooru 的画师标签。
 * 实测（画师已知的 40 张）第一名 39 张认对，认对的分数大多 0.8 以上；随手存的图大多不到 0.05。
 * 门槛按用户要求放宽一点：0.35，每张最多记 2 位（合作图）。认不出的不记，只标「跑过了」。
 *
 * 正常识别时 PixAI 顺便给出画师；旧图（WD 识别的）和这功能加上之前识别的图，由「识别画师」任务补跑。
 */
import type { JobRunner } from '../../core/jobs.ts';
import type { Db } from '../../db/connection.ts';
import { toAbs } from '../fs/paths.ts';
import { acquireTagger, releaseTagger, type TaggerLike, type TaggerStartOptions } from './client.ts';
import { ResilientTagger } from './resilient.ts';
import { ensureModelFiles } from './download.ts';
import { clampBatch, findModel } from './models.ts';
import type { HostItemResult } from './protocol.ts';

export const ARTIST_THRESHOLD = 0.35;
/** 能认画师的模型 */
export const ARTIST_MODEL = 'A1yCE/pixai-tagger-v1.0-onnx-fp16';
/** 识别完角色后，待补的少于这么多才自动接着补；多的（第一次用）要用户在设置里点 */
export const AUTO_ARTIST_MAX = 2000;

/** 记下一张图的画师（替换旧的），并标记跑过。必须在事务里调用 */
export function writeArtists(db: Db, imageId: number, artists: [string, number][], now: string): void {
  db.prepare('DELETE FROM image_artists WHERE image_id = ?').run(imageId);
  const ins = db.prepare('INSERT INTO image_artists (image_id, artist, score) VALUES (?, ?, ?)');
  for (const [a, s] of artists) ins.run(imageId, a, s);
  db.prepare('UPDATE images SET artist_checked_at = ? WHERE id = ?').run(now, imageId);
}

const PENDING = `FROM images i JOIN library_roots r ON r.id = i.root_id
  WHERE i.artist_checked_at IS NULL AND i.trashed_at IS NULL AND i.missing = 0 AND i.excluded_by IS NULL
    AND r.enabled = 1 AND r.removed_at IS NULL AND i.content_kind = 'illustration'`;

export function artistPendingCount(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) AS n ${PENDING}`).get() as { n: number }).n;
}

export interface ArtistJobDeps {
  db: Db;
  modelsDir: string;
  getDevice: () => { device: 'cpu' | 'dml'; batchSize: number };
  now?: () => number;
  /** 测试注入 */
  clientFactory?: (o: TaggerStartOptions) => Promise<TaggerLike>;
  ensureFiles?: typeof ensureModelFiles;
}

/** 「识别画师」：只给插画补跑 PixAI、只写画师，不动角色和标签。新的在前，可以随时取消，下次接着跑 */
export function createArtistJobRunner(deps: ArtistJobDeps): JobRunner {
  const { db } = deps;
  return async (ctx) => {
    const total = artistPendingCount(db);
    ctx.setTotal(total);
    if (!total) return '识别画师：没有需要补的图';
    const spec = findModel(ARTIST_MODEL)!;
    ctx.setMessage('识别画师：检查模型文件…');
    const files = await (deps.ensureFiles ?? ensureModelFiles)(spec, deps.modelsDir, { signal: ctx.signal });
    if (ctx.signal.aborted) return '识别画师：已取消';
    const { device, batchSize } = deps.getDevice();
    ctx.setMessage(device === 'dml' ? '识别画师：加载模型到显卡…' : '识别画师：加载模型…');
    const startOpts: TaggerStartOptions = {
      repo: spec.repo,
      modelPath: files.modelPath,
      labelsPath: files.labelsPath,
      device,
      batchSize: clampBatch(spec, device, batchSize),
      modelsDir: deps.modelsDir,
    };
    const factory = deps.clientFactory ?? acquireTagger;
    // 和识别任务一样的出错处理：子进程崩了按原样重开、显卡出错逐级降级、会弄崩子进程的图单独跳过
    const client = new ResilientTagger(await factory(startOpts), startOpts, factory, {
      signal: ctx.signal,
      discard: deps.clientFactory ? undefined : () => releaseTagger(),
    });
    const sel = db.prepare(`SELECT i.id, r.path AS root, i.rel_path AS rel ${PENDING} AND i.id < ? ORDER BY i.id DESC LIMIT ?`);
    const nowIso = () => new Date(deps.now?.() ?? Date.now()).toISOString();
    let before = Number.MAX_SAFE_INTEGER;
    let done = 0;
    let found = 0;
    const t0 = performance.now();
    try {
      for (;;) {
        if (ctx.signal.aborted) return `识别画师：已取消（这次补了 ${done} 张，认出 ${found} 张）`;
        if (ctx.shouldYield()) {
          ctx.requeue();
          return `识别画师：已让出（这次补了 ${done} 张）`;
        }
        const rows = sel.all(before, client.current.batchSize * 4) as { id: number; root: string; rel: string }[];
        if (!rows.length) break;
        before = rows.at(-1)!.id;
        // 一般标签和角色门槛给到 2（不可能达到），只解码画师
        let results: HostItemResult[];
        try {
          results = await client.tag(
            rows.map((r) => ({ id: r.id, path: toAbs(r.root, r.rel) })),
            { general: 2, character: 2, artist: ARTIST_THRESHOLD },
          );
        } catch (err) {
          if (ctx.signal.aborted) return `识别画师：已取消（这次补了 ${done} 张，认出 ${found} 张）`;
          throw err;
        }
        const now = nowIso();
        db.transaction(() => {
          for (const r of results) {
            // 读不了的图也标跑过，免得每次都卡在它上面；文件不在了的留给扫描器，暂时读不了的（IO）下次再试
            if (!r.ok && (r.code === 'ENOENT' || r.code === 'IO')) continue;
            const artists = r.ok ? (r.artist ?? []) : [];
            writeArtists(db, r.id, artists, now);
            if (artists.length) found++;
          }
        })();
        done += rows.length;
        const rate = done / ((performance.now() - t0) / 1000);
        const left = (total - done) / rate;
        const eta = left < 60 ? `${Math.ceil(left)} 秒` : left < 3600 ? `${Math.ceil(left / 60)} 分钟` : `${(left / 3600).toFixed(1)} 小时`;
        ctx.advance(rows.length, `识别画师：${done} / ${total} · 认出 ${found} 张 · ${rate.toFixed(1)} 张/秒 · 剩余约 ${eta}`);
      }
    } finally {
      client.close();
      releaseTagger();
    }
    return `识别画师：补了 ${done} 张，认出画师 ${found} 张`;
  };
}
