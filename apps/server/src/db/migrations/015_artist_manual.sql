-- 手动改画师（用户 2026-10-07）：识别错了可以改。改过的图 artist_manual = 1，之后识别、补跑都不再动它的画师；
-- 手动加的画师 score 记 1（和手动标签一样）。「改回自动」清掉这个标记和 artist_checked_at，让补跑重新认。
ALTER TABLE images ADD COLUMN artist_manual INTEGER NOT NULL DEFAULT 0;
