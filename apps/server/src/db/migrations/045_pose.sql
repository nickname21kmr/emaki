-- 按姿势找图（实验，默认关）：姿势类别和每张图的主要人物姿势。主人是姿势模块（domain/pose/）。
-- 类别随仓库分发（apps/server/assets/pose/classes.json），启动或打开功能时按版本同步进来；size 是本图库里归到这一类的张数。
-- 早先按 041 编号跑过的库表已经在，IF NOT EXISTS 什么都不做。
CREATE TABLE IF NOT EXISTS pose_classes (
  id TEXT PRIMARY KEY,                  -- full_01 这样：取景组 + 序号
  grp TEXT NOT NULL CHECK (grp IN ('full', 'mid', 'waist', 'bust')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  sort INTEGER NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  -- 原型里的代表图；只在导入原型数据、这张图也在本图库里时才有
  medoid_image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
  -- 代表骨架：float32，23 个点 ×（x, y, 置信度），给最近类别的距离用
  medoid BLOB NOT NULL,
  -- 离代表骨架超过这个距离的不算这一类（原型里每类的 95% 分位）
  cut REAL NOT NULL,
  -- 示意小人（PNG）
  figure BLOB NOT NULL,
  version INTEGER NOT NULL
);

-- 每张图一行（跑过就有，没找到能用的人物也记一行，免得反复跑）
CREATE TABLE IF NOT EXISTS image_poses (
  image_id INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  -- ok，或者没有可用人物的原因（few_points、no_person、crowd_or_panels、decode_error……）
  status TEXT NOT NULL,
  -- 取景：full / mid / waist / bust / other；没有可用人物是 NULL
  grp TEXT,
  -- 主要人物：float32，w、h，再 23 个点 ×（x, y, 置信度），坐标按长边归一
  keypoints BLOB,
  class_id TEXT REFERENCES pose_classes(id) ON DELETE SET NULL,
  -- 最近的类别（超出那一类的范围时 class_id 是 NULL，这里还记着）
  nearest_id TEXT REFERENCES pose_classes(id) ON DELETE SET NULL,
  distance REAL,
  mirror INTEGER NOT NULL DEFAULT 0,
  -- 提取和归类的版本（domain/pose/model.ts 的 POSE_VERSION）；低于当前版本的会重跑
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_poses_class ON image_poses (class_id, distance);
CREATE INDEX IF NOT EXISTS idx_image_poses_nearest ON image_poses (nearest_id);
