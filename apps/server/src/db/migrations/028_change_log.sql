-- 后台自动改动（自动关联 Danbooru 标签、Pixiv 补充）和「移动到文件夹」的记录。
-- payload 存撤回需要的全部信息，重启后也能撤回 / 移回原处；reverted_at 不为空表示已经撤回
CREATE TABLE change_log (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('auto-associate', 'pixiv-sync', 'move')),
  created_at  TEXT    NOT NULL,
  summary     TEXT    NOT NULL,
  payload     TEXT    NOT NULL CHECK (json_valid(payload)),
  reverted_at TEXT,
  note        TEXT
);
CREATE INDEX idx_change_log_kind ON change_log(kind, id);
