-- Folder books retain their existing identity. Selection/post collections have explicit members.
ALTER TABLE collections ADD COLUMN membership TEXT NOT NULL DEFAULT 'folder' CHECK (membership IN ('folder', 'selection', 'post'));
ALTER TABLE collections ADD COLUMN source_key TEXT;
CREATE UNIQUE INDEX idx_collections_source ON collections(source_key) WHERE source_key IS NOT NULL;
-- An explicit removal must survive scans and automatic post grouping.
ALTER TABLE images ADD COLUMN collection_detached INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_images_post ON images(source_site, source_post_id) WHERE source_post_id IS NOT NULL;
