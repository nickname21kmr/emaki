-- 移到回收站先只在库里标记，文件晚一点再真的移走：最近 5 次还能撤销
CREATE TABLE pending_trash (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  -- 撤销 token；挤出窗口时让它过期
  undo_token TEXT,
  -- 「全部处理」一次点下去的多组共用一个，在窗口里只算一次
  grp TEXT,
  -- 已挤出窗口、正在移文件；没移完就退出的下次启动接着移
  flushing INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE pending_trash_items (
  batch_id INTEGER NOT NULL REFERENCES pending_trash(id) ON DELETE CASCADE,
  image_id INTEGER NOT NULL,
  abs_path TEXT NOT NULL
);
CREATE INDEX pending_trash_items_batch ON pending_trash_items(batch_id);
CREATE INDEX pending_trash_items_image ON pending_trash_items(image_id);
