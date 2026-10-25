-- Match explanation is separate from byte identity. Old unresolved candidates are replaced by the next dedupe run.
ALTER TABLE duplicate_groups ADD COLUMN comparison TEXT CHECK(comparison IN ('pixels', 'visual'));

-- Both positive and negative decisions are cached by original content, never by a thumbnail or image ID.
CREATE TABLE duplicate_comparisons (
  sha_a TEXT NOT NULL,
  sha_b TEXT NOT NULL,
  version TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (sha_a, sha_b, version)
) WITHOUT ROWID;

-- The startup pipeline rechecks old candidates with the new verifier.
UPDATE settings SET value = json_set(value, '$.lastRunAt', NULL) WHERE key = 'dedupe' AND json_valid(value);
