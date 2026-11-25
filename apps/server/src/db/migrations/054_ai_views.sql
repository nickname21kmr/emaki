-- 插件 E4（docs/plugins.md 5.1）：AI 助手做的页面也存成装的插件，来源是 ai。
-- SQLite 改不了 CHECK，照原样重建 installed_plugins（列、数据不变，只多认一种来源）。
CREATE TABLE installed_plugins_new (
  id TEXT PRIMARY KEY,
  manifest TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('file', 'folder', 'git', 'ai')),
  -- 文件名、文件夹的路径、git 地址；ai 是「AI 助手」
  source TEXT NOT NULL,
  -- git 的分支或标签
  source_ref TEXT,
  package_dir TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO installed_plugins_new (id, manifest, source_kind, source, source_ref, package_dir, installed_at, updated_at)
  SELECT id, manifest, source_kind, source, source_ref, package_dir, installed_at, updated_at FROM installed_plugins;
DROP TABLE installed_plugins;
ALTER TABLE installed_plugins_new RENAME TO installed_plugins;
