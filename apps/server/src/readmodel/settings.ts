/**
 * 设置的读模型：图库设置（settings 表，按节）加上图库文件夹（library_roots、comic_folders）和每个文件夹里计入统计的张数。
 * GET /api/settings、设置监听者（识别、Danbooru 重载配置）都读它。只有设置模块写 settings 表
 */
import type { Rating, Settings } from '@emaki/shared';
import type { SqliteContext } from '../datasource/sqlite/context.ts';
import { readSettings } from '../datasource/sqlite/settings.ts';
import { toId } from '../datasource/sqlite/sql.ts';
import { FILE_LIVE, NOT_EXCLUDED } from './terms.ts';

export function readSettingsView(ctx: SqliteContext): Settings {
  const rows = ctx
    .stmt(
      `SELECT r.id, r.path, r.enabled, r.last_scan_at, r.imported_at, r.content_mode, r.comic_rating,
         (SELECT COUNT(*) FROM images i
           WHERE i.root_id = r.id AND ${FILE_LIVE('i')} AND ${NOT_EXCLUDED('i')}) AS image_count
       FROM library_roots r
       WHERE r.removed_at IS NULL
       ORDER BY r.id`,
    )
    .all() as {
    id: number;
    path: string;
    enabled: number;
    last_scan_at: string | null;
    imported_at: string | null;
    content_mode: string;
    comic_rating: string;
    image_count: number;
  }[];
  const folders = ctx.db.prepare('SELECT root_id, rel_dir, comic_rating FROM comic_folders ORDER BY rel_dir').all() as {
    root_id: number;
    rel_dir: string;
    comic_rating: Rating;
  }[];
  return {
    libraryRoots: rows.map((r) => ({
      id: toId(r.id),
      path: r.path,
      enabled: !!r.enabled,
      imageCount: r.image_count,
      lastScanAt: r.last_scan_at,
      importedAt: r.imported_at,
      mode: r.content_mode === 'comic' ? 'comic' : 'auto',
      comicRating: r.comic_rating as Rating,
      comicFolders: folders.filter((f) => f.root_id === r.id).map((f) => ({ relDir: f.rel_dir, comicRating: f.comic_rating })),
    })),
    ...readSettings(ctx.db),
  };
}

/** 切换 Pixiv 投稿号识别方式前先数：多少张来源会变、多少张先去掉 Pixiv 建议、多少张要重新补（有缓存的不联网） */
