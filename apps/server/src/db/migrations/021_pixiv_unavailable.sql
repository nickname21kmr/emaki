-- 按投稿缓存明确的 404，同一投稿的新图片和显式补跑都不重复访问。
CREATE TABLE pixiv_unavailable_posts (
  post_id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL
);
