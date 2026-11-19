-- 迁移 038（D5：「动图」从内容类型里拆出来，成为独立的维度 images.animated）前后的核对。
-- 在迁移后的库上执行，先 ATTACH 迁移前自动备份的库（备份文件名里是迁移前的版本号，从 v31 升上来就是 emaki.v31.bak.sqlite）：
--   sqlite3 emaki.sqlite
--   ATTACH DATABASE 'emaki.v37.bak.sqlite' AS old;
--   .read apps/server/scripts/verify-migration-038.sql
-- 备份库只用 images 的 id、content_kind、content_kind_manual、content_kind_version、favorite、rating、rating_manual、shelved_at、
-- original_at、tagged_at（都是迁移 010 之前就有的列），所以从多早的版本一次升上来都能跑；帧数、格式、路径取迁移后的库（迁移不改这些列）。
-- 最好在迁移后启动过一次的库上跑：启动时分析模块按新规则重判原来是 animated 的图（第 2 组看它们落到哪个类型，2b 应为 0）。
-- 每条查询一行（或几行）结果，第一列是说明；理应为 0 的写在说明里。

-- 1. 总账：原来 animated 的张数 = 迁移后是动图的张数？不等就看 1d、1e 的原因
SELECT '1a 原来类型是 animated 的（全部 / 其中手动选的）', COUNT(*), COALESCE(SUM(content_kind_manual = 1), 0)
FROM old.images WHERE content_kind = 'animated';
SELECT '1b 迁移后是动图的（全部 / 计入统计的）', (SELECT COUNT(*) FROM main.images WHERE animated = 1),
  (SELECT COUNT(*) FROM main.v_counted_images WHERE animated = 1);
SELECT '1c 原来 animated、现在也是动图', COUNT(*) FROM main.images a JOIN old.images b ON b.id = a.id
WHERE b.content_kind = 'animated' AND a.animated = 1;
SELECT '1d 原来 animated、现在不是动图：' ||
  CASE WHEN a.frame_count = 1 AND a.format = 'gif' THEN '单帧 GIF（静态 GIF，以前 GIF 一律算动图）'
       WHEN a.frame_count = 1 THEN '单帧 ' || upper(a.format) || '（只可能是手动选的）'
       WHEN a.frame_count IS NULL THEN '帧数还没读过的 ' || upper(a.format) || '（缩略图任务读到帧数后按帧数判）'
       ELSE '其他（应为 0）' END,
  COUNT(*), COALESCE(SUM(b.content_kind_manual = 1), 0) AS 其中手动
FROM main.images a JOIN old.images b ON b.id = a.id
WHERE b.content_kind = 'animated' AND a.animated = 0 GROUP BY 1 ORDER BY 2 DESC;
SELECT '1e 原来不是 animated、现在是动图：原来是 ' || b.content_kind || CASE WHEN b.content_kind_manual = 1 THEN '（手动）' ELSE '' END ||
  '，' || upper(a.format) || CASE WHEN a.format = 'gif' AND a.frame_count IS NULL THEN '（帧数还没读过）' ELSE '' END,
  COUNT(*)
FROM main.images a JOIN old.images b ON b.id = a.id
WHERE b.content_kind <> 'animated' AND a.animated = 1 GROUP BY 1 ORDER BY 2 DESC;
SELECT '1f 对账：1b = 1a - 1d + 1e（应为 1）',
  (SELECT COUNT(*) FROM main.images WHERE animated = 1) =
  (SELECT COUNT(*) FROM old.images WHERE content_kind = 'animated')
  - (SELECT COUNT(*) FROM main.images a JOIN old.images b ON b.id = a.id WHERE b.content_kind = 'animated' AND a.animated = 0)
  + (SELECT COUNT(*) FROM main.images a JOIN old.images b ON b.id = a.id WHERE b.content_kind <> 'animated' AND a.animated = 1);
SELECT '1g 现在是动图、但按帧数规则不该是（应为 0）', COUNT(*) FROM main.images
WHERE animated = 1 AND NOT (format = 'html' OR frame_count > 1 OR (frame_count IS NULL AND format = 'gif'));
SELECT '1h 按帧数规则是动图、现在没标（应为 0）', COUNT(*) FROM main.images
WHERE animated = 0 AND (format = 'html' OR frame_count > 1 OR (frame_count IS NULL AND format = 'gif'));

-- 2. 原来是 animated 的图，迁移后各自落到哪个类型（启动后分析模块重判的结果）
SELECT '2a 原来 animated → 现在：' || a.content_kind || CASE WHEN a.animated = 1 THEN ' · 动图' ELSE ' · 不是动图' END ||
  '（判定依据 ' || COALESCE(a.content_kind_source, '还没重判') || '）', COUNT(*)
FROM main.images a JOIN old.images b ON b.id = a.id
WHERE b.content_kind = 'animated' GROUP BY 1 ORDER BY 2 DESC;
SELECT '2b 原来 animated、还没按新规则重判的（启动之后应为 0）', COUNT(*) FROM main.images a JOIN old.images b ON b.id = a.id
WHERE b.content_kind = 'animated' AND a.content_kind_version IS NULL;
SELECT '2c 现在还有类型 animated 的（应为 0）', COUNT(*) FROM main.images WHERE content_kind = 'animated';

-- 3. 手动类型
SELECT '3a 原来手动选 animated 的：现在是动图 / 帧数显示不是动图', COALESCE(SUM(a.animated = 1), 0), COALESCE(SUM(a.animated = 0), 0)
FROM main.images a JOIN old.images b ON b.id = a.id WHERE b.content_kind = 'animated' AND b.content_kind_manual = 1;
SELECT '3b 原来手动选 animated、现在还标着手动的（应为 0）', COUNT(*) FROM main.images a JOIN old.images b ON b.id = a.id
WHERE b.content_kind = 'animated' AND b.content_kind_manual = 1 AND a.content_kind_manual = 1;
SELECT '3c 原来手动选了别的类型：手动标记或类型变了的（应为 0）', COUNT(*) FROM main.images a JOIN old.images b ON b.id = a.id
WHERE b.content_kind <> 'animated' AND b.content_kind_manual = 1 AND (a.content_kind_manual <> 1 OR a.content_kind IS NOT b.content_kind);
SELECT '3d 原来没有手动、现在标着手动的（应为 0；迁移后用户又手动改过的除外）', COUNT(*) FROM main.images a JOIN old.images b ON b.id = a.id
WHERE b.content_kind_manual = 0 AND a.content_kind_manual = 1;
-- 帧数显示不是动图的手动 animated，逐张列出（最多 50 张）
SELECT '3e 手动 animated、帧数显示不是动图', a.id, a.rel_path, a.format, a.frame_count, a.content_kind
FROM main.images a JOIN old.images b ON b.id = a.id
WHERE b.content_kind = 'animated' AND b.content_kind_manual = 1 AND a.animated = 0 ORDER BY a.id LIMIT 50;

-- 4. 别的都不动
SELECT '4a 图片行数 原来/现在', (SELECT COUNT(*) FROM old.images), (SELECT COUNT(*) FROM main.images);
SELECT '4b 原来不是 animated、自动判的类型变了的（应为 0；迁移后重新识别过、或原来没判过类型的除外）', COUNT(*)
FROM main.images a JOIN old.images b ON b.id = a.id
WHERE b.content_kind <> 'animated' AND b.content_kind_manual = 0 AND b.content_kind_version IS NOT NULL
  AND a.tagged_at IS b.tagged_at AND a.content_kind IS NOT b.content_kind;
SELECT '4c 决定列变了的图（收藏、分级、放下、原创，应为 0；迁移后用户又改过的除外）', COUNT(*)
FROM main.images a JOIN old.images b ON b.id = a.id
WHERE a.favorite IS NOT b.favorite OR a.rating IS NOT b.rating OR a.rating_manual IS NOT b.rating_manual
   OR a.shelved_at IS NOT b.shelved_at OR a.original_at IS NOT b.original_at;
SELECT '4d 角色关联条数 原来/现在', (SELECT COUNT(*) FROM old.image_characters), (SELECT COUNT(*) FROM main.image_characters);

-- 5. 版本和索引
SELECT '5a 类型判定版本：' || COALESCE(content_kind_version, 'NULL（还没重判）'), COUNT(*) FROM main.images GROUP BY 1 ORDER BY 1;
SELECT '5b 记下的类型判定版本（启动后应为 2）', (SELECT version FROM main.derived_versions WHERE name = 'classification');
SELECT '5c 新索引在（应为 1 1）', (SELECT COUNT(*) FROM main.sqlite_master WHERE name = 'idx_images_animated_live'),
  (SELECT instr(sql, 'animated') > 0 FROM main.sqlite_master WHERE name = 'idx_images_live_stats');

-- 6. 现在的分布（计入统计的图）：各类型里有多少动图
SELECT '6 计入统计：' || content_kind, COUNT(*), COALESCE(SUM(animated), 0) AS 其中动图 FROM main.v_counted_images GROUP BY content_kind ORDER BY 2 DESC;
