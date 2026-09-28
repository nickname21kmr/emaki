-- 004：Danbooru 缓存扩展 + 中文词库 + 自建角色匹配（T11 / T12）
ALTER TABLE danbooru_tags ADD COLUMN alias_of           TEXT;     -- 已被 Danbooru alias 到的新标签名
ALTER TABLE danbooru_tags ADD COLUMN implies            TEXT;     -- JSON string[]：直接 implication 的 consequent
ALTER TABLE danbooru_tags ADD COLUMN is_deprecated      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE danbooru_tags ADD COLUMN not_found          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE danbooru_tags ADD COLUMN wiki_fetched_at    TEXT;
ALTER TABLE danbooru_tags ADD COLUMN related_fetched_at TEXT;

-- T12 导入的中文词库
CREATE TABLE tag_i18n (
  tag             TEXT PRIMARY KEY,
  category        INTEGER NOT NULL,   -- 0 general / 3 copyright / 4 character
  zh              TEXT,
  aliases         TEXT NOT NULL DEFAULT '[]',
  copyright_guess TEXT,
  post_count      INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- 反查：searchKey(名字) → 标签
CREATE TABLE tag_name_keys (
  search_key TEXT NOT NULL,
  tag        TEXT NOT NULL,
  kind       TEXT NOT NULL,           -- zh | alias | other_name | tag
  source     TEXT NOT NULL,           -- dict | danbooru
  PRIMARY KEY (search_key, tag, kind)
) WITHOUT ROWID;
CREATE INDEX idx_tag_name_keys_tag ON tag_name_keys(tag);

-- 旧标签名 → 新标签名（WD14 训练时的名字可能已被 Danbooru 改名）
CREATE TABLE tag_renames (
  old_name TEXT PRIMARY KEY,
  new_name TEXT NOT NULL,
  source   TEXT NOT NULL             -- danbooru（优先，INSERT OR REPLACE）| dict（INSERT OR IGNORE）
) WITHOUT ROWID;

CREATE TABLE custom_character_matches (
  character_id          INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  danbooru_tag          TEXT    NOT NULL,
  score                 REAL    NOT NULL,
  reason                TEXT    NOT NULL,   -- 例：'zh:圣园未花 + work:blue_archive'
  existing_character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  dismissed             INTEGER NOT NULL DEFAULT 0,
  computed_at           TEXT    NOT NULL
);
