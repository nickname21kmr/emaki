CREATE TABLE character_verified_forms (
  tag TEXT PRIMARY KEY,
  character_tag TEXT NOT NULL CHECK (tag <> character_tag),
  relation TEXT NOT NULL CHECK (relation IN ('form', 'same-character')),
  aliases TEXT NOT NULL,
  sources TEXT NOT NULL,
  evidence TEXT NOT NULL
);
CREATE INDEX idx_character_verified_forms_character ON character_verified_forms(character_tag);

CREATE TABLE character_verified_names (
  tag TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL,
  sources TEXT NOT NULL,
  evidence TEXT NOT NULL
);
