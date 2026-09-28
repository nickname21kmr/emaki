-- 「归为原创」（用户 2026-09-28）：未识别里画师原创角色的图，归到「原创」作品，不再算未识别。
-- original_at：用户归为原创的时间，NULL = 没归。「原创」作品的标签是 original（识别器认出 original 版权时也挂这里），第一次归为原创时没有就建。
ALTER TABLE images ADD COLUMN original_at TEXT;

-- 首页统计的覆盖索引加上 original_at（「未识别」的判断用到它），否则统计要回表
DROP INDEX IF EXISTS idx_images_live_stats;
CREATE INDEX idx_images_live_stats ON images(root_id, excluded_by, content_kind, collection_id, shelved_at, tagged_at, added_at, bytes, original_at)
  WHERE trashed_at IS NULL AND missing = 0;
