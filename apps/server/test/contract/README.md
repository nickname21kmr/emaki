# DataSource 契约测试

同一套用例分别跑在 `MockDataSource` 和 `SqliteDataSource` 上（`contract.test.ts`），`cross.test.ts` 再把两边的只读查询结果换回 mock id 后逐字段比较。夹具与每个预期数字的推算见 `../fixtures/contract-db.ts`。

- sqlite 这边只有任务编号在 `ready.ts` 的 `SQLITE_READY` 里才会跑。**每完成一个任务就把编号加进去**，并把 `groups.ts` 里对应的 `it.todo` 换成真实用例。
- 运行：仓库根目录 `npx vitest run contract`。

## 有意差异（契约里不断言）

- `newCount` 的绝对值（sqlite 用 `last_seen_at` 计算，种子只能近似还原）。
- 角色的兜底封面（没设封面时两边挑的图不同，`coverRating` 随之不同）；作品 `covers` 具体是哪几张、封面主色 `coverColor`。
- 删除一条排除规则后，是否重新应用其余规则。
- 采纳建议后是否删除该建议；采纳时新建角色可能顺带新建作品。
- 文件名排序（sqlite 用 NOCASE，mock 用 localeCompare）；`random` 排序。
- 合并角色后的 `newCount`。
- `listExclusions` 预览图的顺序。
- `customMatchableCount`（依赖名字索引数据）。
- `listImages` 的游标格式（sqlite 是不透明的 base64url，mock 是数字字符串）——只能原样回传，不能解析。
