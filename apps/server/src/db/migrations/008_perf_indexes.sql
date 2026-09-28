-- T22：性能索引。在真实库的快照上测出来的（8.4 万张图、240 万条 image_tags，见 docs/PERF.md）。
-- 部分索引只有查询 WHERE 字面包含 `trashed_at IS NULL AND missing = 0` 时才会用到（sql.ts 的 VISIBLE 满足），不要改写这两个条件。

-- 图片列表键集分页：排序列 + id，只含「活着」的图
CREATE INDEX idx_images_live_added    ON images(added_at, id)    WHERE trashed_at IS NULL AND missing = 0;
CREATE INDEX idx_images_live_modified ON images(modified_at, id) WHERE trashed_at IS NULL AND missing = 0;
CREATE INDEX idx_images_live_bytes    ON images(bytes, id)       WHERE trashed_at IS NULL AND missing = 0;
CREATE INDEX idx_images_live_name     ON images(file_name COLLATE NOCASE, id) WHERE trashed_at IS NULL AND missing = 0;
DROP INDEX IF EXISTS idx_images_added;

-- 首页统计一遍扫完所有活着的图：窄的覆盖索引比扫整张宽表快一倍（library.ts getStats 用 INDEXED BY 指定）
CREATE INDEX idx_images_live_stats ON images(root_id, excluded_by, content_kind, collection_id, shelved_at, tagged_at, added_at, bytes)
  WHERE trashed_at IS NULL AND missing = 0;

-- 按标签找图（画面筛选、搜索）：tag_id + 分数范围，image_id 覆盖，不回表
CREATE INDEX idx_image_tags_tag_score ON image_tags(tag_id, score, image_id);
DROP INDEX IF EXISTS idx_image_tags_tag;

-- 按角色找图不回表
CREATE INDEX idx_ic_character_image ON image_characters(character_id, image_id);

CREATE INDEX idx_duplicate_members_image   ON duplicate_members(image_id);
CREATE INDEX idx_character_suggestions_tag ON character_suggestions(danbooru_tag);

-- 统计信息：旧库的 sqlite_stat1 可能是几千张图时采的，查询计划会走错（例如 8 万张图时首页先排序全表）。
-- 之后由 refreshPlannerStats 在行数变化较大时重新采样。
ANALYZE;
