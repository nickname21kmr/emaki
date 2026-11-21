-- @skip-if-column image_posewear_members.score
-- 开发途中跑过早期 047 的库，image_posewear_members 少了 score 列（047 因为表已在被跳过），这里补上
ALTER TABLE image_posewear_members ADD COLUMN score REAL;
