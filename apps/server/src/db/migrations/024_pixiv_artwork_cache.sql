-- Cache successful Pixiv metadata by post, independently of per-image matching.
CREATE TABLE pixiv_artwork_cache (
  post_id TEXT PRIMARY KEY,
  artwork TEXT NOT NULL CHECK(json_valid(artwork)),
  fetched_at TEXT NOT NULL
);
