-- @foreign-keys-off
-- PoseWear 姿势库第二版（实验）：一张图在每个匹配上的姿势下都出现，不只是主要姿势；加上双人（按互动类型合并）。主人是姿势模块（domain/pose/）。
-- 1. posewear_poses 的套多一个 pair（双人），加 adult（双人的成人一类，模糊敏感图时不显示）。SQLite 改不了 CHECK，重建表。
-- 2. image_posewear（主要匹配）和 image_posewear_candidates（前三个候选）合成一张 image_posewear_members：
--    每个（图, 姿势）一行，带这个姿势里的名次、方法、是不是主要的、低置信（lowtag+skel）、差分归到哪张（双人用）。
--    旧数据搬过来：主要匹配照搬；过了阈值的其他候选没有名次，排在这个姿势的最后。重新导入匹配结果后整批替换。
-- 注意：上游 main 也有 042–044（uploads、album_sync、upload_rejected），合并时本地的 041–043 要往后挪。

CREATE TABLE posewear_poses_new (
  id TEXT PRIMARY KEY,                  -- full_single_P001、pair_P054 这样：套 + 编号（双人是代表线稿的编号）
  set_id TEXT NOT NULL CHECK (set_id IN ('full_single', 'full_sexy', 'upper80v2', 'pair')),
  number TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  sort INTEGER NOT NULL,
  views TEXT NOT NULL,
  best_view TEXT NOT NULL,
  adult INTEGER NOT NULL DEFAULT 0 CHECK (adult IN (0, 1)),
  version INTEGER NOT NULL
);
INSERT INTO posewear_poses_new (id, set_id, number, name, category, sort, views, best_view, version)
  SELECT id, set_id, number, name, category, sort, views, best_view, version FROM posewear_poses;

CREATE TABLE image_posewear_members (
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  pose_id TEXT NOT NULL REFERENCES posewear_poses(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,                -- 在这个姿势里的名次（小的在前；原型按加权分排，低置信的不单独往后挪）
  score REAL,                           -- 原型的加权分（0.6·骨架相似 + 0.4·标签分）；旧格式没有
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),  -- 单人、双人各自最像的那个
  method TEXT NOT NULL,                 -- tags+skel、lowtag+skel、tag_only、skel_only
  low INTEGER NOT NULL CHECK (low IN (0, 1)),  -- 低置信：lowtag+skel
  distance REAL,
  tag_score REAL,
  view TEXT,                            -- 匹配上的视角
  -- 双人：同一组差分（同一本合集、查重的同一组、dHash 很近）里不是最像的那张，记最像那张的 id；筛图时不单独出现
  variant_of INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (image_id, pose_id)
);

INSERT INTO image_posewear_members (image_id, pose_id, rank, is_primary, method, low, distance, tag_score, view, variant_of, updated_at)
  SELECT image_id, pose_id, rank, 1, method, method = 'lowtag+skel', distance, tag_score, view, NULL, updated_at FROM image_posewear;
INSERT OR IGNORE INTO image_posewear_members (image_id, pose_id, rank, is_primary, method, low, distance, tag_score, view, variant_of, updated_at)
  SELECT c.image_id, c.pose_id, 1000000 + c.ord, 0, COALESCE(c.method, ''), COALESCE(c.method, '') = 'lowtag+skel', c.distance, c.tag_score, NULL, NULL, m.updated_at
  FROM image_posewear_candidates c JOIN image_posewear m ON m.image_id = c.image_id
  WHERE c.accepted = 1;

DROP TABLE image_posewear_candidates;
DROP TABLE image_posewear;
DROP TABLE posewear_poses;
ALTER TABLE posewear_poses_new RENAME TO posewear_poses;

CREATE INDEX idx_image_posewear_members_pose ON image_posewear_members (pose_id, rank);
