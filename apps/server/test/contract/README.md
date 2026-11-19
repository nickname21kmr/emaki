# DataSource 行为测试

用例跑在内存 SQLite 上，开头导入同一份契约夹具（`../fixtures/contract-db.ts`，每个预期数字怎么算的写在它顶部）。夹具里的 id 是 `i1` / `c1` / `w1` 这种，`env.id()` 换成 sqlite 的整数 id，`env.back()` / `canon()` 换回来。

- `groups.ts`：按任务编号分组的用例，`contract.test.ts` 把它们跑一遍。
- `readonly.test.ts`、`changes.test.ts`：整体结果存成快照（`__snapshots__/`）。快照最早是去掉 mock 之前两边逐字段一致时的结果；行为有意改了，看过 diff 再用 `npx vitest run contract -u` 更新。
- 运行：仓库根目录 `npx vitest run contract`。

夹具里的 `D:/Pics` 不一定存在，所以这里不碰真实文件：回收站换成什么也不做的假实现，也不检查盘符。要真的移动、删除文件的用例写在 `src/datasource/sqlite/*.test.ts` 里，用临时目录。
