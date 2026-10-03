-- 查重复核用的细指纹（用户 2026-10-04：画集的白底人物页和别的竖版插画被判成相似）。
-- 64 位 dHash 只负责找候选，候选对再用 16×16 的 dHash 和 8×8 的颜色确认。
-- 按图片内容的 sha256 存：内容不变就一直有效，复制了几份也只算一次。
CREATE TABLE image_fingerprints (
  sha256 TEXT PRIMARY KEY,
  fine   BLOB NOT NULL,  -- 256 位差值哈希，32 字节
  color  BLOB NOT NULL   -- 8×8 RGB，192 字节
) WITHOUT ROWID;
