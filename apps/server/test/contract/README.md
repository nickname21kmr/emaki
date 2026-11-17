# DataSource 契约测试

对唯一的业务实现（`SqliteDataSource`，真实引擎）做接口测试。以前同一套用例还要在 `MockDataSource` 上跑一遍、再用 `cross.test.ts` 逐字段对照两边；2026-11-17（P1）删掉 mock 之后，「两套实现互相对照」由下面两样代替：

- `queries.test.ts`：几组关键查询（统计、未识别汇总、Top 角色、角色和作品列表、合集列表、图库文件夹）的固定期望结果，外加演示数据打开后的统计和合集；
- `../architecture/crossEntry.test.ts`：同一份证据从不同入口进来，结果必须相同。

文件：

- `harness.ts`：`sqliteFactory` 打开内存库，在迁移之后、启动修补之前灌入契约夹具（`../fixtures/contract-db.ts`，每个预期数字的推算写在它顶部的注释里）；`id()` / `back()` / `canon()` 负责夹具 id（`i1` / `c1` / `w1` …）和库里整数 id 的互换。
- `groups.ts` + `contract.test.ts`：按 `docs/TASKS.md` 的任务分组的接口用例。用例名外层的「sqlite」是沿用以前的名字。
- `changes.test.ts`、`source.test.ts`：移动预览、切换 Pixiv 识别方式、最近的改动、手动改来源。
- HTTP 冒烟（`../http.smoke.test.ts`）和 AI 助手的路由测试（`src/assistant/routes.test.ts`）也用真实引擎，只是换上演示模式的部件（`src/demo/engine.ts`：占位图、不碰文件、假任务）。

运行：仓库根目录 `npx vitest run contract`。

## 不断言的地方

以前这里列的是「mock 和 sqlite 的有意差异」。只剩一个实现之后，大部分已经没有意义，剩下的是兜底选择和不透明的格式，用例里不写死：

- 角色、作品的兜底封面挑哪张（`coverImageId`、`coverRating`、作品 `covers`）和封面主色 `coverColor`。
- `random` 排序的具体顺序；`listExclusions` 预览图的顺序。
- `listImages` 的游标格式（不透明的 base64url）——只能原样回传，不能解析。
- `customMatchableCount`（依赖名字索引数据，契约测试不导入词库）。

以前列为差异、现在按真实引擎的行为断言的：`newCount`（按 `last_seen_at` 计算，种子把它还原到第 N+1 新的关联上）；删除排除规则后重新应用其余规则；采纳建议后删除该建议、新建角色时可能顺带新建作品；文件名排序用 NOCASE；合并角色后的 `newCount`。
