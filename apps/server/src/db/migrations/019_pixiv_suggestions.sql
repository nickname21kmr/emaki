-- 区分自动采纳规则，防止多图投稿候选被模型阈值自动提升；不增加来源展示。
ALTER TABLE character_suggestions ADD COLUMN source TEXT NOT NULL DEFAULT 'tagger';
