-- 002：查询 / 撤销 / 排除 / 识别 / 本地化需要的补充结构

-- T02：移除图库文件夹先软删除（可撤销），下次启动再真正删除
ALTER TABLE library_roots ADD COLUMN removed_at TEXT;
-- T17/T18：用户手动「恢复」的图，规则不再自动排除它
ALTER TABLE images ADD COLUMN exclude_exempt INTEGER NOT NULL DEFAULT 0;

-- T10 写入：没被自动采纳、但建议角色所属作品已存在时，图也能归到作品（见 T10.5 的「建议角色的主作品」规则）
CREATE TABLE image_copyrights (
  image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  work_id   INTEGER NOT NULL REFERENCES works(id)  ON DELETE CASCADE,
  score     REAL,
  PRIMARY KEY (image_id, work_id)
) WITHOUT ROWID;
CREATE INDEX idx_image_copyrights_work ON image_copyrights(work_id, image_id);

-- T14：合并角色后，被合并角色的 Danbooru 标签指向目标角色（否则下次打标签又把它建回来）
CREATE TABLE danbooru_tag_redirects (
  tag           TEXT    PRIMARY KEY,
  character_id  INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE
);

-- T20：general 标签在「计入张数」的图里出现的次数（缓存，由 refreshTagCounts() 重算）
ALTER TABLE tags ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0;

-- T10/T11/T12/T14：别名的来源和可见性
ALTER TABLE aliases ADD COLUMN origin   TEXT    NOT NULL DEFAULT 'user'; -- user | danbooru | dict
ALTER TABLE aliases ADD COLUMN visible  INTEGER NOT NULL DEFAULT 1;      -- 0 = 只用于搜索，不出现在 Character.aliases 里
ALTER TABLE aliases ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- T11/T14：用户改过名字 / 所属作品后，自动同步不再覆盖
ALTER TABLE characters ADD COLUMN name_locked  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN works_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE works      ADD COLUMN name_locked  INTEGER NOT NULL DEFAULT 0;

-- 可见的图：文件夹启用且未移除、未进回收站、文件还在（包括被排除的）
CREATE VIEW v_images AS
  SELECT i.* FROM images i JOIN library_roots r ON r.id = i.root_id
  WHERE r.enabled = 1 AND r.removed_at IS NULL AND i.trashed_at IS NULL AND i.missing = 0;
-- 计入「张数」的图 = 可见且未被排除
CREATE VIEW v_counted_images AS SELECT * FROM v_images WHERE excluded_by IS NULL;
-- 图 → 作品：经角色所属作品 ∪ image_copyrights（UNION 去重）
CREATE VIEW v_image_works AS
  SELECT ic.image_id, cw.work_id FROM image_characters ic JOIN character_works cw ON cw.character_id = ic.character_id
  UNION
  SELECT image_id, work_id FROM image_copyrights;
