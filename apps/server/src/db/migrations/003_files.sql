-- 003：文件扫描 / 像素处理需要的结构（T03、T04）

-- 像素处理（T04）完成时间：480/240 缩略图 + 主色 + dHash；NULL = 待处理
ALTER TABLE images ADD COLUMN thumb_at TEXT;
-- 像素处理失败原因；非 NULL 时后台任务跳过。文件内容变化时由扫描器清空
ALTER TABLE images ADD COLUMN decode_error TEXT;
CREATE INDEX idx_images_pixel_pending ON images(id) WHERE thumb_at IS NULL AND decode_error IS NULL;
CREATE INDEX idx_images_missing ON images(missing) WHERE missing = 1;

-- 扫描时读不了或不支持的文件。不进 images 表，避免宽高为 0 弄坏前端布局
CREATE TABLE scan_errors (
  root_id      INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
  rel_path     TEXT    NOT NULL,
  bytes        INTEGER NOT NULL,
  modified_at  TEXT    NOT NULL,
  error        TEXT    NOT NULL,
  at           TEXT    NOT NULL,
  PRIMARY KEY (root_id, rel_path)
);
