# 随仓库分发的数据文件

## character-ips.json

离线的「Danbooru 角色标签 → 所属作品（copyright）」对照表，识别角色后在联网同步 Danbooru 之前就能把角色挂到作品上。

- 来源：[deepghs/pixai-tagger-v0.9-onnx](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx) 的 `selected_tags.csv`（`ips` 列），修订号 `d8cf666911a2c3d10d586d7823259192313c7eb7`
- 许可证：Apache-2.0（原作者 deepghs / PixAI）
- 生成：`npx tsx apps/server/scripts/build-character-ips.ts`。每个角色的作品按出现频次降序排列，第一个是母 IP。
