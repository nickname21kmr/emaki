ALTER TABLE images ADD COLUMN frame_count INTEGER CHECK(frame_count >= 1);
