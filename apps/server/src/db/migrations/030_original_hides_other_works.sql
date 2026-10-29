-- 归为原创的图只算在「原创」作品下：识别器认出的作品标签留着（取消原创时还在），但不再让它出现在那些作品里
DROP VIEW v_image_works;
CREATE VIEW v_image_works AS
  SELECT ic.image_id, cw.work_id FROM image_characters ic JOIN character_works cw ON cw.character_id = ic.character_id
  UNION
  SELECT icr.image_id, icr.work_id FROM image_copyrights icr
  WHERE NOT EXISTS (
    SELECT 1 FROM images i JOIN works w ON w.id = icr.work_id
    WHERE i.id = icr.image_id AND i.original_at IS NOT NULL AND (w.danbooru_tag IS NULL OR w.danbooru_tag <> 'original')
  );
