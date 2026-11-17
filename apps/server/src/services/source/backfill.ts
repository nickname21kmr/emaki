import type { ImageSource, Settings } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import { readSettings } from '../../datasource/sqlite/settings.ts';
import { writeParsedSources } from '../../domain/evidence/source.ts';
import { parseSource, SOURCE_PARSER_VERSION } from './parseSource.ts';

type Mode = Settings['tagger']['pixivFilenameMode'];

/** 一张图自动来源的变化（只列真的变了的） */
export interface SourceChange {
  id: number;
  before: { site: string | null; postId: string | null };
  after: ImageSource | null;
  /** Pixiv 投稿号变了（包括变成没有、从没有变成有） */
  pixivPostChanged: boolean;
  /** 新来源是 Pixiv 且投稿号和原来不同：要重新补 Pixiv 角色 */
  newPixivPost: string | null;
}

/** 按 mode 重算未人工确认的来源，只读：列出会变的图 */
export function diffSources(db: Db, mode: Mode): SourceChange[] {
  const out: SourceChange[] = [];
  const rows = db
    .prepare('SELECT id, rel_path, source_site, source_post_id, source_artist, source_url FROM images WHERE source_manual = 0')
    .all() as { id: number; rel_path: string; source_site: string | null; source_post_id: string | null; source_artist: string | null; source_url: string | null }[];
  for (const r of rows) {
    const s = parseSource(r.rel_path, mode);
    const same =
      (s?.site ?? null) === r.source_site && (s?.postId ?? null) === r.source_post_id && (s?.artist ?? null) === r.source_artist && (s?.url ?? null) === r.source_url;
    if (same) continue;
    const oldPixiv = r.source_site === 'pixiv' ? r.source_post_id : null;
    const newPixiv = s?.site === 'pixiv' ? (s.postId ?? null) : null;
    out.push({
      id: r.id,
      before: { site: r.source_site, postId: r.source_post_id },
      after: s,
      pixivPostChanged: oldPixiv !== newPixiv,
      newPixivPost: newPixiv !== null && newPixiv !== oldPixiv ? newPixiv : null,
    });
  }
  return out;
}

/**
 * 照 diffSources 的结果写库（证据模块写来源）。调用方开事务并声明 image.sourceChanged：
 * 投稿号变了的，过期的 Pixiv 证据和检查记录由反应 dropStalePixivEvidence 去掉（换了投稿就不再是这张图的证据）
 */
export function applySourceChanges(db: Db, changes: SourceChange[]): void {
  writeParsedSources(db, changes.map((c) => ({ id: c.id, source: c.after })));
}

/** 记下这次是按哪个规则版本、哪种模式算的 */
export function markSourcesCurrent(db: Db, mode: Mode): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('sourceParserVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(SOURCE_PARSER_VERSION));
  db.prepare("INSERT INTO settings (key, value) VALUES ('sourceParserMode', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(mode));
}

/**
 * 规则版本或解析模式变化时重算未人工确认的来源；返回来源真的变了的图。
 * 调用方在 ctx.apply 里调用并声明 image.sourceChanged（清过期的 Pixiv 建议、重新登记补充由反应做）
 */
export function backfillSources(db: Db): SourceChange[] {
  const mode = readSettings(db).tagger.pixivFilenameMode;
  const cur = db.prepare("SELECT value FROM settings WHERE key = 'sourceParserVersion'").pluck().get() as string | undefined;
  const previousMode = db.prepare("SELECT value FROM settings WHERE key = 'sourceParserMode'").pluck().get();
  if (cur !== undefined && Number(JSON.parse(cur)) === SOURCE_PARSER_VERSION && previousMode === JSON.stringify(mode)) return [];
  let changes: SourceChange[] = [];
  // 纯字符串处理，10 万行也不到 1 秒，放在一个事务里
  db.transaction(() => {
    changes = diffSources(db, mode);
    applySourceChanges(db, changes);
    markSourcesCurrent(db, mode);
  })();
  return changes;
}
