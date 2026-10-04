-- 画师的显示名和合并（用户 2026-10-04）：Danbooru 的 /artists.json 有日文名、中文名、社团、主页链接。
-- display：从 other_names 里挑的显示名（读音最对得上标签的日文 / 汉字名）；没有资料时为 NULL，界面显示标签。
-- names：其他名字和社团，规范化后的 JSON 数组（搜索、合并用）；twitter：推特账号（不带 @）。
-- alias_of：Danbooru 上改过名的旧标签指向新标签。not_found = Danbooru 上查不到这个画师。
CREATE TABLE danbooru_artists (
  name       TEXT PRIMARY KEY,
  display    TEXT,
  names      TEXT NOT NULL DEFAULT '[]',
  twitter    TEXT,
  alias_of   TEXT,
  not_found  INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL
) WITHOUT ROWID;
