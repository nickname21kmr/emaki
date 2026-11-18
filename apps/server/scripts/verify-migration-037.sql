-- 迁移 037（派生数据的版本统一记在 derived_versions；删掉 image_fingerprints）前后的核对。在迁移后的库上执行，先 ATTACH 迁移前自动备份的库：
--   sqlite3 emaki.sqlite
--   ATTACH DATABASE 'emaki.v36.bak.sqlite' AS old;
--   .read apps/server/scripts/verify-migration-037.sql
-- 每条查询一行结果，第一列是说明。理应为 0 的差异都写在说明里。
-- 迁移本身不动 images 和任何决定、证据。迁移之后第一次启动会做（和 P4a 之前每次启动一样的）派生数据重算：
-- 类型判定只重算 content_kind_version 过期的行，合集全量重判一次（判定版本以前没记过）；所以下面图片只比观测列和决定列，不比类型、合集页码。

-- 1. 图片：行数一样；观测列（路径、内容、丢失、回收站）和决定列（收藏、分级、原创、放下、手动类型、手动来源）逐行不变（应为 0）
SELECT '1a 图片行数 原来/现在', (SELECT COUNT(*) FROM old.images), (SELECT COUNT(*) FROM main.images);
SELECT '1b 观测列变了的图（应为 0）', COUNT(*) FROM main.images a JOIN old.images b ON b.id = a.id
WHERE a.root_id IS NOT b.root_id OR a.rel_path IS NOT b.rel_path OR a.sha256 IS NOT b.sha256 OR a.bytes IS NOT b.bytes
   OR a.modified_at IS NOT b.modified_at OR a.missing IS NOT b.missing OR a.trashed_at IS NOT b.trashed_at;
SELECT '1c 决定列变了的图（应为 0）', COUNT(*) FROM main.images a JOIN old.images b ON b.id = a.id
WHERE a.favorite IS NOT b.favorite OR a.rating IS NOT b.rating OR a.rating_manual IS NOT b.rating_manual OR a.original_at IS NOT b.original_at
   OR a.original_decision IS NOT b.original_decision OR a.shelved_at IS NOT b.shelved_at OR a.content_kind_manual IS NOT b.content_kind_manual
   OR a.source_manual IS NOT b.source_manual OR a.artist_manual IS NOT b.artist_manual OR a.tagged_at IS NOT b.tagged_at;

-- 2. 来源解析的版本：从 settings 的两个键原样搬进 derived_versions（两个键都在才搬），搬完删掉
SELECT '2a 原来记的 版本/模式', (SELECT value FROM old.settings WHERE key = 'sourceParserVersion'), (SELECT value FROM old.settings WHERE key = 'sourceParserMode');
SELECT '2b 现在记的（应为 版本:模式）', (SELECT version FROM main.derived_versions WHERE name = 'source');
SELECT '2c 搬对了（应为 1；原来缺一个键时为 NULL，下次启动整体重算一次）',
  (SELECT version FROM main.derived_versions WHERE name = 'source') =
  CAST(json_extract((SELECT value FROM old.settings WHERE key = 'sourceParserVersion'), '$') AS TEXT) || ':' ||
  json_extract((SELECT value FROM old.settings WHERE key = 'sourceParserMode'), '$');
SELECT '2d 两个旧键还在的（应为 0）', COUNT(*) FROM main.settings WHERE key IN ('sourceParserVersion', 'sourceParserMode');
SELECT '2e 其余设置变了的（应为 0；dedupe.lastRunAt、danbooru.lastSyncAt 这类由后台任务改的除外）', COUNT(*)
FROM old.settings b LEFT JOIN main.settings s ON s.key = b.key
WHERE b.key NOT IN ('sourceParserVersion', 'sourceParserMode', 'dedupe', 'danbooru') AND s.value IS NOT b.value;

-- 3. image_fingerprints：迁移前有多少行（代码里早就不读不写）；迁移后表不在了（应为 0）
SELECT '3a 迁移前 image_fingerprints 行数', (SELECT COUNT(*) FROM old.image_fingerprints);
SELECT '3b 迁移后还在（应为 0）', COUNT(*) FROM main.sqlite_master WHERE name = 'image_fingerprints';

-- 4. 决定和证据的表行数不变（应为 0 差）
SELECT '4 行数差 关联/否决/作品/画师/证据头/角色证据/作品证据/排除/合集（手动）',
  (SELECT COUNT(*) FROM main.image_characters) - (SELECT COUNT(*) FROM old.image_characters),
  (SELECT COUNT(*) FROM main.character_vetoes) - (SELECT COUNT(*) FROM old.character_vetoes),
  (SELECT COUNT(*) FROM main.image_copyrights) - (SELECT COUNT(*) FROM old.image_copyrights),
  (SELECT COUNT(*) FROM main.image_artists) - (SELECT COUNT(*) FROM old.image_artists),
  (SELECT COUNT(*) FROM main.image_evidence) - (SELECT COUNT(*) FROM old.image_evidence),
  (SELECT COUNT(*) FROM main.character_evidence) - (SELECT COUNT(*) FROM old.character_evidence),
  (SELECT COUNT(*) FROM main.work_evidence) - (SELECT COUNT(*) FROM old.work_evidence),
  (SELECT COUNT(*) FROM main.exclusions) - (SELECT COUNT(*) FROM old.exclusions),
  (SELECT COUNT(*) FROM main.collections WHERE origin = 'manual') - (SELECT COUNT(*) FROM old.collections WHERE origin = 'manual');

-- 5. 启动之后（可选）：三种派生数据的版本都记上了；回收站规则下的「丢弃的行」有多少（用户移进回收站、文件也不在原处了）
SELECT '5a 记下的版本', group_concat(name || '=' || version, '，') FROM main.derived_versions;
SELECT '5b 丢弃的行（回收站且丢失）', COUNT(*) FROM main.images WHERE trashed_at IS NOT NULL AND missing = 1;
