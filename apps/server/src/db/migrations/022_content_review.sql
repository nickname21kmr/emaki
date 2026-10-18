-- 保存与文件内容绑定的视觉复核结果，独立于可重新生成的识别标签。
ALTER TABLE images ADD COLUMN content_review TEXT;
