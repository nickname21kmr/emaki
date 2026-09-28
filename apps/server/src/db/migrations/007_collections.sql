-- T38b：合集（本子 / 画集）。一个文件夹最多一本；图片通过 collection_id + page_no 归属。
-- kind / kind_source / origin / state / page_order 都不加 CHECK（理由同 BI-3），取值由代码校验：
--   kind 'doujin'|'artbook'；kind_source 'pages'|'name'|'manual'；origin 'auto'|'manual'；state 'active'|'dismissed'；page_order 'name'|'mtime'
-- title 为 NULL = 无题；cover_image_id 非空 = 手动封面（自动封面读取时现算）
CREATE TABLE collections (
  id INTEGER PRIMARY KEY,
  root_id INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
  rel_dir TEXT NOT NULL,
  kind TEXT NOT NULL,
  kind_source TEXT NOT NULL,
  kind_manual INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  title_manual INTEGER NOT NULL DEFAULT 0,
  event TEXT,
  circle TEXT,
  artist TEXT,
  parody TEXT,
  translator TEXT,
  series_key TEXT,
  volume_no REAL,
  series_manual INTEGER NOT NULL DEFAULT 0,
  page_order TEXT NOT NULL DEFAULT 'name',
  cover_image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  evidence TEXT,
  detector_version INTEGER NOT NULL DEFAULT 1,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (root_id, rel_dir)
);
CREATE INDEX idx_collections_series ON collections(series_key) WHERE series_key IS NOT NULL;
ALTER TABLE images ADD COLUMN collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL;
ALTER TABLE images ADD COLUMN page_no INTEGER;
CREATE INDEX idx_images_collection ON images(collection_id, page_no) WHERE collection_id IS NOT NULL;
CREATE TABLE collection_characters (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, character_id)
);
CREATE INDEX idx_collection_characters_character ON collection_characters(character_id);
CREATE TABLE collection_works (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, work_id)
);
CREATE INDEX idx_collection_works_work ON collection_works(work_id);
