-- PoseWear 姿势在 Emaki 里自己匹配（实验，不再要原型的匹配结果）。主人是姿势模块（domain/pose/）。
-- 1. image_poses 多记两样：像样的人数（单人匹配只看 1 个人的图；以前提取的行是 NULL，当 1 个人算）
--    和挑出来的两个人（双人匹配用：float32，w、h，再两人各 23 个点 ×（x, y, 置信度），坐标按长边归一；没有是 NULL）。
-- 2. posewear_match_state：每张图按哪一版姿势库、用的哪一份骨架和标签匹配过。骨架、标签、低分标签换了，
--    或者姿势库升了版本，这张图就要重新匹配（「重新匹配姿势」任务按它接着做）。
ALTER TABLE image_poses ADD COLUMN npers INTEGER;
ALTER TABLE image_poses ADD COLUMN pair BLOB;

CREATE TABLE IF NOT EXISTS posewear_match_state (
  image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,             -- 姿势库版本 × 100 + 匹配代码版本（domain/pose/posewearStore.ts）
  pose_at TEXT,                         -- 用的骨架：image_poses.updated_at
  tagged_at TEXT,                       -- 用的标签：images.tagged_at
  low_at TEXT,                          -- 用的低分标签：image_pose_tags_checked.checked_at
  matched_at TEXT NOT NULL
);
