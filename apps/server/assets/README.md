# 随仓库分发的数据文件

## character-ips.json

离线的「Danbooru 角色标签 → 所属作品（copyright）」对照表，识别角色后在联网同步 Danbooru 之前就能把角色挂到作品上。

- 来源：[deepghs/pixai-tagger-v0.9-onnx](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx) 的 `selected_tags.csv`（`ips` 列），修订号 `d8cf666911a2c3d10d586d7823259192313c7eb7`
- 许可证：Apache-2.0（原作者 deepghs / PixAI）
- 生成：`npx tsx apps/server/scripts/build-character-ips.ts`。每个角色的作品按出现频次降序排列，第一个是母 IP。

## 可选的离线角色索引

在仓库根目录运行 `npm run build:character-index -w @emaki/server`，下载并校验 [StoryAura 角色标签快照](https://huggingface.co/datasets/StoryAura/Danbooru-Dataset-csv)（MIT），在 Emaki 数据目录生成 `character-index.sqlite`。也可在命令末尾加 `-- <CSV 路径>` 使用同一版本的本地文件。重启服务后，Pixiv 匹配会按标签查询这个索引。更新索引前先退出后端，避免 Windows 锁住正在读取的 SQLite 文件。

随包中文词库和用户维护的角色仍优先。快照只补候选，仍要用作品信息消歧，Pixiv 投稿本身的标签依然由 Pixiv 提供。
