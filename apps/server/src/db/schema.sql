-- Emaki 数据库结构（SQLite）。
-- 迁移规则见 db/migrate.ts：本文件是版本 1；以后改结构请新增 migrations/00N_xxx.sql，不要改这里。
--
-- 约定：
--   * 时间一律 ISO 8601 UTC 字符串（TEXT）。
--   * 布尔值用 INTEGER 0/1。
--   * 对外的 id 是 INTEGER 主键转成字符串。

CREATE TABLE library_roots (
  id            INTEGER PRIMARY KEY,
  path          TEXT    NOT NULL UNIQUE,         -- 绝对路径，正斜杠，无结尾斜杠
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_scan_at  TEXT
);

CREATE TABLE images (
  id              INTEGER PRIMARY KEY,
  root_id         INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
  rel_path        TEXT    NOT NULL,              -- 相对 root 的路径，正斜杠
  file_name       TEXT    NOT NULL,
  width           INTEGER NOT NULL,
  height          INTEGER NOT NULL,
  bytes           INTEGER NOT NULL,
  format          TEXT    NOT NULL,              -- jpeg/png/webp/gif/avif/bmp
  sha256          TEXT    NOT NULL,              -- 精确查重 + 缩略图缓存键
  dhash           TEXT,                          -- 64 位差值哈希（16 位 hex），相似查重用
  dominant_color  TEXT,                          -- #rrggbb
  rating          TEXT    NOT NULL DEFAULT 'general',
  rating_manual   INTEGER NOT NULL DEFAULT 0,    -- 用户手动改过分级后，重新打标签不再覆盖
  favorite        INTEGER NOT NULL DEFAULT 0,
  source_site     TEXT,
  source_post_id  TEXT,
  source_artist   TEXT,
  source_url      TEXT,
  added_at        TEXT    NOT NULL,              -- 第一次被扫描到的时间
  modified_at     TEXT    NOT NULL,              -- 文件 mtime
  tagged_at       TEXT,                          -- NULL = tagger 还没处理
  tagger_model    TEXT,                          -- 换模型后可以只重跑旧模型打过的
  excluded_by     INTEGER REFERENCES exclusions(id) ON DELETE SET NULL,
  missing         INTEGER NOT NULL DEFAULT 0,    -- 扫描时发现文件不在了（先标记，不立刻删，防止移动硬盘没插）
  trashed_at      TEXT,                          -- 被移到系统回收站
  UNIQUE (root_id, rel_path)
);
CREATE INDEX idx_images_added    ON images(added_at DESC);
CREATE INDEX idx_images_sha256   ON images(sha256);
CREATE INDEX idx_images_excluded ON images(excluded_by);
CREATE INDEX idx_images_untagged ON images(tagged_at) WHERE tagged_at IS NULL;

CREATE TABLE works (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,                -- 显示名（中文优先）
  danbooru_tag  TEXT    UNIQUE,                  -- copyright 标签；自建作品为 NULL
  color         TEXT,
  created_at    TEXT    NOT NULL
);

CREATE TABLE characters (
  id              INTEGER PRIMARY KEY,
  name            TEXT    NOT NULL,
  danbooru_tag    TEXT    UNIQUE,
  source          TEXT    NOT NULL CHECK (source IN ('danbooru', 'custom')),
  cover_image_id  INTEGER REFERENCES images(id) ON DELETE SET NULL,
  cover_focus_x   REAL,
  cover_focus_y   REAL,
  pinned          INTEGER NOT NULL DEFAULT 0,
  last_seen_at    TEXT,                          -- 「+N」= 在这之后新增的图
  created_at      TEXT    NOT NULL
);

CREATE TABLE character_works (
  character_id  INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  work_id       INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,      -- 0 = 主作品
  PRIMARY KEY (character_id, work_id)
);
CREATE INDEX idx_character_works_work ON character_works(work_id);

-- 别名：搜索「未花 / ミカ / mika」用。search_key = shared/search.ts 里的 searchKey(alias)
CREATE TABLE aliases (
  owner_type  TEXT    NOT NULL CHECK (owner_type IN ('character', 'work')),
  owner_id    INTEGER NOT NULL,
  alias       TEXT    NOT NULL,
  search_key  TEXT    NOT NULL,
  PRIMARY KEY (owner_type, owner_id, alias)
);
CREATE INDEX idx_aliases_search_key ON aliases(search_key);

CREATE TABLE image_characters (
  image_id      INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  character_id  INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  origin        TEXT    NOT NULL CHECK (origin IN ('tagger', 'manual')),
  score         REAL,                            -- tagger 置信度；manual 为 NULL
  added_at      TEXT    NOT NULL,
  PRIMARY KEY (image_id, character_id)
);
CREATE INDEX idx_image_characters_character ON image_characters(character_id, added_at);

-- tagger 输出的全部标签（general/character/copyright/rating 以外的都存这里）
CREATE TABLE tags (
  id        INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL UNIQUE,
  category  TEXT    NOT NULL                     -- general/character/copyright/artist/meta
);

CREATE TABLE image_tags (
  image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  score     REAL    NOT NULL,
  PRIMARY KEY (image_id, tag_id)
);
CREATE INDEX idx_image_tags_tag ON image_tags(tag_id);

-- 低于自动采纳阈值的角色候选，等「未识别」页人工确认
CREATE TABLE character_suggestions (
  image_id      INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  danbooru_tag  TEXT    NOT NULL,
  score         REAL    NOT NULL,
  PRIMARY KEY (image_id, danbooru_tag)
);

-- Danbooru 元数据缓存（离线也能用）
CREATE TABLE danbooru_tags (
  name         TEXT    PRIMARY KEY,
  category     INTEGER NOT NULL,                 -- 0 general, 1 artist, 3 copyright, 4 character, 5 meta
  post_count   INTEGER NOT NULL DEFAULT 0,
  copyrights   TEXT,                             -- JSON 数组：角色所属的 copyright 标签
  other_names  TEXT,                             -- JSON 数组：wiki 里的其他名字（日文名等）
  fetched_at   TEXT    NOT NULL
);

CREATE TABLE duplicate_groups (
  id                 INTEGER PRIMARY KEY,
  kind               TEXT    NOT NULL CHECK (kind IN ('exact', 'similar')),
  similarity         REAL    NOT NULL,
  suggested_keep_id  INTEGER REFERENCES images(id) ON DELETE SET NULL,
  resolved_at        TEXT,
  ignored            INTEGER NOT NULL DEFAULT 0, -- 用户说「不是重复」，以后不要再报
  created_at         TEXT    NOT NULL
);

CREATE TABLE duplicate_members (
  group_id  INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, image_id)
);

CREATE TABLE exclusions (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('image', 'folder', 'tag', 'character')),
  target      TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  UNIQUE (kind, target)
);

-- 键值设置，value 是 JSON。键名见 SqliteDataSource 里的 SETTINGS_KEYS
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
