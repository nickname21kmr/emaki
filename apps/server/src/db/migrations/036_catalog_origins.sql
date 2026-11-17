-- 编目的来历（P3b，附录 #37）：旧数据里记错的改过来，判断不了的保持原样。
--
-- 1 别名：合并角色时加给目标的「被合并角色的名字」、收拢改标签时留下的旧名字，以前记成 origin = 'user'，
--   「用户整理过别名」的判断因此把词库和 Danbooru 的别名都藏了起来。它们是编目自己加的，改成 'auto'
--   （不随词库刷新，也不算用户整理过）。
--   认法：这两处写的都是 position = 50 的角色别名；合并时被合并角色的别名整体搬给目标、position 加 1000，
--   所以条件是 position % 1000 = 50。用户编辑别名写的 position 是 0–49（最多 50 个，合并搬过去之后是 1000–1049 …），
--   词库 / Danbooru 的从 100 起、来历也不是 user，所以这个条件只会认出机器写的。作品的别名没有这样写过，不动；
--   其余的 user 别名判断不了是谁写的，保持 user。

UPDATE aliases SET origin = 'auto'
WHERE owner_type = 'character' AND origin = 'user' AND position % 1000 = 50;

-- 被藏起来的词库 / Danbooru 别名要按各自的设置重新算一遍显示不显示：改过别名来历的库，下次启动重新导入一次词库
-- （和词库更新时一样，导入后全库刷新显示名和自动别名）
DELETE FROM settings WHERE key = 'i18n.dictVersion' AND EXISTS (SELECT 1 FROM aliases WHERE origin = 'auto');
