-- P4a（docs/core-architecture.md 第 12 节，附录 #23）：派生数据的版本统一记在一张表里；删掉没人读写的 image_fingerprints。
--
-- derived_versions：每种能整体重算的派生数据（name）上次整体重算用的版本（propagation/versions.ts）。
--   source          文件名解析出的来源：规则版本 + 投稿号的识别方式，原来记在 settings 的 sourceParserVersion、sourceParserMode 两个键里，
--                   原样搬过来（两个键都在才搬；缺一个说明上次没按现在的办法记过，下次启动整体重算一次），搬完删掉这两个键
--   classification  自动类型、主题、画质分（CLASSIFIER_VERSION）：不记，下次启动按每行的 content_kind_version 重算过期的行再记下
--   collections     按文件夹成册的判定（DETECTOR_VERSION）：不记，下次启动全量重判一次再记下
-- image_fingerprints（迁移 012）：查重复核用的细指纹，代码里早就不读也不写了。
--
-- 不动 images 和任何决定、证据：图片、关联、来源、类型一行不变。

CREATE TABLE derived_versions (
  name       TEXT PRIMARY KEY,
  version    TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

INSERT INTO derived_versions (name, version, updated_at)
SELECT 'source', CAST(json_extract(v.value, '$') AS TEXT) || ':' || json_extract(m.value, '$'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM settings v JOIN settings m ON m.key = 'sourceParserMode'
WHERE v.key = 'sourceParserVersion' AND json_valid(v.value) AND json_valid(m.value);

DELETE FROM settings WHERE key IN ('sourceParserVersion', 'sourceParserMode');

DROP TABLE image_fingerprints;
