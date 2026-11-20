-- 手机上传（B1，docs/mobile.md 5.4）。devices 的两列由 access/ 写；upload_batches、uploads 由 domain/upload/ 写（单一写入者）。
--
-- devices.upload_root_id / upload_dir：这台设备传上来的图放到哪（图库文件夹 + 相对路径）。都是 NULL = 默认
-- （第一个自动识别的图库文件夹下的 收件箱/手机/<设备名>）。手动上传再放进「手动上传」子文件夹，同步的相册放进相册名的子文件夹。
ALTER TABLE devices ADD COLUMN upload_root_id INTEGER REFERENCES library_roots(id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN upload_dir TEXT;

-- 一批上传：App 一次选的那些图（album 为 NULL），或者一次同步的一个相册。id 是 App 生成的 uuid，第一个文件开始传时建
CREATE TABLE upload_batches (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  album TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 在电脑上「撤销这一批」的时间（新入库的那些移到了回收站）
  undone_at TEXT
);
CREATE INDEX idx_upload_batches_recent ON upload_batches(updated_at DESC);

-- 每个文件一行。没传完的字节在 <数据目录>/uploads/<id>.part；传完、核对过哈希就入库（import.ts），记下图片 id。
-- client_key：手机上这个文件的标识（相册同步用 MediaStore 的 id），同一台设备 + client_key + sha256 只传一次，
-- 电脑上删了的图也不会被同步回来；手动上传没有 client_key，按 设备 + 相册 + sha256 认
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES upload_batches(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  album TEXT,
  client_key TEXT,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  modified_at TEXT,
  received INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'receiving' CHECK (status IN ('receiving', 'imported', 'existing', 'failed')),
  image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_uploads_batch ON uploads(batch_id);
CREATE INDEX idx_uploads_same ON uploads(device_id, sha256);
CREATE UNIQUE INDEX idx_uploads_client ON uploads(device_id, client_key, sha256) WHERE client_key IS NOT NULL;
