-- Explicitly confirmed sources (including a deliberate clear) survive automatic parsing.
ALTER TABLE images ADD COLUMN source_manual INTEGER NOT NULL DEFAULT 0 CHECK (source_manual IN (0, 1));
