-- 同步相册（docs/mobile.md 5.5）：电脑读不了的文件（例如改成 .jpg 的 HEIF）。
-- uploads.rejected：这个文件入库时被拒（格式不支持），同一个内容再传也一样；App 记下不再重传（重新盘点后再试一次）。
-- device_albums.rejected：App 报的这个相册里有几张电脑读不了。
ALTER TABLE uploads ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_albums ADD COLUMN rejected INTEGER;
