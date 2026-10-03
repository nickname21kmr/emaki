-- 画师（用户 2026-10-04）：PixAI 识别结果里的 style 类就是 Danbooru 的画师标签，分数达到门槛的记下来。
-- 认不出的不记。artist_checked_at = 已经用能认画师的模型（PixAI）跑过，没认出也算跑过；NULL 的由「识别画师」任务补跑。
CREATE TABLE image_artists (
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  artist   TEXT    NOT NULL,  -- Danbooru 标签，如 kantoku
  score    REAL    NOT NULL,
  PRIMARY KEY (image_id, artist)
) WITHOUT ROWID;
CREATE INDEX idx_image_artists_artist ON image_artists(artist, score DESC);
ALTER TABLE images ADD COLUMN artist_checked_at TEXT;
CREATE INDEX idx_images_artist_pending ON images(id) WHERE artist_checked_at IS NULL;
