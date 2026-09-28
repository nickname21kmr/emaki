-- T25.5：区分手动封面和自动封面；记录图库文件夹首次导入的时间
-- 以前 tagger 把角色第一张被识别的图写成 cover_image_id，自动兜底永远不生效。
-- 只有「不等于最早关联的那张图」的封面才可能是用户设的，其余全部清空，交给自动选图。
ALTER TABLE characters ADD COLUMN cover_manual INTEGER NOT NULL DEFAULT 0;
UPDATE characters SET cover_manual = 1
WHERE cover_image_id IS NOT NULL
  AND cover_image_id IS NOT (SELECT ic.image_id FROM image_characters ic
                             WHERE ic.character_id = characters.id ORDER BY ic.added_at, ic.rowid LIMIT 1);
UPDATE characters SET cover_image_id = NULL, cover_focus_x = NULL, cover_focus_y = NULL WHERE cover_manual = 0;

-- 首页「刚导入」状态用：扫描器在文件夹第一次扫描开始时写入
ALTER TABLE library_roots ADD COLUMN imported_at TEXT;
UPDATE library_roots SET imported_at = (SELECT MIN(COALESCE(i.thumb_at, i.added_at)) FROM images i WHERE i.root_id = library_roots.id);
