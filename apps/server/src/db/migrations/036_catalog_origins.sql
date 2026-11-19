-- 编目的来历（P3b，附录 #37）：旧数据里两处记错的改过来，判断不了的保持原样。
--
-- 1 别名：合并角色时加给目标的「被合并角色的名字」、收拢改标签时留下的旧名字，以前记成 origin = 'user'，
--   「用户整理过别名」的判断因此把词库和 Danbooru 的别名都藏了起来。它们是编目自己加的，改成 'auto'
--   （不随词库刷新，也不算用户整理过）。
--   认法：这两处写的都是 position = 50 的角色别名；合并时被合并角色的别名整体搬给目标、position 加 1000，
--   所以条件是 position % 1000 = 50。用户编辑别名写的 position 是 0–49（最多 50 个，合并搬过去之后是 1000–1049 …），
--   词库 / Danbooru 的从 100 起、来历也不是 user，所以这个条件只会认出机器写的。作品的别名没有这样写过，不动；
--   其余的 user 别名判断不了是谁写的，保持 user。
--
-- 2 解绑过 Danbooru 的角色：以前手动解绑之后 source 还是 'danbooru'（只有撤回自动绑定才改回 'custom'），
--   现在解绑之后都是自建，并且记成「忽略这个匹配」，自动关联不会把用户解掉的标签再绑回去（domain/catalog/bindings.ts）。
--   旧数据里能从关联的证据认出原来的标签的（迁移 034 之后的关联都记了 evidence_tag，取这个角色身上最多的那个），
--   照现在的做法改成 custom 并记下忽略；认不出原来标签的保持原样（改成自建的话，自动关联可能把用户解掉的标签又绑回去）。

UPDATE aliases SET origin = 'auto'
WHERE owner_type = 'character' AND origin = 'user' AND position % 1000 = 50;

-- 被藏起来的词库 / Danbooru 别名要按各自的设置重新算一遍显示不显示：改过别名来历的库，下次启动重新导入一次词库
-- （和词库更新时一样，导入后全库刷新显示名和自动别名）
DELETE FROM settings WHERE key = 'i18n.dictVersion' AND EXISTS (SELECT 1 FROM aliases WHERE origin = 'auto');

CREATE TEMP TABLE _unbound (character_id INTEGER PRIMARY KEY, tag TEXT NOT NULL);
INSERT INTO _unbound
SELECT id, tag FROM (
  SELECT c.id,
    (SELECT ic.evidence_tag FROM image_characters ic
      WHERE ic.character_id = c.id AND ic.evidence_tag IS NOT NULL AND ic.evidence_tag NOT LIKE 'emaki:%'
      GROUP BY ic.evidence_tag ORDER BY count(*) DESC, ic.evidence_tag LIMIT 1) AS tag
  FROM characters c
  WHERE c.source = 'danbooru' AND c.danbooru_tag IS NULL
) WHERE tag IS NOT NULL;

INSERT INTO custom_character_matches (character_id, danbooru_tag, score, reason, existing_character_id, dismissed, computed_at)
SELECT character_id, tag, 1, 'unbound', NULL, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM _unbound WHERE true
ON CONFLICT(character_id) DO UPDATE SET danbooru_tag = excluded.danbooru_tag, dismissed = 1;

UPDATE characters SET source = 'custom' WHERE id IN (SELECT character_id FROM _unbound);

DROP TABLE _unbound;
