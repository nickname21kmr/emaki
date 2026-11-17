/**
 * 单一写入者的允许清单：现在还在主人目录之外写表的地方（文件相对 apps/server/src）。
 *
 * 这是 P0 时如实记录的现状，只许变短：
 * - 把一处写入改成调用主人模块的命令后，删掉对应的项（不删的话 singleWriter.test.ts 会失败）；
 * - 不要往里加新项。确实绕不开时加一项并在 note 里写清原因，评审时会看到。
 *
 * 表名的写法见 sqlWrites.ts：images 按列组记成 images#<列组>，看不出列的是 images#?，表名拼出来的是 <dynamic>。
 * 各阶段要清掉的（docs/core-architecture.md 第 12 节）：P3a 已清零 image_characters、character_vetoes（只有 domain/curation/ 写）；
 * P3b 清零 character_suggestions、image_copyrights 和证据表；P2、P4、P6 把其余的搬进主人目录。
 */
export interface AllowedWrite {
  file: string;
  table: string;
  note?: string;
}

export const ALLOWED_WRITES: readonly AllowedWrite[] = [
  // datasource/sqlite/SqliteDataSource.ts
  { file: 'datasource/sqlite/SqliteDataSource.ts', table: 'artist_links' },
  { file: 'datasource/sqlite/SqliteDataSource.ts', table: 'character_suggestions' },
  { file: 'datasource/sqlite/SqliteDataSource.ts', table: 'collections' },
  { file: 'datasource/sqlite/SqliteDataSource.ts', table: 'comic_folders' },
  { file: 'datasource/sqlite/SqliteDataSource.ts', table: 'exclusions' },
  { file: 'datasource/sqlite/SqliteDataSource.ts', table: 'images#?', note: '列名是拼出来的或整行快照' },
  { file: 'datasource/sqlite/SqliteDataSource.ts', table: 'images#collections' },
  { file: 'datasource/sqlite/SqliteDataSource.ts', table: 'images#curation' },
  { file: 'datasource/sqlite/SqliteDataSource.ts', table: 'images#evidence' },
  { file: 'datasource/sqlite/SqliteDataSource.ts', table: 'library_roots' },
  { file: 'datasource/sqlite/SqliteDataSource.ts', table: 'pixiv_character_checks' },
  { file: 'datasource/sqlite/SqliteDataSource.ts', table: 'settings' },
  // datasource/sqlite/bulk.ts
  { file: 'datasource/sqlite/bulk.ts', table: 'image_artists' },
  { file: 'datasource/sqlite/bulk.ts', table: 'images#curation' },
  { file: 'datasource/sqlite/bulk.ts', table: 'images#evidence' },
  { file: 'datasource/sqlite/bulk.ts', table: 'images#library' },
  { file: 'datasource/sqlite/bulk.ts', table: 'works' },
  // datasource/sqlite/changeLog.ts
  { file: 'datasource/sqlite/changeLog.ts', table: 'aliases' },
  { file: 'datasource/sqlite/changeLog.ts', table: 'change_log' },
  { file: 'datasource/sqlite/changeLog.ts', table: 'character_works' },
  { file: 'datasource/sqlite/changeLog.ts', table: 'characters' },
  { file: 'datasource/sqlite/changeLog.ts', table: 'custom_character_matches' },
  { file: 'datasource/sqlite/changeLog.ts', table: 'image_copyrights' },
  { file: 'datasource/sqlite/changeLog.ts', table: 'images#curation' },
  { file: 'datasource/sqlite/changeLog.ts', table: 'images#evidence' },
  { file: 'datasource/sqlite/changeLog.ts', table: 'works' },
  // datasource/sqlite/characters.ts
  { file: 'datasource/sqlite/characters.ts', table: '<dynamic>', note: '合并角色时快照别名表：aliases、danbooru_tag_redirects 等' },
  { file: 'datasource/sqlite/characters.ts', table: 'aliases' },
  { file: 'datasource/sqlite/characters.ts', table: 'character_suggestions' },
  { file: 'datasource/sqlite/characters.ts', table: 'character_verified_forms' },
  { file: 'datasource/sqlite/characters.ts', table: 'character_verified_names' },
  { file: 'datasource/sqlite/characters.ts', table: 'character_works' },
  { file: 'datasource/sqlite/characters.ts', table: 'characters' },
  { file: 'datasource/sqlite/characters.ts', table: 'collection_characters' },
  { file: 'datasource/sqlite/characters.ts', table: 'custom_character_matches' },
  { file: 'datasource/sqlite/characters.ts', table: 'danbooru_tag_redirects' },
  { file: 'datasource/sqlite/characters.ts', table: 'works' },
  // datasource/sqlite/collections.ts
  { file: 'datasource/sqlite/collections.ts', table: '<dynamic>', note: '手选合集的角色 / 作品：collection_characters、collection_works' },
  { file: 'datasource/sqlite/collections.ts', table: 'collections' },
  { file: 'datasource/sqlite/collections.ts', table: 'images#collections' },
  // datasource/sqlite/consolidate.ts
  { file: 'datasource/sqlite/consolidate.ts', table: 'aliases' },
  { file: 'datasource/sqlite/consolidate.ts', table: 'character_works' },
  { file: 'datasource/sqlite/consolidate.ts', table: 'characters' },
  { file: 'datasource/sqlite/consolidate.ts', table: 'collection_works' },
  { file: 'datasource/sqlite/consolidate.ts', table: 'danbooru_tag_redirects' },
  { file: 'datasource/sqlite/consolidate.ts', table: 'image_copyrights' },
  { file: 'datasource/sqlite/consolidate.ts', table: 'works' },
  // datasource/sqlite/duplicates.ts
  { file: 'datasource/sqlite/duplicates.ts', table: 'duplicate_groups' },
  { file: 'datasource/sqlite/duplicates.ts', table: 'image_artists' },
  { file: 'datasource/sqlite/duplicates.ts', table: 'images#?', note: '列名是拼出来的或整行快照' },
  { file: 'datasource/sqlite/duplicates.ts', table: 'images#curation' },
  { file: 'datasource/sqlite/duplicates.ts', table: 'images#evidence' },
  { file: 'datasource/sqlite/duplicates.ts', table: 'images#library' },
  // datasource/sqlite/importImages.ts
  { file: 'datasource/sqlite/importImages.ts', table: 'images#library' },
  // datasource/sqlite/kinds.ts
  { file: 'datasource/sqlite/kinds.ts', table: 'images#analysis' },
  { file: 'datasource/sqlite/kinds.ts', table: 'images#curation' },
  // datasource/sqlite/move.ts
  { file: 'datasource/sqlite/move.ts', table: 'images#library' },
  // datasource/sqlite/organizeCollection.ts
  { file: 'datasource/sqlite/organizeCollection.ts', table: 'change_log' },
  // datasource/sqlite/pendingTrash.ts
  { file: 'datasource/sqlite/pendingTrash.ts', table: 'pending_trash' },
  { file: 'datasource/sqlite/pendingTrash.ts', table: 'pending_trash_items' },
  // datasource/sqlite/pixivChecks.ts
  { file: 'datasource/sqlite/pixivChecks.ts', table: 'pixiv_character_checks' },
  // datasource/sqlite/replaceImage.ts
  { file: 'datasource/sqlite/replaceImage.ts', table: 'images#?', note: '列名是拼出来的或整行快照' },
  // datasource/sqlite/roots.ts
  { file: 'datasource/sqlite/roots.ts', table: '<dynamic>', note: '合并 / 接管图库文件夹：images、collections 等带 root_id 的表' },
  { file: 'datasource/sqlite/roots.ts', table: 'comic_folders' },
  { file: 'datasource/sqlite/roots.ts', table: 'library_roots' },
  // datasource/sqlite/search.ts
  { file: 'datasource/sqlite/search.ts', table: 'tags' },
  // datasource/sqlite/settings.ts
  { file: 'datasource/sqlite/settings.ts', table: 'settings' },
  // datasource/sqlite/undo.ts
  { file: 'datasource/sqlite/undo.ts', table: '<dynamic>', note: '撤销回放：按记录的表名还原（UndoTable 里的表）' },
  // datasource/sqlite/unrecognized.ts
  { file: 'datasource/sqlite/unrecognized.ts', table: 'images#evidence' },
  // services/aliases.ts
  { file: 'services/aliases.ts', table: 'aliases' },
  // services/catalog/characterCatalog.ts
  { file: 'services/catalog/characterCatalog.ts', table: 'character_works' },
  { file: 'services/catalog/characterCatalog.ts', table: 'characters' },
  { file: 'services/catalog/characterCatalog.ts', table: 'works' },
  // services/classify/backfill.ts
  { file: 'services/classify/backfill.ts', table: 'images#analysis' },
  // services/classify/rootMode.ts
  { file: 'services/classify/rootMode.ts', table: 'images#curation' },
  { file: 'services/classify/rootMode.ts', table: 'images#evidence' },
  // services/danbooru/apply.ts
  { file: 'services/danbooru/apply.ts', table: 'characters' },
  // services/danbooru/catalog.ts
  { file: 'services/danbooru/catalog.ts', table: 'danbooru_tags' },
  { file: 'services/danbooru/catalog.ts', table: 'tag_name_keys' },
  { file: 'services/danbooru/catalog.ts', table: 'tag_renames' },
  // services/danbooru/matcher.ts
  { file: 'services/danbooru/matcher.ts', table: 'custom_character_matches' },
  // services/danbooru/sync.ts
  { file: 'services/danbooru/sync.ts', table: 'danbooru_artists' },
  { file: 'services/danbooru/sync.ts', table: 'tag_name_keys' },
  // services/dedupe/DedupeService.ts
  { file: 'services/dedupe/DedupeService.ts', table: 'duplicate_comparisons' },
  { file: 'services/dedupe/DedupeService.ts', table: 'duplicate_groups' },
  { file: 'services/dedupe/DedupeService.ts', table: 'duplicate_members' },
  { file: 'services/dedupe/DedupeService.ts', table: 'settings' },
  // services/i18n/dict.ts
  { file: 'services/i18n/dict.ts', table: 'settings' },
  { file: 'services/i18n/dict.ts', table: 'tag_i18n' },
  { file: 'services/i18n/dict.ts', table: 'tag_name_keys' },
  { file: 'services/i18n/dict.ts', table: 'tag_renames' },
  // services/i18n/relocalize.ts
  { file: 'services/i18n/relocalize.ts', table: 'characters' },
  { file: 'services/i18n/relocalize.ts', table: 'works' },
  // services/image/ThumbnailService.ts
  { file: 'services/image/ThumbnailService.ts', table: 'images#analysis' },
  // services/pixiv/cache.ts
  { file: 'services/pixiv/cache.ts', table: 'pixiv_artwork_cache' },
  // services/pixiv/sync.ts
  { file: 'services/pixiv/sync.ts', table: 'character_suggestions' },
  { file: 'services/pixiv/sync.ts', table: 'image_copyrights' },
  { file: 'services/pixiv/sync.ts', table: 'images#curation' },
  { file: 'services/pixiv/sync.ts', table: 'pixiv_artwork_cache' },
  { file: 'services/pixiv/sync.ts', table: 'pixiv_character_checks' },
  { file: 'services/pixiv/sync.ts', table: 'pixiv_unavailable_posts' },
  // services/scan/Scanner.ts
  { file: 'services/scan/Scanner.ts', table: 'comic_folders' },
  { file: 'services/scan/Scanner.ts', table: 'images#analysis' },
  { file: 'services/scan/Scanner.ts', table: 'images#evidence' },
  { file: 'services/scan/Scanner.ts', table: 'images#library' },
  { file: 'services/scan/Scanner.ts', table: 'library_roots' },
  { file: 'services/scan/Scanner.ts', table: 'scan_errors' },
  // services/scan/imageRow.ts
  { file: 'services/scan/imageRow.ts', table: 'images#library' },
  // services/source/backfill.ts
  { file: 'services/source/backfill.ts', table: 'character_suggestions' },
  { file: 'services/source/backfill.ts', table: 'images#evidence' },
  { file: 'services/source/backfill.ts', table: 'settings' },
  // services/tagger/artists.ts
  { file: 'services/tagger/artists.ts', table: 'image_artists' },
  { file: 'services/tagger/artists.ts', table: 'images#evidence' },
  // services/tagger/tagJob.ts
  { file: 'services/tagger/tagJob.ts', table: 'images#analysis' },
  // services/tagger/writer.ts
  { file: 'services/tagger/writer.ts', table: 'character_suggestions' },
  { file: 'services/tagger/writer.ts', table: 'image_copyrights' },
  { file: 'services/tagger/writer.ts', table: 'image_tags' },
  { file: 'services/tagger/writer.ts', table: 'images#curation' },
  { file: 'services/tagger/writer.ts', table: 'images#evidence' },
  { file: 'services/tagger/writer.ts', table: 'tags' },
];
