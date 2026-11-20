-- 同步相册（B2，docs/mobile.md 5.5）。两张表只有 domain/upload/albums.ts 写（单一写入者）。
--
-- device_albums：手机报上来的相册。一个相册 = 手机上的一个文件夹（MediaStore 的 RELATIVE_PATH，去掉结尾的斜杠，
-- 例如 'Download'、'Pictures/bili'），不含子文件夹。
-- - 盘点（inv_*）：App 把相册里每张图的 sha256 问过电脑之后报的：电脑上有几张（have）、其中几张在这台设备的「上传到」里
--   （in_target）、电脑上删过的（deleted：只在回收站里或文件丢了）、电脑上没有的（new）；在「上传到」里最集中的那个文件夹
--   （folder，相对「上传到」）和它有几张。据此建议同步哪些相册、新图放到哪（跟着老图走）。
-- - sync：要不要同步。dir：新图放到「上传到」下的哪个文件夹，第一次打开同步时定下来（dir_reason：history 跟着老图、
--   name 按相册路径取名、manual 用户改的），之后不再自动变。
CREATE TABLE device_albums (
  device_id TEXT NOT NULL REFERENCES devices(id),
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  latest_at TEXT,
  seen_at TEXT NOT NULL,
  -- 手机上没有这个文件夹了（最近一次完整的相册清单里没有它）
  gone_at TEXT,
  inv_total INTEGER,
  inv_have INTEGER,
  inv_in_target INTEGER,
  inv_deleted INTEGER,
  inv_new INTEGER,
  inv_new_bytes INTEGER,
  inv_folder TEXT,
  inv_folder_count INTEGER,
  inventoried_at TEXT,
  sync INTEGER NOT NULL DEFAULT 0,
  dir TEXT,
  dir_reason TEXT CHECK (dir_reason IN ('history', 'name', 'manual')),
  -- 上次同步完还没传上来的（传失败的）
  pending INTEGER,
  synced_at TEXT,
  PRIMARY KEY (device_id, path)
);

-- device_sync：每台设备的同步设置和 App 报的状态（正在盘点 / 同步、进度、上次的结果）
CREATE TABLE device_sync (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  wifi_only INTEGER NOT NULL DEFAULT 1,
  charging_only INTEGER NOT NULL DEFAULT 0,
  running TEXT CHECK (running IN ('inventory', 'sync')),
  done INTEGER,
  total INTEGER,
  error TEXT,
  summary TEXT,
  reported_at TEXT,
  inventoried_at TEXT,
  synced_at TEXT
);
