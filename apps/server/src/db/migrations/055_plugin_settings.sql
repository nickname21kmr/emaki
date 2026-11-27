-- 插件的设置和凭证（docs/plugins.md 第 6 节，E5）：清单里 setting@1 登记的值（你在插件详情里填），
-- 加上插件服务端自己存的凭证（emaki.secrets）。只有插件的服务端读得到，视图读不到（视图的存储是 plugin_storage）；
-- 网页只看得到凭证填没填。卸载时一起删
CREATE TABLE plugin_settings (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
