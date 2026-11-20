-- 同步相册（docs/mobile.md 5.5）：App 报的上次结果（「同步了 12 张」）是什么时候的。
-- 没有新图的那几次同步不再报结果，界面上「上次同步」和「最近传了什么、什么时候」分开写。
ALTER TABLE device_sync ADD COLUMN summary_at TEXT;
