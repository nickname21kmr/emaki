-- T27：图片内容类型（插画 / 漫画 / 截图 / 文字 / 照片 / 表情 / 动图）
-- 不加 CHECK：以后增减类型不用重建表（BI-3），取值由代码校验。
ALTER TABLE images ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'illustration';
ALTER TABLE images ADD COLUMN content_kind_source TEXT;             -- NULL = 还没判断过
ALTER TABLE images ADD COLUMN content_kind_evidence TEXT;           -- 判定依据（文件夹名、标签分数、尺寸、相机型号…）
ALTER TABLE images ADD COLUMN content_kind_manual INTEGER NOT NULL DEFAULT 0;  -- 1 = 用户改过，自动判断永远不覆盖
ALTER TABLE images ADD COLUMN content_kind_version INTEGER;         -- 判定时的 CLASSIFIER_VERSION
ALTER TABLE images ADD COLUMN camera TEXT;                          -- 'HUAWEI EML-AL00' = 相机；'' = 读过但不是；NULL = 没读过
ALTER TABLE images ADD COLUMN kind_signals TEXT;                    -- JSON，留给 BI-5（第一版不写）

CREATE INDEX idx_images_kind_live ON images(content_kind, added_at, id) WHERE trashed_at IS NULL AND missing = 0;

-- 只数插画的口径（角色 / 作品张数、+N、最近在收、自动封面）
CREATE VIEW v_illust_images AS SELECT * FROM v_counted_images WHERE content_kind = 'illustration';

-- T27 补充：未识别分主题
ALTER TABLE images ADD COLUMN theme TEXT;          -- NULL = 还没打标签；取值 odd|multi|swim|kemono|costume|legs|chest|other
ALTER TABLE images ADD COLUMN art_score INTEGER;   -- 像插画的程度，NULL = 还没打标签
ALTER TABLE images ADD COLUMN shelved_at TEXT;     -- 用户「放下」的时间，NULL = 没放下
