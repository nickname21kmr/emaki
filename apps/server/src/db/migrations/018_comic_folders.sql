-- 图库文件夹里的子文件夹按漫画导入（用户 2026-10-09）：漫画在已有的图库文件夹里面时，不用再单独加一个图库文件夹。
-- 范围里的页直接归漫画、不跑识别，每个子文件夹成一本；comic_rating 给没识别过的页用。见 services/classify/comicAreas.ts
CREATE TABLE comic_folders (
  root_id      INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
  rel_dir      TEXT    NOT NULL,
  comic_rating TEXT    NOT NULL DEFAULT 'general',
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (root_id, rel_dir)
) WITHOUT ROWID;
