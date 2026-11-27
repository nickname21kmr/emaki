-- 用库内已有的内容哈希代替修改时间。保留待查、完成和撤销记录，时间写法不一致的旧待查项也能继续。
ALTER TABLE pixiv_character_checks RENAME COLUMN modified_at TO sha256;

UPDATE pixiv_character_checks AS p
SET sha256 = (SELECT i.sha256 FROM images i WHERE i.id = p.image_id);
