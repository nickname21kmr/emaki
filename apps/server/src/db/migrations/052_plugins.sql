-- 插件（docs/plugins.md 第 9 节）。只由插件模块（domain/plugins/）写入。
-- plugin_state：每个插件的启用状态和你改的名字（内置插件没改过时没有行，按默认：启用、原名）。
CREATE TABLE plugin_state (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  display_name TEXT,
  -- 最近一次启用的时间：覆盖冲突时按后启用的那个
  enabled_at TEXT,
  updated_at TEXT NOT NULL
);
-- user_plugins：「我的」插件的清单（E1 只有覆盖插件：自己在「插件」页新建、或者让 AI 助手做的）
CREATE TABLE user_plugins (
  id TEXT PRIMARY KEY,
  manifest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- plugin_point_state：各个贡献点自己的状态（侧栏的顺序和在不在侧栏、覆盖冲突时选了哪个），按 (贡献点, 键) 存 JSON
CREATE TABLE plugin_point_state (
  point TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (point, key)
);
