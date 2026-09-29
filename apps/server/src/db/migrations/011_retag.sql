-- 「用主模型重新识别」（用户 2026-09-29）：未识别里已经识别过、但当时没认出角色的图，标记后交给现在的主模型和阈值再认一遍。
-- retag = 1：等着重新识别；识别写库时清零。只对这一小部分图有意义，用部分索引。
ALTER TABLE images ADD COLUMN retag INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_images_retag ON images(id) WHERE retag = 1;
