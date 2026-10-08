-- 画师手动拆开 / 合并（用户 2026-10-08）：自动合并按 Danbooru 资料猜，猜错了用户改。
-- group_tag 为 NULL = 这个标签单独算一个人（不并到别人）；不为 NULL = 并到这个标签所在的人
CREATE TABLE artist_links (
  tag        TEXT PRIMARY KEY,
  group_tag  TEXT,
  created_at TEXT NOT NULL
) WITHOUT ROWID;
