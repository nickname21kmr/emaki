# 随仓库分发的数据文件

## character-ips.json

离线的「Danbooru 角色标签 → 所属作品（copyright）」对照表，识别角色后在联网同步 Danbooru 之前就能把角色挂到作品上。

- 来源：[deepghs/pixai-tagger-v0.9-onnx](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx) 的 `selected_tags.csv`（`ips` 列），修订号 `d8cf666911a2c3d10d586d7823259192313c7eb7`
- 许可证：Apache-2.0（原作者 deepghs / PixAI）
- 生成：`npx tsx apps/server/scripts/build-character-ips.ts`。每个角色的作品按出现频次降序排列，第一个是母 IP。

## 可选的离线角色索引

在仓库根目录运行 `npm run build:character-index -w @emaki/server`，下载并校验 [StoryAura 角色标签快照](https://huggingface.co/datasets/StoryAura/Danbooru-Dataset-csv)（MIT），在 Emaki 数据目录生成 `character-index.sqlite`。也可在命令末尾加 `-- <CSV 路径>` 使用同一版本的本地文件。重启服务后，Pixiv 匹配会按标签查询这个索引。更新索引前先退出后端，避免 Windows 锁住正在读取的 SQLite 文件。

随包中文词库和用户维护的角色仍优先。快照只补候选，仍要用作品信息消歧，Pixiv 投稿本身的标签依然由 Pixiv 提供。

## pose/

按姿势找图（实验）的 51 个姿势类别：`classes.json`（取景组、中文名、代表骨架、归类半径）和 `figs/*.png`（示意小人，256×256）。

- 来源：在一个约 6.6 万张插画的图库上跑 DWPose（[yzd-v/DWPose](https://huggingface.co/yzd-v/DWPose)，Apache-2.0），按取景分四组做 k-medoids 得到的代表骨架；不含任何原图。
- 生成：原型目录外的 `build_assets.py`（读原型的 classes.json、full_fit.json、full_persons.npz 和小人图）。改了类别要把 `version` 加 1（示意小人的地址跟着变），同时把 `src/domain/pose/store.ts` 的 `POSE_VERSION` 加 1，图库里的姿势才会按新类别重跑。

## pose/posewear/

按姿势找图用的 PoseWear 姿势库：`catalog.json`（233 个单人姿势和 11 类双人互动：编号、中文名、分类、代表视角、标签配方、匹配参数）和 `skeletons.json`（每个视角线稿上检测出的骨架，坐标按长边归一）。Emaki 拿它自己给图库里的图匹配姿势，不用原型。

- 姿势的编号、中文名、分类来自 [PoseWear](https://posewear.pages.dev/)（MIT）整理的 AI Pose Gallery 姿势目录。**不含任何线稿图片**：封面要用户自己放进 `pose-covers/` 或者从 PoseWear 文件夹导入，没有时网页按骨架画小人。
- 配方、阈值、骨架是 Emaki 的原型（pose-proto 的 posewear_final、pose-pair 的 tags_v1）算出来的；骨架是在线稿上跑 DWPose 得到的点。
- 生成：`npx tsx apps/server/scripts/build-posewear-asset.ts [原型目录] [双人原型目录]`。改了配方、参数或骨架要把脚本里的 `VERSION` 加 1，图库会自动重新匹配一遍。和原型对一致率：`apps/server/scripts/posewear-agreement.ts`。
