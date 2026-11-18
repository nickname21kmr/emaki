-- P4b（D5，docs/core-architecture.md 第 13 节）：「动图」不再是内容类型，拆成独立的维度「是否动图」（images.animated，分析模块的派生列）。
-- 类型只剩插画 / 漫画 / 截图 / 照片 / 文字 / 表情，互斥；一张图可以既是插画又是动图。
--
-- 1. 是否动图：按帧数、格式派生，和 services/classify/rules.ts 的 isAnimated 是同一条规则（db/animated.migration.test.ts 逐种核对）——
--    HTML 逐帧动画一律算；读过帧数的看帧数（> 1）；还没读过帧数的 GIF 先算动图（缩略图任务读到帧数后由分析模块按帧数改），其余先算静态。
--    所有图都判一遍：原来按文件夹判成表情、截图的动图（表情包文件夹里的 GIF）这里也算动图。
-- 2. 原来类型是 animated 的图（自动判的和手动选的）：类型交给分析模块按新规则重判。这里先放成插画占位、清掉判定依据和版本
--    （content_kind_version = NULL）；启动时类型判定的版本（CLASSIFIER_VERSION 1 → 2）对不上，classifyStale 重判版本过期的行：
--    动的插画判插画，动的表情判表情。
--    手动选的 animated：本意是「这是动图」，改成自动类型（content_kind_manual = 0），是否动图照第 1 条按帧数。
--    帧数显示其实不是动图的（单帧、没读过帧数的 PNG / WebP），手动选的这个意思就没有了；核对 SQL（scripts/verify-migration-038.sql）列出张数。
-- 3. 别的图（版本 1、类型不是 animated）：新规则只是去掉了「GIF / 多帧 → animated」这一条，没被它判中的图按新规则结果一样，
--    直接记成版本 2，启动时不整库重判（10 万张多花几秒，还会把按旧版本判好的结果全部重写一遍）。
-- 4. 首页统计的覆盖索引加上 animated（统计里数动图张数不用回表）；按「是否动图」筛选、按入库时间排序走一个只含动图的部分索引。
--
-- 不动任何决定（角色、原创、放下、收藏、分级、手动来源……）和证据；只改 animated、原来是 animated 的图的类型列、类型判定的版本号。

ALTER TABLE images ADD COLUMN animated INTEGER NOT NULL DEFAULT 0 CHECK (animated IN (0, 1));

UPDATE images SET animated = 1
WHERE format = 'html' OR frame_count > 1 OR (frame_count IS NULL AND format = 'gif');

UPDATE images
SET content_kind = 'illustration', content_kind_source = NULL, content_kind_evidence = NULL, content_kind_version = NULL, content_kind_manual = 0
WHERE content_kind = 'animated';

UPDATE images SET content_kind_version = 2 WHERE content_kind_version = 1;

DROP INDEX IF EXISTS idx_images_live_stats;
CREATE INDEX idx_images_live_stats
  ON images(root_id, excluded_by, content_kind, collection_id, shelved_at, tagged_at, added_at, bytes, original_at, animated)
  WHERE trashed_at IS NULL AND missing = 0;

CREATE INDEX idx_images_animated_live ON images(added_at, id) WHERE animated = 1 AND trashed_at IS NULL AND missing = 0;
