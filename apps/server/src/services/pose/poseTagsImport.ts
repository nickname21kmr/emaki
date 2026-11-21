/**
 * 导入原型算好的姿势标签低分（F:/Claude/.work/pose-proto/out/posewear_v2/pose_tags_lowthr.npz，retag_low.py merge 的输出），
 * 这个图库就不用再跑「补充姿势标签」。npz 里：ids（图 id）、tags（姿势标签名）、scores（每张 × 每个标签，≥ 0.17 的分数，其余是 0，float16）、
 * model（每张图用的识别模型）。只导本图库里有的图；已经按这张图现在的识别模型收过的不覆盖（再导一次结果不变）；
 * 写的时候只留名单里、分数在 [0.17, 一般标签阈值) 的（达到阈值的已经是普通标签）。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { PoseTagsImportResult } from '@emaki/shared';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { readSettings } from '../../datasource/sqlite/settings.ts';
import { POSE_TAGS, writePoseTagsLow, type PoseLowRow } from '../../domain/evidence/poseTags.ts';
import { parseNpy, readZipEntries, type NpyArray } from '../../infra/npz.ts';

const CANDIDATES = ['F:/Claude/.work/pose-proto/out/posewear_v2/pose_tags_lowthr.npz'];

/** 开发机上有原型的文件就给默认路径 */
export const localPoseTagsNpz = (): string | null => CANDIDATES.find((p) => existsSync(p)) ?? null;

/** 字符串数组（numpy 的 <U）：读得出来就用，读不出来是 null */
function strings(entries: Map<string, Buffer>, key: string): string[] | null {
  const b = entries.get(`${key}.npy`);
  if (!b) return null;
  try {
    return (parseNpy(b) as NpyArray & { strings?: string[] }).strings ?? null;
  } catch {
    return null;
  }
}

export async function importPoseTagsLow(ctx: SqliteContext, file: string): Promise<Omit<PoseTagsImportResult, 'message'>> {
  const entries = readZipEntries(await readFile(file));
  const need = (key: string): NpyArray => {
    const b = entries.get(`${key}.npy`);
    if (!b) throw new Error(`${file} 里没有 ${key}（不是 pose_tags_lowthr.npz？）`);
    return parseNpy(b);
  };
  const ids = need('ids');
  const scores = need('scores');
  const n = ids.shape[0] ?? 0;
  const T = scores.shape[1] ?? 0;
  if (scores.shape[0] !== n) throw new Error('ids 和 scores 的行数对不上');
  // 标签名：npz 里的；读不出来时按随仓库的名单（原型就是用它生成的，个数要对上）
  const tags = strings(entries, 'tags') ?? (T === POSE_TAGS.length ? [...POSE_TAGS] : null);
  if (!tags || tags.length !== T) throw new Error(`标签数（${tags?.length ?? '?'}）和分数的列数（${T}）对不上`);
  const models = strings(entries, 'model');

  const db = ctx.db;
  const t = readSettings(db).tagger;
  const idList = Array.from({ length: n }, (_, i) => Number(ids.data[i]!));
  const have = new Map(
    (
      db
        .prepare(
          `SELECT i.id, i.tagger_model AS model, c.model AS checked FROM images i LEFT JOIN image_pose_tags_checked c ON c.image_id = i.id
           WHERE i.id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(idList)) as { id: number; model: string | null; checked: string | null }[]
    ).map((r) => [r.id, r]),
  );
  const rows: PoseLowRow[] = [];
  let missing = 0;
  let skipped = 0;
  for (let i = 0; i < n; i++) {
    const img = have.get(idList[i]!);
    if (!img) {
      missing++;
      continue;
    }
    const current = img.model ?? t.model;
    // 已经按现在的识别模型收过（识别时顺便收的、补充任务补的、上次导入的）：不覆盖
    if (img.checked === current) {
      skipped++;
      continue;
    }
    const low: [string, number][] = [];
    for (let k = 0; k < T; k++) {
      const s = Number(scores.data[i * T + k]!);
      if (s > 0) low.push([tags[k]!, s]);
    }
    rows.push({ imageId: idList[i]!, model: models?.[i] || current, low });
  }
  const now = new Date(ctx.clock()).toISOString();
  let written = 0;
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    ctx.apply(() => {
      written += writePoseTagsLow(db, chunk, t.generalThreshold, now);
    });
  }
  const withTags = rows.length ? (db.prepare('SELECT COUNT(DISTINCT image_id) FROM image_pose_tags_low WHERE image_id IN (SELECT value FROM json_each(?))').pluck().get(JSON.stringify(rows.map((r) => r.imageId))) as number) : 0;
  return { imported: rows.length, withTags, tags: written, missing, skipped };
}
