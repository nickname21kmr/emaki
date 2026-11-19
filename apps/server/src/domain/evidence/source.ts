/**
 * 来源（站点、投稿号、画师、链接）：文件名解析出的是证据，手动确认的是决定（images.source_manual，归类模块）。
 * 拆开存之前（P4）两者共用 images 的 source_* 列；这几列只在证据模块写，手动确认由 domain/curation/source.ts 调这里。
 * 改了来源的调用方声明 image.sourceChanged（同投稿组、过期的 Pixiv 证据、Pixiv 补充登记由反应做）。
 */
import type { ImageSource } from '@emaki/shared';
import type { Db, Statement } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { stmt } from '../tx.ts';

/** 撤销用：记下这些图的来源 */
export function snapshotSources(u: UndoRecorder, ids: number[]): void {
  u.columns('images', ['source_site', 'source_post_id', 'source_artist', 'source_url'], ids);
}

/** 写来源（手动确认 / 清除时由归类模块调用）；u 不为空时记撤销 */
export function writeSource(db: Db, u: UndoRecorder | null, id: number, src: ImageSource | null): void {
  u?.columns('images', ['source_site', 'source_post_id', 'source_artist', 'source_url'], [id]);
  stmt(db, 'UPDATE images SET source_site = ?, source_post_id = ?, source_artist = ?, source_url = ? WHERE id = ?').run(
    src?.site ?? null,
    src?.postId ?? null,
    src?.artist ?? null,
    src?.url ?? null,
    id,
  );
}

/** 按新的解析结果改来源（只改没手动确认过的）。调用方开事务 */
export function writeParsedSources(db: Db, rows: { id: number; source: ImageSource | null }[]): void {
  const upd = stmt(
    db,
    'UPDATE images SET source_site = @site, source_post_id = @postId, source_artist = @artist, source_url = @url WHERE id = @id AND source_manual = 0',
  );
  for (const r of rows) upd.run({ id: r.id, site: r.source?.site ?? null, postId: r.source?.postId ?? null, artist: r.source?.artist ?? null, url: r.source?.url ?? null });
}

/** 把一张图的来源照搬到这些图上（查重合并搬手动确认的来源时用）；u 不为空时记撤销 */
export function copySource(db: Db, u: UndoRecorder | null, targets: number[], from: number): void {
  if (!targets.length) return;
  u?.columns('images', ['source_site', 'source_post_id', 'source_artist', 'source_url'], targets);
  stmt(
    db,
    `UPDATE images SET (source_site, source_post_id, source_artist, source_url) =
       (SELECT source_site, source_post_id, source_artist, source_url FROM images WHERE id = @from)
     WHERE id IN (SELECT value FROM json_each(@ids))`,
  ).run({ from, ids: JSON.stringify(targets) });
}

/** 扫描发现图移动了：按新路径解析的来源（手动确认的不动）。给扫描器的热循环用的预编译语句 */
export function movedSourceStatement(db: Db): Statement {
  return stmt(
    db,
    `UPDATE images SET source_site=CASE WHEN source_manual=1 THEN source_site ELSE @site END,
       source_post_id=CASE WHEN source_manual=1 THEN source_post_id ELSE @postId END,
       source_artist=CASE WHEN source_manual=1 THEN source_artist ELSE @artist END,
       source_url=CASE WHEN source_manual=1 THEN source_url ELSE @url END
     WHERE id=@id`,
  );
}
