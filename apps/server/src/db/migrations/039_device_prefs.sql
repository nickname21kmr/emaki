-- P5（docs/core-architecture.md 第 6 节「设置的归属」，附录 #32）：ui.blurSensitive、ui.density 是这台设备的偏好，不是图库设置。
-- 以前它们写进服务端却没人读（生效的是浏览器本地那份 usePrefs），现在只存在浏览器里；服务端存的这两项删掉，
-- 免得接口再把没人用的旧值返回出去。设置接口收到这两项会直接丢掉（zod 去掉不认识的键）。
UPDATE settings SET value = json_remove(value, '$.blurSensitive', '$.density') WHERE key = 'ui' AND json_valid(value);
