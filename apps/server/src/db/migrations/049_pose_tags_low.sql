-- 姿势标签的低分（实验，按姿势找图用）：识别时顺便记下约 186 个姿势相关的一般标签里，分数在 [0.17, 一般标签阈值) 的那些。
-- 达到阈值的照旧在 image_tags，显示和筛选都不变。主人是证据模块（domain/evidence/poseTags.ts）。
CREATE TABLE IF NOT EXISTS image_pose_tags_low (
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  PRIMARY KEY (image_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_image_pose_tags_low_tag ON image_pose_tags_low (tag_id, score);

-- 收集过低分姿势标签的图：用哪个模型、什么时候（一个也没有的图也记一行）。
-- 「补充姿势标签」只跑没有这一行、或者模型和 images.tagger_model 不一样的图
CREATE TABLE IF NOT EXISTS image_pose_tags_checked (
  image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
