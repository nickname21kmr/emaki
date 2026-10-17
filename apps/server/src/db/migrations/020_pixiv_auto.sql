-- 首次识别后的 Pixiv 补充任务，重启可继续，已查过的图片不反复联网。
CREATE TABLE pixiv_character_checks (
  image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  checked_at TEXT
);
