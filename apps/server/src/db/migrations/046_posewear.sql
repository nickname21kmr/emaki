-- PoseWear 姿势库（按姿势找图的第二种来源，实验）：姿势目录和每张图匹配到的姿势。主人是姿势模块（domain/pose/）。
-- PoseWear 的线稿不进仓库：用户从本机文件夹导入，图片复制到 <数据目录>/pose/posewear/，这里只记元数据。
-- 51 类（pose_classes、image_poses）不动。
-- 早先按 041–043 编号跑过的库：表已经在（IF NOT EXISTS 什么都不做），已经跑过 047 的整份跳过，免得重新建出空的旧表。
-- @skip-if-table image_posewear_members
CREATE TABLE IF NOT EXISTS posewear_poses (
  id TEXT PRIMARY KEY,                  -- full_single_P001 这样：套 + 编号
  set_id TEXT NOT NULL CHECK (set_id IN ('full_single', 'full_sexy', 'upper80v2')),
  number TEXT NOT NULL,                 -- P001
  name TEXT NOT NULL,                   -- 中文名
  category TEXT NOT NULL,               -- 坐姿、站姿、躺卧……（PoseWear 自己的分类）
  sort INTEGER NOT NULL,                -- PoseWear 里的顺序
  -- 复制进来的视角（JSON 数组：front、high、low、side、diag），小图都有
  views TEXT NOT NULL,
  -- 当代表的视角（匹配时最好用的那一张；大图只复制这一张）
  best_view TEXT NOT NULL,
  -- 导入的次数：图片地址带上它，重导后浏览器重新取
  version INTEGER NOT NULL
);

-- 每张图的主要匹配（导入匹配结果时整批替换）
CREATE TABLE IF NOT EXISTS image_posewear (
  image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  pose_id TEXT NOT NULL REFERENCES posewear_poses(id) ON DELETE CASCADE,
  distance REAL,                        -- 骨架距离（只按标签匹配的是 NULL）
  tag_score REAL,
  method TEXT NOT NULL,                 -- tags+skel、tag_only、skel_only
  rank INTEGER NOT NULL,                -- 在这个姿势里的名次（小的在前）
  view TEXT,                            -- 匹配上的视角
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_posewear_pose ON image_posewear (pose_id, rank);

-- 前三个候选（包括主要的那个），accepted 是过了阈值的
CREATE TABLE IF NOT EXISTS image_posewear_candidates (
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  pose_id TEXT NOT NULL REFERENCES posewear_poses(id) ON DELETE CASCADE,
  accepted INTEGER NOT NULL,
  distance REAL,
  tag_score REAL,
  method TEXT,
  PRIMARY KEY (image_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_image_posewear_candidates_pose ON image_posewear_candidates (pose_id);
