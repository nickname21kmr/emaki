-- 证据和决定分开（docs/core-architecture.md 第 2.1、2.3 节，P3b；附录 #7、#8、#9）。
--
-- 证据：某个来源（tagger 识别模型、pixiv 投稿标签，以后的插件来源）对一张图提出的主张，按「图片 × 来源」整体替换，只有证据模块写。
--   image_evidence      这个来源对这张图给过证据：时间、原创信号（Pixiv 投稿标了原创）
--   character_evidence  角色候选和置信度。模型：达到建议阈值的全部候选（包括已经自动关联的）；Pixiv：确认的 1、待确认的 0
--   work_evidence       作品候选（识别器按候选角色的主作品给出的作品标签），不再算进图的作品
-- 建议改成派生视图 v_character_suggestions：证据里还没关联、也没被否决的候选（不再有单独写入的建议表）。
-- 图的作品（v_image_works）只来自关联的角色、手动指定的作品（image_copyrights）和原创标记。
-- 原创是归类的决定，带来历（original_decision / original_actor / original_rule / original_evidence_provider）：
--   manual + original_at 有值 = 手动标原创；manual + original_at 为空 = 用户取消过（自动不再标回来）；
--   auto = 自动决定（Pixiv 的原创信号，rule 是规则和版本）；都为空 = 还没有决定。
--
-- 旧数据怎么转（一条不丢；对不上就整个迁移失败回滚）：
--   character_suggestions 每一行 → character_evidence（来源、标签、自建角色、分数原样），迁移后派生出来的建议和原来的一样
--   image_copyrights 有分数的（识别器写的）→ work_evidence（来源 tagger，记作品的 Danbooru 标签）
--   image_copyrights 分数为空、作品是「原创」的 → 去掉（原创作品改由 original_at 派生）
--   image_copyrights 分数为空、别的作品 → 留在 image_copyrights，作为手动指定的作品
--   原创：Pixiv 补充记下的（change_log pixiv-sync 的 originals 里有这张图和这个时间，或检查记录的结果是 original 且时间相同）→ auto / pixiv，
--         rule legacy:pixiv；其余标了原创的 → 手动；没标原创、但 Pixiv 判过原创（检查结果是 original，或那轮 Pixiv 补充被撤回了）→ 手动取消
--   证据头：识别过的图记一条 tagger；Pixiv 检查有结果（linked / original / suggested / unmatched）的记一条 pixiv，结果是 original 的带原创信号
-- change_log 的 kind 加上 auto-retract（证据不再支持时撤回的自动关联，D2）。

DROP VIEW v_image_works;

CREATE TABLE image_evidence (
  image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  provider  TEXT    NOT NULL,
  at        TEXT    NOT NULL,
  original  INTEGER NOT NULL DEFAULT 0 CHECK (original IN (0, 1)),
  PRIMARY KEY (image_id, provider)
) WITHOUT ROWID;

CREATE TABLE character_evidence (
  image_id      INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  provider      TEXT    NOT NULL,
  -- 规范化后的候选标签；Pixiv 对上自建角色时是占位标签 emaki:character:<id>，真正的引用在 character_id
  tag           TEXT    NOT NULL,
  character_id  INTEGER REFERENCES characters(id) ON DELETE CASCADE,
  score         REAL    NOT NULL,
  PRIMARY KEY (image_id, provider, tag)
) WITHOUT ROWID;
CREATE INDEX idx_character_evidence_tag ON character_evidence(tag);
CREATE INDEX idx_character_evidence_character ON character_evidence(character_id) WHERE character_id IS NOT NULL;

-- 作品候选按标签记（证据不依赖作品建没建档；作品合并、改名不用跟着改）
CREATE TABLE work_evidence (
  image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  provider  TEXT    NOT NULL,
  tag       TEXT    NOT NULL,
  score     REAL    NOT NULL,
  PRIMARY KEY (image_id, provider, tag)
) WITHOUT ROWID;
CREATE INDEX idx_work_evidence_tag ON work_evidence(tag);

-- 建议 → 角色证据（一行对一行）
INSERT INTO character_evidence (image_id, provider, tag, character_id, score)
SELECT image_id, source, danbooru_tag, character_id, score FROM character_suggestions;

-- 证据头
INSERT INTO image_evidence (image_id, provider, at, original)
SELECT id, 'tagger', tagged_at, 0 FROM images WHERE tagged_at IS NOT NULL;
INSERT INTO image_evidence (image_id, provider, at, original)
SELECT image_id, 'pixiv', checked_at, result = 'original' FROM pixiv_character_checks
WHERE checked_at IS NOT NULL AND result IN ('linked', 'original', 'suggested', 'unmatched');

-- 识别器写的作品 → 作品证据
INSERT INTO work_evidence (image_id, provider, tag, score)
SELECT x.image_id, 'tagger', COALESCE(w.danbooru_tag, 'emaki:work:' || w.id), MAX(x.score)
FROM image_copyrights x JOIN works w ON w.id = x.work_id WHERE x.score IS NOT NULL
GROUP BY x.image_id, COALESCE(w.danbooru_tag, 'emaki:work:' || w.id);

-- 原创的来历
ALTER TABLE images ADD COLUMN original_decision TEXT CHECK (original_decision IN ('manual', 'auto'));
ALTER TABLE images ADD COLUMN original_actor TEXT;
ALTER TABLE images ADD COLUMN original_rule TEXT;
ALTER TABLE images ADD COLUMN original_evidence_provider TEXT;

-- Pixiv 补充标的原创：[图, original_at]（change_log 里记下的；撤回过的那轮单独记，用来认「用户撤回了」）
CREATE TEMP TABLE _px_orig (image_id INTEGER, at TEXT, reverted INTEGER);
INSERT INTO _px_orig
SELECT CAST(o.value ->> 0 AS INTEGER), o.value ->> 2, c.reverted_at IS NOT NULL
FROM change_log c, json_each(c.payload, '$.originals') o
WHERE c.kind = 'pixiv-sync' AND json_type(c.payload, '$.originals') = 'array';

UPDATE images SET original_decision = 'auto', original_actor = 'system:migration', original_rule = 'legacy:pixiv', original_evidence_provider = 'pixiv'
WHERE original_at IS NOT NULL AND (
  EXISTS (SELECT 1 FROM _px_orig p WHERE p.image_id = images.id AND p.at = images.original_at)
  OR EXISTS (SELECT 1 FROM pixiv_character_checks c WHERE c.image_id = images.id AND c.result = 'original' AND c.checked_at = images.original_at)
);
UPDATE images SET original_decision = 'manual', original_actor = 'user'
WHERE original_at IS NOT NULL AND original_decision IS NULL;
UPDATE images SET original_decision = 'manual', original_actor = 'user'
WHERE original_at IS NULL AND (
  EXISTS (SELECT 1 FROM pixiv_character_checks c WHERE c.image_id = images.id AND c.result = 'original')
  OR EXISTS (SELECT 1 FROM _px_orig p WHERE p.image_id = images.id AND p.reverted = 1)
);

-- 不变量：建议、作品证据一条不丢；标了原创的都有来历、原创的张数不变（只加了来历列）
CREATE TEMP TABLE _ev_check (what TEXT NOT NULL, ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ev_check SELECT '建议', (SELECT COUNT(*) FROM character_evidence) = (SELECT COUNT(*) FROM character_suggestions);
INSERT INTO _ev_check SELECT '作品证据', NOT EXISTS (
  SELECT 1 FROM image_copyrights x JOIN works w ON w.id = x.work_id WHERE x.score IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM work_evidence e WHERE e.image_id = x.image_id AND e.tag = COALESCE(w.danbooru_tag, 'emaki:work:' || w.id) AND e.score >= x.score));
INSERT INTO _ev_check SELECT '原创来历', NOT EXISTS (SELECT 1 FROM images WHERE original_at IS NOT NULL AND original_decision IS NULL);

-- 手动指定的作品：只留分数为空、不是「原创」作品的行（原创作品改由 original_at 派生）
CREATE TABLE image_copyrights_v2 (
  image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  work_id   INTEGER NOT NULL REFERENCES works(id)  ON DELETE CASCADE,
  PRIMARY KEY (image_id, work_id)
) WITHOUT ROWID;
INSERT INTO image_copyrights_v2 (image_id, work_id)
SELECT icr.image_id, icr.work_id FROM image_copyrights icr JOIN works w ON w.id = icr.work_id
WHERE icr.score IS NULL AND w.danbooru_tag IS NOT 'original';
DROP TABLE image_copyrights;
ALTER TABLE image_copyrights_v2 RENAME TO image_copyrights;
CREATE INDEX idx_image_copyrights_work ON image_copyrights(work_id, image_id);

DROP TABLE character_suggestions;

-- 建议 = 证据里还没关联、也没被否决的候选。候选对应的角色：自建角色看 character_id，其余按标签找角色或合并重定向
CREATE VIEW v_character_suggestions AS
SELECT e.image_id, e.tag AS danbooru_tag, e.score, e.provider AS source, e.character_id
FROM character_evidence e
WHERE NOT EXISTS (
    SELECT 1 FROM image_characters ic WHERE ic.image_id = e.image_id AND ic.character_id = COALESCE(e.character_id,
      (SELECT c.id FROM characters c WHERE c.danbooru_tag = e.tag), (SELECT r.character_id FROM danbooru_tag_redirects r WHERE r.tag = e.tag)))
  AND NOT EXISTS (
    SELECT 1 FROM character_vetoes v WHERE v.image_id = e.image_id AND v.character_id = COALESCE(e.character_id,
      (SELECT c.id FROM characters c WHERE c.danbooru_tag = e.tag), (SELECT r.character_id FROM danbooru_tag_redirects r WHERE r.tag = e.tag)));

-- 图 → 作品：关联角色的作品 ∪ 手动指定的作品（原创图只算原创作品，迁移 030） ∪ 原创图 → 「原创」作品
CREATE VIEW v_image_works AS
  SELECT ic.image_id, cw.work_id FROM image_characters ic JOIN character_works cw ON cw.character_id = ic.character_id
  UNION
  SELECT icr.image_id, icr.work_id FROM image_copyrights icr
  WHERE NOT EXISTS (
    SELECT 1 FROM images i JOIN works w ON w.id = icr.work_id
    WHERE i.id = icr.image_id AND i.original_at IS NOT NULL AND (w.danbooru_tag IS NULL OR w.danbooru_tag <> 'original')
  )
  UNION
  SELECT i.id, w.id FROM images i JOIN works w ON w.danbooru_tag = 'original' WHERE i.original_at IS NOT NULL;

-- change_log：加上 auto-retract
CREATE TABLE change_log_v2 (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('auto-associate', 'pixiv-sync', 'move', 'auto-retract')),
  created_at  TEXT    NOT NULL,
  summary     TEXT    NOT NULL,
  payload     TEXT    NOT NULL CHECK (json_valid(payload)),
  reverted_at TEXT,
  note        TEXT
);
INSERT INTO change_log_v2 (id, kind, created_at, summary, payload, reverted_at, note)
SELECT id, kind, created_at, summary, payload, reverted_at, note FROM change_log;
DROP TABLE change_log;
ALTER TABLE change_log_v2 RENAME TO change_log;
CREATE INDEX idx_change_log_kind ON change_log(kind, id);

DROP TABLE _px_orig;
DROP TABLE _ev_check;
