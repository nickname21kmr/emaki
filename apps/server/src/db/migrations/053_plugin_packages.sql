-- 装的插件（docs/plugins.md E2）。只由插件模块（domain/plugins/）写入。
-- installed_plugins：从文件、文件夹、git 装的插件。manifest 是装的时候读到的清单（检查过的）；
-- package_dir 是解开后的包：相对 <数据目录>/plugins/ 的路径（packages/…，数据文件夹搬走也认得）；文件夹装的是那个文件夹的绝对路径，不复制。
CREATE TABLE installed_plugins (
  id TEXT PRIMARY KEY,
  manifest TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('file', 'folder', 'git')),
  -- 文件名、文件夹的路径、git 地址
  source TEXT NOT NULL,
  -- git 的分支或标签
  source_ref TEXT,
  package_dir TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- plugin_grants：授权单上确认过的授权（Grant 的 JSON：范围、文件夹、域名、后台、改内部）
CREATE TABLE plugin_grants (
  plugin_id TEXT PRIMARY KEY,
  grant_json TEXT NOT NULL,
  granted_at TEXT NOT NULL
);
-- plugin_storage：插件自己的键值存储（视图和服务端逻辑用，E4、E5）；卸载时一起删
CREATE TABLE plugin_storage (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
-- plugin_errors：出错记录（每个插件只留最近的 20 条），短时间内出错多次自动停用
CREATE TABLE plugin_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  at TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX plugin_errors_by_plugin ON plugin_errors (plugin_id, at);
-- 自动停用的原因（你重新启用时清掉）
ALTER TABLE plugin_state ADD COLUMN disabled_reason TEXT;
