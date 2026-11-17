-- 迁移 035（证据和决定分开）前后的核对。在迁移后的库上执行，先 ATTACH 迁移前自动备份的库：
--   sqlite3 emaki.sqlite
--   ATTACH DATABASE 'emaki.v34.bak.sqlite' AS old;
--   .read apps/server/scripts/verify-migration-035.sql
-- 每条查询一行结果，第一列是说明。理应为 0 的差异都写在说明里。

-- 1. 建议：迁移后派生出来的建议（v_character_suggestions）和原来的 character_suggestions 一致
-- 1a 条数：原来的、迁移后的、原来有迁移后没有的（应为 0，除非那条建议的角色已经关联或被否决：见 1b）、迁移后多出来的（应为 0）
SELECT '1a 建议条数 原来/现在/少了/多了',
  (SELECT COUNT(*) FROM old.character_suggestions),
  (SELECT COUNT(*) FROM main.v_character_suggestions),
  (SELECT COUNT(*) FROM (SELECT image_id, danbooru_tag, score, source FROM old.character_suggestions
                         EXCEPT SELECT image_id, danbooru_tag, score, source FROM main.v_character_suggestions)),
  (SELECT COUNT(*) FROM (SELECT image_id, danbooru_tag, score, source FROM main.v_character_suggestions
                         EXCEPT SELECT image_id, danbooru_tag, score, source FROM old.character_suggestions));
-- 1b 少了的原因：角色已经关联在这张图上（原来读的时候也会滤掉）/ 被否决（原来按理不该有）/ 别的（应为 0）
SELECT '1b 少了的建议 已关联/被否决/其他',
  SUM(linked), SUM(NOT linked AND vetoed), SUM(NOT linked AND NOT vetoed)
FROM (
  SELECT s.image_id, s.danbooru_tag,
    EXISTS (SELECT 1 FROM main.image_characters ic WHERE ic.image_id = s.image_id AND ic.character_id = COALESCE(s.character_id,
      (SELECT c.id FROM main.characters c WHERE c.danbooru_tag = s.danbooru_tag),
      (SELECT r.character_id FROM main.danbooru_tag_redirects r WHERE r.tag = s.danbooru_tag))) AS linked,
    EXISTS (SELECT 1 FROM main.character_vetoes v WHERE v.image_id = s.image_id AND v.character_id = COALESCE(s.character_id,
      (SELECT c.id FROM main.characters c WHERE c.danbooru_tag = s.danbooru_tag),
      (SELECT r.character_id FROM main.danbooru_tag_redirects r WHERE r.tag = s.danbooru_tag))) AS vetoed
  FROM (SELECT image_id, danbooru_tag, score, source, character_id FROM old.character_suggestions
        EXCEPT SELECT image_id, danbooru_tag, score, source, character_id FROM main.v_character_suggestions) s
);
-- 1c 分数逐条一致：同一张图、同一个标签、同一个来源，分数不同的条数（应为 0）
SELECT '1c 分数不一致的建议', COUNT(*)
FROM old.character_suggestions o JOIN main.v_character_suggestions n
  ON n.image_id = o.image_id AND n.danbooru_tag = o.danbooru_tag AND n.source = o.source
WHERE n.score <> o.score;
-- 1d 未识别汇总里的 suggested（插画、漫画页，没放下、没角色、没归原创、不在整本处理的合集、不在漫画区，有建议）：原来/现在（应相等）
SELECT '1d 未识别 suggested 原来/现在',
  (SELECT COUNT(*) FROM old.v_counted_images i
   WHERE (i.content_kind = 'illustration' OR (i.content_kind = 'comic'
          AND COALESCE((SELECT json_extract(s.value, '$.comicInUnrecognized') FROM old.settings s WHERE s.key = 'tagger'), 1)))
     AND i.shelved_at IS NULL AND i.original_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM old.image_characters ic WHERE ic.image_id = i.id)
     AND NOT EXISTS (SELECT 1 FROM old.collections bc WHERE bc.id = i.collection_id AND bc.kind <> 'group' AND bc.state = 'active')
     AND NOT (i.root_id IN (SELECT id FROM old.library_roots WHERE content_mode = 'comic')
       OR EXISTS (SELECT 1 FROM old.comic_folders cf WHERE cf.root_id = i.root_id AND substr(i.rel_path, 1, length(cf.rel_dir) + 1) = cf.rel_dir || '/'))
     AND EXISTS (SELECT 1 FROM old.character_suggestions s WHERE s.image_id = i.id)),
  (SELECT COUNT(*) FROM main.v_counted_images i
   WHERE (i.content_kind = 'illustration' OR (i.content_kind = 'comic'
          AND COALESCE((SELECT json_extract(s.value, '$.comicInUnrecognized') FROM main.settings s WHERE s.key = 'tagger'), 1)))
     AND i.shelved_at IS NULL AND i.original_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM main.image_characters ic WHERE ic.image_id = i.id)
     AND NOT EXISTS (SELECT 1 FROM main.collections bc WHERE bc.id = i.collection_id AND bc.kind <> 'group' AND bc.state = 'active')
     AND NOT (i.root_id IN (SELECT id FROM main.library_roots WHERE content_mode = 'comic')
       OR EXISTS (SELECT 1 FROM main.comic_folders cf WHERE cf.root_id = i.root_id AND substr(i.rel_path, 1, length(cf.rel_dir) + 1) = cf.rel_dir || '/'))
     AND EXISTS (SELECT 1 FROM main.v_character_suggestions s WHERE s.image_id = i.id));
-- 1e 证据：角色证据条数 = 原来的建议条数（应相等）；按来源分
SELECT '1e 角色证据 总数/tagger/pixiv', COUNT(*), SUM(provider = 'tagger'), SUM(provider = 'pixiv') FROM main.character_evidence;

-- 2. 原创：张数前后一致；分成手动、Pixiv（自动）各多少；另有多少张记成「用户取消过」（之后 Pixiv 不会再标回来）
SELECT '2a 原创张数 原来/现在', (SELECT COUNT(*) FROM old.images WHERE original_at IS NOT NULL), (SELECT COUNT(*) FROM main.images WHERE original_at IS NOT NULL);
SELECT '2b 原创 手动/Pixiv 自动/没有来历（应为 0）',
  SUM(original_decision = 'manual'), SUM(original_decision = 'auto' AND original_evidence_provider = 'pixiv'), SUM(original_decision IS NULL)
FROM main.images WHERE original_at IS NOT NULL;
SELECT '2c 用户取消过原创（Pixiv 判过原创、现在没标）', COUNT(*) FROM main.images WHERE original_at IS NULL AND original_decision = 'manual';
SELECT '2d 原创标记的时间变了的张数（应为 0）', COUNT(*)
FROM old.images o JOIN main.images n ON n.id = o.id WHERE o.original_at IS NOT n.original_at;

-- 3. 作品：模型给的作品改成证据，不再算图的作品（附录 #8）；原创作品改由 original_at 派生
-- 3a image_copyrights 原来 有分数（识别器写的）/ 分数为空的原创作品 / 分数为空的其他作品；现在：作品证据 / 手动指定的作品
SELECT '3a 作品行 原来识别器/原来原创/原来其他手动 → 现在作品证据/现在手动',
  (SELECT COUNT(*) FROM old.image_copyrights WHERE score IS NOT NULL),
  (SELECT COUNT(*) FROM old.image_copyrights x JOIN old.works w ON w.id = x.work_id WHERE x.score IS NULL AND w.danbooru_tag = 'original'),
  (SELECT COUNT(*) FROM old.image_copyrights x JOIN old.works w ON w.id = x.work_id WHERE x.score IS NULL AND w.danbooru_tag IS NOT 'original'),
  (SELECT COUNT(*) FROM main.work_evidence),
  (SELECT COUNT(*) FROM main.image_copyrights);
-- 3b 作品统计（作品页的张数：v_image_works ∩ 插画）前后有变化的作品数、合计少了多少张、合计多了多少张
SELECT '3b 张数变了的作品 / 少了 / 多了', COUNT(*), SUM(MAX(o.n - n.n, 0)), SUM(MAX(n.n - o.n, 0))
FROM (SELECT w.id, (SELECT COUNT(*) FROM old.v_image_works x JOIN old.v_illust_images i ON i.id = x.image_id WHERE x.work_id = w.id) AS n FROM old.works w) o
JOIN (SELECT w.id, (SELECT COUNT(*) FROM main.v_image_works x JOIN main.v_illust_images i ON i.id = x.image_id WHERE x.work_id = w.id) AS n FROM main.works w) n
  ON n.id = o.id
WHERE n.n <> o.n;
-- 3c 原来算在作品里、现在不算了的（图, 作品）对，按原因分：只靠识别器的作品证据 / 原创图上分数为空的原创行（原创图仍算原创作品，不应出现）/ 其他（应为 0）
SELECT '3c 不再算的图×作品 作品证据/其他', SUM(ev), SUM(NOT ev)
FROM (
  SELECT d.image_id, d.work_id, EXISTS (SELECT 1 FROM old.image_copyrights x WHERE x.image_id = d.image_id AND x.work_id = d.work_id AND x.score IS NOT NULL) AS ev
  FROM (SELECT image_id, work_id FROM old.v_image_works EXCEPT SELECT image_id, work_id FROM main.v_image_works) d
);
-- 3d 新算进作品的（图, 作品）对（原创图在旧库没有原创作品行的；应很少）
SELECT '3d 新算进的图×作品', COUNT(*) FROM (SELECT image_id, work_id FROM main.v_image_works EXCEPT SELECT image_id, work_id FROM old.v_image_works);
-- 3e 侧栏「作品」数（有插画的作品数）原来/现在
SELECT '3e 有插画的作品数 原来/现在',
  (SELECT COUNT(DISTINCT x.work_id) FROM old.v_image_works x JOIN old.v_illust_images i ON i.id = x.image_id),
  (SELECT COUNT(DISTINCT x.work_id) FROM main.v_image_works x JOIN main.v_illust_images i ON i.id = x.image_id);
