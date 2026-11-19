/**
 * 单一写入者的允许清单：现在还在主人目录之外写表的地方（文件相对 apps/server/src）。
 *
 * 这是 P0 时如实记录的现状，只许变短：
 * - 把一处写入改成调用主人模块的命令后，删掉对应的项（不删的话 singleWriter.test.ts 会失败）；
 * - 不要往里加新项。确实绕不开时加一项并在 note 里写清原因，评审时会看到。
 *
 * 表名的写法见 sqlWrites.ts：images 按列组记成 images#<列组>，看不出列的是 images#?，表名拼出来的是 <dynamic>。
 * 各阶段要清掉的（docs/core-architecture.md 第 12 节）：P3a 已清零 image_characters、character_vetoes（只有 domain/curation/ 写）；
 * P3b 清零归类、证据、编目的表（建议改成派生视图，image_copyrights、image_artists、images 的归类和证据列都只由主人写）；
 * P4a 清零图库与文件、分析的表和列（library_roots、comic_folders、scan_errors、pending_trash*、images 的观测列和派生列只由
 * domain/library/、domain/analysis/ 写；来源解析的版本改记在 derived_versions）；P6 把其余的搬进主人目录。
 */
export interface AllowedWrite {
  file: string;
  table: string;
  note?: string;
}

export const ALLOWED_WRITES: readonly AllowedWrite[] = [
  // commands/：P6 从 SqliteDataSource.ts 搬过来的两处（改来源前记同投稿组的撤销快照；切换识别方式的撤销把设置那一项改回去）
  { file: 'commands/curation.ts', table: 'images#collections', note: '改来源前记同投稿组成员的撤销快照（u.columns）' },
  { file: 'commands/system.ts', table: 'settings', note: '切换识别方式的撤销：只把 pixivFilenameMode 改回去（u.sql）' },
  // datasource/sqlite/changeLog.ts
  { file: 'datasource/sqlite/changeLog.ts', table: 'change_log' },
  // datasource/sqlite/collections.ts
  { file: 'datasource/sqlite/collections.ts', table: '<dynamic>', note: '手选合集的角色 / 作品：collection_characters、collection_works' },
  { file: 'datasource/sqlite/collections.ts', table: 'collections' },
  { file: 'datasource/sqlite/collections.ts', table: 'images#collections' },
  // datasource/sqlite/duplicates.ts
  { file: 'datasource/sqlite/duplicates.ts', table: 'duplicate_groups' },
  // datasource/sqlite/settings.ts
  { file: 'datasource/sqlite/settings.ts', table: 'settings' },
  // datasource/sqlite/undo.ts
  { file: 'datasource/sqlite/undo.ts', table: '<dynamic>', note: '撤销回放：按记录的表名还原（UndoTable 里的表）' },
  // services/dedupe/DedupeService.ts
  { file: 'services/dedupe/DedupeService.ts', table: 'duplicate_comparisons' },
  { file: 'services/dedupe/DedupeService.ts', table: 'duplicate_groups' },
  { file: 'services/dedupe/DedupeService.ts', table: 'duplicate_members' },
  { file: 'services/dedupe/DedupeService.ts', table: 'settings' },
  // services/i18n/dict.ts
  { file: 'services/i18n/dict.ts', table: 'settings' },
];
