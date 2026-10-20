# 运行现有报表流程

这些命令说明当前实现，不要求每次重做全部步骤。先核对已有产物、快照范围和参数：只改文字时复用一致的数据并重新生成报告；数据或分析范围变化时重算受影响的部分。不要混用不同范围、时间或参数的快照、抽样和分析结果。

本技能使用通用 Agent Skills 格式，可由 Claude、Codex 或 Pi 加载，正文和模板共用一份。下列 `<skill>` 替换为当前这个 SKILL.md 所在目录的绝对路径；命令可从任意工作目录运行。

Emaki 助手会在技能目录生成 `.emaki-runtime.json`，绑定当前应用目录、数据目录、服务地址，以及助手共用的 `profile/assistant/` 输出目录。其他会话可能在这里留下过快照、抽样和报告，复用前按快照时间和参数核对。脚本自动读取它，不要猜测其他工作树的数据路径。直接在源码仓库使用时，默认仍输出 `data/profile/`；可用 `--data <目录>` 和 `--out <目录>` 显式覆盖。以下步骤始终使用同一输出目录，文中的 `data/profile/` 指该输出目录。

用 `scripts/run.mjs` 启动各步骤，它负责定位 Node 依赖和 TypeScript 加载器。只有模板生成与统计需要运行时才执行相应步骤，不因技能被加载就开始下载对照图片或运行识别。

1. **快照**：`node "<skill>/scripts/run.mjs" snapshot`
   之后只读快照，不碰正在用的库。

2. **看时间是否可信**：用 sqlite 看各个 `library_roots` 下图片的 `modified_at` 分布。
   - 有的备份在复制时把修改时间全改成了复制那天，这种文件夹的时间不能用。
   - 把它们的 id 记下来，后面每一步都加 `--undated-roots 1,3`，这些图会归到「更早」。
   - 文件名里带时间戳的（`2023_01_12_21_51_57_IMG_….JPG`、`Image_<毫秒>`）不受影响。

3. **统一标签口径**：如果库里同时有 WD 和 PixAI 打的标签（`images.tagger_model`），运行：
   `node "<skill>/scripts/run.mjs" wd-sample --undated-roots …`
   - 当前默认每个时期抽 600 张非 WD 图片，用 WD 重打；样本量和适用模型以脚本当前实现为准。
   - 重跑是增量的，只补缺的部分。
   - 混用标签口径可能把模型差异误读为口味变化；需要跨模型比较时统一口径，无法统一就缩小结论范围并说明局限。

4. **Danbooru 对照**（可选，但推荐，否则只能和全站二十年的人工标签比）：
   - `node "<skill>/scripts/run.mjs" baseline --undated-roots …`
     - 当前实现默认抽三组，每组约 1000 张；运行前查看脚本参数与已有缓存，按实际范围估算开销：`recent`（同时期全站）、`cn`（中文平台来源，也就是中文圈画师）、`works`（用户收得最多的作品）。
     - 原默认规模可能下载约 400 MB；实际大小随样本变化，用完删除临时对照图片。
   - `node "<skill>/scripts/run.mjs" baseline-tag`

5. **算数字**：`node "<skill>/scripts/run.mjs" analyze --undated-roots … [--private]`
   - 输出 `data.json`。
   - 核对统计单元数量与纳入范围是否一致；查看 `data.json` 的 `uncovered`，有缺口时补足所需抽样，或明确哪些比较不可靠。

6. **写文字**：读 `data.json`，写 `data/profile/story.json`，格式与叙述要求见 [story.json 格式](story-format.md)。

7. **生成报告**：`node "<skill>/scripts/run.mjs" report`，然后在环境允许的预览方式中打开 `report.html` 检查；若浏览器拒绝本地文件协议，不绕过其限制，说明尚未完成视觉检查。
   - 角色封面从当前 Emaki 服务读取，Emaki 要开着；独立源码运行默认使用 `http://127.0.0.1:5174`。
   - 检查有没有空白的图表，或者 NaN。
