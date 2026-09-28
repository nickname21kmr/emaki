-- 换识别模型（WD → PixAI，2026-09-28）后，有些角色标签在两个模型里写法不同，中文词库里也没有这条改名。
-- 不补的话，同一个角色的新图会被 PixAI 建成另一个角色。方向是旧写法 → PixAI 的写法（PixAI 是主模型）。
-- INSERT OR IGNORE：词库或 Danbooru 已有的改名优先。
INSERT OR IGNORE INTO tag_renames (old_name, new_name, source) VALUES
  ('hoshino_ai_(oshi_no_ko)', 'hoshino_ai', 'model'),
  ('leafa', 'leafa_(sao)', 'model'),
  ('bardiche', 'bardiche_(nanoha)', 'model'),
  ('kero', 'kero_(cardcaptor_sakura)', 'model'),
  ('white_mage', 'white_mage_(final_fantasy)', 'model'),
  ('backbeako', 'backbeako_(torotei)', 'model'),
  ('kooh', 'kooh_(pangya)', 'model'),
  ('sans', 'sans_(undertale)', 'model');
