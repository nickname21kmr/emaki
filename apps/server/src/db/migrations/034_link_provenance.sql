-- 统一来历（docs/core-architecture.md 第 2.2 节，P3a；附录 #5）：image_characters 的 origin / score 换成同一组来历字段。
--   decision          manual：用户做的；auto：规则做的
--   actor             user / assistant / job:<任务> / system:<步骤>；这次迁移转过来的自动关联记 system:migration
--   rule              自动决定的规则和版本（auto-accept@1、promote@1、pixiv@1、dedupe-merge@1 …）；手动的为空。自动的必须有
--   evidence_provider 依据的证据来源：tagger / pixiv；没有证据为空
--   evidence_tag      证据里的候选（规范化后的标签）；不知道为空
--   evidence_score    证据的分数；Pixiv 没有分数
--   added_at          来历的「at」：关联的时间（沿用原来的列名，索引和「最近在收」都按它）
--
-- 旧数据怎么转（一条不丢，条数不变；对不上就整个迁移失败回滚）：
--   origin='manual'              → manual，actor user。单张采纳带着的模型分数保留成证据（分数 0 是 Pixiv 建议的占位分，来源记 pixiv）
--   origin='tagger' 且有分数     → auto / tagger，rule legacy:tagger
--   origin='tagger' 且分数为空   → 依次对：
--       Pixiv 检查记录的结果是 linked，或 change_log 的 pixiv-sync 记录里有这一对 → auto / pixiv，rule legacy:pixiv
--       模型证据（image_tags 里有解析到这个角色的角色标签，即补采纳）          → auto / tagger，分数取 image_tags，rule legacy:tagger-evidence
--       都对不上                                                               → auto，来源为空，rule legacy（原样保留，可以从 rule 追溯）
-- 模型来源的行顺带补上 evidence_tag（image_tags 里解析到这个角色的标签，分数相同的优先）。

-- v_image_works 引用 image_characters：先删，重建表之后原样建回
DROP VIEW v_image_works;

-- 模型证据：每一对取一个解析到这个角色的角色标签（角色的 Danbooru 标签，或指向它的合并重定向）
CREATE TEMP TABLE _ic_tag (image_id INTEGER, character_id INTEGER, tag TEXT, score REAL, PRIMARY KEY (image_id, character_id)) WITHOUT ROWID;
INSERT INTO _ic_tag
SELECT image_id, character_id, tag, score FROM (
  SELECT ic.image_id, ic.character_id, t.name AS tag, it.score,
    ROW_NUMBER() OVER (PARTITION BY ic.image_id, ic.character_id ORDER BY (it.score IS ic.score) DESC, it.score DESC, t.name) AS rn
  FROM image_characters ic
  JOIN image_tags it ON it.image_id = ic.image_id
  JOIN tags t ON t.id = it.tag_id AND t.category = 'character'
  WHERE t.name = (SELECT c.danbooru_tag FROM characters c WHERE c.id = ic.character_id)
     OR EXISTS (SELECT 1 FROM danbooru_tag_redirects r WHERE r.tag = t.name AND r.character_id = ic.character_id)
) WHERE rn = 1;

-- Pixiv 补充记下的关联（change_log 的 pixiv-sync：links = [[图, 角色, added_at], …]，撤回过的也算）
CREATE TEMP TABLE _ic_pixiv (image_id INTEGER, character_id INTEGER, PRIMARY KEY (image_id, character_id)) WITHOUT ROWID;
INSERT OR IGNORE INTO _ic_pixiv
SELECT CAST(l.value ->> 0 AS INTEGER), CAST(l.value ->> 1 AS INTEGER)
FROM change_log c, json_each(c.payload, '$.links') l
WHERE c.kind = 'pixiv-sync' AND json_type(c.payload, '$.links') = 'array';

CREATE TABLE image_characters_v2 (
  image_id          INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  character_id      INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  decision          TEXT    NOT NULL CHECK (decision IN ('manual', 'auto')),
  actor             TEXT    NOT NULL,
  rule              TEXT,
  evidence_provider TEXT,
  evidence_tag      TEXT,
  evidence_score    REAL,
  added_at          TEXT    NOT NULL,
  PRIMARY KEY (image_id, character_id),
  -- 自动的一定有规则，手动的没有
  CHECK ((decision = 'auto') = (rule IS NOT NULL))
);

INSERT INTO image_characters_v2 (image_id, character_id, decision, actor, rule, evidence_provider, evidence_tag, evidence_score, added_at)
SELECT image_id, character_id, decision, actor, rule, provider,
  CASE WHEN provider = 'tagger' THEN etag END,
  CASE WHEN rule = 'legacy:tagger-evidence' THEN escore ELSE score END,
  added_at
FROM (
  SELECT ic.image_id, ic.character_id, ic.added_at, ic.score, et.tag AS etag, et.score AS escore,
    CASE WHEN ic.origin = 'manual' THEN 'manual' ELSE 'auto' END AS decision,
    CASE WHEN ic.origin = 'manual' THEN 'user' ELSE 'system:migration' END AS actor,
    CASE
      WHEN ic.origin = 'manual' THEN NULL
      WHEN ic.score IS NOT NULL THEN 'legacy:tagger'
      WHEN px.image_id IS NOT NULL OR pc.image_id IS NOT NULL THEN 'legacy:pixiv'
      WHEN et.tag IS NOT NULL THEN 'legacy:tagger-evidence'
      ELSE 'legacy'
    END AS rule,
    CASE
      WHEN ic.score IS NOT NULL THEN CASE WHEN ic.origin = 'manual' AND ic.score = 0 THEN 'pixiv' ELSE 'tagger' END
      WHEN ic.origin = 'manual' THEN NULL
      WHEN px.image_id IS NOT NULL OR pc.image_id IS NOT NULL THEN 'pixiv'
      WHEN et.tag IS NOT NULL THEN 'tagger'
    END AS provider
  FROM image_characters ic
  LEFT JOIN _ic_tag et ON et.image_id = ic.image_id AND et.character_id = ic.character_id
  LEFT JOIN _ic_pixiv px ON px.image_id = ic.image_id AND px.character_id = ic.character_id
  LEFT JOIN pixiv_character_checks pc ON pc.image_id = ic.image_id AND pc.result = 'linked'
);

-- 不变量：条数相同；每一对都在，关联时间不变，手动 / 自动和原来的 manual / tagger 一一对应，原来的分数原样保留。
-- 不成立就往带 CHECK 的表里写 0，整个迁移失败回滚（迁移执行器每个迁移一个事务）
CREATE TEMP TABLE _ic_check (what TEXT NOT NULL, ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ic_check SELECT '条数', (SELECT COUNT(*) FROM image_characters_v2) = (SELECT COUNT(*) FROM image_characters);
INSERT INTO _ic_check SELECT '逐条', (SELECT COUNT(*) FROM image_characters) = (
  SELECT COUNT(*) FROM image_characters ic JOIN image_characters_v2 v ON v.image_id = ic.image_id AND v.character_id = ic.character_id
  WHERE v.added_at = ic.added_at
    AND v.decision = CASE WHEN ic.origin = 'manual' THEN 'manual' ELSE 'auto' END
    AND (ic.score IS NULL OR v.evidence_score = ic.score)
);

DROP TABLE image_characters;
ALTER TABLE image_characters_v2 RENAME TO image_characters;
CREATE INDEX idx_image_characters_character ON image_characters(character_id, added_at);
CREATE INDEX idx_ic_character_image ON image_characters(character_id, image_id);

CREATE VIEW v_image_works AS
  SELECT ic.image_id, cw.work_id FROM image_characters ic JOIN character_works cw ON cw.character_id = ic.character_id
  UNION
  SELECT icr.image_id, icr.work_id FROM image_copyrights icr
  WHERE NOT EXISTS (
    SELECT 1 FROM images i JOIN works w ON w.id = icr.work_id
    WHERE i.id = icr.image_id AND i.original_at IS NOT NULL AND (w.danbooru_tag IS NULL OR w.danbooru_tag <> 'original')
  );

DROP TABLE _ic_tag;
DROP TABLE _ic_pixiv;
DROP TABLE _ic_check;
