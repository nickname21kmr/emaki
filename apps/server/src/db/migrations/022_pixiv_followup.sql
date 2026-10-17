-- 自建角色的建议改用真外键：角色被合并或删除时建议跟着清掉，编号复用后不会指到别的角色。
-- danbooru_tag 仍写 'emaki:character:<id>'，只当主键占位，读的时候看 character_id。
ALTER TABLE character_suggestions ADD COLUMN character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE;
UPDATE character_suggestions SET character_id = CAST(substr(danbooru_tag, 17) AS INTEGER)
  WHERE danbooru_tag LIKE 'emaki:character:%'
    AND danbooru_tag = 'emaki:character:' || CAST(substr(danbooru_tag, 17) AS INTEGER)
    -- 伪标签只会指向自建角色；编号已经被识别器新建的 Danbooru 角色占用的，不能挂过去
    AND CAST(substr(danbooru_tag, 17) AS INTEGER) IN (SELECT id FROM characters WHERE danbooru_tag IS NULL);
-- 角色已经不在的伪标签行没法再对上，删掉
DELETE FROM character_suggestions WHERE danbooru_tag LIKE 'emaki:character:%' AND character_id IS NULL;
CREATE INDEX idx_character_suggestions_character ON character_suggestions(character_id) WHERE character_id IS NOT NULL;

-- 上一次 Pixiv 补充的结果：linked / original / suggested / unmatched / unavailable / skipped
ALTER TABLE pixiv_character_checks ADD COLUMN result TEXT;
