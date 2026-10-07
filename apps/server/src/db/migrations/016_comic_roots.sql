-- 按漫画导入（用户 2026-10-07）：图库文件夹整个当漫画。content_mode = 'comic' 的文件夹页面直接归漫画、不跑识别，
-- 每个子文件夹成一本（本子），按卷号排。没识别就不知道分级，comic_rating 是导入时选的分级，给没识别过的页面用。
ALTER TABLE library_roots ADD COLUMN content_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE library_roots ADD COLUMN comic_rating TEXT NOT NULL DEFAULT 'general';
