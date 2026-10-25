-- 用户从某张图上去掉的角色：重新识别、调低阈值采纳建议、Pixiv 补充都不再把它加回来，也不再作为建议
CREATE TABLE character_vetoes (
  image_id     INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (image_id, character_id)
) WITHOUT ROWID;
CREATE INDEX idx_character_vetoes_character ON character_vetoes(character_id);
