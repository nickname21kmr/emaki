# Emaki 絵巻 · 实现任务清单（TASKS.md）

> 本文件由架构阶段汇总：4 份调研草稿 + 对现有代码的核对。它是后续实现的唯一依据。
> 任务编号 T01–T24 是固定的（`SqliteDataSource.ts` 里的 `NotImplementedError('Txx')` 就指向这里），可以加子步骤（如 T07.1），不要重新编号。

## 怎么用这份文件

1. **按里程碑顺序实现**：M0 → M1 → M2 → M3 → T21 → **M5** → M4 剩余（T22–T24）。里程碑内部按「里程碑总览」里的**推荐顺序**做（和编号顺序不完全一致，例如 T24 阶段 A 紧跟 T01，T19 是 M3 的第一个）。
2. **每个任务都能单独验收**：做完就跑该任务「验收标准」里的命令，全部通过再开始下一个。验收不过不要往下做。
3. **行为以 `MockDataSource` 为准**：`apps/server/src/datasource/mock/MockDataSource.ts` 是完整的参考实现。排序、过滤、分页口径、提示文案、撤销、事件都要和它一致；只有任务里明确写了「有意差异」的地方可以不同。
4. **前端不需要改**：后端把 `SqliteDataSource` 填完，设置 `EMAKI_DATA_SOURCE=sqlite` 就能切过去。例外只有 T21（首次启动引导），以及标了「可选」的新接口。
5. **契约不动**：`packages/shared` 的类型是前后端契约，除非任务明确要求，不要改。
6. **冲突时的优先级**：「关键技术决策」和「全局约定」两节 > 任务正文。如果发现任务正文和这两节矛盾，以这两节为准，并把问题记进文末「风险与未决问题」。**例外**：M5 一节（T25–T37）明确改写的口径、契约和前端，以 M5 为准；第 4、5 条不适用于 M5（M5 会改前端和契约）。M5 的任务会在第 0 步先把新口径写进「全局约定」。
7. **遇到本文件没覆盖的决定，不要猜**：先按最保守的做法实现（不删数据、不联网、不改契约），再在「风险与未决问题」里记一条。

给实现模型的通用规则：

- 所有命令都在仓库根目录 `F:\Claude\emaki` 的 PowerShell 里执行。PowerShell 里 `curl` 是别名，必须写 `curl.exe`；设环境变量用 `$env:NAME='value'`。
- 文中出现的版本号、文件大小、sha256、commit、下标范围都已实测。**直接照抄，不要自己猜，也不要顺手升级版本**。
- 提示文案、错误信息、进度文字一律用中文；代码标识符用英文。
- TypeScript 开着 `noUncheckedIndexedAccess`：数组取值要加 `!` 或先判断。服务端 import 路径带 `.ts` 后缀（沿用现有风格）。
- 每做完一个任务，把它的编号加进契约测试的 `SQLITE_READY` 集合（见 T24 第 5 步），然后跑 `npx vitest run`。

---

## 关键技术决策

| 领域 | 决定 | 为什么（摘要） | 来源 |
|---|---|---|---|
| SQLite 驱动 | **`better-sqlite3@^13.0.3`**（同步 API）。`node:sqlite` 只作为 T01 第 10 步的可选兜底 | 13.x 改用 N-API，预编译二进制直接打包在 npm 包里（2026-09-27 复核：13.0.3 包内有 `prebuilds/win32-x64.node`）；**13.0.2 起**删除了 install 脚本并设 `"gypfile": false`（13.0.0 / 13.0.1 仍是 `install: node-gyp rebuild`，**不能用**，所以下限必须是 13.0.3），不从 GitHub 下载，不需要 VS Build Tools，换 Node 或 Electron 版本也不用重编译。包里虽然还带着 `binding.gyp`，但 `gypfile: false` 让 npm 不会自动补 `node-gyp rebuild`。12.x 仍然是 `prebuild-install \|\| node-gyp rebuild`，国内经常装不上，**不要用 12.x**。`node:sqlite` 在 Node 24 是 RC 阶段，没有 `transaction()`/`pragma()` 辅助方法 | [v13.0.0 release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0) · [API 文档](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) · [node:sqlite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) |
| npm 11 的 allowScripts | 见下方「npm 11 allowScripts 操作规程」 | 本机 npm 11.17：目前只是提示，脚本照样执行；npm 12 会默认拦截，所以现在就登记 | [npm approve-scripts](https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/) · [config](https://docs.npmjs.com/cli/v11/using-npm/config) · [npm 12 变更预告](https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/) |
| 图片处理 | **`sharp@^0.35.4`**（T03 安装）。全局 `sharp.cache(false)`，输入参数 `failOn: 'none'` | 0.35 起删掉了 install 脚本，Windows 二进制走可选依赖 `@img/sharp-win32-x64`，不受 allowScripts 影响。预编译版**不支持 BMP 和 HEIC**：BMP 用自写解码器（T04），HEIC 不收录。`cache(false)` 防止 Windows 上原图被 libvips 占着导致改名 / 进回收站失败 | [0.35 changelog](https://sharp.pixelplumbing.com/changelog/v0.35.0/) · [install](https://sharp.pixelplumbing.com/install/) · [constructor](https://sharp.pixelplumbing.com/api-constructor/) · [cache](https://sharp.pixelplumbing.com/api-utility/) |
| 缩略图 | webp 480 + 240 由后台任务预生成，960 按需生成；缓存键是 sha256：`<dataDir>/thumbs/v1/ab/<sha256>_<w>.webp`；HTTP 改用 ETag（按 sha256）+ `private, no-cache` | SQLite 版图片 id 稳定（内容变了 id 不变），原来路由上的 `immutable` 会让浏览器一直显示旧图。WebP 单边上限 16383，长条图必须限高 | [WebP FAQ](https://developers.google.com/speed/webp/faq) |
| 角色识别模型 | 默认 **`SmilingWolf/wd-eva02-large-tagger-v3`**（GPU），CPU 回退时建议换 `wd-swinv2-tagger-v3`；可选 PixAI v0.9。推理库 **`onnxruntime-node@1.30.0`（精确锁定）**，Windows 用 DirectML（`{ name: 'dml', deviceId }`），失败自动回退 CPU | eva02 的 Macro-F1 最高（0.4772）。ORT 的 `run()` 同步阻塞 JS 线程，DirectML 偶尔原生崩溃 → 推理放进 **`child_process.fork` 子进程**（不用 `worker_threads`，有已知 bug）。WD v3 **没有 copyright 输出**，作品靠离线映射表 + Danbooru 同步推断 | [eva02 模型卡](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3) · [官方 Space app.py](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/main/app.py) · [ORT node README](https://unpkg.com/onnxruntime-node@1.30.0/README.md) · [DirectML EP](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html) · [worker 问题 #23790](https://github.com/microsoft/onnxruntime/issues/23790) |
| 模型下载源 | huggingface.co、hf-mirror.com、ModelScope（`fireicewolf/*` 镜像）三源并行测速，选最快的；断点续传（**按 `Content-Range` 判断是否续传，不按状态码**，见 T09.4）；下载完**必须校验 sha256**；HF 用固定 commit，不用 `main`。支持 `HF_ENDPOINT`、`EMAKI_MODEL_SOURCES`，也可以手动把文件放进模型目录 | 国内直连 HF 可能不通。ModelScope 上的是第三方镜像，内容可信完全靠写死的 sha256（已核对与 HF 一致；2026-09-27 复核：ModelScope 上 model.onnx 的 LFS 对象名就是 `9e768793…bfc`）。ModelScope 的小文件（selected_tags.csv）对 Range 请求返回**非标准的 `200` + `Content-Range` + 部分内容** | [hf-mirror](https://hf-mirror.com) · [ModelScope 镜像](https://www.modelscope.cn/models/fireicewolf/wd-eva02-large-tagger-v3/files) |
| 网络与代理 | 所有出网请求走 `apps/server/src/net/http.ts`（T09 创建）：`undici@^8.11.2` 的 `fetch` + `ProxyAgent`，代理地址取 `EMAKI_HTTP_PROXY` → `HTTPS_PROXY` → `HTTP_PROXY` | Node 24 内置 fetch 默认不读代理环境变量（要 `NODE_USE_ENV_PROXY=1`）；Clash 系统代理模式下 Node 不走系统代理。显式 ProxyAgent 更可控 | [Node 企业网络配置](https://nodejs.org/en/learn/http/enterprise-network-configuration) · [undici](https://www.npmjs.com/package/undici) |
| Danbooru | 只用 GET；自定义 UA `Emaki/<版本> (+<仓库地址>)`；串行、相邻请求间隔 ≥ 1 秒；列表接口**必须传 `limit`**；遇到 Cloudflare 挑战（403 + `cf-mitigated: challenge`）立即失败不重试；联网失败时降级为本地词库。默认**不联网**（`danbooru.enabled=false`），首次启动引导里让用户选 | 实测：UA 为 `node` 或浏览器 UA 会被 Cloudflare 拦截；不传 limit 默认只回 20 条且不报错。读接口限速与账号无关，API key 只用于标识身份 | [help:api](https://danbooru.donmai.us/wiki_pages/help:api) · [公共参数](https://danbooru.donmai.us/wiki_pages/help:common_url_parameters) |
| 中文名 | 内置 **ame-la/danbooru-tags-data-zh**（MIT，2026-08 快照，固定修订号）生成的精简词库 `apps/server/assets/i18n/danbooru-zh.json.gz`（提交进仓库，离线可用）；Danbooru wiki `other_names` 作为回退；简繁判断用 `opencc-js@^1.4.2` | WD v3 的 2751 个角色标签离线命中 98.9%。EhTagTranslation 是 CC BY-NC-SA，不能随仓库分发 | [数据集](https://huggingface.co/datasets/ame-la/danbooru-tags-data-zh) · [GitHub](https://github.com/amenorira/danbooru-tags-data-zh) · [opencc-js](https://www.npmjs.com/package/opencc-js) |
| 角色 → 作品（离线） | `apps/server/assets/character-ips.json`：从 deepghs/pixai-tagger-v0.9-onnx 的 `selected_tags.csv`（`ips` 列，Apache-2.0）生成，覆盖 WD v3 角色 98.3% | T10 打标签时就能把角色挂到作品上，不必等联网同步。联网同步（T11）结果优先级更高 | [deepghs/pixai-tagger-v0.9-onnx](https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx) |
| 回收站 | **`trash@^10.1.1`**，调用时**必须传 `{ glob: false }`**；调用后**逐个检查文件是否还在**；U 盘 / 网络盘提前拒绝；**永远不退化成 `fs.unlink`** | trash 默认 glob=true，`[1].png` 这种文件名会被当成通配符。它打包的 recycle-bin.exe 是 2.0.0，失败时可能不报错（issue #9） | [trash](https://github.com/sindresorhus/trash) · [recycle-bin #9](https://github.com/sindresorhus/recycle-bin/issues/9) |
| 文件监听 | **不用 chokidar**，改用 Node 自带 `fs.watch(root, { recursive: true })`（T08 标题里的 chokidar 以此为准） | chokidar 5 给每个文件建一个 `fs.watch`，10 万张图就是 10 万个句柄，启动时还要把整棵树遍历一遍。Windows 上 `fs.watch` 基于 ReadDirectoryChangesW，每个根目录 1 个句柄。事件只用来标「脏目录」，真假判断交给扫描器 | [chokidar](https://github.com/paulmillr/chokidar) · [Node fs.watch](https://nodejs.org/docs/latest-v24.x/api/fs.html) |
| 相似查重 | 64 位 dHash + **多索引哈希（MIH，4 段 × 16 位）**，不用 BK-tree（T16 标题里的 BK-tree 以此为准）；阈值实际生效范围 0..16 | 本机实测 10 万条、阈值 8：BK-tree 601 秒，MIH 1.8 秒，结果一致 | [Multi-Index Hashing](https://arxiv.org/abs/1307.2982) |
| 后台并发 | 缩略图用 `p-queue@^9.3.3`（优先级 + 反压）；JobQueue 串行执行，但增加优先级和「让出」（T07.1） | 打标签可能跑一个多小时，不能让新放进来的图一直等 | [p-queue](https://github.com/sindresorhus/p-queue) |
| 测试 | **`vitest@^5.0.2`** 装在仓库根目录，根 `vitest.config.ts` 用 `test.projects`；DataSource 契约测试同一套用例跑 mock 和 sqlite | `workspace` 文件从 vitest 3.2 起废弃 | [vitest projects](https://vitest.dev/guide/projects) |

### npm 11 allowScripts 操作规程（已在本机 npm 11.17 的文档和源码里核实）

- **现状**：npm 11 的 `allowScripts` 只是提示。未审核的安装脚本照样执行，装完打印 `npm warn allow-scripts ...`。只有显式写成 `false` 的包会被跳过；设置 `strict-allow-scripts=true` 才会变成硬错误（本机是 `false`）。官方写明以后的版本会默认拦截，所以现在就登记。
- **命令只在仓库根目录执行**：`npm approve-scripts` 不认 workspace（文档原话 *This command is unaware of workspaces*），它写的是**根** `package.json` 的 `allowScripts` 字段，要一起提交。
- **写入格式**：默认按版本钉住，例如 `"allowScripts": { "esbuild@0.28.2": true, "onnxruntime-node@1.30.0": true }`（本机源码 `C:\Program Files\nodejs\node_modules\npm\lib\utils\allow-scripts-writer.js` 确认值是 `true`、键是 `名字@版本`）。加 `--no-allow-scripts-pin` 会写不带版本的 `"esbuild": true`。已有的 `false` 条目永远优先，approve 不会覆盖。
- **标准流程**：
  ```powershell
  npm install <包> -w @emaki/server          # 装依赖（照常）
  npm approve-scripts --allow-scripts-pending  # 只读：列出还没审核的包
  npm approve-scripts <包名>                    # 审核通过，写入根 package.json
  npm approve-scripts --allow-scripts-pending  # 再看一遍，应当不再列出它
  npm rebuild <包名>                            # 只有当脚本曾被跳过（npm 12 / strict 模式）时才需要
  ```
- **不要**在项目里执行 `npm install --allow-scripts=...`：这个参数只给 `-g` / `npx` 用，项目内会直接报错。
- **本项目涉及的包**：
  - 需要审核：`esbuild@0.28.2`（vite / tsx 的依赖，T01 审核）、`onnxruntime-node@1.30.0`（T09 审核；它的 postinstall 在 Windows 上什么也不做，`install-metadata.js` 里是 `'win32/x64': []`，需要的 DLL 已在包里）。
  - 没有安装脚本、无需审核：`better-sqlite3@13`、`sharp@0.35`、`trash`、`p-queue`、`undici`、`opencc-js`、`csv-parse`、`vitest`。
- 国内网络慢：`npm config set registry https://registry.npmmirror.com --location=user`。package-lock 里仍是 registry.npmjs.org，npm 默认 `replace-registry-host=npmjs` 会自动替换，不用改锁文件。

### 迁移编号（固定，避免撞号）

| 文件 | 任务 | 内容 |
|---|---|---|
| `apps/server/src/db/schema.sql` | 已有 | v1，不要改 |
| `db/migrations/002_core_additions.sql` | T01 | 软删除文件夹、排除豁免、`image_copyrights`、`danbooru_tag_redirects`、`tags.image_count`、别名来源 / 可见性、名字 / 作品锁、三个视图 |
| `db/migrations/003_files.sql` | T03（T04 共用） | `thumb_at`、`decode_error`、`scan_errors` |
| `db/migrations/004_danbooru_i18n.sql` | T11（T12 共用） | `danbooru_tags` 扩展列、`tag_i18n`、`tag_name_keys`、`tag_renames`、`custom_character_matches` |
| `db/migrations/005_covers_import.sql` | T25.5 | `characters.cover_manual`、`library_roots.imported_at` 与回填 |
| `db/migrations/006_content_kind.sql` | T27 | `images.content_kind` 等分类列、`camera`、视图 `v_illust_images`；T27 补充的 `theme`、`art_score`、`shelved_at` |
| `db/migrations/007_collections.sql` | T38b | 合集：`collections` 等表、`images.collection_id`、`page_no` |
| `db/migrations/008_perf_indexes.sql` | T22 | 性能索引（M5 之后做，原定的 005 → 007 → 顺延为 008） |

迁移执行器要求版本号从 1 开始连续。按里程碑顺序做就不会断号。如果确实要跳着做（例如先做 T22），先为缺的编号建一个只有注释的占位文件（`-- reserved for T11`），**并删掉开发库重建**（占位文件以后填上内容时，已经升过版本的开发库不会重跑它）。项目还没发布，开发库随时可以删。

---

## 全局约定（所有任务都必须遵守）

### 数据口径

- **可见的图** = 视图 `v_images`：所在文件夹 `enabled = 1 AND removed_at IS NULL`，并且 `trashed_at IS NULL AND missing = 0`（包含被排除的图）。
- **计入张数的图** = 视图 `v_counted_images`：可见，并且 `excluded_by IS NULL`。所有 imageCount、recentImageCount、lastAddedAt、newCount、统计数字都只数它。
- **图属于作品** = 视图 `v_image_works`：经角色所属作品（`character_works`）∪ `image_copyrights`。列表筛选（T05）、作品张数（T13）、hydrate 的 `workIds`（T05）都只用这个视图，保证数字对得上。
- 自己写 SQL 不用视图时，条件必须**字面上**写成 `i.missing = 0 AND i.trashed_at IS NULL AND r.enabled = 1 AND r.removed_at IS NULL`（T22 的部分索引要求 `trashed_at IS NULL AND missing = 0` 字面出现）。
- **recent** = `images.added_at >= iso(now - 30 天)`（`sql.ts` 的 `RECENT_DAYS`；derived 缓存最多 5 分钟，窗口随之移动）。
- **recentCount**（T28，CR-5）= 角色 30 天内的插画张数；作品的 `recentImageCount` 同一口径。`topCharacters({ workId: 'recent' })` 只取 `lastAddedAt` 在 30 天内的角色，按 recentCount 降序、再按 imageCount 降序，置顶角色不插队；`listWorks({ sort: 'recent' })` 按 recentImageCount 降序。
- **newCount**（T25.5，CR-3、MG-6）= `SUM(i.added_at > COALESCE(c.last_seen_at, @cutoff))`，`@cutoff` 就是 recent 的 30 天界线。从没打开过的角色只把 30 天内的图算「新」，所以首次导入不会满屏 +N；打开角色扉页（`markCharacterSeen`）写 `last_seen_at` 后清零。旧写法「`characters.created_at` 和 `image_characters.added_at` 用同一个时间戳」已经不影响 newCount。
- **角色封面**（T25.5 MG-2，检查点 A 修订）：`cover_manual = 1` 并且 `cover_image_id` 仍计入张数时才用它（焦点用手动焦点）；否则用自动封面。tagger、Danbooru 同步、采纳建议都不写封面。自动封面：
  - 候选是这个角色的插画和漫画页（截图等别册类型永远不用），`isUnfitCover` 直接剔除截图、聊天、界面、以文字为主的图和 `Screenshot_` 文件名，宁可显示名字首字；
  - 排序：漫画页垫底（没有合适的插画才用）→ 分级档位（questionable、explicit 往后）→ `coverQuality` 画面质量分 → id 降序；
  - 候选少的角色先挑，用全局 `used` 集合在角色之间去重（只在同档、质量差 30 分以内换），实在没有就允许重复；
  - 焦点由 `inferCoverFocus(tags)` 按构图标签推断（T28），没命中为 null（前端居中）。
- **作品封面**（T28，MG-1）：`covers` 0–3 张，`coverImageId = covers[0].imageId`。作品按 imageCount 降序依次挑；候选是该作品下各角色的有效封面，排序为「主作品是它 → 分级档位 → 角色 imageCount 降序 → id」；跳过已被别的作品用过的图、本作品已选过的图、去掉括号后缀后同名的角色。不足 3 张时先用这些角色候选里安全档的其他好图补位，仍不足才允许跨作品重复。
- **只数插画**（T27，D3）= 视图 `v_illust_images`（计入张数，并且 `content_kind = 'illustration'`）：角色和作品的 imageCount、recentImageCount、recentCount、newCount、排名、+N、lastAddedAt、作品的 `characterCount`（有插画的角色）、`stats.characterCount`（有插画的角色）、`stats.workCount`（有插画的作品）、`stats.lastAddedAt`、`addedLast7Days`。自动封面也以插画为主（见上）。其余类型记在 `otherCount`。
- **角色列表默认隐藏**「插画 0 张、`otherCount > 0`」的角色（`otherOnlyCount`，`includeOther=true` 时显示；0 张图的新建角色照常显示，BI-2）。注意：`otherCount` 含漫画，所以**只有漫画的角色也会被隐藏**，书架末尾写「另有 N 位角色只出现在漫画、截图等里」。用户 2026-09-28 确认保持这个做法（D3 已相应修改）。
- **仍是全部类型**：`stats.imageCount`、`totalBytes`、`kindCounts`（各项之和 = imageCount）、`pendingTagCount`、图库列表、查重。
- **未识别队列**（常量 `QUEUE`，最终版）= 计入张数、`content_kind IN ('illustration','comic')`、`shelved_at IS NULL`、没有角色、`collection_id IS NULL`（T38c 追加：合集的页整本处理，不逐张进队列）。`unrecognizedCount`、各分段、侧栏都用它；「待识别」（`UNTAGGED_UNRECOGNIZED`）= 队列里 `tagged_at IS NULL` 并且不是漫画（漫画不等识别，直接算「没认出」）。`shelvedCount` = 同样条件但 `shelved_at IS NOT NULL`。
- **status**：有角色，或既不是插画也不是漫画 → `recognized`；图库「未识别」筛选 = 插画和漫画、没有角色（**含放下的和合集页**）。
- **主题** = `images.theme`（打标签后算好存下）加查询时的 CASE（`THEME_EXPR`：漫画 > 不像插画 > 敏感 > 存的主题），一图一组。
- **放下** = `images.shelved_at`：退出未识别队列和 `unrecognizedCount`（另记 `shelvedCount`），但仍计入张数、仍在图库里，可以放回。
- **合集页**（T38b）= `images.collection_id` 非空（只会指向 `state='active'` 的合集）。合集页数 = `v_counted_images` 里 `collection_id = c.id` 的张数；页码只在可见页里连续编号（排除、回收站、丢失的页离开合集）。
- **角色出现在合集** ⇔ 手动关联，或该角色的页数 ≥（本子 `max(2, ceil(0.1 × 页数))`，画集 1）。整本关联只写 `collection_characters` / `collection_works`，不改任何张数。

### SQL 与数据写法

- 时间只存 `new Date().toISOString()`（形如 `2026-09-27T10:00:00.000Z`），**不要**用 SQLite 的 `datetime('now')`（格式不同，字符串比较会错）。
- API 的 id 是字符串，库里是 INTEGER：入口统一用 T01 的 `parseId`（不合法返回 null，按「找不到」处理，不要 500），出口用 `toId`。
- 数组参数一律 `WHERE id IN (SELECT value FROM json_each(?))`，传 `JSON.stringify(数字数组)`（传字符串数组会和 INTEGER 比较失败）。
- SQL 里的字符串字面量一律**单引号**（better-sqlite3 关闭了双引号字符串）。绑定参数不能是 `boolean` / `undefined`，转成 `0/1` / `null`；SQL 里出现的具名参数都要在对象里给值。`lastInsertRowid` 可能是 bigint，用 `Number()`。
- 路径前缀匹配**不要用 `LIKE`**（`_`、`%` 是通配符，二次元文件名里到处是下划线），用 `substr(...) = ...`。
- `db.transaction(fn)` 里的 `fn` 必须是同步函数，里面不能 `await`。异步的事（stat、读文件、网络）先做完再进事务。
- 预编译语句在构造函数里或通过 `ctx.stmt(sql)` 只 prepare 一次，不要在循环里 prepare。
- 批量写入每个事务 ≤ 200 行，批次之间 `await new Promise((r) => setImmediate(r))` 让出事件循环（better-sqlite3 是同步的，长事务会卡住 HTTP 和 SSE）。

### 撤销与事件

- M3 起（T19 完成后），所有可撤销的修改都走 `ctx.mutate((u) => …)`，不可撤销的走 `ctx.write(...)`。M0 / M1 里的 T02、T05 先直接用 `UndoStack.result(message, revert)`，T19 之后可以顺手改掉（不强制）。
- 用户操作后立即 emit `library-changed`（`ctx.touch()`）；后台任务里最多每 3 秒 emit 一次（T22 统一成 `ctx.emitChanged`，之前各任务自己节流）。前端收到事件会让**所有** query 失效，发太频繁会把服务打爆。

### 共享模块（谁创建、谁复用）

下表里的函数只允许有**一份**实现。后做的任务 import，不要再写一份。

| 模块 / 函数 | 创建者 | 使用者 |
|---|---|---|
| `db/connection.ts` `openDatabase`（含 SQL 函数 `search_key`）、`db/migrate.ts` | T01 | 全部 |
| `datasource/sqlite/sql.ts`：`toId`、`parseId`、`jsonArray`、`encodeCursor`、`decodeCursor`、`paginateOffset`、`iso`、`DAY` | T01 | 全部；T05 往里加 `VISIBLE`、`MIME`、`DEFAULT_DOMINANT` |
| `datasource/sqlite/context.ts` `SqliteContext` | T01（T19 加 `mutate` / `write`，T22 加 `emitChanged` 和缓存分级） | 全部 |
| `datasource/sqlite/settings.ts`：`readSettings`、`normalizeRootPath`、`samePath`、`isInside`、`patchSettingsInternal`、`getDanbooruApiKey` | T02 | T03、T08、T09、T10、T11、T16、T17 |
| `services/fs/paths.ts`、`services/fs/hash.ts`（`sha256File`、`sha256Buffer`） | T03 | T04、T08、T09、T18 |
| `services/image/sharpConfig.ts`（所有 sharp 调用都从这里 import） | T03 | T04、T09 |
| `services/scan/ScanRequests.ts` | T03 | T07、T08 |
| `core/jobs.ts` 的优先级 / 让出 / `requeueIfRunning` / runner 返回值作为 message | T07.1（M1 开头先做） | T03、T04、T10、T11、T16 |
| `services/pipeline.ts`（任务链：scan → thumbnail → tag → dedupe / danbooru-sync） | T07 | T10、T11、T16、T20 注册自己的阶段 |
| `datasource/sqlite/hydrate.ts` `hydrateImages` / `loadImageItems`、`datasource/sqlite/suggestions.ts` `loadSuggestions` | T05 | T15、T16、T17、T18 |
| `net/http.ts`（undici fetch + 代理） | T09 | T11、T12 |
| `services/fs/hash.ts` 的 `sha256File` | T03 | T09 下载校验 |
| `util/color.ts`（`hslToHex`、`hashString`、`colorFromTag`，从 mock 复制） | T10 | T13 |
| `services/i18n/humanize.ts`（`humanizeCharacterTag`、`humanizeCopyrightTag`；T12 再加 `stripZhQualifier`、`cleanOtherName`） | T10 | T11–T15 |
| `services/i18n/localizer.ts`：`Localizer` 接口 + 只会 humanize 的占位实现 `HumanizeLocalizer` | T10 | T11；T12 提供真实实现 `SqliteLocalizer` |
| `services/aliases.ts` `replaceAutoAliases` | T10 | T11、T12、T14 |
| `services/catalog/characterCatalog.ts` `CharacterCatalog`：`resolveCharacterId`（标签 → 角色，含合并重定向）、`ensureCharacter`、`ensureWork`、`linkWorks`、`backfillWorks`、`describeTag`；导出 `resolveCharacterIdByTag` | T10（T11 加 `relinkWorks`、`normalizeTag`） | T11、T14、T15 |
| `services/catalog/copyrights.ts` `CopyrightSource` / `CopyrightResolver`（角色 → 作品列表，第一个是主作品） | T10（T11 扩展成完整回退链） | T10、T11、T14、T15 |
| `services/danbooru/matcher.ts`（自建角色能否对上 Danbooru） | T11 | T13（计数）、T14（编辑后重算） |
| `services/trash/recycleBin.ts`、`driveType.ts` | T18（T16 先做到时，先做 T18 第 1–2 步） | T16 |
| `datasource/sqlite/exclusions.ts` `applyExclusionRules`、`createExclusionInTx` | T17 | T03、T10、T15、T18 |
| `datasource/sqlite/undo.ts` `UndoRecorder` | T19 | M3 全部 |

**标签 → 角色 / 作品的统一规则**（T10、T11、T14、T15 共用，别各写一套）：

1. `normalizeTag(tag)`：T11 之前是原样返回；T11 之后 = 先按 `tag_renames` 换成 Danbooru 当前名字（`gojou_satoru` → `gojo_satoru`），再把服装变体归到本体（`mika_(swimsuit)_(blue_archive)` → `mika_(blue_archive)`）。
2. `resolveCharacterId(tag)`：`normalizeTag` 之后，先查 `characters.danbooru_tag`，再查 `danbooru_tag_redirects`（角色合并后留下的重定向，T14 写入）。
3. 作品列表 `copyrights(tag)` 的回退链，第一个非空的结果生效：① `danbooru_tags.copyrights`（T11 联网同步，最权威）→ ② `character-ips.json`（T10 离线表）→ ③ `tag_i18n.copyright_guess`（T12 词库）→ ④ 从标签括号里的限定词推断（T11）→ `[]`。
4. **主作品**（`position = 0`）：离线表按「母 IP 在前」排序（`fate_(series)`、`hololive`）；联网同步按「并列时更具体的在前」（`honkai:_star_rail` 先于 `honkai_(series)`）。这是**已知且接受的差异**：离线结果是临时近似，T11 同步后以在线结果为准，并重新挂作品（`works_locked = 1` 的角色不动）。两种规则下角色都会同时挂在母系列和子作品下，只影响卡片上显示哪个作品名。
5. 新建角色 / 作品的显示名：`Localizer.characterName(tag)` / `workName(tag)`（T12 之前只做 humanize）。自动生成的别名用 `replaceAutoAliases` 写入（`origin = 'dict' | 'danbooru'`），用户手动编辑的别名 `origin = 'user'`。

### 识别阈值默认值（T02 写入，T10 使用，T21 的预设档位也按这个）

`generalThreshold 0.35 / characterThreshold 0.35（建议阈值）/ autoAcceptThreshold 0.85 / batchSize 8 / device 'dml' / model 'SmilingWolf/wd-eva02-large-tagger-v3'`。

原因：mock 里的 0.85 / 0.9 会让「建议区间」只剩 [0.85, 0.9)，「未识别」页几乎不会有建议；0.85 是官方 Space 的角色阈值。T02 同时把 mock 的 `fixtures.ts` 默认值改成一样的数字，保证契约测试一致（mock 行为不依赖这两个数）。

### 目录、脚本、测试命令

- 开发用的数据目录都放在 `F:/Claude/emaki/data/` 下面（已被 `.gitignore` 忽略）：`data/dev`（通用开发库）、`data/fixtures-lib`（T03 生成的测试图库，**只读使用**）、`data/fixtures-t03`、`data/fixtures-t08`、`data/fixtures-t18`（需要改文件的验收各用一份，随时可以重新生成）、`data/dev-t03` 之类（各任务自己的库）、`data/empty`、`data/perf`。
- 注意 T02 会拒绝「和数据目录互相包含」的图库文件夹：验收时不要把 `data/xxx` 加为图库，同时又用默认的 `EMAKI_DATA_DIR`（= `data`）。按各任务命令里的 `EMAKI_DATA_DIR` 来就不会冲突。
- 模型文件目录：`EMAKI_MODELS_DIR`，默认 `<dataDir>/models`（T09）。多个开发库可以共用一份 1.26 GB 的模型：`$env:EMAKI_MODELS_DIR='F:/Claude/emaki/data/models'`。
- 服务端开发脚本统一放在 `apps/server/scripts/`，用 `npx tsx apps/server/scripts/<名字>.ts` 运行。常用的三个：`db-info.ts <dataDir>`（T01，看库结构和行数）、`db-query.ts "<SQL>"`（T03，对 `EMAKI_DATA_DIR` 下的库执行一条 SQL 并用表格打印）、`make-fixtures.ts <dir>`（T03，生成测试图库）。
- 测试一律在仓库根目录跑：`npx vitest run <路径片段>`，例如 `npx vitest run apps/server/src/services/tagger`（路径片段按子串匹配测试文件）。vitest 由 T24 阶段 A 在根目录安装，**各任务不要再往 workspace 里单独装 vitest**。
- `npm run typecheck` 跑全部 workspace 的类型检查。T01 把 `apps/server/tsconfig.json` 的 `include` 改成 `["src", "scripts", "test"]`，脚本和测试也参与类型检查。

---

## 里程碑总览

| 里程碑 | 任务 | 标题 | 难度 | 依赖 | 建议模型档位 |
|---|---|---|---|---|---|
| **M0 基础** | T01 | 数据库连接与迁移 | M | — | 小模型可做（步骤已写全） |
| | T02 | 设置与图库文件夹持久化 | S–M | T01 | 小模型可做 |
| **M1 入库** | T03 | 扫描器 | L | T01、T02、T07.1（T06 可选） | 建议中高档模型 |
| | T04 | 缩略图与主色 | M | T03、T07.1 | 小模型可做 |
| | T05 | 图片查询与文件服务 | M | T01、T03、T04 | 中档模型（游标分页要严谨） |
| | T06 | 来源解析 | S | — | 小模型可做 |
| | T07 | 后台任务接线 | M | T03、T04 | 中档模型 |
| | T08 | 文件监听 | M | T03、T07 | 中档模型 |
| **M2 识别** | T09 | WD14 tagger 推理 | L | T01、T03（sharp、hash） | 建议中高档模型 |
| | T10 | 打标签任务 + 角色自动归类 | L | T02、T03、T07、T09 | 建议中高档模型 |
| | T11 | Danbooru 元数据同步 | L | T02、T07、T10（T12 穿插） | 建议中高档模型 |
| | T12 | 中文名本地化 | M | T11 第 1–8 步 | 中档模型 |
| **M3 查询与整理** | T13 | 角色 / 作品 / 统计查询 | M–L | T01、T02、T24A | 中档模型 |
| | T14 | 角色编辑、合并、自建角色、Danbooru 匹配 | M | T10、T11、T13、T19 | 中档模型 |
| | T15 | 未识别队列与采纳建议 | M | T05、T13、T14、T19 | 小模型可做 |
| | T16 | 查重 | L | T04、T05、T07、T18 第 1–2 步 | 中档模型（核心算法已给出） |
| | T17 | 排除规则 | M | T02、T19 | 小模型可做 |
| | T18 | 批量操作与回收站 | M | T05、T17、T19 | 中档模型 |
| | T19 | 撤销（SQLite 版） | M | T01 | 建议中高档模型（被所有写操作依赖） |
| | T20 | 搜索 | S | T13 | 小模型可做 |
| **M4 收尾** | T21 | 前端切换到真实数据 + 首次启动引导 | M | T02、T07、T13 | 建议中高档模型（前端要有设计感） |
| | T22 | 性能（10 万张图） | L | T05、T13、T15、T17、T20 | 建议中高档模型 · 已完成（2026-09-28，用真实库快照代替造数据）：迁移 008 索引 + 查询统计自动重新采样、图片列表去掉 JOIN、翻页 / 计数两套写法、两级失效缓存、重复组一次补全、统计一遍扫描、封面排序移到 JS；结果见 docs/PERF.md（只剩「修改后第一次请求统计」在 500 ms 上下） |
| | T23 | 一键启动与打包 | M | T21 | 小模型可做 · 已完成（2026-09-28，Electron 壳不做）：start.bat、scripts/start.mjs、npm start、.gitattributes、README；app.ts 安全钩子（非本机 Host → 403，POST 非 JSON → 415，冒烟测试覆盖），真实后端实测通过；另加「运行时防止电脑休眠」（用户 2026-09-28，`services/system/keepAwake.ts`，设置 → 识别，默认开：有后台任务时起守护子进程调 SetThreadExecutionState / caffeinate，全部结束 1 分钟后放开，本进程没了它也自己退出） |
| | T24 | 测试（阶段 A 在 M0 做） | L（阶段 A：M） | T01 | 阶段 A 建议中高档模型；阶段 B 小模型可做 · 阶段 B 完成（2026-09-28）：undo 往返 49 例（dumpCore）、HTTP 冒烟 45 个路由（新增路由漏测会失败）、CI（windows-latest，推送后待验证）；全量 612 通过。发现 updateImage 同时改 kind 和其他字段时撤销不回类型，已修（一次 mutate 一个 token） |
| **M5 视觉打磨与内容整理** | T25 | 任务链与实时状态热修（大部分已完成） | S | — | 中档模型 |
| | T25.5 | 封面止血（先行，含迁移 005） | M | T25 | 建议中高档模型 |
| | T26 | 数据契约 v2 | M | T25.5 | 建议中高档模型 |
| | T28 | 作品封面与计数口径 | M | T26 | 建议中高档模型 |
| | T29a | 前端共用件（总览要用的） | M | T26 | 建议中高档模型（前端要有设计感） |
| | T30 | 角色总览改版 | M | T28、T29a | 建议中高档模型 |
| | T27 | 内容分类数据层 + 迁移 006（与 T32a 同批合入） | L | T26 | 建议中高档模型 |
| | T32a | 别册：最小可见版 | M | T27 | 中档模型 |
| | T29b | 画集语汇 | M | T29a、T27 | 建议中高档模型 |
| | T31 | 首页改版 | M | T27、T29b、T30 | 中档模型 |
| | T32b | 别册：正式版 | M | T29b、T32a | 中档模型 |
| | T33 | 浏览页 | L | T29b、T30 | 建议中高档模型 |
| | T34 | 整理页 | M | T26、T27、T29b | 中档模型 |
| T35 | 质感与微交互 | M | T29b | 中档模型 |
| | T36 | 文档定稿与视觉验收 | S | T30–T35 | 小模型可做 |
| | T37 | （可选）在磁盘上分类存放 | M | T27、T32b | 待用户确认后再排期 |

**推荐实施顺序**（按这个顺序每一步都有前置可用）：

- M0：T01 → **T24 阶段 A** → T02
- M1：T06 → **T07.1**（只改 `core/jobs.ts`）→ T03 → T04 → T05 → T07（其余部分）→ T08
- M2：T09 → T10 → T11 第 1–8 步 → T12 → T11 第 9–12 步
- M3：T19 → T13 → T14 → T15 → T17 → T18 → T16 → T20
- M4：T21（已完成）
- **M5**：T25 → T25.5 → T26 → T28 → T29a → T30 已完成；之后按「M5 第二轮 → 实现顺序」
- M5 第二轮：见「M5 第二轮 → 实现顺序」
- M4 剩余：T22（迁移改为 008）→ T23 → T24 阶段 B

### `SqliteDataSource` 方法 → 任务对照（已与代码核对）

`apps/server/src/datasource/sqlite/SqliteDataSource.ts` 里共 36 处 `NotImplementedError`，每一处都有任务覆盖：

| 编号 | 方法 | 覆盖的任务 |
|---|---|---|
| T01 | `static open` | T01 |
| T02 | `getSettings`、`updateSettings`、`addLibraryRoot`、`updateLibraryRoot`、`removeLibraryRoot` | T02 |
| T04 | `getThumbnail` | T04 |
| T05 | `listImages`、`getImage`、`updateImage`、`getOriginal`、`revealImage` | T05 |
| T07 | `listJobs`、`startJob`、`cancelJob` | T07 |
| T13 | `getStats`、`listWorks`、`getWork`、`listCharacters`、`topCharacters`、`getCharacter` | T13 |
| T14 | `createCharacter`、`updateCharacter`、`markCharacterSeen`、`mergeCharacter` | T14 |
| T15 | `listUnrecognized`、`acceptSuggestion` | T15 |
| T16 | `listDuplicates`、`resolveDuplicate`、`ignoreDuplicate` | T16 |
| T17 | `listExclusions`、`createExclusion`、`deleteExclusion` | T17 |
| T18 | `bulkImages` | T18 |
| T19 | `undo` | T19 |
| T20 | `search` | T20 |

没有对应桩方法、而是提供服务或基础设施的任务：T03、T06、T08、T09、T10、T11、T12（由 T07 的 Pipeline 或 `open()` 接入），T21–T24（前端、性能、启动、测试）。

另外，桩文件顶部注释「T08 装 chokidar」「T01 时安装 better-sqlite3、sharp」已过时：以本文件为准（sharp 在 T03 安装，T08 不装 chokidar）。实现 T08 时顺手把那行注释改掉。

---

# M0 基础

## T01 数据库连接与迁移（better-sqlite3，SqliteDataSource.open，migrate.ts，原生依赖安装）

### 目标
- `EMAKI_DATA_SOURCE=sqlite` 时后端能启动：创建或打开 `${EMAKI_DATA_DIR}/emaki.sqlite`，开启 WAL 和外键，按 `PRAGMA user_version` 跑完迁移。
- 提供后续所有 sqlite 任务共用的基础设施：连接、迁移执行器、`SqliteContext`、SQL 小工具（id 转换、游标编解码、用 json_each 传数组）、SQL 函数 `search_key`、调试脚本 `db-info`。
- 新增迁移 `002_core_additions.sql`。它只建结构，真正读写这些结构的是 T02、T10、T11、T13、T14、T15、T17。

### 依赖
无，第一个做。做完立刻做 T24 阶段 A（vitest 骨架、种子数据、契约测试框架），之后每个任务都用契约测试验收。

### 涉及文件
- `apps/server/package.json`（依赖）；根 `package.json`（`allowScripts`，由命令写入）
- `apps/server/tsconfig.json`（`include` 改成 `["src", "scripts", "test"]`）
- `apps/server/src/db/connection.ts`（新）
- `apps/server/src/db/migrate.ts`（把注释换成实现）
- `apps/server/src/db/migrations/002_core_additions.sql`（新）
- `apps/server/src/datasource/sqlite/sql.ts`、`context.ts`（新）
- `apps/server/src/datasource/sqlite/SqliteDataSource.ts`（open、构造函数、close）
- `apps/server/src/datasource/DataSource.ts`（加可选的 `close?()`）；`apps/server/src/index.ts`（优雅退出）
- `apps/server/scripts/db-info.ts`（新）

### 实现步骤
1. 安装（仓库根目录，PowerShell）：
```powershell
npm install better-sqlite3@^13.0.3 -w @emaki/server
npm install -D @types/better-sqlite3@^9.6.0 -w @emaki/server
npm approve-scripts --allow-scripts-pending   # 只读，应当只列出 esbuild
npm approve-scripts esbuild                    # 写入根 package.json："allowScripts": { "esbuild@0.28.2": true }
node -e "const D=require('better-sqlite3');console.log(new D(':memory:').prepare('select sqlite_version() v').get())"
npm ls better-sqlite3                          # 必须 ≥ 13.0.3（13.0.0 / 13.0.1 带 node-gyp install 脚本）
```
网络慢时见「关键技术决策 → npm 11 allowScripts 操作规程」最后一条（npmmirror）。
`sqlite_version()` 打印出来的版本记下来写进 `db/connection.ts` 顶部注释；后面 T13（`unixepoch(..., 'subsec')` 需要 ≥ 3.42）、T20（`UPDATE … FROM` 需要 ≥ 3.33）都依赖它。

2. `db/connection.ts`：
```ts
import Database from 'better-sqlite3';
import { searchKey } from '@emaki/shared';
export type Db = Database.Database;
export function openDatabase(file: string): Db {
  const db = new Database(file, { timeout: 5000 });   // busy_timeout 5s
  db.pragma('journal_mode = WAL');                     // ':memory:' 返回 'memory'，正常
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536');                   // 64 MB
  db.pragma('mmap_size = 268435456');                 // 256 MB
  // 供 SQL 里做和 mock 一致的搜索匹配（T05 listImages 的 q 用它）
  db.function('search_key', { deterministic: true }, (s: unknown) => (s == null ? null : searchKey(String(s))));
  return db;
}
export function closeDatabase(db: Db): void {
  try { db.pragma('optimize'); } finally { db.close(); }
}
```

3. `db/migrate.ts`：
```ts
export interface Migration { version: number; name: string; sql: string; foreignKeysOff: boolean }
export function loadMigrations(dir = import.meta.dirname): Migration[]
export function migrate(db: Db, opts?: { dir?: string; backupDir?: string; log?: (msg: string) => void }): { from: number; to: number }
```
规则：
- v1 = `dir/schema.sql`；其余是 `dir/migrations/NNN_名字.sql`（正则 `/^(\d{3})_.+\.sql$/`，NNN 就是版本号，从 002 开始）。版本号必须从 1 开始连续且不重复，否则 throw。编号分配见「关键技术决策 → 迁移编号」。
- `current = db.pragma('user_version', { simple: true }) as number`；`current > latest` → throw `数据库版本 v${current} 比程序支持的 v${latest} 新，请升级 Emaki`。
- `current >= 1`、有待执行的迁移、并且传了 `backupDir` 时：先删掉同名文件，再执行 `VACUUM INTO '<backupDir>/emaki.v${current}.bak.sqlite'`（路径里的 `'` 替换成 `''`；VACUUM 不能在事务里执行）。
- 每个迁移：`db.transaction(() => { db.exec(m.sql); db.pragma(`user_version = ${m.version}`); })()`。失败直接抛（事务自动回滚），不要吞错。
- 文件第一行是 `-- @foreign-keys-off`（需要重建表的迁移）时：在事务外执行 `PRAGMA foreign_keys = OFF`；事务内跑完迁移后执行 `PRAGMA foreign_key_check`，有结果就 throw；事务结束后恢复 `ON`。
- 全部完成后执行 `db.pragma('optimize')`（SQLite 官方建议：改结构或建索引后跑一次）。

4. `db/migrations/002_core_additions.sql`（原样使用，不要自己加列）：
```sql
-- 002：查询 / 撤销 / 排除 / 识别 / 本地化需要的补充结构

-- T02：移除图库文件夹先软删除（可撤销），下次启动再真正删除
ALTER TABLE library_roots ADD COLUMN removed_at TEXT;
-- T17/T18：用户手动「恢复」的图，规则不再自动排除它
ALTER TABLE images ADD COLUMN exclude_exempt INTEGER NOT NULL DEFAULT 0;

-- T10 写入：没被自动采纳、但建议角色所属作品已存在时，图也能归到作品（见 T10.5 的「建议角色的主作品」规则）
CREATE TABLE image_copyrights (
  image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  work_id   INTEGER NOT NULL REFERENCES works(id)  ON DELETE CASCADE,
  score     REAL,
  PRIMARY KEY (image_id, work_id)
) WITHOUT ROWID;
CREATE INDEX idx_image_copyrights_work ON image_copyrights(work_id, image_id);

-- T14：合并角色后，被合并角色的 Danbooru 标签指向目标角色（否则下次打标签又把它建回来）
CREATE TABLE danbooru_tag_redirects (
  tag           TEXT    PRIMARY KEY,
  character_id  INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE
);

-- T20：general 标签在「计入张数」的图里出现的次数（缓存，由 refreshTagCounts() 重算）
ALTER TABLE tags ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0;

-- T10/T11/T12/T14：别名的来源和可见性
ALTER TABLE aliases ADD COLUMN origin   TEXT    NOT NULL DEFAULT 'user'; -- user | danbooru | dict
ALTER TABLE aliases ADD COLUMN visible  INTEGER NOT NULL DEFAULT 1;      -- 0 = 只用于搜索，不出现在 Character.aliases 里
ALTER TABLE aliases ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- T11/T14：用户改过名字 / 所属作品后，自动同步不再覆盖
ALTER TABLE characters ADD COLUMN name_locked  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN works_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE works      ADD COLUMN name_locked  INTEGER NOT NULL DEFAULT 0;

-- 可见的图：文件夹启用且未移除、未进回收站、文件还在（包括被排除的）
CREATE VIEW v_images AS
  SELECT i.* FROM images i JOIN library_roots r ON r.id = i.root_id
  WHERE r.enabled = 1 AND r.removed_at IS NULL AND i.trashed_at IS NULL AND i.missing = 0;
-- 计入「张数」的图 = 可见且未被排除
CREATE VIEW v_counted_images AS SELECT * FROM v_images WHERE excluded_by IS NULL;
-- 图 → 作品：经角色所属作品 ∪ image_copyrights（UNION 去重）
CREATE VIEW v_image_works AS
  SELECT ic.image_id, cw.work_id FROM image_characters ic JOIN character_works cw ON cw.character_id = ic.character_id
  UNION
  SELECT image_id, work_id FROM image_copyrights;
```

5. `datasource/sqlite/sql.ts`（全部导出，其他任务复用；T05 会往里追加 `VISIBLE`、`MIME`、`DEFAULT_DOMINANT`）：
```ts
export const toId = (n: number | bigint): string => String(n);
/** API 字符串 id → 整数；不合法返回 null（调用方按「找不到」处理，不要 500） */
export function parseId(id: string | null | undefined): number | null {
  return id && /^[1-9]\d{0,15}$/.test(id) ? Number(id) : null;
}
export const bool = (v: boolean): 0 | 1 => (v ? 1 : 0);
export const iso = (ms: number): string => new Date(ms).toISOString();
/** 数组参数一律：WHERE id IN (SELECT value FROM json_each(?))，绕开参数个数上限 */
export const jsonArray = (xs: readonly (number | string)[]): string => JSON.stringify(xs);
export function encodeCursor(v: unknown): string { return Buffer.from(JSON.stringify(v)).toString('base64url'); }
export function decodeCursor<T>(s: string | undefined, isValid: (x: unknown) => x is T): T | null {
  if (!s) return null;
  try { const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); if (isValid(v)) return v; } catch { /* 走到下面 */ }
  throw new BadRequestError('分页游标无效，请刷新页面');
}
/** 与 mock 相同的偏移分页，只用于已在内存里排好序的小列表（角色） */
export function paginateOffset<T>(all: T[], cursor: string | undefined, limit: number | undefined): Page<T>
export const DAY = 86_400_000;
export const RECENT_DAYS = 30;
```

6. `datasource/sqlite/context.ts`：
```ts
export interface SqliteContext {
  readonly db: Db;
  readonly bus: EventBus;
  readonly dataDir: string;
  readonly clock: () => number;            // 测试可以注入固定时间
  readonly undo: UndoStack;
  readonly jobs: JobQueue;
  /** 数据变了：让派生缓存失效（T13/T22 往里挂具体的缓存） */
  invalidate(scope?: 'all' | 'stats' | 'entities', opts?: { soft?: boolean }): void;
  /** 用户操作之后：invalidate + emit { type: 'library-changed', reason: 'mutation' } */
  touch(): void;
  /** 预编译语句缓存：同一段 SQL 只 prepare 一次（Map<string, Statement>） */
  stmt(sql: string): Database.Statement;
}
```
（T19 会再加 `mutate()` / `write()`，T22 加 `emitChanged()`。）

7. `SqliteDataSource`：
```ts
export interface SqliteOpenOptions { memory?: boolean; clock?: () => number; autoJobs?: boolean }
static async open(bus: EventBus, dataDir: string, opts: SqliteOpenOptions = {}): Promise<SqliteDataSource> {
  await fs.promises.mkdir(dataDir, { recursive: true });
  const db = openDatabase(opts.memory ? ':memory:' : path.join(dataDir, 'emaki.sqlite'));
  migrate(db, { backupDir: opts.memory ? undefined : dataDir, log: (m) => console.log(m) });
  db.pragma('optimize = 0x10002');   // 长连接：打开时一次，之后每小时一次
  const ds = new SqliteDataSource(db, bus, dataDir, opts);
  // T02：ds.purgeRemovedRoots()；T07：opts.autoJobs !== false 时组装 Pipeline 并启动自动扫描
  return ds;
}
readonly ctx: SqliteContext;          // 测试和脚本通过 ds.ctx.db 访问
async close(): Promise<void> { clearInterval(this.optimizeTimer); closeDatabase(this.ctx.db); }
```
- JobQueue 的 resolver 先写成 `(kind) => this.runners[kind] ?? (async () => { throw new NotImplementedError('T07'); })`，`runners: Partial<Record<JobKind, JobRunner>>`。T07 会把它换成 Pipeline。
- 构造函数里：`this.optimizeTimer = setInterval(() => db.pragma('optimize'), 3_600_000); this.optimizeTimer.unref();`
- `index.ts` 里调用 `SqliteDataSource.open(bus, config.dataDir)` 的地方保持不变（新参数都可选）。

8. `DataSource.ts` 加 `close?(): Promise<void>;`。`index.ts` 在 listen 之后：
```ts
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => { await app.close(); await ds.close?.(); process.exit(0); });
}
```

9. `apps/server/scripts/db-info.ts`（`npx tsx apps/server/scripts/db-info.ts <dataDir>`）：只读打开 `<dataDir>/emaki.sqlite`，打印 user_version、journal_mode、所有表和视图名、每张表的行数。之后各任务验收都用它看库。

10.（可选，只有 better-sqlite3 在用户机器上加载失败时才做）`db/driver-node.ts`：用 `node:sqlite` 的 `DatabaseSync` 实现同一组能力：`prepare(sql)` 返回带 `get/all/run/iterate/pluck()` 的包装、`exec`、`pragma(str, { simple })`、`transaction(fn)`（用 BEGIN / SAVEPOINT 计数实现嵌套）、`function`、`close`。`openDatabase` 根据 `EMAKI_SQLITE_DRIVER=node` 选择驱动。两边的 `run()` 都返回 `{ changes, lastInsertRowid }`。

### 坑
- SQL 里的字符串一律用单引号：better-sqlite3 编译时关闭了双引号字符串，`WHERE kind = "image"` 会报 no such column。
- `PRAGMA foreign_keys` 在事务内设置无效；`VACUUM INTO` 不能在事务内执行。
- 视图用了 `i.*`：以后要「重建 images 表」的迁移，必须先 `DROP VIEW` 这三个视图，重建后再 `CREATE VIEW`。
- `schema.sql` 里 `images.excluded_by` 引用了后面才建的 exclusions 表，SQLite 允许，不用改。
- `import Database from 'better-sqlite3'` 是 CJS 默认导出，在 NodeNext + esModuleInterop 下正常；实例类型是 `Database.Database`。
- 本任务只做基础设施，不写任何业务 SQL。后续所有任务都通过 `ds.ctx` 访问数据库，不要在别处 `new Database`（脚本除外）。

### 验收标准
```powershell
npm run typecheck
$env:EMAKI_DATA_SOURCE='sqlite'; $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev'; npm run dev:server
# 另开一个终端：
curl.exe -s http://127.0.0.1:5174/api/health                              # {"ok":true,"dataSource":"sqlite"}
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:5174/api/stats   # 501（T13 还没做），服务不崩
npx tsx apps/server/scripts/db-info.ts F:/Claude/emaki/data/dev
# 期望：user_version = 2，journal_mode = wal，有视图 v_images / v_counted_images / v_image_works，
#       有表 image_copyrights / danbooru_tag_redirects，aliases 表有 origin / visible / position 列
```
- 再启动一次：不重复迁移，不生成备份文件（`Get-ChildItem F:/Claude/emaki/data/dev/*.bak.sqlite` 为空）。
- 降级保护（**先停掉服务**，Ctrl+C）：
  ```powershell
  node -e "const D=require('better-sqlite3');const d=new D('F:/Claude/emaki/data/dev/emaki.sqlite');d.pragma('user_version = 99');d.close()"
  $env:EMAKI_DATA_SOURCE='sqlite'; $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev'; npm run dev:server   # 启动失败，日志含「比程序支持的 v2 新」
  node -e "const D=require('better-sqlite3');const d=new D('F:/Claude/emaki/data/dev/emaki.sqlite');d.pragma('user_version = 2');d.close()"
  ```
- `npm approve-scripts --allow-scripts-pending` 不再列出任何包；根 `package.json` 里有 `"allowScripts": { "esbuild@0.28.2": true }`。
- T24 阶段 A 完成后：`npx vitest run migrate` 通过（全新库 → v2；重复 migrate 幂等；故意写错的迁移回滚后 user_version 不变；降级保护）。

### 难度
M

## T02 设置与图库文件夹持久化（getSettings/updateSettings/add/update/removeLibraryRoot）

### 目标
实现 `getSettings / updateSettings / addLibraryRoot / updateLibraryRoot / removeLibraryRoot`，行为和提示文案与 MockDataSource 一致。设置存在 `settings` 表（key → JSON）；图库文件夹存在 `library_roots`，「移除」是软删除（可撤销），下次启动时才真正删除。

### 依赖
T01。撤销先用 `ctx.undo.result(message, revert)` 闭包；T19 完成后可以改用 `ctx.mutate`（不强制）。

### 涉及文件
- `apps/server/src/datasource/sqlite/settings.ts`（新：默认值、读写、路径规范化）
- `apps/server/src/datasource/sqlite/SqliteDataSource.ts`（5 个方法 + `purgeRemovedRoots()` + 内部监听器）
- `apps/server/src/datasource/mock/fixtures.ts`（只改 tagger 默认阈值，见第 1 步）
- `apps/server/src/datasource/sqlite/settings.test.ts`（新）

### 实现步骤
1. 默认值与键名：
```ts
export const SETTINGS_KEYS = { tagger: 'tagger', danbooru: 'danbooru', dedupe: 'dedupe', ui: 'ui', danbooruApiKey: 'secret.danbooruApiKey' } as const;
export const DEFAULT_SETTINGS = {
  tagger: { model: 'SmilingWolf/wd-eva02-large-tagger-v3', device: 'dml', generalThreshold: 0.35, characterThreshold: 0.35, autoAcceptThreshold: 0.85, batchSize: 8 },
  danbooru: { enabled: false, username: '', lastSyncAt: null as string | null },   // 不存 hasApiKey；默认不联网，T21 的引导里让用户选
  dedupe: { hammingThreshold: 8 },
  ui: { theme: 'system', blurSensitive: true, density: 'comfortable' },
} as const;
```
阈值为什么这样定见「全局约定 → 识别阈值默认值」。同时把 `apps/server/src/datasource/mock/fixtures.ts` 里 tagger 的 `characterThreshold` 改成 0.35、`autoAcceptThreshold` 改成 0.85（mock 的行为不依赖这两个数，只是让两边默认设置一致）。

2. `export function readSettings(db: Db): Omit<Settings, 'libraryRoots'>`（模块级函数，同步，导出给其他任务读设置；T10 / T11 / T16 都写成 `readSettings(db)`）：`SELECT key, value FROM settings`，每段用 `{ ...DEFAULT_SETTINGS[k], ...JSON.parse(value) }` 合并（以后新增字段自动有默认值；JSON 坏了就用默认值并 `console.warn`）。`hasApiKey = 存在 secret.danbooruApiKey 这一行`。

3. `getSettings()`：
```sql
SELECT r.id, r.path, r.enabled, r.last_scan_at,
       (SELECT COUNT(*) FROM images i
         WHERE i.root_id = r.id AND i.trashed_at IS NULL AND i.missing = 0 AND i.excluded_by IS NULL) AS image_count
FROM library_roots r
WHERE r.removed_at IS NULL
ORDER BY r.id;
```
（mock 的 imageCount = 未进回收站且未排除，不看 enabled；这里额外排除 missing。）映射成 `{ id: toId(id), path, enabled: !!enabled, imageCount, lastScanAt: last_scan_at }`。

4. `updateSettings(body)`：在一个事务里，对 body 中出现的每一段：`merged = { ...current[k], ...body[k] }`，并删掉 danbooru 段里的 `hasApiKey` / `lastSyncAt`（这两个只允许后端写）；
```sql
INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```
`danbooruApiKey`：undefined 不动；`''` → `DELETE FROM settings WHERE key = 'secret.danbooruApiKey'`；非空 → trim 后 upsert。然后调用设置监听器（第 8 步）和 `ctx.touch()`，返回 `getSettings()`。不可撤销（与 mock 一致）。

5. 路径工具（导出，T03 / T08 / T17 复用）：
```ts
export function normalizeRootPath(input: string): string {
  let p = input.trim().replace(/^"(.*)"$/, '$1');                   // 资源管理器「复制为路径」会带引号
  if (!p) throw new BadRequestError('路径不能为空');
  if (/^[a-zA-Z]:$/.test(p)) p += '/';                               // 裸盘符「D:」按盘符根处理（path.isAbsolute('D:') 是 false）
  if (!path.isAbsolute(p)) throw new BadRequestError('请填写完整路径，例如 D:/Pictures/插画');
  p = path.resolve(p).split(path.win32.sep).join('/');
  if (/^[a-zA-Z]:[/]?$/.test(p)) return `${p[0]!.toUpperCase()}:/`;   // 盘符根目录保留斜杠
  p = p.replace(/[/]+$/, '');
  return /^[a-z]:/.test(p) ? p[0]!.toUpperCase() + p.slice(1) : p;
}
export const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();   // Windows 不区分大小写
export const isInside = (child: string, parent: string) =>
  child.toLowerCase().startsWith(parent.toLowerCase().replace(/[/]$/, '') + '/');
```

6. `addLibraryRoot({ path })`：
   1. `p = normalizeRootPath(path)`；在事务外 `await fs.promises.stat(p)`：ENOENT → `BadRequestError('找不到这个文件夹：' + p)`；不是目录 → `BadRequestError('这不是一个文件夹')`；EACCES/EPERM → `BadRequestError('没有权限读取这个文件夹')`。
   2. 读出所有行（包括已移除的）：未移除的里面有 samePath → `BadRequestError('这个文件夹已经在图库里了')`（mock 原文）；和任一未移除的行互相包含（`isInside(p, other) || isInside(other, p)`）→ `BadRequestError('和已有文件夹重叠：' + other.path)`；设 `d = normalizeRootPath(ctx.dataDir)`（`config.dataDir` 是反斜杠的原生路径，**必须先规范化再比较**），`samePath(p, d) || isInside(p, d) || isInside(d, p)` → `BadRequestError('不能把 Emaki 的数据目录加入图库')`。
   3. 已移除的行里有 samePath → `UPDATE library_roots SET removed_at = NULL, enabled = 1, path = ? WHERE id = ?`（复活，旧图和识别结果全部回来）；否则 `INSERT INTO library_roots (path, enabled) VALUES (?, 1)`。
   4. `ctx.touch()` → 通知文件夹监听器（T08 据此开始监听）→ `ctx.jobs.enqueue('scan')`（T07 会把这里改成「只扫新文件夹 + requeueIfRunning」；T07 之前这个 scan 任务会显示 failed 并提示 T07，属正常）→ 返回 `done(`已添加文件夹，开始扫描：${p}`)`（不可撤销，与 mock 一致）。

7. `updateLibraryRoot(id, enabled)`：parseId 失败、行不存在或已移除 → `NotFoundError('图库文件夹')`。记下旧值 → UPDATE → `ctx.touch()` → `ctx.undo.result(enabled ? `已启用：${path}` : `已停用：${path}`, () => { UPDATE 回旧值; ctx.touch(); 通知文件夹监听器 })`。
   `removeLibraryRoot(id)`：同样的校验 → `UPDATE library_roots SET removed_at = ? WHERE id = ?`；撤销 = `SET removed_at = NULL`；提示 `已移除文件夹（不会删除磁盘上的文件）：${path}`。

8. 内部接口（给 T07 / T08 / T09 / T10 / T11 用，不走 HTTP）：
```ts
// SqliteDataSource 的公开方法（监听器存在实例上）
onSettingsChanged(fn: (s: Settings) => void): () => void
onRootsChanged(fn: () => void): () => void
// settings.ts 的模块级函数（第一个参数是 db，其他任务直接 import，不需要拿到 SqliteDataSource 实例）
/** 后端内部改设置（例如 T11 写 danbooru.lastSyncAt），不触发 touch */
export function patchSettingsInternal(db: Db, key: 'tagger' | 'danbooru' | 'dedupe' | 'ui', patch: Record<string, unknown>): void
export function getDanbooruApiKey(db: Db): string | null
```

9. `purgeRemovedRoots()`：在 `open()` 迁移之后调用：
```sql
DELETE FROM library_roots WHERE removed_at IS NOT NULL;    -- 级联删掉 images 及其 image_* 行
DELETE FROM exclusions WHERE kind = 'image' AND CAST(target AS INTEGER) NOT IN (SELECT id FROM images);
```
打印删除数量。缩略图文件由 T04 的孤儿清理处理。

### 坑
- 路径比较忽略大小写，存储保留原大小写。`library_roots.path` 的 UNIQUE 区分大小写，所以重复判断必须在 JS 里做。
- `D:` 经 `path.resolve` 会变成「D 盘的当前目录」，所以盘符根目录按上面的写法单独处理。
- API key 只写不读：`getSettings` 永远不返回它；日志里不要打印请求 body。
- 设置是「按段浅合并」；`libraryRoots` 永远不存进 settings 表。
- `fs.promises.stat` 是异步的，必须在事务之外调用。
- 提示文案直接复制 MockDataSource 里的字符串。`updateSettings` 返回 `Settings`，不是 `MutationResult`。

### 验收标准
（sqlite 模式运行，`$env:EMAKI_DATA_SOURCE='sqlite'; $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev'; npm run dev:server`）
```powershell
$api = 'http://127.0.0.1:5174/api'
Invoke-RestMethod "$api/settings" | ConvertTo-Json -Depth 5      # libraryRoots=[]，tagger 为默认值（0.35/0.35/0.85），hasApiKey=false
Invoke-RestMethod -Method Put "$api/settings" -ContentType 'application/json' -Body '{"ui":{"theme":"dark"},"danbooruApiKey":"abc"}'
# ui.theme=dark，其它 ui 字段不变，danbooru.hasApiKey=true，响应里没有 abc
New-Item -ItemType Directory -Force F:/Claude/emaki/data/tmp-lib/sub | Out-Null
Invoke-RestMethod -Method Post "$api/library-roots" -ContentType 'application/json' -Body '{"path":"F:/Claude/emaki/data/tmp-lib/"}'
# message = 已添加文件夹，开始扫描：F:/Claude/emaki/data/tmp-lib
```
- 再加 `f:/claude/EMAKI/data/tmp-lib` → 400「这个文件夹已经在图库里了」；加 `F:/Claude/emaki/data/tmp-lib/sub` → 400「和已有文件夹重叠」；加 `F:/不存在` → 400「找不到这个文件夹」；加 `F:/Claude/emaki/data/dev` → 400「不能把 Emaki 的数据目录加入图库」。
- DELETE 这个文件夹 → settings 里消失；`POST /api/undo/<token>` → 回来；再删一次并重启 → `db-info` 显示 library_roots 0 行。
- 重启后设置保持。
- `npx vitest run settings` 通过：`normalizeRootPath` 覆盖带引号（`"D:\Pictures\插画"` → `D:/Pictures/插画`）、盘符根（`D:`、`D:\`、`d:/` 都 → `D:/`）、结尾斜杠（`D:\a\` → `D:/a`）、小写盘符（`d:\a` → `D:/a`）、UNC（`\\nas\share\x` → `//nas/share/x`）、相对路径（`a\b`、`.\a`）→ 抛 BadRequestError。
- 把 `T02` 加进 `SQLITE_READY` 后，T24 的 settings 契约在 mock 和 sqlite 两边都通过。

### 难度
S–M

# M1 入库

> M1 的推荐顺序：T06 → T07.1 → T03 → T04 → T05 → T07（其余）→ T08。T07.1 只改 `core/jobs.ts`，T03 / T04 的 runner 要用到它的 `shouldYield()` / `requeue()` 和「返回值作为最终 message」。

## T03 扫描器（遍历图库文件夹、sha256、元数据、增删改入库、missing 标记）

### 目标
把所有「启用」的图库文件夹同步进 `images` 表。只读文件头并计算 sha256，**不解码像素**（缩略图、主色、dHash 属于 T04 的「像素处理」）。
- 新文件 → 插入
- 内容变化（大小或 mtime 变了，并且 sha256 也变了）→ 原地更新，**保留 id**（角色、收藏、排除都还在），清空像素结果和打标签结果
- 移动 / 改名（同目录、跨目录、跨图库根都算）→ 只改 `root_id / rel_path / file_name`，**保留 id**
- 文件消失 → `missing = 1`（不删行；整个根目录不可访问时一张都不标）
- 标了 missing 或 trashed 的文件又出现（例如用户从回收站还原）→ 清掉标记
- 两种模式：全量（所有启用的根）和增量（只扫 T08 给出的脏目录）。可以取消。**取消了或目录读取失败时，绝不做「丢失」判定**
- 读不了或不支持的文件写进 `scan_errors`，文件没变之前不再重试

### 依赖
- 必须：T01、T02（`library_roots` 读写、`normalizeRootPath`）、T07.1（`JobContext` 的新字段）
- 可选：T06 的 `parseSource`（没做时 source_* 写 NULL）；T17 的 `applyExclusionRules`（没做时先留 `// TODO(T17)` 调用点）
- 被依赖：T04、T07（把 `Scanner` 接进 Pipeline）、T08（往 `ScanRequests` 里塞脏目录）、T09（`sha256File`、`sharpConfig`）、T16

### 涉及文件
新建：
- `apps/server/src/db/migrations/003_files.sql`（T03 和 T04 的表结构改动都放这一个文件）
- `apps/server/src/services/fs/paths.ts`：扩展名、跳过规则、路径换算
- `apps/server/src/services/fs/walk.ts`：递归遍历
- `apps/server/src/services/fs/hash.ts`：sha256
- `apps/server/src/services/image/sharpConfig.ts`：sharp 全局设置（内容见 T04 第 1 步，T03 先建好）
- `apps/server/src/services/image/probe.ts`：读文件头（格式、宽高）
- `apps/server/src/services/scan/ScanRequests.ts`：全量 / 脏目录请求（T07、T08 共用）
- `apps/server/src/services/scan/Scanner.ts`：扫描主流程
- `apps/server/scripts/make-fixtures.ts`：生成测试图库（T04、T16、T18、T24 共用）
- `apps/server/scripts/scan-once.ts`：不起 HTTP，直接对开发库跑一次扫描
- `apps/server/scripts/db-query.ts`：开发用，对 `EMAKI_DATA_DIR` 下的库执行一条 SQL 并用 `console.table` 打印
- 测试：`services/fs/walk.test.ts`、`services/image/probe.test.ts`、`services/scan/Scanner.test.ts`

### 实现步骤

#### 1. 安装 sharp
```powershell
npm i sharp@^0.35.4 -w @emaki/server
```
- sharp 0.35.0 起**删掉了 install 脚本**，Windows x64 的 sharp + libvips 通过可选依赖 `@img/sharp-win32-x64` 作为普通 npm 包下发，不会被 allowScripts 拦截，不需要 `npm approve-scripts`。国内用 npmmirror 也能装，不走 GitHub。
- 不要加 `--omit=optional` 或 `--no-optional`，否则运行时报 `Could not load the "sharp" module using the win32-x64 runtime`。
- 自检：`node --input-type=module -e "import s from 'sharp'; console.log(s.versions)"`，能打印出 `vips` 版本就行。
- 按 T04 第 1 步的内容建好 `services/image/sharpConfig.ts`，本任务里所有 sharp 调用都从它 import。

#### 2. 迁移 `003_files.sql`
```sql
-- 像素处理（T04）完成时间：480/240 缩略图 + 主色 + dHash；NULL = 待处理
ALTER TABLE images ADD COLUMN thumb_at TEXT;
-- 像素处理失败原因；非 NULL 时后台任务跳过。文件内容变化时由扫描器清空
ALTER TABLE images ADD COLUMN decode_error TEXT;
CREATE INDEX idx_images_pixel_pending ON images(id) WHERE thumb_at IS NULL AND decode_error IS NULL;
CREATE INDEX idx_images_missing ON images(missing) WHERE missing = 1;

-- 扫描时读不了或不支持的文件。不进 images 表，避免宽高为 0 弄坏前端布局
CREATE TABLE scan_errors (
  root_id      INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
  rel_path     TEXT    NOT NULL,
  bytes        INTEGER NOT NULL,
  modified_at  TEXT    NOT NULL,
  error        TEXT    NOT NULL,
  at           TEXT    NOT NULL,
  PRIMARY KEY (root_id, rel_path)
);
```

#### 3. `services/fs/paths.ts`
```ts
import path from 'node:path';
export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.apng', '.webp', '.gif', '.avif', '.bmp']);
// 旧版 Chrome 另存推特图时得到的扩展名：a.jpg_large / a.png_orig / a.jpg-large
const TWITTER_EXT = /\.(jpe?g|png|webp|gif)[_-](large|orig|medium|small|thumb|\d+x\d+)$/i;
export function isImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTS.has(path.extname(lower)) || TWITTER_EXT.test(lower);
}
const SKIP_DIRS = new Set(['system volume information', 'recycler', 'node_modules', '@eadir', '__macosx', '#recycle', '#snapshot']);
/** 以 . 或 $ 开头的目录（.git、.emaki-trash、$RECYCLE.BIN）以及黑名单里的目录都不进 */
export function isSkippedDirName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('$') || SKIP_DIRS.has(name.toLowerCase());
}
/** rootPath 是库里的形式（正斜杠、无结尾斜杠，但盘符根是 `D:/`）。返回平台原生路径 */
export function toAbs(rootPath: string, relPath: string): string {
  return path.join(rootPath.endsWith('/') ? rootPath : rootPath + '/', relPath);
}
export const toRel = (rootAbs: string, abs: string) => path.relative(rootAbs, abs).split(path.sep).join('/');
export const isoFromMs = (ms: number) => new Date(Math.trunc(ms)).toISOString();
/** 路径比较键：Windows 不区分大小写 */
export function pathKey(p: string): string {
  const n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
export const parentRel = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
```

#### 4. `services/fs/walk.ts`：手写栈遍历（不要用 `readdir({ recursive: true })`）
```ts
export interface WalkEntry { relPath: string; bytes: number; mtimeMs: number; birthtimeMs: number }
export interface WalkOptions {
  startRel?: string;            // 从哪个子目录开始（相对根，'' = 根）
  recursive?: boolean;          // false = 只列 startRel 这一层
  skipAbs?: string[];           // 要跳过的绝对路径：dataDir、嵌套在里面的其他图库根
  signal?: AbortSignal;
  onDirError?: (relDir: string, err: NodeJS.ErrnoException) => void;
}
export async function* walkImages(rootPath: string, o: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  const skip = new Set((o.skipAbs ?? []).map(pathKey));
  const stack = [o.startRel ?? ''];
  while (stack.length) {
    if (o.signal?.aborted) return;
    const rel = stack.pop()!;
    let entries: Dirent[];
    try { entries = await readdir(toAbs(rootPath, rel), { withFileTypes: true }); }
    catch (err) { o.onDirError?.(rel, err as NodeJS.ErrnoException); continue; } // EPERM/EACCES/ENOENT：跳过这个目录
    const files: string[] = [];
    for (const d of entries) {
      if (d.isSymbolicLink()) continue;              // Windows junction 在 Node 里也是 symlink，跳过以防成环
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (o.recursive === false || isSkippedDirName(d.name)) continue;
        if (skip.has(pathKey(toAbs(rootPath, child)))) continue;
        stack.push(child);
      } else if (d.isFile() && isImageFile(d.name)) files.push(child);
    }
    for (let i = 0; i < files.length; i += 16) {       // 每批并发 stat 16 个
      const chunk = files.slice(i, i + 16);
      const stats = await Promise.allSettled(chunk.map((r) => stat(toAbs(rootPath, r))));
      for (let k = 0; k < chunk.length; k++) {
        const s = stats[k]!;
        if (s.status === 'fulfilled' && s.value.isFile() && s.value.size > 0)
          yield { relPath: chunk[k]!, bytes: s.value.size, mtimeMs: s.value.mtimeMs, birthtimeMs: s.value.birthtimeMs };
      }
    }
  }
}
```

#### 5. `services/fs/hash.ts`
```ts
export const sha256Buffer = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
export async function sha256File(abs: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(abs, { highWaterMark: 1 << 20 })) h.update(chunk as Buffer);
  return h.digest('hex'); // 不要 pipeline(stream, hash) 之后再 digest()，会抛 ERR_CRYPTO_HASH_FINALIZED
}
```

#### 6. `services/image/probe.ts`
```ts
export class UnsupportedImageError extends Error {}
export interface Probe { format: ImageFormat; width: number; height: number; pages: number }
export async function probeImage(input: Buffer | string): Promise<Probe> {
  try {
    const m = await sharp(input, { failOn: 'none' }).metadata();
    const format = m.format === 'jpeg' || m.format === 'png' || m.format === 'webp' || m.format === 'gif' ? m.format
      : m.format === 'heif' && m.compression === 'av1' ? 'avif'   // AVIF 在 sharp 里报 format 'heif' + compression 'av1'
      : null;                                                       // HEIC(hevc)、svg、tiff、jp2… 不收
    const width = m.autoOrient?.width ?? m.width;                   // metadata().width 不考虑 EXIF 方向，autoOrient 里的才是显示尺寸
    const height = m.autoOrient?.height ?? m.height;
    if (!format || !width || !height) throw new UnsupportedImageError(`不支持的格式：${m.format}`);
    return { format, width, height, pages: m.pages ?? 1 };        // 动图默认只读第一帧，height 是单帧高度
  } catch (err) {
    const bmp = await readBmpHeader(input);                         // 预编译 sharp 不支持 BMP
    if (bmp) return bmp;
    throw err;
  }
}
```
`readBmpHeader`：取前 26 字节（input 是路径时用 `fs.open` + `read`），`buf[0]===0x42 && buf[1]===0x4d` 时返回 `{ format: 'bmp', width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)), pages: 1 }`，否则返回 null。

#### 7. `services/scan/ScanRequests.ts`
```ts
export interface ScanScope { rootId: number; relDir: string; recursive: boolean }
export class ScanRequests {
  private full = false;
  private dirty = new Map<string, ScanScope>();          // key = `${rootId}\n${relDir}`
  requestFull(): void { this.full = true; }
  addDirty(s: ScanScope): void { /* 同一个 key 的 recursive 取 OR；已被某个祖先目录的 recursive scope 覆盖就不加 */ }
  get pending(): boolean { return this.full || this.dirty.size > 0; }
  /** 取出并清空。没有任何请求时（比如手动 startJob）视为全量 */
  take(): { full: boolean; scopes: ScanScope[] } { /* ... */ }
}
```

#### 8. `services/scan/Scanner.ts`
```ts
export interface ScanSummary { added: number; updated: number; moved: number; missing: number; restored: number;
  errors: number; deferred: number; unreachable: string[]; newIds: number[] }
export class Scanner {
  constructor(private readonly d: { db: Database.Database; bus: EventBus; dataDir: string; requests: ScanRequests;
    /** T17：在每批写入的同一个事务里，对新插入的图应用排除规则 */
    onNewImagesInTx?: (ids: number[]) => void;
    /** 「刚修改过、可能还在写入」的判定窗口，默认 2000 ms；单元测试传 0（测试里刚写的文件 mtime 就是现在） */
    settleMs?: number;
    /** 当前时间，默认 Date.now；测试可注入 */
    now?: () => number }) {}
  async scan(ctx: JobContext): Promise<ScanSummary> { /* 下面这些阶段 */ }
}
export function formatScanSummary(s: ScanSummary): string // 「扫描完成：新增 12 · 更新 1 · 移动 3 · 丢失 0 · 无法读取 1」；deferred > 0 时追加「 · 延后 N」；有不可达的根时追加「 · 无法访问：D:/xxx」
```
**阶段 0 请求**：`const req = requests.take()`；`roots = SELECT id, path, last_scan_at FROM library_roots WHERE enabled = 1 AND removed_at IS NULL`。全量时每个根一个 scope `{ relDir: '', recursive: true }`；否则用 `req.scopes`（过滤掉已停用或已移除的根）。

**阶段 1 可达性**：`stat(root.path)` 失败或不是目录 → 放进 `summary.unreachable`，丢掉这个根的所有 scope（**不标 missing**）。

**阶段 2 遍历**：用 `walkImages` 收集 `disk: Map<"rootId\nrelPath", WalkEntry & { rootId }>`。`skipAbs` = dataDir + 其他启用的根里位于当前根之内的路径。`onDirError` 把读失败的目录记进 `failedDirs`。每发现 500 个文件调一次 `ctx.setMessage('正在遍历：已发现 N 个文件')`。

**阶段 3 读库**：对每个 scope 执行（`@prefix` = relDir 为空时是 `''`，否则是 `relDir + '/'`；**不要用 LIKE**）：
```sql
SELECT id, root_id, rel_path, file_name, bytes, modified_at, sha256, missing, trashed_at
FROM images
WHERE root_id = @rootId
  AND (@prefix = '' OR substr(rel_path, 1, length(@prefix)) = @prefix)
  AND (@recursive = 1 OR instr(substr(rel_path, length(@prefix) + 1), '/') = 0)
```
再读全库的移动候选 `SELECT id, root_id, rel_path, file_name, bytes, modified_at, sha256 FROM images WHERE missing = 1`，以及本根的 `scan_errors`。

**阶段 4 分类**（写成纯函数 `classify(disk, dbRows, failedDirs, scanErrors)`，方便单测）：
- 磁盘和库里都有：`bytes` 相等且 `modified_at === isoFromMs(mtimeMs)` → unchanged（如果 missing=1 或 trashed_at 非空 → restored）；否则 → changed
- 只在磁盘上：在 scan_errors 里而且 bytes、modified_at 都没变 → 跳过；否则 → fresh
- 只在库里：位于 failedDirs 之下 → 不动；否则 → gone
- 然后 `ctx.setTotal(changed.length + fresh.length)`

**阶段 5 快速移动匹配（不读文件）**：用 gone ∪ 全库 missing 行建索引，key 为 `file_name + '\n' + bytes + '\n' + modified_at`。fresh 里的文件恰好命中 1 个候选时视为移动，并从候选里移除。整个目录改名走的就是这条路，不用重算哈希。

**阶段 6 读文件**（手写 worker 池，并发数 `Number(process.env.EMAKI_SCAN_CONCURRENCY ?? 2)`）。对 changed 和剩下的 fresh 逐个处理：
1. `now() - mtimeMs < settleMs`（默认 2000），文件可能还在写入 → `requests.addDirty({ rootId, relDir: parentRel(relPath), recursive: false })`，`deferred++`，跳过
2. `bytes <= 64 MiB` 时 `buf = await readFile(abs)`；如果 `buf.length !== bytes` 同样延后；`sha = sha256Buffer(buf)`。大文件用 `sha256File(abs)`，`buf = null`
3. `probe = await probeImage(buf ?? abs)`（**优先传 Buffer**：绕开 260 字符长路径问题，sharp 也不会占着文件句柄）。抛错 → upsert scan_errors，`errors++`
4. changed：sha 没变 → 只更新 bytes / modified_at；sha 变了 → 走「内容变化」更新
5. fresh：在 `sha256 + bytes` 相同的 gone/missing 候选里找（取 id 最小的并移除）→ 移动；找不到 → 插入
6. 结果进写缓冲，每 200 条或每 1 秒执行一次 `db.transaction(flush)()`。flush 里插入完新行后，在**同一个事务里**调用 `onNewImagesInTx(本批新 id)`（T17 的排除规则）。flush 之后 `await new Promise((r) => setImmediate(r))` 让出事件循环
7. `ctx.advance(1, `${done}/${total} · ${fileName}`)`，每轮检查 `ctx.signal.aborted`

SQL（全部只 prepare 一次）：
```sql
-- 插入
INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256,
  source_site, source_post_id, source_artist, source_url, added_at, modified_at)
VALUES (@rootId, @relPath, @fileName, @width, @height, @bytes, @format, @sha256,
  @site, @postId, @artist, @url, @addedAt, @modifiedAt);
-- 内容变化（保留 id / 角色 / 收藏 / excluded_by）
UPDATE images SET width=@width, height=@height, bytes=@bytes, format=@format, sha256=@sha256, modified_at=@modifiedAt,
  dhash=NULL, dominant_color=NULL, thumb_at=NULL, decode_error=NULL, tagged_at=NULL, tagger_model=NULL,
  missing=0, trashed_at=NULL
WHERE id=@id;
-- 只有 mtime/大小变了，内容相同
UPDATE images SET bytes=@bytes, modified_at=@modifiedAt, missing=0, trashed_at=NULL WHERE id=@id;
-- 移动 / 改名
UPDATE images SET root_id=@rootId, rel_path=@relPath, file_name=@fileName, modified_at=@modifiedAt, missing=0, trashed_at=NULL,
  source_site=COALESCE(@site, source_site), source_post_id=COALESCE(@postId, source_post_id),
  source_artist=COALESCE(@artist, source_artist), source_url=COALESCE(@url, source_url)
WHERE id=@id;
-- 丢失 / 恢复（@ids = JSON.stringify(数字数组)）
UPDATE images SET missing=1 WHERE id IN (SELECT value FROM json_each(@ids)) AND missing=0;
UPDATE images SET missing=0, trashed_at=NULL WHERE id IN (SELECT value FROM json_each(@ids));
-- 失败记录
INSERT INTO scan_errors (root_id, rel_path, bytes, modified_at, error, at) VALUES (@rootId, @relPath, @bytes, @modifiedAt, @error, @at)
ON CONFLICT(root_id, rel_path) DO UPDATE SET bytes=excluded.bytes, modified_at=excluded.modified_at, error=excluded.error, at=excluded.at;
```
source_* 由 T06 的 `parseSource(relPath)` 算出（T06 没做时全写 NULL）。
`addedAt`：该根 `last_scan_at IS NULL`（首次导入）时用 `isoFromMs(Math.min(birthtimeMs || mtimeMs, mtimeMs))`，否则用当前时间。不然首次导入的 10 万张全挤在「今天」，「最近 7 天」统计和按入库时间排序都没有意义。

**阶段 7 丢失**：`ctx.signal.aborted` 为 true 时整段跳过；否则剩下的 gone 全部标 missing=1。
**阶段 8 恢复**：restored → missing=0, trashed_at=NULL。
**阶段 9 收尾**：全量而且没被取消的根执行 `UPDATE library_roots SET last_scan_at=@now WHERE id=@id`；删掉已遍历 scope 里文件已不存在的 scan_errors 行；调用 T06 的 `backfillSources(db)`；`bus.emit({ type: 'library-changed', reason: 'scan' })`。
**事件节流**：扫描过程中每写完一批、且距上次 emit ≥ 3 秒时 emit 一次 `library-changed`，让前端网格逐步出现新图。

#### 9. 开发脚本（都在 `apps/server/scripts/`）
- `make-fixtures.ts <dir>`：用 sharp 生成**带纹理**的测试图（纯色图的 dHash 没有意义）。
  - **安全规则**：目标目录不存在 → 创建；存在且里面有标记文件 `.emaki-fixtures` → 整个清空后重新生成；存在但没有标记文件且不为空 → 报错退出（防止误删用户的图）。生成完写入标记文件。
  - `makePattern(seed, w, h)` 生成 raw RGB（正弦条纹 + 种子噪声；**条纹方向、频率、相位都由 seed 决定**，用 mulberry32(seed) 取值），再 `sharp(raw, { raw: { width: w, height: h, channels: 3 } })` 输出。
  - **图案分配规则**（T04 的「17 个不同 sha」和 T16 的「恰好 2 组重复」都依赖它）：清单里写了「图案 X」的按字母用固定种子（A=1, B=2, … I=9）；**没写图案的每一项都用自己独有的种子 `100 + 序号`**，除 #4、#5（逐字节拷贝）和 #6（A 的缩小版）以外，任意两张都不能相似。
  - **写文件一律 `await sharp(...).xxx().toBuffer()` 再 `fs.promises.writeFile`**，不要用 sharp 的 `toFile`（#15 的路径超过 260 字符，libvips 自己开文件可能失败；Node 的 fs 能处理长路径）。拷贝用 `fs.promises.copyFile`。
  - **全部生成完后，把每个文件的 mtime / atime 设为过去的时间**：`fs.promises.utimes(file, t, t)`，`t = new Date(Date.now() - 3600_000 - 序号 * 60_000)`。否则刚写完的文件会被扫描器的「2 秒内刚修改 → 延后」规则跳过，验收里的「新增 19」会变成「新增 17 · 延后 2」。
  - 清单如下，最后打印「应入库 19 张，应报错 1 个」：
  1. `pixiv/123456789_p0.png` 800×1200 图案 A
  2. `pixiv/123456789_p1.png` 1200×800 图案 B
  3. `pixiv/98765432 someuser/98765432_p0.jpg` 图案 C
  4. `copies/98765432_p0 - 副本.jpg`：#3 的逐字节拷贝（完全重复）
  5. `copies/123456789_p0 (1).png`：#1 的逐字节拷贝
  6. `copies/resized_A.jpg`：图案 A 缩到 50%，JPEG q85（相似）
  7. `twitter/someartist/1789012345678901234_1.jpg` 图案 D
  8. `twitter/someartist-1789012345678901234-20250101_120000-img1.jpg` 图案 E
  9. `twitter/GJnJQvHbwAAoY3S.jpg_large` 图案 F（JPEG）
  10. `downloads/__hatsune_miku_vocaloid_drawn_by_foo_bar__0123456789abcdef0123456789abcdef.jpg` 图案 G
  11. `alpha/transparent.png`：RGBA，一半透明
  12. `tall/strip.png` 800×20000
  13. `broken/truncated.jpg`：**图案 H** 的 1200×1200 JPEG 的前 60% 字节（文件头完整，能入库；用独立图案，避免截断图和 #3 连成相似组）
  14. `中文 目录/插画, 测试 [1].png`（逗号、方括号、空格、中文）
  15. `deep/<多层长目录名>/long.png`：绝对路径超过 260 字符
  16. `legacy/image.jfif`（JPEG 内容）
  17. `gif/still.gif`
  18. `avif/test.avif`（`.avif()` 输出）
  19. `bmp/test.bmp`：手写 24 位 BMP 300×200（54 字节头，行 4 字节对齐，BGR，自下而上）
  - 应报错：`broken/fake.png`（内容是文本）
  - 应被跳过：`.hidden/secret.png`、`$RECYCLE.BIN/x.png`、`misc/readme.txt`、`misc/empty.png`（0 字节）
- `scan-once.ts <rootPath>`：用 T01 的 `openDatabase` + `migrate` 打开 `${EMAKI_DATA_DIR}/emaki.sqlite`，`INSERT OR IGNORE` 这个根（路径先过 `normalizeRootPath`），执行 `new Scanner(...).scan(fakeCtx)`，打印 summary 和耗时。fakeCtx = `{ signal: new AbortController().signal, setTotal() {}, advance() {}, setMessage() {}, shouldYield: () => false, requeue() {}, yielded: false } satisfies JobContext`。
- `db-query.ts "<SQL>"`：打开 `${EMAKI_DATA_DIR}/emaki.sqlite`，`console.table(db.prepare(sql).all())`（非 SELECT 语句用 `run()` 并打印 changes）。

### 坑
- `readdir({ recursive: true })` 不能剪枝（会钻进 node_modules、$RECYCLE.BIN），而且子目录遇到 EPERM 会整体失败，所以要手写栈遍历。
- 盘符根陷阱：`path.join('D:', 'a.png')` 得到的是 `D:a.png`（相对于 D 盘当前目录）。`toAbs` 里一定先补 `/`。
- 扫描盘符根时会遇到 `System Volume Information`（EPERM），靠跳过名单 + 单目录 try/catch 处理。
- **某个子目录读失败，不能把它下面的行判成 gone**（failedDirs）；扫描被取消时也不做丢失判定。
- 根目录不可访问（U 盘没插、网络盘断开）：整个根跳过。
- mtime 比较统一用 `isoFromMs(Math.trunc(mtimeMs))`。FAT32/exFAT 的 2 秒精度没关系，因为比较两边来自同一来源。
- 首次扫描是 IO 瓶颈（sha256 要读全部字节：10 万张 × 3MB ≈ 300GB，机械盘要几十分钟），进度文案要写清楚。`EMAKI_SCAN_CONCURRENCY` 在机械盘上设成 1。
- `.jfif` 是 Windows 上常见的 JPEG 扩展名，`.jpg_large` 是推特旧格式，都要收。HEIC、SVG、TIFF、JXL 不收（预编译 sharp 解不了 HEIC）。
- 嵌套的图库根：外层扫描要跳过内层根，否则同一文件会有两行（T02 本来就拒绝重叠的根，这里是兜底）。

### 验收标准
1. `npm run typecheck` 通过。
2. `npx tsx apps/server/scripts/make-fixtures.ts F:/Claude/emaki/data/fixtures-lib` 打印「应入库 19 张，应报错 1 个」。再对一个非空、没有标记文件的目录执行 → 报错退出，不删任何文件。
3. `npx vitest run apps/server/src/services/fs apps/server/src/services/image apps/server/src/services/scan` 全绿。至少覆盖：walk 跳过隐藏目录、$RECYCLE.BIN、非图片和 0 字节文件，并能列出中文逗号文件名和超长路径文件；probe 对 avif、jfif、bmp、strip 返回正确的格式和宽高；Scanner.test 用临时目录 + `:memory:` 库（`new Scanner({ …, settleMs: 0 })`）验证：新增、移动后 id 不变、删除后 missing=1、放回后恢复、改内容后 id 不变但 sha 变了（改内容时用 `fs.utimes` 把 mtime 往后拨 10 秒，保证 mtime 一定变化）；另测 `settleMs: 60_000` 时刚写的文件计入 deferred 且 `requests.pending === true`。
4. 集成验证（PowerShell；在单独生成的副本上改文件，`fixtures-lib` 保持原样给后面的任务用）：
```powershell
npx tsx apps/server/scripts/make-fixtures.ts F:/Claude/emaki/data/fixtures-t03
$env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t03'
npx tsx apps/server/scripts/scan-once.ts F:/Claude/emaki/data/fixtures-t03   # 新增 19 · 无法读取 1
npx tsx apps/server/scripts/scan-once.ts F:/Claude/emaki/data/fixtures-t03   # 新增 0 · 更新 0 · 移动 0 · 丢失 0，耗时 < 1 秒
npx tsx apps/server/scripts/db-query.ts "SELECT id, rel_path FROM images WHERE file_name='123456789_p1.png'"
Move-Item F:/Claude/emaki/data/fixtures-t03/pixiv/123456789_p1.png F:/Claude/emaki/data/fixtures-t03/copies/
npx tsx apps/server/scripts/scan-once.ts F:/Claude/emaki/data/fixtures-t03   # 移动 1；再查 id 与上面相同，rel_path 已变
Rename-Item F:/Claude/emaki/data/fixtures-t03/twitter twitter2               # 整个目录改名 → 移动 3（清单 #7 #8 #9），id 都不变
Remove-Item F:/Claude/emaki/data/fixtures-t03/gif/still.gif                   # → 丢失 1，该行 missing=1
```
5. 把整个 fixtures-t03 目录暂时改名（模拟 U 盘拔掉）后再扫描：summary 显示「无法访问」，并且 `丢失 0`。改回原名。
6. `npx tsx apps/server/scripts/db-query.ts "SELECT COUNT(*) AS n FROM scan_errors"` = 1；再扫一次不重复报错。

### 难度
L

### 给实现模型的提示
- 先读 `MockDataSource.ts` 理解「可见」的含义；不要改 mock。
- 把纯函数（paths、walk、probe、分类逻辑）和写库分开，方便单测。
- 所有 SQL 用 prepared statement + 命名参数；id 在库里是 INTEGER，对外转字符串是 T05 的事。
- 先保证正确性（不丢数据、不误标 missing），性能留给 T22。

## T04 缩略图与主色（sharp，webp 240/480/960，缓存目录，getThumbnail）

### 目标
1. `getThumbnail(id, width)`：从缓存 `${dataDir}/thumbs/v1/ab/<sha256>_<w>.webp` 返回 webp；缓存里没有就当场生成（按需生成，优先级高）。
2. 后台任务 `thumbnail`（「像素处理」）：对所有待处理的图片**只解码一次原图**，同时产出 480 和 240 缩略图、主色 `dominant_color`、64 位 dHash `dhash`，写 `thumb_at`。960 不预生成，按需生成后缓存。
3. HTTP 缓存：SQLite 版的图片 id 是稳定的（内容变了 id 不变），现在路由上的 `immutable` 会让浏览器一直显示旧缩略图 → 改用 ETag（按 sha256）+ `Cache-Control: private, no-cache` + 304。

### 依赖
- T01、T03（images 行、`thumb_at` / `decode_error` 列、paths.ts、sharpConfig.ts）、T07.1（`shouldYield` / `requeue`）
- 被依赖：T05（getOriginal 也用 ETag）、T07（接 thumbnail 任务）、T16（用这里的 `computeDHash`）

### 涉及文件
- `apps/server/src/services/image/sharpConfig.ts`：T03 已建，内容以本任务第 1 步为准
- 新建 `apps/server/src/services/image/bmp.ts`：`decodeBmp`（24/32 位 BMP 转 raw）
- 新建 `apps/server/src/services/image/pixels.ts`：`openSharp`、`processPixels`、`computeDominantColor`、`fitBox`、`thumbPath`
- 新建 `apps/server/src/services/image/dhash.ts`：`computeDHash`（T16 用）
- 新建 `apps/server/src/services/fs/atomicWrite.ts`
- 新建 `apps/server/src/services/thumbs/ThumbnailService.ts`
- 新建 `apps/server/scripts/thumbs-once.ts`
- 修改 `apps/server/src/datasource/DataSource.ts`：`FileResponse` 增加可选的 `etag`、`cacheControl`
- 修改 `apps/server/src/routes/images.ts`：`sendFile` 支持 ETag/304，并改掉「内容变了会换 id」这句注释
- 修改 `apps/server/src/datasource/sqlite/SqliteDataSource.ts`：`getThumbnail`
- 依赖：`npm i p-queue@^9.3.3 -w @emaki/server`（纯 ESM，没有安装脚本，支持 priority 和 `onSizeLessThan`）

### 实现步骤

#### 1. `sharpConfig.ts`（所有用到 sharp 的模块都从这里 import）
```ts
import os from 'node:os';
import sharp from 'sharp';
// libvips 默认最多同时开着 20 个文件句柄（cache.files=20）。在 Windows 上会导致原图没法移到回收站或重命名（EBUSY）
sharp.cache(false);
// 每张图只用一半的核，给 HTTP / tagger 留余量
sharp.concurrency(Math.max(1, Math.floor(os.availableParallelism() / 2)));
export const SHARP_INPUT = { failOn: 'none', limitInputPixels: 500_000_000 } as const satisfies sharp.SharpOptions;
export { sharp };
```
- `failOn` 默认值是 `'warning'`，太严格：pixiv 常见的「Corrupt JPEG data: N extraneous bytes」都会直接失败。改用 `'none'`，截断的 JPEG 也能解出上半部分。
- `limitInputPixels` 默认 268402689（约 16384²），这里放宽到 5 亿像素，超过就记 decode_error。

#### 2. `pixels.ts`
```ts
export const WEBP = { quality: 80, effort: 4, smartSubsample: true } as const;
const MAX_WEBP = 16383;                                            // WebP 单边上限
export const fitBox = (w: number) => ({ width: w, height: Math.min(MAX_WEBP, w * 8), fit: 'inside' as const, withoutEnlargement: true });

/** BMP 走自己的解码器，其余格式直接交给 sharp；统一做 EXIF 自动旋转 */
export function openSharp(input: Buffer | string, format: ImageFormat): sharp.Sharp {
  if (format === 'bmp' && Buffer.isBuffer(input)) {
    const raw = decodeBmp(input);
    if (!raw) throw new Error('不支持的 BMP 变体');
    return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } });
  }
  return sharp(input, SHARP_INPUT).autoOrient();
}

export interface PixelResult { dominantColor: string; dhash: string }
/** 解码一次原图：写 480 + 240 缩略图，并算出主色和 dHash */
export async function processPixels(input: Buffer | string, format: ImageFormat, sha256: string, thumbsRoot: string): Promise<PixelResult> {
  const t480 = await openSharp(input, format).resize(fitBox(480)).webp(WEBP).toBuffer();
  await writeFileAtomic(thumbPath(thumbsRoot, sha256, 480), t480);
  const t240 = await sharp(t480).resize(fitBox(240)).webp(WEBP).toBuffer();   // 240 从 480 缩，便宜
  await writeFileAtomic(thumbPath(thumbsRoot, sha256, 240), t240);
  const [dominantColor, dhash] = await Promise.all([computeDominantColor(t240), computeDHash(t480)]);
  return { dominantColor, dhash };
}

export async function computeDominantColor(input: Buffer): Promise<string> {
  // stats() 统计的是「输入图」，所以先把压平 + 缩小后的结果写成 buffer 再统计
  const small = await sharp(input).flatten({ background: '#ffffff' }).resize(64, 64, { fit: 'inside' })
    .toColourspace('srgb').png().toBuffer();
  const { dominant, channels } = await sharp(small).stats();
  const luma = 0.2126 * dominant.r + 0.7152 * dominant.g + 0.0722 * dominant.b;
  // 插画多是白底：主色接近纯白或纯黑时改用平均色，占位色才有区分度
  const c = luma > 235 || luma < 20
    ? { r: channels[0]!.mean, g: (channels[1] ?? channels[0])!.mean, b: (channels[2] ?? channels[0])!.mean }
    : dominant;
  return '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}
export const thumbPath = (root: string, sha: string, w: number) => path.join(root, sha.slice(0, 2), `${sha}_${w}.webp`);
```

#### 3. `dhash.ts`
```ts
/** 64 位差值哈希：压平 → 缩到 9×8 灰度 → 每行相邻像素比较。返回 16 位 hex */
export async function computeDHash(input: Buffer): Promise<string> {
  const { data, info } = await sharp(input, { failOn: 'none' })
    .flatten({ background: '#ffffff' })                 // flatten 默认背景是黑色，透明图会变黑
    .resize(9, 8, { fit: 'fill', kernel: 'cubic' })     // fill：忽略宽高比
    .toColourspace('b-w')                                // 只调 greyscale() 的话仍然是 3 个相同通道
    .raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;                              // 期望为 1，按 stride 取值更保险
  let hi = 0, lo = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const bit = data[(y * 9 + x) * ch]! > data[(y * 9 + x + 1) * ch]! ? 1 : 0;
    if (y < 4) hi = ((hi << 1) | bit) >>> 0; else lo = ((lo << 1) | bit) >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}
```

#### 4. `bmp.ts`
`decodeBmp(buf): { data: Buffer; width: number; height: number; channels: 3 | 4 } | null`：只支持 BI_RGB(0) 的 24/32 位，以及 BI_BITFIELDS(3) 的 32 位（假定标准 BGRA 掩码），其余返回 null。字段位置：像素偏移 `readUInt32LE(10)`，宽 `readInt32LE(18)`，高 `readInt32LE(22)`（负数表示自上而下），位深 `readUInt16LE(28)`，压缩方式 `readUInt32LE(30)`；每行按 4 字节对齐，像素顺序是 BGR(A)，要转成 RGB(A)。大约 40 行。

#### 5. `atomicWrite.ts`
```ts
export async function writeFileAtomic(dest: string, buf: Buffer): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, buf);
  try { await rename(tmp, dest); }
  catch (err) {                                   // Windows：目标正被 HTTP 读取时 rename 会报 EPERM；同一 sha 内容相同，直接丢掉 tmp
    await rm(tmp, { force: true });
    if (!existsSync(dest)) throw err;
  }
}
```

#### 6. `ThumbnailService.ts`
```ts
export interface ThumbRow { id: number; sha256: string; format: ImageFormat; rel_path: string; root_path: string }
export class ThumbnailService {
  readonly queue = new PQueue({ concurrency: Math.max(2, Math.floor(os.availableParallelism() / 4)) });
  private readonly inflight = new Map<string, Promise<string | null>>();
  constructor(private readonly d: { db: Database.Database; thumbsRoot: string }) {}

  /** 按需生成：HTTP 用 priority 10，后台任务用 0 */
  ensure(row: ThumbRow, width: ThumbWidth, priority = 10): Promise<string | null> { /* 缓存命中直接返回；否则按 `${sha}_${w}` 合并并发请求，再 queue.add(() => this.generate(row, width), { priority }) */ }
  private async generate(row: ThumbRow, width: ThumbWidth): Promise<string | null> {
    // 1) 再查一次缓存
    // 2) width=240 且 480 已存在 → 从 480 缩
    // 3) 读原图：readFile(toAbs(root_path, rel_path))；文件超过 256MB 时直接把路径交给 sharp
    //    ENOENT → return this.anyCached(sha)（原图没了就退而用其他尺寸的缓存；已处理的重复组还要显示被删的图）
    // 4) width=960 → openSharp(...).resize(fitBox(960)).webp({ ...WEBP, quality: 82 }) 写缓存
    //    width=480/240 → processPixels(...)，然后
    //    UPDATE images SET dominant_color=@c, dhash=@h, thumb_at=@now, decode_error=NULL WHERE sha256=@sha
    // 5) 解码失败 → UPDATE images SET decode_error=@err WHERE sha256=@sha; return null
  }
  /** 后台任务 thumbnail */
  async runBackfill(ctx: JobContext): Promise<string> { /* 见下 */ }
}
```
`runBackfill`：
```sql
-- 总数
SELECT COUNT(*) AS n FROM images i JOIN library_roots r ON r.id = i.root_id AND r.enabled = 1 AND r.removed_at IS NULL
WHERE i.thumb_at IS NULL AND i.decode_error IS NULL AND i.missing = 0 AND i.trashed_at IS NULL;
-- 分批：按 id 倒序做 keyset（新图先处理，和默认的「按入库倒序」一致）
SELECT i.id, i.sha256, i.format, i.rel_path, r.path AS root_path
FROM images i JOIN library_roots r ON r.id = i.root_id AND r.enabled = 1 AND r.removed_at IS NULL
WHERE i.thumb_at IS NULL AND i.decode_error IS NULL AND i.missing = 0 AND i.trashed_at IS NULL AND i.id < @last
ORDER BY i.id DESC LIMIT 200;
```
每条的处理：同一 sha 本轮已处理过就跳过（`advance(1)`）；`await queue.onSizeLessThan(2)`（反压，不要一次塞 10 万个任务）；`queue.add(() => this.generate(row, 480), { priority: 0 })`，完成后 `ctx.advance(1, ...)`；每批开头检查 `ctx.signal.aborted`；`ctx.shouldYield()` 为 true 时 `ctx.requeue()` 并返回「已让出给扫描」。结束时 `await queue.onIdle()`，返回 `生成缩略图：完成 N 张，失败 M 张`。**不要每张图都 emit library-changed**（JobQueue 在任务结束时会发一次）。

#### 7. `getThumbnail`（SqliteDataSource）
```ts
async getThumbnail(id: ID, width: ThumbWidth): Promise<FileResponse | null> {
  const n = parseId(id); if (n == null) return null;
  // 不要求「可见」：排除页和已处理的重复组都要显示被排除或已删除图片的缩略图（mock 也是这样）
  const row = this.ctx.stmt(`SELECT i.id, i.sha256, i.format, i.rel_path, r.path AS root_path
    FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ?`).get(n) as ThumbRow | undefined;
  if (!row) return null;
  const file = await this.thumbs.ensure(row, width);
  if (!file) return null;
  return { kind: 'path', contentType: 'image/webp', filePath: file,
           etag: `"${row.sha256.slice(0, 20)}-${width}"`, cacheControl: 'private, no-cache' };
}
```
`this.thumbs = new ThumbnailService({ db, thumbsRoot: path.join(dataDir, 'thumbs', 'v1') })` 在 `open()` 里创建（T07 组装 Pipeline 时复用同一个实例）。

#### 8. HTTP：`DataSource.ts` 与 `routes/images.ts`
```ts
export type FileResponse =
  | { kind: 'buffer'; contentType: string; body: Buffer | string; etag?: string; cacheControl?: string }
  | { kind: 'path'; contentType: string; filePath: string; etag?: string; cacheControl?: string };

function sendFile(req: FastifyRequest, reply: FastifyReply, file: FileResponse, defaultCache: string) {
  reply.header('Cache-Control', file.cacheControl ?? defaultCache);
  if (file.etag) {
    reply.header('ETag', file.etag);
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === file.etag)) return reply.code(304).send();
  }
  reply.type(file.contentType);
  return file.kind === 'buffer' ? reply.send(file.body) : reply.send(createReadStream(file.filePath));
}
```
mock 不带 etag，照旧走 `immutable`，行为不变。

#### 9. 可选：缓存清理
完整跑完一轮 backfill 后：遍历 `thumbs/v1/*/`，删除 sha 不在 `SELECT DISTINCT sha256 FROM images` 里的文件，以及超过 1 小时的 `*.tmp`。

#### 10. `apps/server/scripts/thumbs-once.ts`
打开 `${EMAKI_DATA_DIR}` 的库，`new ThumbnailService(...).runBackfill(fakeCtx)`（fakeCtx 同 T03），打印返回的消息和耗时。

### 坑
- WebP 单边上限是 16383：800×20000 的长条图不限高度直接报错，所以 `fitBox` 用 `fit: 'inside'` 同时限制高度。
- `stats()` 统计的是**输入图**，不是管线处理后的结果，必须先 `toBuffer()` 再 `sharp(buf).stats()`。
- `flatten()` 默认背景是黑色；透明 PNG 不压平的话，主色和 dHash 都会偏黑。
- GIF / APNG 默认只读第一帧（`animated: false`）→ 缩略图是静态的，这正是我们要的；看图器用原图，动图照样会动。
- 预编译 sharp **不支持 BMP**（没有 magick 加载器）也不支持 HEIC → BMP 走 `decodeBmp`；其他不支持的写 decode_error。
- Windows 文件锁：必须 `sharp.cache(false)`，并且尽量传 Buffer，否则回收站（T18）或用户在资源管理器里改名会报「文件正在使用」。
- sharp 任务跑在 libuv 线程池（默认 4 线程），和 fs 读写共用；并发太高时 HTTP 读原图会排队。所以 queue 并发保持在 2~4。`UV_THREADPOOL_SIZE` 留给 T23 的启动脚本设置。
- 多行可能共享同一 sha（完全重复）：DB 更新要按 sha256，不要按 id。
- `ensure` 里的并发合并（inflight Map）一定要有：网格一次会对同一张图请求 240 和 480。

### 验收标准
1. `npm run typecheck` 通过；`npx vitest run apps/server/src/services/image` 全绿，包括：
   - `dhash.test.ts`：图案 A 与「A 缩 50% 再存 JPEG」的汉明距离 ≤ 6；A 与 B ≥ 20；同一 buffer 算两次结果相同
   - `pixels.test.ts`：纯红 200×200 → 主色 r ≥ 240、g,b ≤ 16；纯白图 → 走平均色分支，结果为 `#ffffff`；strip 的 480 缩略图宽 ≤ 480 且高 ≤ 3840；透明 PNG 的缩略图 `metadata().hasAlpha === true`
   - `bmp.test.ts`：make-fixtures 生成的 BMP 解码后宽高 300×200，左上像素颜色正确
2. 离线跑一遍像素处理（`fixtures-lib` 是 T03 验收第 2 步生成的原样图库）：
```powershell
$env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t04'
npx tsx apps/server/scripts/scan-once.ts F:/Claude/emaki/data/fixtures-lib
npx tsx apps/server/scripts/thumbs-once.ts
npx tsx apps/server/scripts/db-query.ts "SELECT file_name, dominant_color, dhash, thumb_at IS NOT NULL AS ok, decode_error FROM images"
```
   19 行都是 ok=1，dhash 为 16 位 hex；`(Get-ChildItem F:/Claude/emaki/data/dev-t04/thumbs/v1 -Recurse -Filter *_480.webp).Count` 等于不同 sha 的数量（17）。
3. HTTP（服务端 `$env:EMAKI_DATA_SOURCE='sqlite'`，数据目录同上）：
   - `curl.exe -s -D - -o NUL "http://127.0.0.1:5174/api/images/1/thumb?w=960"` → 200，`content-type: image/webp`，带 `ETag`
   - `curl.exe -s -o NUL -w "%{http_code}" -H "If-None-Match: <上一步的 ETag>" "http://127.0.0.1:5174/api/images/1/thumb?w=960"` → `304`
   - 删掉 `thumbs` 目录后再请求 → 200，文件重新生成
4. 用 `make-fixtures.ts` 另生成 `data/fixtures-t04`、扫描并生成缩略图后：把某张原图挪出图库（不扫描），请求 `w=480` → 仍然 200（走缓存）；对另一张原图立刻 `Rename-Item` → 成功，没有「文件正在使用」。
5. mock 回归：不设 `EMAKI_DATA_SOURCE` 启动，前端缩略图照常显示（响应头仍是 immutable）。

### 难度
M

### 给实现模型的提示
- 所有 sharp 调用都从 `sharpConfig.ts` 导入，确保 `cache(false)` 先执行。
- 先让 `getThumbnail` 能按需生成，再写 backfill；backfill 只是循环调用 `generate(row, 480)`。

## T05 图片查询与文件服务（listImages/getImage/updateImage/getOriginal/revealImage）

### 目标
用 SQL 实现 `listImages`（筛选、排序、游标分页，行为与 `MockDataSource.listImages` 一致）、`getImage`、`updateImage`（可撤销）、`getOriginal`（流式发原图 + ETag）、`revealImage`（在资源管理器中选中文件）。同时沉淀共享的 `hydrateImages` / `loadImageItems`（行转 `ImageItem`）和 `loadSuggestions`，供 T15、T16、T17、T18 复用。

### 依赖
- T01（db、`sql.ts`、SQL 函数 `search_key`、视图）、T03（images 数据）、T04（`FileResponse.etag` 与路由的 ETag 处理）
- 撤销先用 `ctx.undo.result(message, revert)`；T19 完成后可以改用 `ctx.mutate`（不强制）

### 涉及文件
- 修改 `apps/server/src/datasource/sqlite/sql.ts`（T01 创建）：追加 `VISIBLE`、`MIME`、`DEFAULT_DOMINANT`
- 新建 `apps/server/src/datasource/sqlite/hydrate.ts`：`ImageRow`、`IMAGE_COLS`、`hydrateImages`、`loadImageItems`
- 新建 `apps/server/src/datasource/sqlite/suggestions.ts`：`loadSuggestions`（批量版，T15 再完善中文名）
- 新建 `apps/server/src/datasource/sqlite/queries/listImages.ts`
- 新建 `apps/server/src/services/fs/reveal.ts`
- 修改 `SqliteDataSource.ts`：`listImages`、`getImage`、`updateImage`、`getOriginal`、`revealImage`，以及私有的 `requireVisibleImages(ids)`
- 测试：`queries/listImages.test.ts`（`:memory:` 库 + 造数据）

### 实现步骤

#### 1. `sql.ts` 追加
```ts
/** 用法：FROM images i JOIN library_roots r ON r.id = i.root_id WHERE ${VISIBLE}
 *  条件必须字面上包含 i.missing = 0 AND i.trashed_at IS NULL（T22 的部分索引靠它命中） */
export const VISIBLE = 'i.missing = 0 AND i.trashed_at IS NULL AND r.enabled = 1 AND r.removed_at IS NULL';
/** 图片 i 属于作品 @workId —— 与 T13 的作品张数用同一个视图，数字才对得上 */
export const IMAGE_IN_WORK = 'EXISTS (SELECT 1 FROM v_image_works vw WHERE vw.image_id = i.id AND vw.work_id = @workId)';
export const MIME: Record<ImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };
export const DEFAULT_DOMINANT = '#d9d4cc'; // 像素处理还没跑时的占位色
```
（SQL 函数 `search_key` 已在 T01 的 `openDatabase` 里注册。）

#### 2. `hydrate.ts`
```ts
export const IMAGE_COLS = `i.id, i.root_id, i.rel_path, i.file_name, i.width, i.height, i.bytes, i.format, i.sha256,
  i.dominant_color, i.rating, i.favorite, i.source_site, i.source_post_id, i.source_artist, i.source_url,
  i.added_at, i.modified_at, i.excluded_by, i.tagged_at`;
export function hydrateImages(db: Database.Database, rows: ImageRow[]): ImageItem[] {
  if (!rows.length) return [];
  const ids = JSON.stringify(rows.map((r) => r.id));            // 数字数组
  // 角色：SELECT image_id, character_id FROM image_characters WHERE image_id IN (SELECT value FROM json_each(@ids)) ORDER BY image_id, added_at, character_id
  // 作品：SELECT image_id, work_id FROM v_image_works WHERE image_id IN (SELECT value FROM json_each(@ids)) ORDER BY image_id, work_id
  return rows.map((r) => ({
    id: toId(r.id), relPath: r.rel_path, fileName: r.file_name, libraryRootId: toId(r.root_id),
    width: r.width, height: r.height, bytes: r.bytes, format: r.format, addedAt: r.added_at, modifiedAt: r.modified_at,
    rating: r.rating, favorite: r.favorite === 1,
    status: r.excluded_by != null ? 'excluded' : chars.length ? 'recognized' : 'unrecognized',
    characterIds: chars.map(toId), workIds: works.map(toId),
    dominantColor: r.dominant_color ?? DEFAULT_DOMINANT,
    source: r.source_site ? { site: r.source_site, ...(r.source_post_id ? { postId: r.source_post_id } : {}),
      ...(r.source_artist ? { artist: r.source_artist } : {}), ...(r.source_url ? { url: r.source_url } : {}) } : null,
  }));
}
/** 按一批 id 取 ImageItem，返回顺序 = ids 顺序（T15/T16/T17/T18 用） */
export function loadImageItems(db: Database.Database, ids: number[]): ImageItem[]
```

#### 3. `suggestions.ts`（批量版，T15 会在此基础上接中文名）
```ts
export function loadSuggestions(ctx: SqliteContext, imageIds: number[]): Map<number, CharacterSuggestion[]>
```
```sql
SELECT s.image_id, s.danbooru_tag, s.score, COALESCE(c.id, r.character_id) AS character_id
FROM character_suggestions s
LEFT JOIN characters c ON c.danbooru_tag = s.danbooru_tag
LEFT JOIN danbooru_tag_redirects r ON r.tag = s.danbooru_tag
WHERE s.image_id IN (SELECT value FROM json_each(?))
  AND NOT EXISTS (SELECT 1 FROM image_characters ic
                  WHERE ic.image_id = s.image_id AND ic.character_id = COALESCE(c.id, r.character_id))
ORDER BY s.image_id, s.score DESC, s.danbooru_tag;
```
映射（对照 mock 的 `suggestionsFor`）：有角色 → `name = 角色名`，`workName = 角色第一个作品（position 最小）的名字 ?? null`；没有角色 → `name = humanizeTag(tag)`（mock 的规则：去掉结尾的 `_(...)`，按下划线分词，首字母大写；T10 之后改用 `services/i18n/humanize.ts`，T12 之后改用 Localizer），`workName = null`（T15 再补）；`characterId = toId(...) | null`；`score`。

#### 4. `queries/listImages.ts`
```ts
export function listImages(db: Database.Database, q: ListImagesQuery): Page<ImageItem> {
  const where = [VISIBLE]; const p: Record<string, unknown> = {};
  switch (q.status) {                                  // 与 mock 一致：不传 status = 除了 excluded 以外的全部
    case undefined: where.push('i.excluded_by IS NULL'); break;
    case 'excluded': where.push('i.excluded_by IS NOT NULL'); break;
    case 'recognized': where.push('i.excluded_by IS NULL', 'EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id)'); break;
    case 'unrecognized': where.push('i.excluded_by IS NULL', 'NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id)'); break;
  }
  if (q.characterId) { const cid = parseId(q.characterId); if (cid == null) return EMPTY_PAGE;
    where.push('EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id AND ic.character_id = @cid)'); p.cid = cid; }
  if (q.workId) { const wid = parseId(q.workId); if (wid == null) return EMPTY_PAGE; where.push(IMAGE_IN_WORK); p.workId = wid; }
  if (q.rating?.length) { where.push('i.rating IN (SELECT value FROM json_each(@ratings))'); p.ratings = JSON.stringify(q.rating); }
  if (q.favorite !== undefined) { where.push('i.favorite = @fav'); p.fav = q.favorite ? 1 : 0; }
  if (q.orientation === 'landscape') where.push('i.width > i.height * 1.05');       // mock：ratio > 1.05
  if (q.orientation === 'portrait') where.push('i.width < i.height * 0.95');        // ratio < 0.95
  if (q.orientation === 'square') where.push('i.width <= i.height * 1.05 AND i.width >= i.height * 0.95');
  const qk = q.q ? searchKey(q.q) : '';
  if (qk) { where.push(`(instr(search_key(i.file_name), @qk) > 0 OR EXISTS (SELECT 1 FROM image_tags it WHERE it.image_id = i.id
      AND it.tag_id IN (SELECT t.id FROM tags t WHERE instr(search_key(t.name), @qk) > 0)))`); p.qk = qk; }
  const from = 'FROM images i JOIN library_roots r ON r.id = i.root_id';
  const w = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${w}`).get(p) as { n: number }).n;
  const limit = Math.min(Math.max(q.limit ?? 60, 1), 200);
  const sort = q.sort ?? 'addedAt';
  // random：确定性的伪随机顺序 + 偏移游标（和 mock 一样忽略 order）
  // 其余：keyset 游标。order 默认 desc，fileName 也一样（mock 就是这样）
}
```
先核对 `ListImagesQuery` 的字段名（`packages/shared/src/api.ts`），以契约为准。

排序表达式：`addedAt → i.added_at`，`modifiedAt → i.modified_at`，`fileName → i.file_name COLLATE NOCASE`，`bytes → i.bytes`；random 用 `((i.id * 2654435761) % 4294967296), i.id`。

keyset 游标（编解码用 T01 的 `encodeCursor` / `decodeCursor`；游标无效时 `decodeCursor` 抛 400「分页游标无效，请刷新页面」）：
```ts
const dir = q.order === 'asc' ? 'ASC' : 'DESC'; const cmp = dir === 'ASC' ? '>' : '<';
const c = decodeCursor(q.cursor, isCursorTuple);   // [sortValue, id]
const cursorSql = c ? ` AND (${expr} ${cmp} @cv OR (${expr} = @cv AND i.id ${cmp} @cid))` : '';
const rows = db.prepare(`SELECT ${IMAGE_COLS} ${from} WHERE ${w}${cursorSql} ORDER BY ${expr} ${dir}, i.id ${dir} LIMIT @lim`)
  .all({ ...p, cv: c?.[0] ?? null, cid: c?.[1] ?? null, lim: limit + 1 }) as ImageRow[];
const hasMore = rows.length > limit; if (hasMore) rows.pop();
const last = rows.at(-1);
const nextCursor = hasMore && last ? encodeCursor([last[SORT_FIELD[sort]], last.id]) : null;
return { items: hydrateImages(db, rows), nextCursor, total };
```
用 keyset 而不用 mock 的 offset：扫描期间不断插入新图，offset 分页会让无限滚动出现重复或漏图。游标对前端是不透明字符串，不影响前端。

#### 5. `getImage(id)`
只返回可见的图（和 mock 一样，不可见返回 null；「可见」= 在 `v_images` 里，包括被排除的）。在 hydrate 的结果上补：`absPath: path.normalize(toAbs(root_path, rel_path))`（Windows 下是反斜杠，方便用户复制）；`tags`：`SELECT t.name AS tag, t.category, it.score FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = ? ORDER BY it.score DESC`；`characterSuggestions: loadSuggestions(ctx, [id]).get(id) ?? []`。

#### 6. `updateImage(id, body)`（可撤销，提示文案和 mock 一样）
```ts
const iid = this.requireVisibleImages([id])[0]!;
const before = { img: db.prepare('SELECT rating, rating_manual, favorite FROM images WHERE id = ?').get(iid),
                 chars: db.prepare('SELECT * FROM image_characters WHERE image_id = ?').all(iid) };
db.transaction(() => {
  if (body.characterIds) {
    const ids = [...new Set(body.characterIds)].map((c) => this.requireCharacterId(c));   // 不存在 → NotFoundError('角色')
    db.prepare(`DELETE FROM image_characters WHERE image_id = @iid AND character_id NOT IN (SELECT value FROM json_each(@ids))`).run({ iid, ids: JSON.stringify(ids) });
    db.prepare(`INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at)
                SELECT @iid, value, 'manual', NULL, @now FROM json_each(@ids)`).run({ iid, ids: JSON.stringify(ids), now });
  }
  if (body.rating) db.prepare('UPDATE images SET rating = ?, rating_manual = 1 WHERE id = ?').run(body.rating, iid);
  if (body.favorite !== undefined) db.prepare('UPDATE images SET favorite = ? WHERE id = ?').run(body.favorite ? 1 : 0, iid);
})();
this.ctx.touch();
return this.ctx.undo.result(msg, () => { /* 事务里：恢复 rating / rating_manual / favorite；删掉该图全部 image_characters 再插回 before.chars；然后 touch() */ });
```
改 rating 时必须同时写 `rating_manual = 1`（T10 重打标签时不覆盖手动分级）。

#### 7. `getOriginal(id)`
和 mock 一样不要求可见。查 `sha256, format, rel_path, root path`，`abs = toAbs(...)`；`await access(abs)` 失败返回 null（404）；否则返回 `{ kind: 'path', contentType: MIME[format], filePath: abs, etag: `"${sha256.slice(0, 20)}"`, cacheControl: 'private, no-cache' }`。

#### 8. `services/fs/reveal.ts` 与 `revealImage`
```ts
export async function revealInFileManager(abs: string): Promise<void> {
  if (process.platform === 'win32') {
    const p = path.win32.normalize(abs);
    // explorer 用自己的规则解析命令行，逗号是分隔符。必须带引号且 windowsVerbatimArguments，
    // 否则「插画, 测试.png」这种文件名会打开错误的目录
    await new Promise<void>((resolve, reject) => {
      const child = spawn('explorer.exe', [`/select,"${p}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });   // 不要等退出码：explorer 成功时也经常返回非 0
    });
    return;
  }
  if (process.platform === 'darwin') { spawn('open', ['-R', abs], { detached: true, stdio: 'ignore' }).unref(); return; }
  spawn('xdg-open', [path.dirname(abs)], { detached: true, stdio: 'ignore' }).unref();
}
```
`revealImage`：先 `requireVisibleImages([id])`，再 `access(abs)`；失败抛 `NotFoundError('文件（可能已被移动或删除）')`。

### 坑
- 非数字 id（比如 mock 风格的 `i123`）经 `parseId` 变成 null，按找不到处理，不要让 SQL 报错。
- better-sqlite3 **不支持**自定义 collation，所以 fileName 排序用 `COLLATE NOCASE`，和 mock 的 `localeCompare` 有差异（数字不做自然排序）——有意差异，可以接受。
- keyset 条件里的表达式必须和 ORDER BY 完全一致（包括 `COLLATE NOCASE`）；用展开写法 `(expr < @cv OR (expr = @cv AND i.id < @cid))`，不要用行值比较，避免 collation 歧义。
- `q` 搜索要和 mock 的 `matchesQuery` 一样：两边都过 `searchKey` 再做子串匹配；`searchKey(q)` 为空时不加条件。
- `total` 不能带游标条件。
- `absPath` 只用于显示；reveal 时再 `path.win32.normalize` 一次。路径里不可能有 `"`（Windows 不允许），所以 verbatim 拼引号是安全的。

### 验收标准
1. `npm run typecheck` 通过。
2. `npx vitest run apps/server/src/datasource/sqlite/queries`：用 `:memory:` 库 + 迁移 + 造 500 张图（随机的评级、收藏、宽高、角色、`image_copyrights`、排除、missing、trashed、停用的根、已移除的根）：
   - 每种筛选的结果 id 集合 = 在 JS 里按 mock 规则过滤出来的集合
   - 每种 sort × order 组合翻完所有页：每个 id 恰好出现一次，顺序正确，`total` 等于集合大小
   - 翻完第 1 页后插入 10 张新图再翻后续页，没有重复
3. 手工（sqlite 模式；`$env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t04'`，就是 T04 验收用过的库）：
```powershell
(Invoke-RestMethod 'http://127.0.0.1:5174/api/images?sort=fileName&order=asc&limit=5').items | select id, fileName
(Invoke-RestMethod 'http://127.0.0.1:5174/api/images?orientation=portrait').total
(Invoke-RestMethod 'http://127.0.0.1:5174/api/images/1').absPath          # 反斜杠的原生路径
$r = Invoke-RestMethod -Method Patch 'http://127.0.0.1:5174/api/images/1' -ContentType 'application/json' -Body '{"favorite":true}'
Invoke-RestMethod -Method Post "http://127.0.0.1:5174/api/undo/$($r.undoToken)"   # 再 GET，favorite 回到 false
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:5174/api/images/abc        # 404，不是 500
```
4. 对「插画, 测试 [1].png」调用 `POST /api/images/<id>/reveal`：资源管理器打开「中文 目录」并选中这个文件；对超长路径的那张不报 500（最坏情况是打开父目录）。
5. 前端切到 sqlite 后（`npm run dev`，环境变量同上），图库页能滚动加载、筛选、排序，看图器能打开原图（`/api/images/:id/file`）。此时 `/api/stats`、`/api/characters` 等还没实现（T13 起），页头副标题、侧栏计数处出现「尚未实现（见 docs/TASKS.md T13）」的错误提示属正常，只检查网格和看图器。

### 难度
M

### 给实现模型的提示
- 把 `listImages.ts` 写成纯函数 `(db, query) => Page`，方便在内存库里测试。
- 严格对照 mock 的 `listImages` 和 `toImage`：默认 status、orientation 阈值、默认 desc、random 忽略 order。
- `hydrateImages` 一次查询拿整页的角色和作品，不要 N+1。

## T06 来源解析（pixiv/twitter/danbooru 文件名规则 → source）

### 目标
写一个纯函数 `parseSource(relPath)`：根据文件名（必要时参考父目录名）推断 `ImageSource { site, postId?, artist?, url? }`。扫描器插入 / 移动时调用它（T03），另外提供一次性回填：规则版本升级后，对库里所有行重算一遍。

### 依赖
- 无（纯函数）。回填函数需要 T01 的 db。T03 调用它。M1 里建议第一个做。

### 涉及文件
- 新建 `apps/server/src/services/source/parseSource.ts`
- 新建 `apps/server/src/services/source/backfill.ts`
- 新建 `apps/server/src/services/source/parseSource.test.ts`、`backfill.test.ts`

### 实现步骤

#### 1. 函数签名与预处理
```ts
export const SOURCE_PARSER_VERSION = 1;
/** relPath 用正斜杠，包含目录（目录名是作者名的线索） */
export function parseSource(relPath: string): ImageSource | null {
  const parts = relPath.split('/');
  const base = parts.at(-1)!;
  const dirs = parts.slice(0, -1);
  const lowerDirs = dirs.map((d) => d.toLowerCase());
  const parent = dirs.at(-1) ?? '';
  // 去掉扩展名（包括 .jpg_large），再去掉副本后缀「 (1)」「 - 副本」「 - Copy (2)」
  const stem = base.replace(/\.[^.]+$/, '').replace(/(\s*\(\d+\)|\s*-\s*(副本|复制|copy)(\s*\(\d+\))?)$/i, '');
  // …按下面的规则顺序匹配，第一个命中就返回
}
```

#### 2. 规则（按顺序，第一个命中就返回）
| # | 来源 | 正则（作用于 stem） | 结果 |
|---|---|---|---|
| 1 | Danbooru 站内「下载」文件名 `__{tags}_drawn_by_{artist}__{md5}` | `/^__(.+?)__(?:sample-)?([0-9a-f]{32})$/i`；作者用 `/_drawn_by_(.+)$/` 匹配第 1 组 | `{ site: 'danbooru', artist?, url: 'https://danbooru.donmai.us/posts?md5=' + md5 }` |
| 2 | gallery-dl 的 booru 格式 `{category}_{id}_{md5}` | `/^(danbooru\|gelbooru\|safebooru\|yandere\|konachan)_(\d+)_[0-9a-f]{32}$/i` | danbooru → `{ site: 'danbooru', postId, url: 'https://danbooru.donmai.us/posts/' + id }`；yandere → `{ site: 'other', postId, url: 'https://yande.re/post/show/' + id }`；konachan → `https://konachan.com/post/show/`；gelbooru → `https://gelbooru.com/index.php?page=post&s=view&id=`；safebooru → `https://safebooru.org/index.php?page=post&s=view&id=` |
| 3 | yande.re / Konachan 站内下载名 | `/^yande\.re (\d+)(?: \|$)/i`、`/^Konachan\.com - (\d+)(?: \|$)/i` | 同上的 other + url |
| 4 | Twitter Media Downloader（furyutei）`{screen_name}-{tweet_id}-{yyyymmdd_hhmmss}-{img\|vid\|gif}{n}` | `/^([A-Za-z0-9_]{1,15})-(\d{15,20})-\d{8}_\d{6}-(?:img\|vid\|gif)\d+$/` | `{ site: 'twitter', artist, postId, url: 'https://x.com/' + artist + '/status/' + id }` |
| 5 | gallery-dl twitter `{tweet_id}_{num}`，目录是 `twitter/{user}` | `/^(\d{15,20})_(\d{1,2})$/` | `{ site: 'twitter', postId, artist: lowerDirs.at(-2) 为 'twitter' 或 'x' 时取 parent, url: artist ? 'https://x.com/' + artist + '/status/' + id : 'https://x.com/i/status/' + id }` |
| 6 | gallery-dl fanbox，目录 `fanbox/{creatorId}`，文件 `{postId}_{num}` | 条件：`lowerDirs.at(-2) === 'fanbox'` 且 `/^(\d{4,9})_(\d{1,3})$/` | `{ site: 'fanbox', postId, artist: parent, url: 'https://' + parent + '.fanbox.cc/posts/' + id }` |
| 7 | pixiv 原图名 `{id}_p{n}` / `{id}_ugoira{n}` / `{id}_p0_master1200` | `/(?<!\d)(\d{4,10})_(?:p\d{1,4}\|ugoira\d*)(?!\d)/` | `{ site: 'pixiv', postId, url: 'https://www.pixiv.net/artworks/' + id, artist? }`；作者：父目录符合 PixivUtil2 的 `名字 (数字)` → `/^(.+) \((\d+)\)$/` 的第 1 组；或 `lowerDirs.at(-2) === 'pixiv'` 且父目录符合 gallery-dl 的 `{uid} {account}` → `/^(\d+) (.+)$/` 的第 2 组 |
| 8 | pixiv 手机 App 保存名 `illust_{id}_{yyyymmdd}_{hhmmss}`（经验规则，没有官方文档） | `/^illust_(\d{4,10})(?:_\|$)/i` | pixiv，同上 |
| 9 | 推特媒体原名（15 位 base64url，低置信度） | `/^[A-Za-z0-9_-]{15}$/`，并且同时含大写和小写字母，并且**不**匹配 `/^[A-Za-z]+[_-]?\d+$/`（排除 `Screenshot_2024` 这类） | `{ site: 'twitter' }`（没有 postId / url） |
| – | 纯 md5 名（`/^[0-9a-f]{32}$/i`）、`IMG_0001`、`wallpaper_1920x1080` 等 | – | `null`（纯 md5 可能来自任何 booru，不猜） |

注意：表格里的 `\|` 只是 markdown 转义，代码里写普通的 `|`。

#### 3. 回填 `backfill.ts`
```ts
/** settings 表里的 key 'sourceParserVersion' 不等于 SOURCE_PARSER_VERSION 时，对所有行重算 source_* 并写回版本号 */
export function backfillSources(db: Database.Database): number {
  const cur = db.prepare(`SELECT value FROM settings WHERE key = 'sourceParserVersion'`).get() as { value: string } | undefined;
  if (cur && Number(JSON.parse(cur.value)) === SOURCE_PARSER_VERSION) return 0;
  const upd = db.prepare(`UPDATE images SET source_site=@site, source_post_id=@postId, source_artist=@artist, source_url=@url WHERE id=@id`);
  let n = 0;
  db.transaction(() => {
    for (const r of db.prepare('SELECT id, rel_path FROM images').iterate() as Iterable<{ id: number; rel_path: string }>) {
      const s = parseSource(r.rel_path);
      upd.run({ id: r.id, site: s?.site ?? null, postId: s?.postId ?? null, artist: s?.artist ?? null, url: s?.url ?? null }); n++;
    }
    db.prepare(`INSERT INTO settings (key, value) VALUES ('sourceParserVersion', @v) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run({ v: JSON.stringify(SOURCE_PARSER_VERSION) });
  })();
  return n;
}
```
10 万行纯字符串处理不到 1 秒，可以放在一个事务里。以后改了规则就把 `SOURCE_PARSER_VERSION` 加 1。

### 坑
- 规则顺序很重要：TMD 文件名里有 `20250101_120000`，必须在 pixiv 规则之前处理；pixiv 规则要求 `_p` 或 `_ugoira`，本来就不会误伤。
- 推特 tweet id（雪花 ID，现在是 19 位）和 pixiv id（最多 9~10 位）靠位数区分：`\d{15,20}` 对 `\d{4,10}`。
- pixiv 正则用 `(?<!\d)`、`(?!\d)` 做边界，不用 `\b`：`_` 是单词字符，`\b` 在 `abc_123_p0` 里不生效。
- Danbooru 的 `drawn_by` 后面的作者 tag 本身也可能带下划线（`foo_bar`），所以取 `_drawn_by_` 之后的**全部**。
- `ImageSource.site` 只有 5 个取值，yande.re / gelbooru / konachan 一律归为 `other`，用 url 区分。
- 不要从 `rel_path` 以外的地方取信息（EXIF、侧车 json 以后再说）。
- 返回的对象里不要出现值为 `undefined` 的键（用条件展开 `...(artist ? { artist } : {})`），测试里 `toEqual` 更干净。

### 验收标准
1. `npx vitest run apps/server/src/services/source` 全绿。`parseSource.test.ts` 用 `it.each` 覆盖下面这些用例（期望值写全）：
   - `pixiv/123456789_p0.png` → `{ site: 'pixiv', postId: '123456789', url: 'https://www.pixiv.net/artworks/123456789' }`
   - `pixiv/98765432 someuser/98765432_p0.jpg` → pixiv，artist `someuser`
   - `PixivUtil/絵師名 (1234567)/98765432_p0 - タイトル.png` → pixiv，postId `98765432`，artist `絵師名`
   - `98765432_p0_master1200.jpg`、`98765432_ugoira0.jpg`、`illust_98765432_20240101_123456.jpg`、`sub/123456789_p0 (1).png` → pixiv
   - `twitter/someartist/1789012345678901234_1.jpg` → twitter，artist `someartist`，url `https://x.com/someartist/status/1789012345678901234`
   - `downloads/1789012345678901234_2.png` → twitter，没有 artist，url `https://x.com/i/status/1789012345678901234`
   - `someartist-1789012345678901234-20250101_120000-img1.jpg` → twitter，artist `someartist`
   - `GJnJQvHbwAAoY3S.jpg_large`、`GJnJQvHbwAAoY3S (1).jpg` → `{ site: 'twitter' }`
   - `__hatsune_miku_vocaloid_drawn_by_foo_bar__0123456789abcdef0123456789abcdef.jpg` → danbooru，artist `foo_bar`，url 为 md5 搜索
   - `__original__sample-0123456789abcdef0123456789abcdef.jpg` → danbooru，没有 artist
   - `danbooru_7654321_0123456789abcdef0123456789abcdef.png` → danbooru，postId `7654321`，url `https://danbooru.donmai.us/posts/7654321`
   - `yandere_1027894_<md5>.jpg`、`yande.re 1027894 animal_ears dress.jpg` → other，url `https://yande.re/post/show/1027894`
   - `Konachan.com - 312345 blue_eyes.jpg` → other，konachan url
   - `gelbooru_9876543_<md5>.jpg` → other，gelbooru url
   - `fanbox/creator123/5123456_1.png` → fanbox，artist `creator123`，url `https://creator123.fanbox.cc/posts/5123456`
   - 返回 null：`0123456789abcdef0123456789abcdef.jpg`、`IMG_00012.png`、`2024-01-01 123456.png`、`wallpaper_1920x1080.png`、`Screenshot_2024.png`、`1234567890123_p0.png`（13 位）
2. `backfill.test.ts`：`:memory:` 库（T01 migrate）插 3 行 → 第一次 `backfillSources` 返回 3；第二次返回 0。
3. T03 做完后：`$env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t04'; npx tsx apps/server/scripts/db-query.ts "SELECT file_name, source_site, source_artist FROM images WHERE source_site IS NOT NULL"` 有 pixiv、twitter、danbooru 各至少 1 行。

### 难度
S

### 给实现模型的提示
- 先写测试表，再写实现。
- 不要引入依赖；正则写成模块顶层常量。

## T07 后台任务接线（JobQueue runners → services，启动时自动扫描，listJobs/startJob/cancelJob）

### 目标
1. **T07.1（M1 开头先做）**：增强 `core/jobs.ts`（mock 必须照常工作）：按优先级出队（scan 优先）；长任务可以「让出」（有更高优先级的任务在排队时暂停并重新排队）；`enqueue` 支持「正在运行也再排一个」；runner 返回的字符串作为任务的最终 message（显示扫描摘要）。
2. 新建 `Pipeline`：把 `JobKind` 映射到各个 service，并负责链式触发：scan → thumbnail → tag（模型就绪时）→ dedupe；tag 之后按需 danbooru-sync。
3. `SqliteDataSource.open` 里组装 ScanRequests、Scanner、ThumbnailService、Pipeline、JobQueue；启动时自动做一次扫描；实现 `listJobs`、`startJob`、`cancelJob`。

### 依赖
- T07.1：只依赖现有代码。
- 其余部分：T01、T02、T03（Scanner、ScanRequests）、T04（ThumbnailService）
- 可选注入：T10（tag）、T11（danbooru-sync）、T16（dedupe）。没有注入时对应 runner 抛 `NotImplementedError('T10')` 等，任务显示为 failed，页面会提示缺哪一项。

### 涉及文件
- 修改 `apps/server/src/core/jobs.ts`（T07.1）
- 新建 `apps/server/src/core/jobs.test.ts`（T07.1）
- 新建 `apps/server/src/services/pipeline.ts`
- 修改 `apps/server/src/datasource/sqlite/SqliteDataSource.ts`（open、listJobs、startJob、cancelJob、addLibraryRoot 里的入队）

### 实现步骤

#### 1. T07.1：`core/jobs.ts` 的改动
```ts
export type JobRunner = (ctx: JobContext) => Promise<void | string>;   // 返回字符串 = 最终 message
export interface JobContext {
  readonly signal: AbortSignal;
  setTotal(total: number | null): void;
  advance(n?: number, message?: string): void;
  setMessage(message: string): void;
  /** 有更高优先级的任务在排队：长任务应尽快 requeue() 然后 return */
  shouldYield(): boolean;
  /** 当前任务结束后再排一个同类任务 */
  requeue(): void;
  /** 本次调用过 requeue()（Pipeline 据此判断要不要链式触发） */
  readonly yielded: boolean;
}
const PRIORITY: Record<JobKind, number> = { scan: 0, thumbnail: 1, dedupe: 2, tag: 3, 'danbooru-sync': 4 };

enqueue(kind: JobKind, opts: { requeueIfRunning?: boolean } = {}): Job {
  const queued = this.jobs.find((j) => j.kind === kind && j.status === 'queued');
  if (queued) return queued;
  const running = this.jobs.find((j) => j.kind === kind && j.status === 'running');
  if (running && !opts.requeueIfRunning) return running;
  // …原来的创建逻辑…
  // 只保留最近 100 条已结束的任务（绝不删 queued / running）；list() 仍然只返回最近 20 条
}
private pickNext(): Job | undefined {   // 优先级最高的；同优先级按先进先出
  let best: Job | undefined;
  for (const j of this.jobs) if (j.status === 'queued' && (!best || PRIORITY[j.kind] < PRIORITY[best.kind])) best = j;
  return best;
}
```
`pump()` 里把 `this.jobs.find((j) => j.status === 'queued')` 换成 `this.pickNext()`。ctx 增加：
```ts
let yielded = false;
shouldYield: () => this.jobs.some((j) => j.status === 'queued' && PRIORITY[j.kind] < PRIORITY[job.kind]),
requeue: () => { yielded = true; this.enqueue(job.kind, { requeueIfRunning: true }); },
get yielded() { return yielded; },
```
结束时：`const result = await runner(ctx); job.status = aborted ? 'cancelled' : 'done'; job.message = typeof result === 'string' && job.status === 'done' ? result : 默认文案`。mock 的 runner 返回 void，行为不变。

#### 2. `services/pipeline.ts`
```ts
/** 各阶段由对应任务注入；没有注入的阶段 runner 抛 NotImplementedError */
export interface TagStage { isReady(): boolean; pendingCount(): number; run: JobRunner }          // T10
export interface DanbooruStage { shouldRunAfterTag(): boolean; run: JobRunner }                  // T11
export interface DedupeStage { run(ctx: JobContext): Promise<string> }                           // T16
export interface PipelineDeps {
  jobs: () => JobQueue;                       // 延迟获取，避免构造时循环依赖
  requests: ScanRequests; scanner: Scanner; thumbs: ThumbnailService;
  pixelPendingCount: () => number;            // SELECT COUNT(*) … WHERE thumb_at IS NULL AND decode_error IS NULL AND missing=0 AND trashed_at IS NULL（加上根启用、未移除）
  tag?: TagStage;
  danbooru?: DanbooruStage;
  dedupe?: DedupeStage;
  afterTag?: () => void;                      // T20：refreshTagCounts
}
export type PipelineStages = Partial<Pick<PipelineDeps, 'tag' | 'danbooru' | 'dedupe' | 'afterTag'>>;
export class Pipeline {
  private dedupeDirty = false;
  constructor(private readonly d: PipelineDeps) {}
  /** 让后续任务在 open() 之后注册自己的阶段（Object.assign(this.d, stages)；d 不要声明成 readonly 对象字面量类型） */
  register(stages: PipelineStages): void

  runner = (kind: JobKind): JobRunner => async (ctx) => {
    switch (kind) {
      case 'scan': {
        const s = await this.d.scanner.scan(ctx);
        if (!ctx.signal.aborted) this.afterScan(s);
        return formatScanSummary(s);
      }
      case 'thumbnail': {
        const msg = await this.d.thumbs.runBackfill(ctx);
        if (!ctx.signal.aborted && !ctx.yielded) this.afterThumbnail();
        return msg;
      }
      case 'tag': {
        if (!this.d.tag) throw new NotImplementedError('T10', '角色识别');
        const msg = await this.d.tag.run(ctx);
        if (!ctx.signal.aborted && !ctx.yielded) {
          this.d.afterTag?.();
          if (this.d.danbooru?.shouldRunAfterTag()) this.d.jobs().enqueue('danbooru-sync');
          if (this.dedupeDirty) this.d.jobs().enqueue('dedupe');
        }
        return msg;
      }
      case 'dedupe': {
        if (!this.d.dedupe) throw new NotImplementedError('T16', '查重');
        const msg = await this.d.dedupe.run(ctx);
        if (!ctx.signal.aborted) this.dedupeDirty = false;
        return msg;
      }
      case 'danbooru-sync': {
        if (!this.d.danbooru) throw new NotImplementedError('T11', 'Danbooru 同步');
        return this.d.danbooru.run(ctx);
      }
    }
  };
  private afterScan(s: ScanSummary) {
    const changed = s.added + s.updated + s.moved + s.restored > 0;
    if (changed) this.dedupeDirty = true;
    if (changed || this.d.pixelPendingCount() > 0) this.d.jobs().enqueue('thumbnail');
    else if (this.dedupeDirty) this.d.jobs().enqueue('dedupe');
  }
  private afterThumbnail() {
    const t = this.d.tag;
    if (t?.isReady() && t.pendingCount() > 0) this.d.jobs().enqueue('tag');
    else if (this.dedupeDirty) this.d.jobs().enqueue('dedupe');
  }
}
```
注意：模型还没下载时 `isReady()` 为 false，不会自动触发 1.26 GB 的下载；用户点「运行识别」（`startJob('tag')`）才开始下载。

#### 3. `SqliteDataSource.open` 的组装（接在 T01、T02 已有代码之后）
```ts
const requests = new ScanRequests();
const scanner = new Scanner({ db, bus, dataDir, requests /*, onNewImagesInTx: T17 */ });
const pipeline = new Pipeline({ jobs: () => ds.ctx.jobs, requests, scanner, thumbs: ds.thumbs, pixelPendingCount: () => … });
// T01 的 resolver 改成 (kind) => pipeline.runner(kind)
// T08：ds.watcher = new LibraryWatcher({ … }); ds.watcher.sync(roots)
// T10 / T11 / T16 / T20：pipeline.register({ … })
const roots = /* SELECT … FROM library_roots WHERE enabled = 1 AND removed_at IS NULL */;
if (opts.autoJobs !== false && !process.env.EMAKI_NO_AUTOSCAN && roots.length) { requests.requestFull(); ds.ctx.jobs.enqueue('scan'); }
```

#### 4. 三个接口
```ts
async listJobs() { return this.ctx.jobs.list(); }
async startJob(kind: JobKind) { if (kind === 'scan') this.requests.requestFull(); return this.ctx.jobs.enqueue(kind); }
async cancelJob(id: ID) { this.ctx.jobs.cancel(id); }
```
同时把 T02 `addLibraryRoot` 的入队改成：`requests.addDirty({ rootId, relDir: '', recursive: true }); jobs.enqueue('scan', { requeueIfRunning: true })`（mock 也是添加后立刻扫描）。

### 坑
- 原来的 `enqueue` 在同类任务**正在运行**时直接返回它。T08 监听到的变更如果在扫描中途到达就会丢，所以必须用 `requeueIfRunning`。
- 任务是串行的：打标签可能跑一个多小时，没有「让出」的话，新放进来的图要等打完标签才出现。thumbnail、tag、dedupe 的 runner 都要在每批开头检查 `ctx.shouldYield()`。
- 取消的扫描不能触发后续任务（这时也没做 missing 判定）。
- `pump()` 的 finally 里会 emit `library-changed`，不用重复发。
- 改 `core/jobs.ts` 时保证 mock 模式可用：mock 的 runner 不用新方法，返回 void。
- 链式触发放在 Pipeline 里，不要写进 JobQueue（JobQueue 保持通用）。Pipeline 通过构造参数 / `register` 注入依赖（接口类型），不要直接 import SqliteDataSource；目前没有的阶段用可选字段，不要写空实现假装成功。

### 验收标准
1. `npm run typecheck` 通过。
2. T07.1：`npx vitest run apps/server/src/core`，用假 runner 覆盖：
   - 先后排队 tag、dedupe、scan：scan 最先跑，然后是 dedupe，最后是 tag
   - 同类任务 queued 时再 enqueue 返回同一个；running 时带 `requeueIfRunning` 会新建一个 queued
   - 运行中的 tag 任务在 scan 入队后 `shouldYield()` 为 true，调用 `requeue()` 后顺序变为 scan → tag
   - runner 返回 `'扫描完成：新增 3'` 时，任务最终 message 就是这句
   - cancel 正在运行的任务 → status 为 cancelled
3. mock 回归：不设 `EMAKI_DATA_SOURCE`，`npm run dev`，在前端点「重新查找」「运行识别」，进度条正常走完。
4. sqlite 集成（data 目录清空后启动）：
```powershell
$env:EMAKI_DATA_SOURCE='sqlite'; $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t07'; npm run dev:server
# 另开终端：
Invoke-RestMethod -Method Post http://127.0.0.1:5174/api/library-roots -ContentType 'application/json' -Body '{"path":"F:/Claude/emaki/data/fixtures-lib"}'
Start-Sleep 20; Invoke-RestMethod http://127.0.0.1:5174/api/jobs | select kind, status, message
```
   能看到 scan（done，message 是「扫描完成：新增 19 · …」）→ thumbnail（done）→ dedupe（T16 没做时是 failed 并提示 T16）；tag 没有出现（模型还没就绪）。
5. 重启服务 → 自动出现一个 scan 任务，很快完成，message 为「扫描完成：新增 0 …」。
6. 在 thumbnail 运行时 `POST /api/jobs {"kind":"scan"}` → thumbnail 在一批之内结束，message 为「已让出给扫描」；scan 跑完后 thumbnail 自动重跑并完成。（fixtures 太小可能来不及，可以临时把 backfill 的批大小改成 1 验证后改回。）
7. `DELETE /api/jobs/<正在运行的 scan 的 id>` → status 为 cancelled，`SELECT COUNT(*) FROM images WHERE missing=1` 没有变化。

### 难度
M

## T08 文件监听（chokidar 增量更新）

> 实现改用 Node 自带的 `fs.watch(root, { recursive: true })`，**不装 chokidar**。理由见「关键技术决策 → 文件监听」。

### 目标
图库文件夹里有新增、删除、改名、修改时，几秒内自动做一次**增量**扫描（只扫受影响的目录）。要求在 10 万张图、几千个子目录的 Windows 图库上几乎不占资源；移动硬盘拔插、根目录被删都不能让进程崩溃；另外加一个定时兜底扫描。

### 为什么不用 chokidar
- chokidar 5.0.0（2025-11，只支持 ESM，Node ≥ 20.19）底层仍然是 `fs.watch`，但它**给每个文件单独建一个 watcher**（`handler.js` 里 `_handleFile` → `_watchWithNodeFs(file)`，按完整路径缓存 FsWatchInstances）。10 万张图就是 10 万个 `fs.watch` 句柄，启动时还要把整棵树遍历并 stat 一遍（和我们的扫描器重复）。
- Windows 上 Node 的 `fs.watch` 基于 `ReadDirectoryChangesW`，原生支持 `recursive`：**每个根目录只要 1 个句柄**，事件给出相对路径。
- 我们不需要 chokidar 的 add/change/unlink 精确语义和 `awaitWriteFinish`：事件只用来标「脏目录」，真正的判定交给扫描器（它有大小 + mtime + sha256 比对，还有「2 秒内刚写的文件延后」规则）。

### 依赖
- T03（ScanRequests、paths.ts）、T07（`jobs.enqueue('scan', { requeueIfRunning: true })`）、T02（`onRootsChanged`）

### 涉及文件
- 新建 `apps/server/src/services/watch/LibraryWatcher.ts`
- 修改 `apps/server/src/datasource/sqlite/SqliteDataSource.ts`：在 open 里创建；订阅 T02 的 `onRootsChanged`，文件夹增删改后调用 `watcher.sync(roots)`；`close()` 里 `await watcher.close()`
- 修改 `SqliteDataSource.ts` 顶部注释里「T08 装 chokidar」那句
- 新建 `apps/server/src/services/watch/LibraryWatcher.test.ts`

### 实现步骤

#### 1. 类结构
```ts
export interface WatchedRoot { id: number; path: string; enabled: boolean }
export class LibraryWatcher {
  private readonly watchers = new Map<number, FSWatcher>();
  private readonly unknown = new Map<string, { rootId: number; rel: string }>(); // 需要 stat 才知道是不是目录的路径
  private debounceTimer: NodeJS.Timeout | null = null;
  private firstEventAt = 0;
  constructor(private readonly d: {
    requests: ScanRequests;
    enqueueScan: () => void;                    // () => jobs.enqueue('scan', { requeueIfRunning: true })
    dataDir: string;
    log: (msg: string, err?: unknown) => void;
    quietMs?: number;                           // 默认 1500：安静这么久才触发
    maxWaitMs?: number;                         // 默认 10000：持续有事件时最多等这么久
    rescanMinutes?: number;                     // 默认 Number(process.env.EMAKI_RESCAN_MINUTES ?? 180)，0 = 关闭
  }) {}
  sync(roots: WatchedRoot[]): void              // 启动或关闭各个根的 watcher，使之与「启用且未移除」的根一致
  async close(): Promise<void>
}
```

#### 2. 启动单个根
```ts
private start(root: WatchedRoot) {
  let w: FSWatcher;
  try {
    w = watch(toAbs(root.path, ''), { recursive: true, persistent: false }, (event, filename) => this.onEvent(root, filename));
  } catch (err) { this.d.log(`无法监听 ${root.path}`, err); return; }   // 根目录不存在：交给可达性重试
  w.on('error', (err) => {           // 必须挂 error 监听：Windows 上被监听的目录被删除会报 EPERM，没有监听器进程直接崩溃
    this.d.log(`监听中断 ${root.path}`, err);
    w.close(); this.watchers.delete(root.id);
    this.d.requests.addDirty({ rootId: root.id, relDir: '', recursive: true }); this.schedule();
  });
  this.watchers.set(root.id, w);
}
```

#### 3. 事件处理
```ts
private onEvent(root: WatchedRoot, filename: string | Buffer | null) {
  if (!filename) {                                            // 文件名可能为 null（例如缓冲区溢出）→ 整个根增量重扫
    this.d.requests.addDirty({ rootId: root.id, relDir: '', recursive: true }); return this.schedule();
  }
  const rel = String(filename).split(path.sep).join('/');
  const segs = rel.split('/');
  if (segs.slice(0, -1).some(isSkippedDirName)) return;       // .git、$RECYCLE.BIN、.emaki-trash 里的变化不管
  if (pathKey(toAbs(root.path, rel)).startsWith(pathKey(this.d.dataDir) + '/')) return;
  if (isImageFile(segs.at(-1)!)) {
    this.d.requests.addDirty({ rootId: root.id, relDir: parentRel(rel), recursive: false });
  } else {
    this.unknown.set(`${root.id}\n${rel}`, { rootId: root.id, rel });   // 可能是目录被新增、改名或删除，flush 时再 stat
  }
  this.schedule();
}
```
`flush()`（防抖到点后执行）：对 `unknown` 里的每项 `stat`：是目录 → `addDirty({ relDir: rel, recursive: true })`；ENOENT（被删除或被改名走）→ 同样 `addDirty(rel, recursive)`，扫描器会发现该前缀下的行都不在了；是普通非图片文件 → 忽略。清空 `unknown`，然后 `this.d.enqueueScan()`。

#### 4. 防抖
```ts
private schedule() {
  const now = Date.now();
  if (!this.debounceTimer) this.firstEventAt = now;
  if (this.debounceTimer) clearTimeout(this.debounceTimer);
  const wait = Math.min(this.d.quietMs ?? 1500, Math.max(0, this.firstEventAt + (this.d.maxWaitMs ?? 10000) - now));
  this.debounceTimer = setTimeout(() => { this.debounceTimer = null; void this.flush(); }, wait);
}
```

#### 5. 可达性重试与定时兜底
- 每 60 秒检查一次所有「启用」的根（`setInterval(...).unref()`）：
  - 没有 watcher、`stat` 成功 → `start(root)`，并 `addDirty(root, '', true)` + `enqueueScan()`（U 盘插回来自动补扫）；
  - **有 watcher、但 `stat(root.path)` 失败**（根目录被改名 / 移走：Windows 上 ReadDirectoryChangesW 的句柄会跟着目录走，不报错也不再对应原路径）→ `close()` 这个 watcher 并从 Map 里删掉，下一轮路径恢复后会重新 `start`。
- 定时兜底：`rescanMinutes > 0` 时，每隔这么久执行 `requests.requestFull(); enqueueScan()`，弥补漏掉的事件（程序没开时的变化由启动扫描处理）。

#### 6. 接线
在 open 里 `ds.watcher = new LibraryWatcher({ requests, enqueueScan: () => ds.ctx.jobs.enqueue('scan', { requeueIfRunning: true }), dataDir, log: (m, e) => console.warn(m, e) }); ds.watcher.sync(roots)`。在 `onRootsChanged` 回调里重新查 roots（`enabled = 1 AND removed_at IS NULL`）并 `sync`。

### 坑
- `fs.watch` 的 `error` 事件**一定要监听**，否则根目录被删除时进程崩溃。
- Windows 上被监听的目录**被移动或改名后不会再有任何事件**（Node 文档写明）→ 靠可达性重试 + 定时兜底。
- 大量拷贝（上千个文件）时 ReadDirectoryChangesW 的缓冲可能溢出，事件会丢或者 filename 为 null → null 时整个根重扫，另外还有定时兜底。
- 监听中的目录会让 U 盘「无法安全弹出」：根被停用或移除时要 `close()` 对应的 watcher。
- 网络盘（SMB/NAS）上的 `fs.watch` 不一定可靠（Node 文档明确提到），靠定时兜底。
- 不要用 Node 24 文档里的 `ignore` 选项（版本历史里没写从哪一版开始有），自己过滤。
- 浏览器下载时先写 `.crdownload` 再改名：`.crdownload` 本身不是图片会被忽略，改名成 `.jpg` 那一刻才会触发，正好。
- 自己触发的变化（T18 移到回收站）也会产生事件，这是无害的：扫描器看到 trashed_at 已设置的行不在了，只是标 missing。
- `persistent: false`：进程本来就由 HTTP 服务保活，不要让 watcher 阻止退出（tsx watch 重启时更干净）。
- 监听器只负责「标脏 + 防抖 + 入队」，所有真假判断交给扫描器。以后要支持网络盘，优先用定时增量扫描，而不是轮询（轮询要 stat 10 万个文件）。

### 验收标准
1. `npm run typecheck` 通过。
2. `npx vitest run apps/server/src/services/watch`（真实临时目录，每条断言最多等 5 秒；防抖逻辑另用 `vi.useFakeTimers()` 单独测）：新建 `a/b.png` 后 `requests.take()` 包含 `{ relDir: 'a', recursive: false }`；新建目录 `c` 并放入图片后包含 `c`；删除根目录后 `error` 被处理，进程不崩溃；在 quietMs 之内连续写 50 个文件只调用 1 次 `enqueueScan`。
3. 集成（sqlite 模式，用单独的图库副本）：
```powershell
npx tsx apps/server/scripts/make-fixtures.ts F:/Claude/emaki/data/fixtures-t08
$env:EMAKI_DATA_SOURCE='sqlite'; $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t08'; npm run dev:server
# 另开终端：先把 fixtures-t08 加为图库，等扫描完成
Invoke-RestMethod -Method Post http://127.0.0.1:5174/api/library-roots -ContentType 'application/json' -Body '{"path":"F:/Claude/emaki/data/fixtures-t08"}'
New-Item -ItemType Directory F:/Claude/emaki/data/fixtures-t08/new-drop | Out-Null
Copy-Item F:/Claude/emaki/data/fixtures-t08/pixiv/123456789_p0.png F:/Claude/emaki/data/fixtures-t08/new-drop/fresh.png
Start-Sleep 5; (Invoke-RestMethod 'http://127.0.0.1:5174/api/images?limit=1').total      # 比之前 +1
Rename-Item F:/Claude/emaki/data/fixtures-t08/new-drop new-drop2
Start-Sleep 5; $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t08'; npx tsx apps/server/scripts/db-query.ts "SELECT id, rel_path, missing FROM images WHERE file_name='fresh.png'"   # id 不变，路径已变
```
4. 批量拷贝（先在图库**外面**准备 2000 个文件，再用 robocopy 一次性拷进去，拷贝本身只要几秒）：
   ```powershell
   New-Item -ItemType Directory -Force F:/Claude/emaki/data/bulk-src | Out-Null
   1..2000 | % { Copy-Item F:/Claude/emaki/data/fixtures-t08/pixiv/123456789_p0.png "F:/Claude/emaki/data/bulk-src/copy_$_.png" }
   $before = (Invoke-RestMethod 'http://127.0.0.1:5174/api/images?limit=1').total
   $jobsBefore = @((Invoke-RestMethod http://127.0.0.1:5174/api/jobs) | ? kind -eq 'scan').Count
   robocopy F:\Claude\emaki\data\bulk-src F:\Claude\emaki\data\fixtures-t08\bulk /E /NFL /NDL /NJH /NJS | Out-Null
   Start-Sleep 60
   (Invoke-RestMethod 'http://127.0.0.1:5174/api/images?limit=1').total - $before                       # 2000
   @((Invoke-RestMethod http://127.0.0.1:5174/api/jobs) | ? kind -eq 'scan').Count - $jobsBefore        # ≤ 3
   ```
   （`/api/jobs` 只返回最近 20 条；若中间还有 thumbnail 等任务把 scan 挤出列表，就看服务端日志里 scan 的条数。）
5. 把整个 fixtures-t08 改名再改回：服务不崩溃，60 秒内恢复监听，期间没有任何图被标 missing。
6. 没有文件变化时，任务管理器里 node 进程 CPU ≈ 0%。

### 难度
M

# M2 识别

> M2 的推荐顺序：T09 → T10 → T11 第 1–8 步 → T12 → T11 第 9–12 步。

## T09 WD14 tagger 推理（onnxruntime-node + DirectML，模型下载，预处理，selected_tags.csv）

### 目标
在 `apps/server/src/services/tagger/` 下实现一个**不碰数据库**的打标签引擎：输入图片绝对路径，输出 `rating` 四档概率、`general` 标签和 `character` 标签（都带 0~1 分数）。写库和任务接线放在 T10。

- **模型文件自动下载**：huggingface.co、hf-mirror.com、ModelScope 三个源先测速再选最快的，支持断点续传，下完做 sha256 校验。用户也可以手动把文件放进目录。
- **推理跑在独立子进程**（`child_process.fork`）。原因有两个：
  - onnxruntime-node 的 `session.run()` 在 JS 线程上同步执行（`js/node/src/inference_session_wrap.cc` 里直接调用 `session_->Run(...)`）。如果放在主进程，Fastify/SSE 每一批都会卡几百毫秒甚至几秒。
  - DirectML 偶尔会发生原生崩溃（进程直接退出，JS 捕获不到）。放在子进程里，主进程只要重启子进程、回退到 CPU 就行。
- **不用 `worker_threads`**。onnxruntime-node 在 worker 里有已知问题：microsoft/onnxruntime#23790 "no available backend found"；两个线程同时持有 session 时会出现 V8 FATAL。
- **设备选择**：优先 `dml`（DirectML，走 RTX 3070 Laptop），失败自动回退 `cpu`。
- **CLI**（download / inspect / tag / bench）：T09 的验收全部用它完成。

### 依赖
- 前置：T01（workspace 能正常装依赖）、T03（已装 `sharp@0.35.4`，并提供 `services/image/sharpConfig.ts` 和 `services/fs/hash.ts` 的 `sha256File`）。
- 被依赖：T10（写库、任务），T15 间接使用。

### 选型结论（写进 models.ts 顶部注释）

| Settings.tagger.model（HF 仓库） | model.onnx 字节数 | 官方验证 Macro-F1（P=R 阈值） | 定位 |
|---|---|---|---|
| SmilingWolf/wd-eva02-large-tagger-v3 | 1,260,435,999 | 0.4772 @ 0.5296 | **默认**，GPU 用 |
| SmilingWolf/wd-vit-large-tagger-v3 | 1,260,645,673 | 0.4674 @ 0.2606 | 体积一样但更差，只作可选 |
| SmilingWolf/wd-swinv2-tagger-v3 | 467,460,978 | 0.4541 @ 0.2653（v2.0） | CPU 回退时推荐 |
| SmilingWolf/wd-vit-tagger-v3 | 378,536,310 | 0.4402 @ 0.2614 | 最快、最弱 |

- 四个 v3 模型共用同一份 `selected_tags.csv`：308,468 字节，sha256 `298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217`。
- CSV 有 10861 行（不含表头），与模型输出维度一一对应：
  - 下标 0–3：rating（category=9，依次为 general / sensitive / questionable / explicit）
  - 下标 4–8109：general（category=0，共 8106 个）
  - 下标 8110–10860：character（category=4，共 2751 个）
- **v3 没有 copyright 类别**，作品只能通过角色去映射（T10、T11）。
- 训练数据截至 2024-02-28，之后出的新角色认不出来。可选方案见 T09.12 的 PixAI v0.9。
- ONNX 图已检查（eva02 和 swinv2）：
  - 输入名 `input`，形状 `[batch_size, 448, 448, 3]`（NHWC，float32）。
  - 图的开头是 `Transpose → Div → Sub`，归一化已经**内置在图里**，所以直接喂 0~255 的值。
  - 图的结尾是 `final_act/Sigmoid`，输出名 `output`，形状 `[batch_size, 10861]`，输出**已经是概率**，不要再做 sigmoid。
- 速度和显存（**估算，未实测**，以 T09.10 的 bench 结果为准）：
  - eva02 在 3070 Laptop + DML 上约 4–10 张/秒，batch 8 时显存约 3 GB；swinv2 大约快 3 倍。
  - CPU 上 eva02 约 1–3 秒/张，swinv2 约 0.3–0.6 秒/张。
  - 10 万张图：GPU 几个小时；CPU 跑 eva02 要 1–3 天。所以回退到 CPU 时，要在任务消息里建议用户换 swinv2（但不要自动换）。

### 涉及文件
新建（都在 `apps/server/src/services/tagger/` 下）：
- `models.ts`：模型注册表（大小、sha256、源、预处理类型）
- `download.ts`：多源测速、断点续传、sha256 校验、手动放置检测、`isModelReady`
- `labels.ts`：CSV 解析（RFC4180，按表头取列）
- `preprocess.ts`：sharp 预处理（WD v3 用 NHWC BGR 0–255；PixAI 用 NCHW RGB [-1,1]）
- `postprocess.ts`：阈值、MCut、rating
- `protocol.ts`：父子进程消息类型
- `host.ts`：子进程入口（加载 ORT、选适配器、推理）
- `client.ts`：主进程侧的 `TaggerClient`、崩溃回退、单例管理（`acquireTagger` / `releaseTagger`）
- `cli.ts`：命令行
- `__tests__/labels.test.ts`、`__tests__/postprocess.test.ts`、`__tests__/preprocess.test.ts`

另外新建：`apps/server/src/net/http.ts`（统一的出网请求 + 代理，T11/T12 复用）。

修改：
- `apps/server/package.json`：加依赖；scripts 加 `"tagger": "tsx src/services/tagger/cli.ts"`
- 根 `package.json`：`allowScripts` 字段由 `npm approve-scripts` 自动写入
- `apps/server/src/config.ts`：下载源、HF_ENDPOINT、DML 适配器号、模型目录、代理
- `docs/ARCHITECTURE.md`：「配置」表格补上新环境变量

### 实现步骤

#### T09.1 安装 onnxruntime-node 和 undici（按 allowScripts 规程）
```powershell
npm install onnxruntime-node@1.30.0 --save-exact -w @emaki/server
npm install undici@^8.11.2 -w @emaki/server
npm approve-scripts --allow-scripts-pending   # 只读：应列出 onnxruntime-node@1.30.0
npm approve-scripts onnxruntime-node          # 写入根 package.json："allowScripts": { …, "onnxruntime-node@1.30.0": true }
npm approve-scripts --allow-scripts-pending   # 不应再列出任何包
```
- 这个 postinstall（`node ./script/install`）在 Windows 上**什么也不下载**：包里 `script/install-metadata.js` 写的是 `'win32/x64': []`，只有 linux/x64 会从 NuGet 下载 CUDA。Windows 需要的 `onnxruntime.dll`、`DirectML.dll`、`dxcompiler.dll`、`dxil.dll`、`onnxruntime_binding.node` 都已经在包的 `bin/napi-v6/win32/x64/` 里。所以批准它只是为了消除警告、兼容 npm 12。
- 如果以后开了 `strict-allow-scripts=true` 或升级到 npm 12 时还没批准：安装会报错或跳过脚本（Windows 上跳过也没影响）。真要重跑，先批准，再 `npm rebuild onnxruntime-node`。
- 版本号**精确锁定**，不加 `^`：DirectML EP 已进入 sustained engineering，升级要主动测试。undici 没有安装脚本。

验证：
```powershell
node -e "const o=require('onnxruntime-node');console.log(o.env.versions.node, JSON.stringify(o.listSupportedBackends()))"
```
期望打印 `1.30.0`，列表里同时有 `"name":"cpu"` 和 `"name":"dml"`。

#### T09.2 config.ts 新增配置 和 `net/http.ts`
```ts
export type ModelSourceId = 'huggingface' | 'hf-mirror' | 'modelscope';
// 加到 config 对象里：
/** 模型文件目录；多个开发库可共用一份。相对路径按仓库根目录解析（npm -w 运行时 cwd 是 apps/server） */
modelsDir: process.env.EMAKI_MODELS_DIR ? path.resolve(repoRoot, process.env.EMAKI_MODELS_DIR) : path.join(dataDir, 'models'),
/** 模型下载源（逗号分隔），会并行测速，选最快的 */
modelSources: (process.env.EMAKI_MODEL_SOURCES ?? 'huggingface,hf-mirror,modelscope')
  .split(',').map((s) => s.trim()).filter(Boolean) as ModelSourceId[],
/** 兼容 huggingface_hub 的 HF_ENDPOINT 约定（例如 https://hf-mirror.com） */
hfEndpoint: (process.env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/+$/, ''),
/** 强制 DirectML 适配器序号；不设就自动探测，结果缓存到 <modelsDir>/dml-device.json */
dmlDeviceId: process.env.EMAKI_DML_DEVICE_ID ? Number(process.env.EMAKI_DML_DEVICE_ID) : null,
/** 出网代理（国内常见：Clash 系统代理模式下 Node 不走系统代理，要写 http://127.0.0.1:7890） */
httpProxy: process.env.EMAKI_HTTP_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? null,
```
（`dataDir` 需要先算出来再引用；按现有 config.ts 的写法调整顺序。顺手把现有的 `dataDir` 也改成 `path.resolve(repoRoot, process.env.EMAKI_DATA_DIR ?? 'data')`：原来的 `path.resolve(相对路径)` 按 cwd 解析，而 `npm run dev -w @emaki/server` 的 cwd 是 `apps/server`，`.env.example` 里的 `EMAKI_DATA_DIR=./data` 会落到 `apps/server/data`。）

`apps/server/src/net/http.ts`：
```ts
import { fetch as undiciFetch, Agent, ProxyAgent, type Dispatcher } from 'undici';
import { config } from '../config.ts';
let dispatcher: Dispatcher | undefined;
function getDispatcher(): Dispatcher {
  dispatcher ??= config.httpProxy ? new ProxyAgent(config.httpProxy) : new Agent({ connect: { timeout: 15_000 } });
  return dispatcher;
}
/** 所有出网请求都走这里（模型下载、Danbooru、词库构建脚本） */
export function httpFetch(url: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  return undiciFetch(url, { ...init, dispatcher: getDispatcher() });
}
```

#### T09.3 models.ts
```ts
export type PreprocessKind = 'wd-v3' | 'pixai';
export interface ModelFile { name: string; size: number; sha256: string }
export interface TaggerModelSpec {
  repo: string;               // = Settings.tagger.model，也写进 images.tagger_model
  label: string;              // UI 显示
  revision: string;           // HF commit，固定版本，防止上游更新导致 sha 不符
  preprocess: PreprocessKind;
  inputSize: number;          // 448
  outputName: string | null;  // null = session.outputNames[0]
  batchDim: string;           // freeDimensionOverrides 用的维度名
  hasRating: boolean;
  maxDmlBatch: number;        // 8GB 显存下的安全上限
  files: { model: ModelFile; labels: ModelFile };
  modelscopeRepo: string | null; // ModelScope 上的同内容镜像（第三方 fork，靠 sha256 保证一致）
}
const WD_V3_LABELS: ModelFile = { name: 'selected_tags.csv', size: 308468, sha256: '298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217' };
const wd = (name: string, revision: string, label: string, size: number, sha256: string, maxDmlBatch: number): TaggerModelSpec => ({
  repo: `SmilingWolf/${name}`, label, revision, preprocess: 'wd-v3', inputSize: 448, outputName: null,
  batchDim: 'batch_size', hasRating: true, maxDmlBatch,
  files: { model: { name: 'model.onnx', size, sha256 }, labels: WD_V3_LABELS },
  modelscopeRepo: `fireicewolf/${name}`,
});
export const TAGGER_MODELS: TaggerModelSpec[] = [
  wd('wd-eva02-large-tagger-v3', 'b25b82a03f7282e41aa2f257a52c7583b710bd1c', 'WD EVA02-Large v3（默认，最准）', 1260435999, '9e768793060c7939b277ccb382783e8670e8a042d29d77aa736be0c8cc898bfc', 16),
  wd('wd-vit-large-tagger-v3', 'ae469aa2e4706a3af08d3673cf73a11d1add314c', 'WD ViT-Large v3', 1260645673, 'e4c8001b000a6c98f2db10794f7c406daa79873d071d6ca924330fa053fa1845', 16),
  wd('wd-swinv2-tagger-v3', '627aef95638667ddcaa3ac8ae625e88ea5b02f51', 'WD SwinV2 v3（快，CPU 推荐）', 467460978, 'e6774bff34d43bd49f75a47db4ef217dce701c9847b546523eb85ff6dbba1db1', 32),
  wd('wd-vit-tagger-v3', '7f6b584d0bd3f55c4531f14ba3d4761b2bccdc0f', 'WD ViT v3（最快）', 378536310, '35f23693620b668f4d53fd3c62bf65e40af739bc52c7eb0fbc49258b58d065b6', 32),
];
export const DEFAULT_TAGGER_MODEL = TAGGER_MODELS[0]!.repo;
export function findModel(repo: string): TaggerModelSpec | null { return TAGGER_MODELS.find((m) => m.repo === repo) ?? null; }
/** CPU 上大 batch 没有收益；DML 按模型限制，防止爆显存 */
export function clampBatch(spec: TaggerModelSpec, device: 'cpu' | 'dml', requested: number): number {
  return Math.max(1, Math.min(requested, device === 'dml' ? spec.maxDmlBatch : 4));
}
```
`batchDim` 的确认情况：eva02 和 swinv2 已从 ONNX 文件尾部确认是 `batch_size`。vit 系列来自同一个导出脚本，大概率一样，但请用 T09.10 的 `inspect` 命令确认后再改注释。

#### T09.4 download.ts
对外 API：
```ts
export interface DownloadProgress { file: string; source: ModelSourceId; received: number; total: number }
export function modelDir(modelsDir: string, spec: TaggerModelSpec): string // → <modelsDir>/SmilingWolf__wd-eva02-large-tagger-v3
export function sourceUrl(source: ModelSourceId, spec: TaggerModelSpec, file: string): string | null
export async function ensureModelFiles(spec: TaggerModelSpec, modelsDir: string, opts?: {
  sources?: ModelSourceId[]; signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void;
}): Promise<{ dir: string; modelPath: string; labelsPath: string }>
/** 同步、便宜的检查（给 T07 Pipeline 判断能否自动触发打标签）：manifest.json 里两个文件都记录过 sha256，且磁盘上的大小一致 */
export function isModelReady(spec: TaggerModelSpec, modelsDir: string): boolean
```
sha256 用 T03 的 `services/fs/hash.ts` 里的 `sha256File`，不要再写一份。所有请求用 `net/http.ts` 的 `httpFetch`。

三个源的 URL（2026-09-27 在本机复核）：
- huggingface：`${config.hfEndpoint}/${spec.repo}/resolve/${spec.revision}/${file}`。会 302/307 跳到 `huggingface.co/api/resolve-cache/…` 或 CDN，fetch 默认会跟随跳转；Range 请求返回 **206**。
- hf-mirror：`https://hf-mirror.com/${spec.repo}/resolve/${spec.revision}/${file}`。本机实测会 308 回 huggingface.co（最终 206），属于正常现象。
- modelscope：`https://www.modelscope.cn/models/${spec.modelscopeRepo}/resolve/master/${file}`。
  - model.onnx：302 到国内 CDN（cdn-lfs-cn-1.modelscope.cn），Range 请求返回标准的 **206**。
  - selected_tags.csv（小文件，直接由 www.modelscope.cn 返回）：Range 请求返回 **`200` + `Content-Range: bytes 100-1123/308468` + 只有请求的那一段**。这是非标准行为，所以续传逻辑**只看 `Content-Range`，不看状态码**（见下面 `downloadOnce`）。
  - fireicewolf 这个 fork 里 model.onnx 和 selected_tags.csv 的 sha256 与官方完全一致。

`ensureFile(spec, dir, file, sources, onProgress, signal)` 的算法：
1. 设 `target = dir/file.name`。如果文件存在且大小等于 `file.size`：
   - `manifest.json` 里记录过相同的 sha256 → 直接返回。
   - 否则现算 sha256。一致 → 写 manifest（source='local'，对应用户手动放置的情况）后返回；不一致 → 把文件改名为 `.bad`，重新下载。
2. 测速：对每个源**并行**发 `Range: bytes=0-1048575` 请求，15 秒超时，速度 = 读到的字节数 / 耗时（毫秒）。按速度从快到慢排序，失败的源剔除。一个都连不上时抛错：`无法连接任何下载源（…）。可手动下载 <file> 放到 <dir>，或设置 EMAKI_HTTP_PROXY`。
3. 按排序逐个源尝试，每个源最多 3 次，每次都能从 `.part` 续传。下载完成后依次校验：大小，然后 sha256。都通过才 `rename(part, target)` 并写 manifest。**大小不符或 sha 不符 → 删掉 `.part`**，换下一个源（`.part` 比 `file.size` 大时也直接删掉重下）。
4. 先下 labels（小文件），再下 model。

核心代码：
```ts
async function probe(url: string, signal?: AbortSignal): Promise<number> {
  const t0 = performance.now();
  const s = AbortSignal.timeout(15_000);
  const res = await httpFetch(url, { headers: { range: 'bytes=0-1048575' }, signal: signal ? AbortSignal.any([s, signal]) : s });
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
  let n = 0;
  for await (const chunk of res.body!) { n += (chunk as Uint8Array).byteLength; if (n >= 1 << 20) break; }
  return n / (performance.now() - t0);
}
async function downloadOnce(url: string, part: string, total: number, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
  const have = await stat(part).then((s) => s.size, () => 0);
  if (have === total) return;
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(new Error('60 秒没有收到数据')), 60_000);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(new Error('60 秒没有收到数据')), 60_000); };
  try {
    const res = await httpFetch(url, {
      headers: have > 0 ? { range: `bytes=${have}-` } : {},
      signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal,
    });
    if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    // 只按 Content-Range 判断是不是续传：ModelScope 小文件会回「200 + Content-Range + 部分内容」
    const cr = /^bytes (\d+)-\d+\/\d+$/.exec(res.headers.get('content-range') ?? '');
    const start = cr ? Number(cr[1]) : 0;                  // 没有 Content-Range = 服务器忽略了 Range，给的是完整文件
    if (have > 0 && cr && start !== have) { await res.body?.cancel(); await rm(part, { force: true }); throw new Error(`续传位置不符：请求 ${have}，返回 ${start}`); }
    const append = have > 0 && start === have;
    let received = append ? have : 0;
    const meter = new Transform({ transform(chunk: Buffer, _e, cb) { received += chunk.length; bump(); onBytes(received); cb(null, chunk); } });
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, createWriteStream(part, { flags: append ? 'a' : 'w' }));
  } finally { clearTimeout(timer); }
}
```
`manifest.json` 的格式：`{ "repo": "...", "files": { "model.onnx": { "sha256": "...", "size": 123, "source": "modelscope", "verifiedAt": "ISO" } } }`。

#### T09.5 labels.ts
```ts
export interface Labels {
  names: string[];                 // 保留下划线原样，如 mika_(blue_archive)；不要像 app.py 那样替换成空格
  categories: Uint8Array;          // 0 general / 4 character / 9 rating
  ratingIdx: number[]; generalIdx: number[]; characterIdx: number[];
}
export function parseCsv(text: string): string[][] // 最小 RFC4180：支持引号、"" 转义、CRLF
export function parseSelectedTags(text: string): Labels
```
- 解析前先去掉 BOM（`text.replace(/^\uFEFF/, '')`），丢弃空行。
- **按表头找 `name` 和 `category` 两列**，不要写死列号：WD 的表头是 `tag_id,name,category,count`，PixAI 的是 `id,tag_id,name,category,count,ips`。
- 真实文件里有带引号的行，例如 `612924,"don't_say_""lazy""",0,1062`，所以绝对不能直接 `split(',')`。
- 如果 `ratingIdx` 非空，校验对应的名字按顺序正好是 `general, sensitive, questionable, explicit`，否则抛错。

#### T09.6 preprocess.ts（对齐官方 Space 的 app.py）
官方 `prepare_image()` 做了这几步：RGBA 合成到白底 → 居中补白成正方形 → BICUBIC 缩放到 448 → 转 float32（0–255，不归一化）→ RGB 转 BGR → 加 batch 维度（NHWC）。

用 sharp 实现时有两个坑：
- **sharp 的 `extend()` 永远在 resize 之后执行**（官方文档原话："always occur after resizing"），所以没法先补白再缩放。
- 解决办法是用 `resize(448, 448, { fit: 'contain', background: 白 })`：先等比缩放，再居中补白。结果和「先补白再缩放」等价，只有 ±1 像素的取整差异。

```ts
import { sharp } from '../image/sharpConfig.ts';
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
/** WD v3：返回长度 size*size*3 的 Float32Array，HWC、BGR、0~255 */
export async function preprocessWdV3(input: string | Buffer, size = 448): Promise<Float32Array> {
  const { data, info } = await sharp(input, { failOn: 'none', autoOrient: true }) // 默认只读第一帧（GIF/动图 WebP）
    .flatten({ background: WHITE })                                                   // 透明 → 白底
    .resize(size, size, { fit: 'contain', background: WHITE, kernel: 'cubic', position: 'centre' })
    .toColourspace('srgb')   // 灰度 / CMYK / 16 位 PNG 都统一成 8 位 sRGB 3 通道
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== size || info.height !== size || info.channels !== 3) throw new Error(`预处理尺寸异常 ${info.width}x${info.height}x${info.channels}`);
  const out = new Float32Array(size * size * 3);
  for (let i = 0, n = size * size; i < n; i++) {
    const o = i * 3;
    out[o] = data[o + 2]!;     // B
    out[o + 1] = data[o + 1]!; // G
    out[o + 2] = data[o]!;     // R
  }
  return out;
}
/** PixAI v0.9（可选，见 T09.12）：CHW、RGB、(x/255-0.5)/0.5，448x448 直接拉伸，不补白 */
export async function preprocessPixai(input: string | Buffer, size = 448): Promise<Float32Array> { /* 同上，但 fit:'fill'、kernel:'linear'，输出三个平面 */ }
export function preprocess(spec: TaggerModelSpec, input: string | Buffer) { return spec.preprocess === 'wd-v3' ? preprocessWdV3(input, spec.inputSize) : preprocessPixai(input, spec.inputSize); }
export const perImage = (spec: TaggerModelSpec) => spec.inputSize * spec.inputSize * 3;
```

#### T09.7 postprocess.ts
```ts
import type { Rating } from '@emaki/shared';
export const RATINGS: Rating[] = ['general', 'sensitive', 'questionable', 'explicit'];
export interface DecodeOptions { generalThreshold: number; characterThreshold: number; generalMcut?: boolean; characterMcut?: boolean; maxGeneral?: number; maxCharacter?: number }
export interface Decoded { rating: Record<Rating, number> | null; general: [string, number][]; character: [string, number][] }
/** MCut（Largeron 2012），与 app.py 一致：降序排序，取相邻差最大处的中点 */
export function mcutThreshold(values: ArrayLike<number>): number {
  const s = Array.from(values).sort((a, b) => b - a);
  if (s.length < 2) return s.length ? s[0]! : 1;
  let t = 0, best = -Infinity;
  for (let i = 0; i < s.length - 1; i++) { const d = s[i]! - s[i + 1]!; if (d > best) { best = d; t = i; } }
  return (s[t]! + s[t + 1]!) / 2;
}
const r4 = (x: number) => Math.round(x * 1e4) / 1e4; // 保留 4 位小数，省 IPC 和数据库体积
function pick(p: Float32Array, off: number, idx: number[], names: string[], thr: number, max: number): [string, number][] {
  const out: [string, number][] = [];
  for (const i of idx) { const v = p[off + i]!; if (v >= thr) out.push([names[i]!, r4(v)]); }
  return out.sort((a, b) => b[1] - a[1]).slice(0, max);
}
export function decodeRow(p: Float32Array, off: number, L: Labels, o: DecodeOptions): Decoded {
  let rating: Decoded['rating'] = null;
  if (L.ratingIdx.length === 4) { rating = { general: 0, sensitive: 0, questionable: 0, explicit: 0 }; for (const i of L.ratingIdx) rating[L.names[i] as Rating] = r4(p[off + i]!); }
  const g = o.generalMcut ? mcutThreshold(L.generalIdx.map((i) => p[off + i]!)) : o.generalThreshold;
  const c = o.characterMcut ? Math.max(0.15, mcutThreshold(L.characterIdx.map((i) => p[off + i]!))) : o.characterThreshold; // 0.15 下限同 app.py
  return { rating, general: pick(p, off, L.generalIdx, L.names, g, o.maxGeneral ?? 80), character: pick(p, off, L.characterIdx, L.names, c, o.maxCharacter ?? 10) };
}
export function pickRating(r: Record<Rating, number>): Rating { return RATINGS.reduce((a, b) => (r[b] > r[a] ? b : a)); }
```
比较一律用 `>=`（app.py 用的是 `>`，差别可以忽略；和 Settings「≥ 阈值自动采纳」的语义保持一致）。MCut 先不暴露到 Settings 里（改 Settings 要动 shared 契约），只作为 `DecodeOptions` 的开关，CLI 可以用 `--mcut` 试。

#### T09.8 protocol.ts 和 host.ts（子进程）
```ts
// protocol.ts
import type { Rating } from '@emaki/shared';
export type HostDevice = 'cpu' | 'dml';
export interface HostThresholds { general: number; character: number; generalMcut?: boolean; characterMcut?: boolean }
export interface InitMsg { type: 'init'; repo: string; modelPath: string; labelsPath: string; device: HostDevice; dmlDeviceId: number | 'probe'; batchSize: number; fixedBatch: boolean }
export interface TagMsg { type: 'tag'; reqId: number; items: { id: number; path: string }[]; thresholds: HostThresholds }
export type ParentMsg = InitMsg | TagMsg | { type: 'shutdown' };
export type HostItemResult =
  | { id: number; ok: true; rating: Record<Rating, number> | null; general: [string, number][]; character: [string, number][] }
  | { id: number; ok: false; code: 'ENOENT' | 'UNSUPPORTED' | 'DECODE'; message: string };
export interface ReadyMsg { type: 'ready'; device: HostDevice; dmlDeviceId: number | null; fallbackReason: string | null; batchSize: number; fixedBatch: boolean; inputName: string; inputShape: (number | string)[]; outputName: string; numLabels: number; loadMs: number; pid: number }
export type ChildMsg = ReadyMsg
  | { type: 'result'; reqId: number; results: HostItemResult[]; preprocessMs: number; inferMs: number }
  | { type: 'error'; reqId: number | null; message: string; fatal: boolean };
```

host.ts 要点：
```ts
import { createRequire } from 'node:module';
import type * as Ort from 'onnxruntime-node';
import { sharp } from '../image/sharpConfig.ts';          // 里面已 sharp.cache(false)
const ort = createRequire(import.meta.url)('onnxruntime-node') as typeof Ort; // onnxruntime-node 是 CJS，用 require 最稳
process.on('disconnect', () => process.exit(0));      // 父进程退出（包括 tsx watch 重启）时自杀，防止孤儿进程占着显存
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => { const p = chain.then(fn, fn); chain = p.catch(() => undefined); return p; };

function sessionOptions(spec: TaggerModelSpec, device: HostDevice, deviceId: number, batch: number, fixed: boolean): Ort.InferenceSession.SessionOptions {
  if (device === 'dml') return {
    executionProviders: [{ name: 'dml', deviceId }],
    enableMemPattern: false,          // DirectML 强制要求（官方文档），不关会报错
    executionMode: 'sequential',      // DirectML 强制要求
    graphOptimizationLevel: 'all',
    ...(fixed ? { freeDimensionOverrides: { [spec.batchDim]: batch } } : {}), // DML 在形状固定时更快
    logSeverityLevel: 3,
  };
  return { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: Math.max(1, os.availableParallelism() - 1), logSeverityLevel: 3 };
}
```

`init(m: InitMsg)` 的流程：
1. `findModel(m.repo)`；`labels = parseSelectedTags(await readFile(m.labelsPath, 'utf8'))`。
2. 如果 `m.device === 'dml'`：
   - 候选适配器 `ids = m.dmlDeviceId === 'probe' ? [0, 1, 2, 3] : [m.dmlDeviceId]`。
   - 对每个 id：`InferenceSession.create(m.modelPath, sessionOptions(...))`，然后用全零输入先 warmup 一次（首次会编译 DML 着色器）；探测模式下再计时 2 次取平均。
   - 留下最快的那个，其余 `release()`；出错的记下原因，继续试下一个。
   - **为什么要探测**：node 绑定里 DML 用的是 `OrtSessionOptionsAppendExecutionProvider_DML(opts, deviceId)`，deviceId 默认 0，底层是 `IDXGIFactory::EnumAdapters1(deviceId)`，按「接显示器的适配器排第一」的顺序枚举。混合显卡笔记本（本机还有一个 MuMu 虚拟显示适配器）的 0 号不一定是 RTX 3070。
3. 如果 DML 全部失败，或者没要求 DML：用 CPU 创建 session，写上 `fallbackReason`；**CPU 时把 batch 截到 ≤ 4**。
4. 用 warmup 的输出校验：`data.length === n * labels.names.length`。不等就抛错「标签表与模型不匹配」。
5. 发送 `ready`，带上实际的 device、batchSize、`session.inputNames[0]`、`inputMetadata[0].shape`、输出名、`process.pid`。

`tag(m: TagMsg)` 的流程：
1. 每个 item 先 `stat(path)`：ENOENT 记为 `code:'ENOENT'`。再 `preprocess()`：错误信息包含 `unsupported image format` 的记为 `UNSUPPORTED`（比如 **BMP，sharp 不支持**），其他错误记为 `DECODE`。
2. 预处理用 `Promise.all` 并行（sharp 在 libuv 线程池里跑）。
3. 把成功的样本拷进 `Float32Array(n * per)`：固定 batch 时 `n = batchSize`，不足的部分补零，输出里丢掉。
4. `serial(() => session.run({ [inputName]: new ort.Tensor('float32', buf, dims) }, [outputName]))`。dims：wd-v3 是 `[n,448,448,3]`，pixai 是 `[n,3,448,448]`。
5. 逐行调用 `decodeRow(probs, k * numLabels, labels, thresholds)`，回复 `result`，附带 `preprocessMs` 和 `inferMs`。
6. 注意：`run()` 在子进程里也会阻塞 JS 线程，但 sharp 的活在线程池里照样进行。所以**父进程要保持 2–3 个请求在途**（T10 用 3），下一批的预处理才能和本批推理重叠。

#### T09.9 client.ts（主进程侧）
```ts
export class TaggerCrashedError extends Error {}
export interface TaggerStartOptions { repo: string; modelPath: string; labelsPath: string; device: 'cpu' | 'dml'; batchSize: number; modelsDir: string; fixedBatch?: boolean }
export interface TaggerLike { readonly device: 'cpu' | 'dml'; readonly batchSize: number; readonly info: ReadyMsg; tag(items: { id: number; path: string }[], th: HostThresholds): Promise<HostItemResult[]> }
export class TaggerClient implements TaggerLike {
  static async spawn(o: TaggerStartOptions & { dmlDeviceId: number | 'probe' }): Promise<TaggerClient>
  tag(items, th, timeoutMs = 300_000): Promise<HostItemResult[]>
  get alive(): boolean
  dispose(): Promise<void>  // 发 shutdown，5 秒后还没退出就 kill
}
export async function startTagger(o: TaggerStartOptions): Promise<TaggerClient>  // 带 DML→CPU 回退和适配器缓存
export function acquireTagger(o: TaggerStartOptions): Promise<TaggerClient>      // 单例：key = repo|device|batchSize
export function releaseTagger(idleMs = 60_000): void                           // 空闲 60 秒后关子进程，释放显存（约 3GB）
export async function shutdownTagger(): Promise<void>
```
- 用 `fork(fileURLToPath(new URL('./host.ts', import.meta.url)), [], { serialization: 'advanced' })` 启动子进程。
  - `execArgv` 默认继承 `process.execArgv`。本机已实测：tsx 的 `--require preflight.cjs --import loader.mjs` 会传给子进程，`.ts` 子进程能跑。以后打包成 JS（T23）时，要根据 `import.meta.url` 的扩展名选 `host.ts` 或 `host.js`。
  - `serialization:'advanced'` 能直接传 Float32Array 和嵌套数组。
- 初始化最多等 600 秒（DML 首次编译加上多适配器探测可能要几十秒到几分钟）。子进程在 ready 之前退出 → reject `TaggerCrashedError`。
- 每个请求超时 300 秒。超时就 `child.kill()`，再 reject `TaggerCrashedError`，防止 DML 卡死（microsoft/onnxruntime#16473 就是这种情况）。
- 子进程 `exit` 时，把所有 pending 请求 reject 成 `TaggerCrashedError`。
- `startTagger` 的逻辑：
  - DML 的 deviceId 按这个顺序确定：`config.dmlDeviceId` → `<modelsDir>/dml-device.json` 的缓存 → `'probe'`。
  - 探测成功后写缓存；用缓存的 id 却失败了 → 删掉缓存，下次重新探测。
  - DML 子进程在 ready 前原生崩溃 → 自动再用 `device:'cpu'` 起一次，`fallbackReason = 'DirectML 子进程崩溃：…'`。
- `acquireTagger` 注意：如果 `startTagger` 失败，要把单例清掉，别把 rejected 的 promise 一直缓存着。

#### T09.10 cli.ts
用 `node:util` 的 `parseArgs`，参数：`--model`（默认 eva02）、`--device dml|cpu`（**默认 `dml`**）、`--batch 8`、`--n 64`、`--general 0.35`、`--character 0.35`、`--mcut`、`--no-fixed-batch`。`inspect` / `tag` / `bench` 启动 client 后**第一行都打印** `[tagger] 子进程 pid=<info.pid> · device: <device> (#<dmlDeviceId>)`（CPU 时是 `device: cpu`，有 fallbackReason 时再打印一行），崩溃演练要用这个 pid。

| 命令 | 作用 |
|---|---|
| `download` | `ensureModelFiles`，打印每个源的测速结果和进度 |
| `inspect` | 启动 client，打印 `info`（device、dmlDeviceId、fallbackReason、pid、inputName、inputShape、outputName、numLabels、loadMs） |
| `tag <文件...>` | 每张图打印 rating（四档概率和 argmax）、前 15 个 general、所有 character |
| `bench <文件>` | 同一张图重复 n 次，3 个请求在途，打印总张/秒，以及每批平均 preprocessMs / inferMs |

运行方式：`npm run tagger -w @emaki/server -- <命令> ...`。脚本的 cwd 是 apps/server，文件路径请用绝对路径。CLI 结束前一定调用 `dispose()`。

#### T09.11 单元测试
- **labels.test.ts**：
  - 内联一个小 CSV：包含 CRLF 行尾、带 `""` 转义的行、4 条 rating、2 条 general、1 条 character。断言各下标数组正确。
  - 如果 `<modelsDir>/SmilingWolf__wd-eva02-large-tagger-v3/selected_tags.csv` 存在（用 `it.skipIf` 控制），再断言：总数 10861，rating 0–3，general 从 4 开始共 8106 个，character 从 8110 开始共 2751 个。
- **postprocess.test.ts**：
  - `mcutThreshold([0.9, 0.8, 0.2, 0.1])` ≈ 0.5。
  - 用人造的 7 个标签：`[general, sensitive, questionable, explicit, 1girl, solo, mika_(blue_archive)]`，分数 `[0.1, 0.7, 0.15, 0.05, 0.99, 0.2, 0.93]`，阈值 general 0.35 / character 0.35。期望 rating argmax = sensitive，general = `[['1girl', 0.99]]`，character = `[['mika_(blue_archive)', 0.93]]`。
- **preprocess.test.ts**：
  - 用 `sharp({create:{width:200,height:100,channels:3,background:{r:255,g:0,b:0}}}).png().toBuffer()` 生成图片。断言：长度 448×448×3；中心像素 (224,224) 约等于 `[0,0,255]`（BGR 顺序），容差 2；(5,5) 和 (224,440) 约等于 `[255,255,255]`（上下补白）。
  - 64×64 全透明 PNG → 所有值 ≥253。**求最小值要用 for 循环**，`Math.min(...arr)` 在 60 万个元素时会栈溢出。

#### T09.12（可选）PixAI Tagger v0.9 预设
- 角色数据更新到 2025-01，共 13461 个标签（其中 3720 个角色）。官方自称角色 micro-F1 ≈ 0.865，对比 WD eva02 ≈ 0.61（厂商自测数据）。**没有 rating 输出**。
- 在注册表里加一条：
```ts
{ repo: 'deepghs/pixai-tagger-v0.9-onnx', revision: 'd8cf666911a2c3d10d586d7823259192313c7eb7', label: 'PixAI v0.9（新角色更多，无分级）', preprocess: 'pixai', inputSize: 448, outputName: 'prediction', batchDim: 'batch_size', hasRating: false, maxDmlBatch: 16,
  files: { model: { name: 'model.onnx', size: 1271365854, sha256: 'a8d479098b5e23f253543c93df42391736abbb77c21c2efd3a513b9cda7b3657' }, labels: { name: 'selected_tags.csv', size: 596868, sha256: '76b5dd39354a7a4d9baefb94d63b44a09a4934ee15303b7eb86c38f2128eb68a' } }, modelscopeRepo: null }
```
- 这个 ONNX 有三个输出：`embedding`、`logits`、`prediction`。输入名 `input`，维度 `batch_size`。`run` 时只取 `['prediction']` 这一个。
- 预处理按 deepghs 的 `preprocess.json`：直接 resize 到 448×448（bilinear），然后 to_tensor，再 normalize(0.5, 0.5)。
- 官方推荐阈值：general 0.3；character 0.75（PixAI 卡片）或 0.85（deepghs 的 thresholds.csv）。

### 坑
1. **不要在主进程 import onnxruntime-node。** 主进程只 import `client.ts`，client.ts 里只能有 `import type`。
2. **DML 的 session 必须带 `enableMemPattern:false` 和 `executionMode:'sequential'`。** 同一个 session 同一时间只能有一个 `run()`，用 `serial()` 串起来。
3. **适配器 0 可能不是独显**，所以要做探测，并提供 `EMAKI_DML_DEVICE_ID` 手动覆盖。在任务管理器 →「性能 → GPU」里确认是 RTX 3070 在跑（看 Compute / 3D 占用）。
4. **freeDimensionOverrides 固定 batch 后，最后一批要补零到 batch 大小**，否则 run 会报形状不符。
5. **不要对输出再做 sigmoid**（图里已经有）；**不要做 mean/std 归一化**（图里的 Div/Sub 已经做了）。**通道顺序是 BGR。** 做错了分数会整体偏低，power.jpg 验收过不了。
6. **sharp 调用顺序**：不能用 extend 先补白，要用 `fit:'contain'` 加白色 `background`。要调用 `.toColourspace('srgb')`：灰度图不加这一步只有 1 个通道，16 位 PNG 也要靠它转换。要 `autoOrient`：手机拍的 JPEG 带 EXIF 旋转。
7. **BMP 在 sharp 里不支持**：返回 `UNSUPPORTED` 就行（T10 会把它记为已处理，避免反复重试）。可选改进：T04 已有 `decodeBmp` / `openSharp(buf, 'bmp')`，host 里读到以 `BM` 开头的文件时可以先用它解码，再走同样的 flatten / resize 流程，这样 BMP 也能识别。
8. **Windows 上模型路径**：绑定层用 UTF-16 传路径，中文路径没问题；不要为这个把 1.26GB 模型整个读进 Buffer。
9. **下载**：ModelScope 的 fireicewolf 是第三方 fork，**一定要做 sha256 校验**。HF 的 URL 用固定 revision，不用 `main`。1.26GB 的 sha256 要算 3–6 秒，属于正常。
10. **子进程要处理 `disconnect`**，否则 `tsx watch` 每次重启都会留下一个占 3GB 显存的孤儿进程。
11. **DirectML 已进入 sustained engineering。** OpenUtau 报告过 ORT.DirectML 1.24.x 建 session 时原生崩溃，所以回退路径一定要真的测过（见验收 6）。如果本机 1.30.0 的 DML 反复崩溃，可以尝试把 onnxruntime-node 精确锁定到 1.23.2 再测（记得重新 approve-scripts）。

### 验收标准（PowerShell，在 F:\Claude\emaki 下执行）
1. `npm ls onnxruntime-node` 显示 `onnxruntime-node@1.30.0`。根 package.json 里有 `"onnxruntime-node@1.30.0": true`。`npm approve-scripts --allow-scripts-pending` 的输出为空。T09.1 的 `node -e` 命令输出里有 `dml`。
2. 执行 `npm run tagger -w @emaki/server -- download`：先打印三个源的测速结果，然后把 `model.onnx`、`selected_tags.csv`、`manifest.json` 下到 `data/models/SmilingWolf__wd-eva02-large-tagger-v3/`（默认 modelsDir）。再执行一次，1 秒内打印「已存在，校验通过」。删掉一半 `.part` 后重跑，能续传。
3. 下载官方示例图：`New-Item -ItemType Directory -Force F:\Claude\emaki\data\test | Out-Null; curl.exe -L -o F:\Claude\emaki\data\test\power.jpg https://hf-mirror.com/spaces/SmilingWolf/wd-tagger/resolve/main/power.jpg`。然后执行 `npm run tagger -w @emaki/server -- tag --device dml F:\Claude\emaki\data\test\power.jpg`：
   - 输出 `device: dml (#N)`。
   - character 第一名是 `power_(chainsaw_man)`，分数 ≥0.85（这张就是官方 Space 的示例图）。
4. 同一张图用 `--device cpu` 跑：general 前 10 名的集合一样，各标签分数差的绝对值 < 0.02。
5. `bench --device dml --batch 8 --n 64` 能打印张/秒，并且明显快于 `--device cpu --n 8` 的结果。把两个数字记进 docs/ARCHITECTURE.md。
6. **崩溃演练**：跑 `bench --device dml --batch 8 --n 2000`（跑得够久），从它第一行输出里拿到子进程 pid（每次运行 CLI 都会起一个新的子进程，**不能用另一次 `inspect` 的 pid**），在另一个终端执行 `taskkill /PID <pid> /F`。CLI 应当打印 `TaggerCrashedError`，以非 0 退出码结束但不是未捕获异常崩溃。再执行 `$env:EMAKI_DML_DEVICE_ID=9` 后跑 `inspect --device dml`：应当显示 `device: cpu` 和 fallbackReason。之后 `Remove-Item Env:EMAKI_DML_DEVICE_ID`。
7. `npx vitest run apps/server/src/services/tagger` 全部通过；`npm run typecheck` 通过。
8. 跑完之后 5 秒内，任务管理器里不应残留 node 子进程。

### 难度
L

### 给实现模型的提示
- 顺序：T09.1 → 2 → 3 → 5 → 7 → 6（每完成一步就跑对应的单元测试）→ 4 → 8 → 9 → 10，最后做验收。T09.12 最后再做，也可以不做。
- 不要写死 rating、general、character 的下标，一律用 labels 里的数组。
- 报错信息和进度文案用中文。日志加 `[tagger]` 前缀。
- 不要改 `packages/shared` 的契约，也不要改 `core/jobs.ts`。
- onnxruntime-node 用 `createRequire` 加载，类型用 `import type * as Ort`。

## T10 打标签任务 + 角色自动归类（阈值、自动采纳、建议写入 character_suggestions、rating）

### 目标
实现 `tag` 后台任务：把 T09 引擎的输出写进 SQLite。具体要做到：
- 高分角色自动归类，库里没有的角色自动新建，并尽量挂上作品（离线映射表）。
- 中等分数的角色写进 `character_suggestions`，给「未识别」页面人工确认；建议角色所属的作品如果已存在，图也归到这个作品（`image_copyrights`）。
- 更新分级（手动改过的不动）、`tagged_at`、`tagger_model`。
- 通过 `JobContext` 实时汇报进度：张/秒、剩余时间、设备。
- 支持取消、让出给扫描、DML 崩溃自动转 CPU，全程不阻塞 HTTP。
- 建立「标签 → 角色 / 作品」的共享模块（`CharacterCatalog` 等），T11、T14、T15 复用（见「全局约定 → 共享模块」）。

### 依赖
- 前置：T01、T02（`readSettings(db).tagger`）、T03（images 里有数据）、T07（Pipeline）、T09（引擎）。
- 可选钩子：T11（更完整的作品回退链、标签规范化）、T12（中文名 Localizer）、T17（排除规则）、T20（标签计数）。
- 被依赖：T11、T14、T15 复用 `CharacterCatalog`、`CopyrightResolver`、`Localizer`、`replaceAutoAliases`。

### 规则（实现和测试都以这张表为准）
设 `t = settings.tagger`。`t.characterThreshold` 就是 ARCHITECTURE.md 里说的「建议阈值」。下表里的「角色标签」都先经过 `catalog.normalizeTag()`（T11 之前原样返回），同一张图规范化后重复的标签取最高分。

| 输出 | 条件 | 写入 |
|---|---|---|
| general 标签 | 分数 ≥ `t.generalThreshold`，最多 80 个 | `tags`（category='general'）+ `image_tags` |
| character 标签（原始名） | 分数 ≥ `min(t.characterThreshold, t.autoAcceptThreshold)` | `tags`（category='character'）+ `image_tags`，供详情页的标签列表展示 |
| character | 分数 ≥ `t.autoAcceptThreshold` | `image_characters(origin='tagger', score)`；角色不存在就新建；已有的关联行（包括 manual）不覆盖 |
| character | `t.characterThreshold` ≤ 分数 < `t.autoAcceptThreshold` | `character_suggestions`，每张图最多 5 条，按分数降序；该图已关联的角色跳过 |
| 建议角色的主作品 | 上一行写入的每条建议：`copyrights(tag)[0]` 在 `works` 里**已存在** | `image_copyrights(image_id, work_id, score)`（**不新建作品**） |
| rating | 有 rating 输出的模型 | 四档取 argmax 写进 `images.rating`，**`rating_manual=1` 的不改** |
| 成功 | —— | `tagged_at=now`，`tagger_model=spec.repo` |
| DECODE / UNSUPPORTED | —— | 也写 `tagged_at`、`tagger_model`，避免每次都重试；计入 failed |
| ENOENT | —— | **不写**，留给扫描器标记 `missing` |

补充说明：
- 如果 `characterThreshold ≥ autoAcceptThreshold`，建议区间为空，所有 ≥ autoAccept 的都直接采纳。
- 重打标签时，`image_tags`、`character_suggestions`、`image_copyrights` 先删后写；`image_characters` **只增不删**，手动和 tagger 的结果都保留。

**候选范围**（`startJob('tag')` 不带参数，所以写死在 SQL 里）：
- 基本条件：未排除、未进回收站、文件没丢、所在库根已启用且未移除。
- 并且满足下面任一条：从来没打过标签（`tagged_at IS NULL`）；或者用别的模型打过，而且目前没有任何角色关联（换了更好的模型后，点「运行识别」只会重跑未识别的图）。
- 按 `id DESC` 处理，新图优先。

**阶段 0**（每次任务开始时都执行，很便宜）：
- 已有建议里分数 ≥ 当前 autoAccept 的，提升为 `image_characters`，并删掉这条建议。效果：用户把自动采纳阈值调低后，点一下「运行识别」就能批量归类。
- 没有作品的 danbooru 角色，补挂作品。

### 涉及文件
新建：
- `apps/server/src/util/color.ts`：`hslToHex`、`hashString`（从 MockDataSource 复制）、`colorFromTag`
- `apps/server/src/services/i18n/humanize.ts`：`humanizeCharacterTag`、`humanizeCopyrightTag`（T12 再加别的函数）
- `apps/server/src/services/i18n/localizer.ts`：`Localizer` 接口 + 占位实现 `HumanizeLocalizer`
- `apps/server/src/services/aliases.ts`：`replaceAutoAliases`
- `apps/server/src/services/catalog/copyrights.ts`：`CopyrightSource`、`CopyrightResolver`
- `apps/server/src/services/catalog/characterCatalog.ts`：`CharacterCatalog`、`resolveCharacterIdByTag`
- `apps/server/src/services/tagger/writer.ts`：`TagResultWriter`
- `apps/server/src/services/tagger/tagJob.ts`：`createTagJobRunner`、`createTagStage`
- `apps/server/scripts/build-character-ips.ts`，以及它生成的 `apps/server/assets/character-ips.json`（要提交）
- `apps/server/assets/README.md`：数据来源和 Apache-2.0 署名
- 测试：`services/catalog/__tests__/catalog.test.ts`、`services/tagger/__tests__/writer.test.ts`、`services/tagger/__tests__/tagJob.test.ts`、`services/i18n/__tests__/humanize.test.ts`

修改：
- `apps/server/src/config.ts`：加 `assetsDir: path.join(repoRoot, 'apps/server/assets')`
- `SqliteDataSource.open`：`pipeline.register({ tag: createTagStage(...) })`；`close()` 里 `await shutdownTagger()`

### 实现步骤

#### T10.1 离线「角色 → 作品」表 character-ips.json
背景：WD v3 没有 copyright 输出，T11 联网同步前角色也挂不上作品。deepghs 的 `pixai-tagger-v0.9-onnx/selected_tags.csv` 里有一列 `ips`，给每个 character 标签标了所属 copyright，许可证是 Apache-2.0。已实测：
- 3720 个角色里有 3709 个带 ips。
- **覆盖 WD v3 的 2751 个角色中的 2704 个（98.3%）**。
- 其中 776 个有多个 ips，而且原始顺序不稳定。

脚本 `apps/server/scripts/build-character-ips.ts`（执行：`npx tsx apps/server/scripts/build-character-ips.ts`）：
1. 用 `httpFetch` 下载 `https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/selected_tags.csv`。失败就把 host 换成 `hf-mirror.com` 再试。然后校验 size=596868、sha256=`76b5dd39354a7a4d9baefb94d63b44a09a4934ee15303b7eb86c38f2128eb68a`。
2. 用 T09 的 `parseCsv` 解析，按表头取 `name`、`category`、`ips` 三列。只保留 category==='4' 且 `JSON.parse(ips)` 非空的行。
3. 统计每个 ip 出现在多少个角色里（频次）。每个角色的 ips 按「频次降序、名字升序」重排，这样**第一个就是母 IP**：例如 `matou_sakura → ["fate_(series)","fate/stay_night"]`，`cure_black → ["precure","futari_wa_precure"]`。（联网同步后的主作品规则不同，见「全局约定 → 标签 → 角色 / 作品的统一规则」第 4 条。）
4. 输出 `{ "source": "deepghs/pixai-tagger-v0.9-onnx@d8cf666 selected_tags.csv", "license": "Apache-2.0", "generatedAt": "…", "characters": { …key 排序… } }`。预期 3709 个 key，约 168KB。
5. `apps/server/assets/README.md` 写明来源 URL、修订号和 Apache-2.0 署名。

#### T10.2 color.ts、humanize.ts、localizer.ts、aliases.ts
```ts
// util/color.ts
export function hslToHex(h: number, s: number, l: number): string   // 从 MockDataSource 原样复制
export function hashString(s: string): number                       // 从 MockDataSource 原样复制
/** 作品色点：按 tag 哈希取色相，和 mock 一样用 hsl(h,62%,58%) */
export const colorFromTag = (tag: string) => hslToHex(hashString(tag) % 360, 62, 58);
```
```ts
// services/i18n/humanize.ts
/** 只去掉最后一个 `_(...)`；剩下的 `_(xxx)` 变成 ` (Xxx)`；下划线变空格；每个词首字母大写。
 *  mika_(blue_archive) → Mika；hatsune_miku → Hatsune Miku；mika_(swimsuit)_(blue_archive) → Mika (Swimsuit)
 *  （简单标签的结果与 MockDataSource.humanizeTag 一致） */
export function humanizeCharacterTag(tag: string): string
/** 只去掉结尾的 `_(series)`，其他括号保留成 ` (Xxx)`；`/` `:` `-` `(` 后面的字母也大写。
 *  fate_(series) → Fate；fate/grand_order → Fate/Grand Order；honkai:_star_rail → Honkai: Star Rail；pokemon_(anime) → Pokemon (Anime) */
export function humanizeCopyrightTag(tag: string): string {
  return tag.replace(/_\(series\)$/, '').replace(/_/g, ' ').replace(/(^|[\s/:(-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}
```
```ts
// services/i18n/localizer.ts（接口签名固定，T11/T12 不得修改）
export type NameSource = 'dict' | 'wiki-zh' | 'wiki-converted' | 'wiki-ja' | 'tag';
export interface LocalizedName { name: string; source: NameSource }
export interface AutoAlias { alias: string; origin: 'dict' | 'danbooru'; visible: boolean }
export interface Localizer {
  characterName(tag: string): LocalizedName;
  workName(tag: string): LocalizedName;
  aliasesFor(tag: string, owner: 'character' | 'work', displayName: string): AutoAlias[];
  invalidate(): void;
}
/** T12 之前的占位实现：只会 humanize */
export class HumanizeLocalizer implements Localizer {
  characterName(tag: string): LocalizedName { return { name: humanizeCharacterTag(tag), source: 'tag' }; }
  workName(tag: string): LocalizedName { return { name: humanizeCopyrightTag(tag), source: 'tag' }; }
  /** 原始标签（visible=false，只供搜索）+ 人性化名字；按 searchKey 去重，去掉与 displayName 同 key 的 */
  aliasesFor(tag: string, owner: 'character' | 'work', displayName: string): AutoAlias[]
  invalidate(): void {}
}
```
```ts
// services/aliases.ts（002 迁移已给 aliases 加了 origin / visible / position）
import { searchKey } from '@emaki/shared';
/** 替换某个角色 / 作品的自动别名；用户手动写的（origin='user'）不动 */
export function replaceAutoAliases(db: Database.Database, owner: 'character' | 'work', ownerId: number, list: AutoAlias[]): void {
  const hasUser = db.prepare(`SELECT 1 FROM aliases WHERE owner_type = ? AND owner_id = ? AND origin = 'user' LIMIT 1`).get(owner, ownerId);
  db.prepare(`DELETE FROM aliases WHERE owner_type = ? AND owner_id = ? AND origin <> 'user'`).run(owner, ownerId);
  const ins = db.prepare(`INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  list.forEach((a, i) => ins.run(owner, ownerId, a.alias, searchKey(a.alias), a.origin, hasUser ? 0 : a.visible ? 1 : 0, 100 + i));
}
```
（用户手动整理过别名的对象，自动别名只做搜索不显示；`INSERT OR IGNORE` 保证用户别名优先；自动别名 position 从 100 起，排在用户别名后。）

#### T10.3 copyrights.ts
```ts
export interface CopyrightSource { copyrights(tag: string): string[] }   // 第一个 = 主作品
export class CopyrightResolver implements CopyrightSource {
  private readonly stmt: Database.Statement;
  constructor(db: Database.Database, readonly offline: Readonly<Record<string, string[]>>) {
    this.stmt = db.prepare('SELECT copyrights FROM danbooru_tags WHERE name = ?');
  }
  static fromAsset(db: Database.Database, file = path.join(config.assetsDir, 'character-ips.json')): CopyrightResolver {
    let map: Record<string, string[]> = {};
    try { map = (JSON.parse(readFileSync(file, 'utf8')) as { characters: Record<string, string[]> }).characters; } catch { /* 没有离线表也能跑，只是不自动建作品 */ }
    return new CopyrightResolver(db, map);
  }
  /** ① T11 同步下来的 danbooru_tags.copyrights（非空才算）② 离线表。T11 会在外面再包一层完整回退链 */
  copyrights(tag: string): string[] {
    const row = this.stmt.get(tag) as { copyrights: string | null } | undefined;
    if (row?.copyrights) { try { const a: unknown = JSON.parse(row.copyrights); if (Array.isArray(a) && a.length && a.every((x) => typeof x === 'string')) return a as string[]; } catch { /* 坏数据忽略 */ } }
    return this.offline[tag] ?? [];
  }
}
```

#### T10.4 characterCatalog.ts
```ts
export interface CatalogOptions {
  copyrights: CopyrightSource;
  localizer?: Localizer;                      // 默认 new HumanizeLocalizer()
  normalizeTag?: (tag: string) => string;     // 默认原样返回；T11 换成「改名解析 + 服装变体归本体」
}
export class CharacterCatalog {
  constructor(db: Database.Database, o: CatalogOptions)
  normalizeTag(tag: string): string
  /** normalizeTag → characters.danbooru_tag → danbooru_tag_redirects（合并重定向） */
  resolveCharacterId(tag: string): number | null
  /** 已存在就返回；否则新建 danbooru 角色（名字、别名、作品） */
  ensureCharacter(tag: string, coverImageId: number | null, now: string): { id: number; created: boolean; createdWorkIds: number[] }
  ensureWork(copyright: string, now: string): { id: number; created: boolean }
  /** 按 copyrights(tag) 追加挂作品（INSERT OR IGNORE，position 接着现有最大值），返回新建的作品 id */
  linkWorks(characterId: number, tag: string, now: string): number[]
  /** 给没有作品的 danbooru 角色补挂，返回补挂的角色数 */
  backfillWorks(now: string): number
  /** 给 T15 拼 CharacterSuggestion；只查不写 */
  describeTag(tag: string): { characterId: number | null; name: string; workName: string | null }
}
/** 给 T14/T15 用的便捷函数：db + 可选的 normalize */
export function resolveCharacterIdByTag(db: Database.Database, tag: string, normalize: (t: string) => string = (t) => t): number | null
```
要用到的 SQL（在构造函数里一次性 prepare）：
```sql
SELECT id FROM characters WHERE danbooru_tag = @tag
UNION ALL
SELECT character_id FROM danbooru_tag_redirects WHERE tag = @tag
LIMIT 1;
INSERT INTO characters(name, danbooru_tag, source, cover_image_id, created_at) VALUES (@name, @tag, 'danbooru', @cover, @now);
UPDATE characters SET cover_image_id = ? WHERE id = ? AND cover_image_id IS NULL;
SELECT id FROM works WHERE danbooru_tag = ?;
INSERT INTO works(name, danbooru_tag, color, created_at) VALUES (@name, @tag, @color, @now);
SELECT COALESCE(MAX(position) + 1, 0) FROM character_works WHERE character_id = ?;
INSERT OR IGNORE INTO character_works(character_id, work_id, position) VALUES (?, ?, ?);
SELECT c.id, c.danbooru_tag AS tag FROM characters c
  WHERE c.danbooru_tag IS NOT NULL AND c.works_locked = 0
    AND NOT EXISTS (SELECT 1 FROM character_works cw WHERE cw.character_id = c.id);
```
新建角色时：
- `tag = normalizeTag(rawTag)`；`name = localizer.characterName(tag).name`。
- 用 `Number(run().lastInsertRowid)` 拿 id（better-sqlite3 在大数时返回 bigint）。
- 调用 `linkWorks`（position 从 0 开始）；每个新建的作品 id 放进 `createdWorkIds`（T14 撤销时要删掉它们）。
- `replaceAutoAliases(db, 'character', id, localizer.aliasesFor(tag, 'character', name))`。

新建作品时：`name = localizer.workName(copyright).name`，`color = colorFromTag(copyright)`，然后 `replaceAutoAliases(db, 'work', id, localizer.aliasesFor(copyright, 'work', name))`。

`describeTag(tag)`：有角色 → 角色名 + 第一个作品名；没有 → `localizer.characterName(tag).name` + `copyrights(tag)[0]` 对应的 works.name（没有就 `localizer.workName(它).name`；没有 copyright 就 null）。

缓存：进程内用 `Map<tag, id>` 缓存，**只在一次任务或一次请求内有效**，每次 runner 执行都 new 一个 catalog。T14 合并、删除角色后，长期缓存会过期。

#### T10.5 writer.ts
```ts
export interface WriterOptions { repo: string; generalThreshold: number; characterThreshold: number; autoAcceptThreshold: number; maxSuggestions?: number;
  /** T17：在同一个事务里对本批图应用排除规则 */
  afterBatchInTx?: (imageIds: number[]) => void }
export interface WriteStats { tagged: number; linked: number; createdCharacters: number; suggestions: number; failed: number; missing: number }
export class TagResultWriter {
  readonly stats: WriteStats;
  constructor(db: Database.Database, catalog: CharacterCatalog, copyrights: CopyrightSource, o: WriterOptions)
  writeBatch(results: HostItemResult[]): number[]   // 一个事务；返回被标记为已处理的 imageId
  promoteSuggestions(): number                      // 阶段 0
}
```
prepared statements：
```sql
-- upsert 标签：冲突时也要 RETURNING id，所以写一个空操作的 SET
INSERT INTO tags(name, category) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id;
DELETE FROM image_tags WHERE image_id = ?;
INSERT OR REPLACE INTO image_tags(image_id, tag_id, score) VALUES (?, ?, ?);
DELETE FROM character_suggestions WHERE image_id = ?;
INSERT OR REPLACE INTO character_suggestions(image_id, danbooru_tag, score) VALUES (?, ?, ?);
DELETE FROM image_copyrights WHERE image_id = ?;
INSERT INTO image_copyrights(image_id, work_id, score) VALUES (@imageId, @workId, @score)
  ON CONFLICT(image_id, work_id) DO UPDATE SET score = MAX(score, excluded.score);
SELECT id FROM works WHERE danbooru_tag = ?;
SELECT character_id FROM image_characters WHERE image_id = ?;
INSERT INTO image_characters(image_id, character_id, origin, score, added_at)
  VALUES (@imageId, @characterId, 'tagger', @score, @now) ON CONFLICT(image_id, character_id) DO NOTHING;
UPDATE images SET rating = ? WHERE id = ? AND rating_manual = 0;
UPDATE images SET tagged_at = ?, tagger_model = ? WHERE id = ?;
-- 阶段 0
SELECT cs.image_id AS imageId, cs.danbooru_tag AS tag, cs.score AS score
  FROM character_suggestions cs JOIN images i ON i.id = cs.image_id
  WHERE cs.score >= ? AND i.trashed_at IS NULL;
DELETE FROM character_suggestions WHERE image_id = ? AND danbooru_tag = ?;
```
单张图的写法（放在 `db.transaction(...)` 里；better-sqlite3 的事务函数必须是同步的，catalog 也全是同步 API）：
```ts
if (!r.ok) {
  if (r.code === 'ENOENT') { stats.missing++; return null; }
  markTagged.run(now, repo, r.id); stats.failed++; return r.id;
}
delImageTags.run(r.id);
for (const [name, s] of r.general) insImageTag.run(r.id, this.tagId(name, 'general'), s);   // tagId 带 Map 缓存
for (const [name, s] of r.character) insImageTag.run(r.id, this.tagId(name, 'character'), s);
// 角色标签规范化 + 去重（取最高分）
const chars = new Map<string, number>();
for (const [raw, s] of r.character) { const t = catalog.normalizeTag(raw); chars.set(t, Math.max(chars.get(t) ?? 0, s)); }
const sorted = [...chars].sort((a, b) => b[1] - a[1]);
delSuggestions.run(r.id); delImageCopyrights.run(r.id);
for (const [tag, s] of sorted) if (s >= o.autoAcceptThreshold) {
  const { id, created } = catalog.ensureCharacter(tag, r.id, now);
  if (created) stats.createdCharacters++;
  if (insImageChar.run({ imageId: r.id, characterId: id, score: s, now }).changes) stats.linked++;
}
const linked = new Set((linkedIds.all(r.id) as { character_id: number }[]).map((x) => x.character_id));
let n = 0;
for (const [tag, s] of sorted) {
  if (s >= o.autoAcceptThreshold || s < o.characterThreshold || n >= (o.maxSuggestions ?? 5)) continue;
  const cid = catalog.resolveCharacterId(tag);
  if (cid != null && linked.has(cid)) continue;   // 已经归到这个角色了（包括手动归的、合并后的重定向）
  insSuggestion.run(r.id, tag, s); n++;
  const primary = copyrights.copyrights(tag)[0];   // 建议角色的主作品：只挂已存在的作品，不新建
  const w = primary ? (workByTag.get(primary) as { id: number } | undefined) : undefined;
  if (w) insImageCopyright.run({ imageId: r.id, workId: w.id, score: s });
}
stats.suggestions += n;
if (r.rating) updRating.run(pickRating(r.rating), r.id);
markTagged.run(now, repo, r.id); stats.tagged++;
return r.id;
```
整批写完后（还在同一个事务里）调用 `o.afterBatchInTx?.(ids)`。
`image_characters.added_at` 写的是**关联时间**（now），不是图片的入库时间；新建角色的 `created_at` 用同一个 `now`（见「全局约定 → newCount」）。

#### T10.6 tagJob.ts
```ts
export interface TagJobDeps {
  db: Database.Database;
  bus: EventBus;
  modelsDir: string;
  getTaggerSettings(): Settings['tagger'];                   // T02 的 readSettings(db).tagger（同步）
  /** 每次任务 new 一个 catalog。默认：new CharacterCatalog(db, { copyrights: CopyrightResolver.fromAsset(db) })；T11/T12 注入升级版 */
  makeCatalog?: () => { catalog: CharacterCatalog; copyrights: CopyrightSource };
  afterBatchInTx?: (imageIds: number[]) => void;             // T17
  log?: (msg: string) => void;
  // 测试注入：
  clientFactory?: (o: TaggerStartOptions) => Promise<TaggerLike>;
  ensureFiles?: typeof ensureModelFiles;
}
export function createTagJobRunner(deps: TagJobDeps): JobRunner
/** 给 T07 Pipeline 的阶段对象 */
export function createTagStage(deps: TagJobDeps): TagStage   // { isReady, pendingCount, run }
```
候选 SQL（`@beforeId`、`@limit`、`@model` 是 better-sqlite3 的命名参数，传的对象里只放用到的 key）：
```ts
const WHERE = `r.enabled = 1 AND r.removed_at IS NULL AND i.missing = 0 AND i.trashed_at IS NULL AND i.excluded_by IS NULL
  AND (i.tagged_at IS NULL
       OR (i.tagger_model IS NOT @model
           AND NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id)))`;
const COUNT = `SELECT COUNT(*) AS n FROM images i JOIN library_roots r ON r.id = i.root_id WHERE ${WHERE}`;
const BATCH = `SELECT i.id AS id, r.path AS rootPath, i.rel_path AS relPath
  FROM images i JOIN library_roots r ON r.id = i.root_id
  WHERE ${WHERE} AND i.id < @beforeId ORDER BY i.id DESC LIMIT @limit`;
```
`createTagStage`：`isReady = () => { const s = findModel(getTaggerSettings().model); return !!s && isModelReady(s, modelsDir); }`；`pendingCount = () => COUNT`；`run = createTagJobRunner(deps)`。

runner 的流程：
1. `t = getTaggerSettings()`，`spec = findModel(t.model)`。找不到就抛错：`不支持的模型：… 可选：…`。
2. `{ catalog, copyrights } = makeCatalog()`，`writer = new TagResultWriter(...)`。
3. 阶段 0：执行 `writer.promoteSuggestions()` 和 `catalog.backfillWorks(now)`。
4. `total = COUNT`。如果是 0：`return promoted ? `已按新阈值采纳 ${promoted} 条建议` : '没有需要识别的图片'`。
5. 准备模型：`ctx.setMessage('识别角色：检查模型文件…')`，再调用 `ensureModelFiles(spec, modelsDir, { signal: ctx.signal, onProgress: p => ctx.setMessage(`下载模型 ${p.file}（${p.source}）${mb(p.received)}/${mb(p.total)} MB`) })`。下载阶段 total 保持 null，前端显示为不确定进度。
6. 启动引擎：`ctx.setMessage(t.device === 'dml' ? '识别角色：加载模型到显卡（首次约 30–90 秒）…' : '识别角色：加载模型…')`。用 `ResilientTagger` 包一层 `acquireTagger`。实际 batch 用 `client.batchSize`（可能被截小了）。拿到 client 后 `deps.log(`tagger 子进程 pid=${client.info.pid} device=${client.device}`)`（验收 11 要用这个 pid；回退到 CPU 换了 client 时再打一次）。
7. `ctx.setTotal(total)`。主循环**保持 3 批在途**：
```ts
const th = { general: t.generalThreshold, character: Math.min(t.characterThreshold, t.autoAcceptThreshold) };
let beforeId = Number.MAX_SAFE_INTEGER; let yielded = false;
const next = () => { const rows = selBatch.all({ model: spec.repo, beforeId, limit: B }) as Row[]; if (rows.length) beforeId = rows[rows.length - 1]!.id; return rows; };
const queue: { rows: Row[]; p: Promise<HostItemResult[]> }[] = [];
const fill = () => { while (queue.length < 3 && !ctx.signal.aborted) {
  if (ctx.shouldYield()) { yielded = true; break; }        // 扫描在排队：不再发新批
  const rows = next(); if (!rows.length) break;
  const p = tagger.tag(rows.map((r) => ({ id: r.id, path: toAbs(r.rootPath, r.relPath) })), th);
  p.catch(() => undefined);   // 必须加！否则排队中的 promise 被 reject 会触发 unhandledRejection，把整个服务进程搞崩
  queue.push({ rows, p }); } };
fill();
while (queue.length) {
  const { rows, p } = queue.shift()!;
  const results = await p;          // 这里会原样抛出错误，任务 failed
  fill();                           // 先把下一批发出去，再写库
  writer.writeBatch(results);
  done += rows.length;
  ctx.advance(rows.length, `${done} / ${total} · ${deviceLabel} · ${rate.toFixed(1)} 张/秒 · 剩余约 ${eta}`);
  if (performance.now() - lastEmit > 5000) { deps.bus.emit({ type: 'library-changed', reason: 'tag' }); lastEmit = performance.now(); }
}
if (yielded && !ctx.signal.aborted) { ctx.requeue(); return `识别角色：已让出给扫描（本次处理 ${done} 张）`; }
return `识别角色：完成 ${done} 张 · 新建角色 ${writer.stats.createdCharacters} · 建议 ${writer.stats.suggestions} · 失败 ${writer.stats.failed}`;
```
补充说明：
- `deviceLabel` 是 `GPU·DirectML#<id>` 或 `CPU`。有 `fallbackReason` 时，第一条消息写成：`DirectML 不可用，已改用 CPU（较慢，可在设置里换 SwinV2 模型）`。
- 取消：`ctx.signal.aborted` 之后就不再发新批，只把在途的写完（最多 3 批），然后 return，JobQueue 会标记成 cancelled。已写的结果都保留，下次从剩下的继续。
- `ResilientTagger.tag()`：捕获 `TaggerCrashedError`。如果当前是 dml 而且还没回退过，就用 `acquireTagger({...opts, device:'cpu'})` 换一个 client 再重试**一次**。多个在途请求同时失败时，靠「代数」计数器保证只切换一次。CPU 也崩了就抛错，任务 failed。
- `finally` 里调用 `releaseTagger()`（空闲 60 秒后关掉子进程、释放显存），再用 `deps.log` 打印 `writer.stats`。

#### T10.7 接线
在 `SqliteDataSource.open` 里：
```ts
pipeline.register({ tag: createTagStage({
  db, bus, modelsDir: config.modelsDir,
  getTaggerSettings: () => readSettings(db).tagger,
  // afterBatchInTx: T17 完成后接 (ids) => applyExclusionRules(ctx, { imageIds: ids })
  log: (m) => console.info(`[tag] ${m}`),
}) });
```
服务关闭（`close()`）时 `await shutdownTagger()`。

#### T10.8 测试（不需要模型、不需要 GPU）
测试环境：内存数据库，用 T01 的 `openDatabase(':memory:')` + `migrate(db)` 建表，插入 1 个 library_root 和几张 images。

**writer.test.ts**：用一个注入 `{ 'mika_(blue_archive)': ['blue_archive'], 'hina_(blue_archive)': ['blue_archive'] }` 的 `CopyrightResolver`。
- img1：`character = [['mika_(blue_archive)', 0.95], ['hina_(blue_archive)', 0.5]]`，`general = [['1girl', 0.99]]`，rating 取 sensitive（阈值 0.35/0.35/0.85）。期望：
  - characters 新增一行（name='Mika'，source='danbooru'）。
  - works 新增 `blue_archive`（name='Blue Archive'）。
  - character_works 的 position=0。
  - image_characters 是 (img1, mika, 'tagger', 0.95)。
  - character_suggestions 是 (img1, 'hina_(blue_archive)', 0.5)。
  - image_copyrights 是 (img1, blue_archive 的 work id, 0.5)。
  - rating='sensitive'，tagged_at 不为空，tagger_model=repo。
  - aliases 里没有与角色名 search_key 相同的行（占位的 `HumanizeLocalizer` 下，`mika_(blue_archive)` 和 `Mika` 的 key 都是 `mika`，所以这个角色 0 条别名）；另用一个 `aliasesFor` 返回 `[{ alias: '未花', origin: 'dict', visible: true }]` 的假 Localizer 再建一个角色，断言 aliases 里有这一行且 origin='dict'、visible=1、position=100。
- img2：预先设 `rating_manual=1, rating='explicit'` → 写入后 rating 不变。
- img3：预先手动关联 hina → 不产生 hina 的建议。
- 错误结果：`DECODE` → tagged_at 被写上；`ENOENT` → tagged_at 仍为 NULL。
- 同一批再写一遍，所有表的行数不变（幂等）。
- 提升：先插一条 0.88 的建议，用 autoAccept=0.85 调 `promoteSuggestions()` → 返回 1，建议被删掉，image_characters 多一行。

**tagJob.test.ts**：注入 `clientFactory` 返回假 client（`batchSize:2`，按 id 返回固定结果），`ensureFiles` 返回假路径，ctx 用 `{ signal, setTotal: vi.fn(), advance: vi.fn(), setMessage: vi.fn(), shouldYield: () => false, requeue: vi.fn(), yielded: false }`。
- 5 张图跑完：候选数变成 0，advance 的总和是 5。
- 再跑一次：返回「没有需要识别的图片」，不会调 clientFactory。
- 第一次 advance 之后 abort：剩余图片仍是 `tagged_at IS NULL`，runner 正常 resolve。
- 第一次 advance 之后 `shouldYield` 改成返回 true：runner 调用了 `requeue`，返回值含「已让出」。
- 假 client 第一次抛 `TaggerCrashedError` 且 device='dml' → factory 被第二次调用，参数是 `device:'cpu'`，最终全部写完。

**catalog.test.ts**：
- 插一条 `danbooru_tag_redirects('mika_(blue_archive)' → 另一个角色 id)` → `resolveCharacterId` 返回那个 id，`ensureCharacter` 不新建。
- `ensureCharacter` 新建时返回的 `createdWorkIds` 包含新建的作品 id；作品已存在时为空。

**humanize.test.ts**：本节 `humanizeCharacterTag` / `humanizeCopyrightTag` 注释里的每个例子。

### 与其他任务的约定
- **T05**：`updateImage` 改 rating 时必须同时写 `rating_manual=1`。
- **T11**：`danbooru_tags.copyrights`（JSON 数组，第一个是主作品）优先级高于离线表。T11 通过 `makeCatalog` 注入完整回退链和 `normalizeTag`，同步完之后调用 `catalog.backfillWorks()` / `relinkWorks()` 补挂作品。
- **T14**：合并 A→B 时写 `danbooru_tag_redirects(A.danbooru_tag → B)`，否则下次打标签会把 A 重新建出来。T14 新建 danbooru 角色也用 `ensureCharacter`。
- **T15**：`acceptSuggestion` 用 `catalog.ensureCharacter(tag, imageId, now)` + `INSERT … origin='manual'`，再删掉那条建议。`listUnrecognized` 用 `catalog.describeTag(tag)` 拼 `CharacterSuggestion`。
- **T17**：提供 `applyExclusionRules(ctx, { imageIds })`，通过 `afterBatchInTx` 接进来。
- **T20**：tag 任务结束后由 Pipeline 的 `afterTag` 调用 `refreshTagCounts`。

### 坑
1. **3 批在途时，每个 promise 都要立刻 `.catch(() => undefined)`。** 否则后面的批次先失败会触发 unhandledRejection，把整个 Fastify 进程带崩。
2. **better-sqlite3 的 `db.transaction(fn)` 里不能有 await。** catalog 和 resolver 必须全是同步调用；设置用同步的 `readSettings`。
3. **命名参数对象只放 SQL 里用到的 key。** `COUNT` 只传 `{ model }`，`BATCH` 传 `{ model, beforeId, limit }`。
4. **tag 名保留下划线原样**（`long_hair`），和 Danbooru、`characters.danbooru_tag` 保持一致；显示时由前端决定要不要换成空格。
5. **库里的数字转成 API 字符串 id 是 T05/T13 的事**，这里一律用 number。
6. **`library-changed` 要限流。** 前端收到后会让所有 query 失效，每批都发会把前端刷爆。
7. **数据量**：10 万张 × 平均约 35 个标签 ≈ 350 万行 image_tags，所以 general 每张最多 80 个。
8. **重打标签不会删除用户移除过的 tagger 角色**：因为只增不删，被用户移除的角色可能在换模型重跑时回来。默认范围只重跑「未识别」的图，基本规避了这个问题。没有做拒绝表，已知的小限制。
9. 所有 SQL 都在构造函数里 `db.prepare` 一次，别在循环里 prepare。`searchKey` 从 `@emaki/shared` 引入。

### 验收标准
1. **离线表**：执行 `npx tsx apps/server/scripts/build-character-ips.ts`，生成 `apps/server/assets/character-ips.json`。然后执行 `node -e "const j=require('./apps/server/assets/character-ips.json');console.log(Object.keys(j.characters).length, j.characters['mika_(blue_archive)'], j.characters['matou_sakura'][0])"`，应输出 `3709 [ 'blue_archive' ] fate_(series)`。
2. **单元测试**：`npx vitest run apps/server/src/services/tagger apps/server/src/services/catalog apps/server/src/services/i18n` 全部通过；`npm run typecheck` 通过。
3. **端到端**（前提：T01–T07 已完成，模型已下载）：
   ```powershell
   $env:EMAKI_DATA_SOURCE='sqlite'; $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev'; $env:EMAKI_MODELS_DIR='F:/Claude/emaki/data/models'; npm run dev
   ```
   在设置里加一个装有约 50 张插画的文件夹（用户提供的本地插画目录；还没有时先用 `data/fixtures-lib` 验证流程，下面关于角色名的检查跳过），等扫描完成。然后：
   ```powershell
   Invoke-RestMethod -Method Post http://127.0.0.1:5174/api/jobs -ContentType 'application/json' -Body '{"kind":"tag"}'
   curl.exe -N http://127.0.0.1:5174/api/events     # 能看到 job 事件，消息形如 12 / 50 · GPU·DirectML#0 · 6.3 张/秒 · 剩余约 6 秒，最后 status=done
   ```
4. **运行期间 HTTP 不卡**：`1..20 | % { (Measure-Command { curl.exe -s http://127.0.0.1:5174/api/health }).TotalMilliseconds }`，每次都应小于 100 ms。
5. **结束后的数据库检查**（`$env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev'`，用 `npx tsx apps/server/scripts/db-query.ts "<SQL>"` 逐条执行）：
   - `SELECT COUNT(*) n FROM v_counted_images WHERE tagged_at IS NULL` → 0
   - `SELECT COUNT(*) n FROM image_characters WHERE origin='tagger' AND score < 0.85` → 0（0.85 = 当前 autoAccept）
   - `SELECT COUNT(*) n FROM character_suggestions cs JOIN characters c ON c.danbooru_tag=cs.danbooru_tag JOIN image_characters ic ON ic.image_id=cs.image_id AND ic.character_id=c.id` → 0
   - `SELECT COUNT(*) n FROM characters c WHERE c.source='danbooru' AND NOT EXISTS (SELECT 1 FROM character_works w WHERE w.character_id=c.id)` → 大约只占新建角色的 2%
   - `SELECT c.name, w.name AS work FROM characters c JOIN character_works cw ON cw.character_id=c.id AND cw.position=0 JOIN works w ON w.id=cw.work_id ORDER BY random() LIMIT 3` → 名字和作品名都可读（例如 `Mika / Blue Archive`）
6. **重复运行**：再 POST 一次 tag，任务在 1 秒内完成，消息是「没有需要识别的图片」。
7. **取消**：换成约 500 张的文件夹，运行中执行 `Invoke-RestMethod -Method Delete http://127.0.0.1:5174/api/jobs/<id>`。约 3 批之内状态变成 cancelled。再运行一次，只处理剩下的图。
8. **让出**：tag 运行中 `POST /api/jobs {"kind":"scan"}` → tag 在 3 批之内结束（消息含「已让出」），scan 完成后 tag 自动重新排队并继续。
9. **阈值提升**：`Invoke-RestMethod -Method Put http://127.0.0.1:5174/api/settings -ContentType 'application/json' -Body '{"tagger":{"autoAcceptThreshold":0.6}}'`，再运行 tag。消息是「已按新阈值采纳 N 条建议」，`character_suggestions` 里不再有分数 ≥0.6 的行。改回 0.85。
10. **手动分级保留**：对某张图 PATCH rating（T05 会把 `rating_manual` 设为 1），然后 `db-query.ts "UPDATE images SET tagged_at=NULL WHERE id=<id>"` 并重跑，该图 rating 不变。
11. **崩溃转 CPU**：运行中在任务管理器里结束 tagger 子进程（它的 pid 在任务开始的日志里）。任务不失败，后续消息的设备变成 `CPU`，最终 done。

### 难度
L（如果 T11、T12、T17 的钩子暂时传空，就是 M）

### 给实现模型的提示
- 先写 color / humanize / localizer / aliases / copyrights / catalog，配上 catalog.test 和 humanize.test；再写 writer 和 writer.test；最后写 tagJob 和 tagJob.test。这几步都不需要模型和 GPU。端到端验收放到最后。
- 不要改 `JobQueue`、`packages/shared`，也不要改 schema.sql。这个任务不需要新的迁移（用到的列和表在 002 里已经有了）。
- 遇到「这个角色该不该建、该不该建议」拿不准时，以上面的「规则」表为准。

## T11 Danbooru 元数据同步（API 客户端、限速、角色→作品 copyright 映射、别名/other_names）

### 目标
实现后台任务 `danbooru-sync`：把库里出现的角色 / 作品标签拿到 Danbooru 查元数据，缓存进 `danbooru_tags`（离线也能用），再落到 `works`、`character_works`、`aliases`、角色显示名上：
- 标签是否存在、分类、post_count、是否已改名（alias → 新名）、implication（服装变体 → 本体、子作品 → 系列）；
- wiki `other_names`（日文名 / 中文名 / 韩文名…，给 T12 取中文名、做搜索别名）；
- 角色所属作品（copyright）。**WD14 v3 只输出 general / character / rating，不输出 copyright**，在线的作品推断在这里做；
- 离线 / 被 Cloudflare 拦截时降级为本地推断（T10 离线表 + T12 词库），任何时候都不阻塞启动和 UI；
- 顺带提供「自建角色能对上 Danbooru」匹配器（T13 getStats、T14 用）；
- 给 T10 的 `CharacterCatalog` 提供完整的作品回退链和 `normalizeTag`（见「全局约定 → 标签 → 角色 / 作品的统一规则」）。

### 依赖
- T01、T02（`readSettings`、`getDanbooruApiKey`、`patchSettingsInternal`）、T07（Pipeline）、T09（`net/http.ts`）、T10（`CharacterCatalog`、`CopyrightResolver`、`Localizer`、`replaceAutoAliases`）。
- T12 的 `SqliteLocalizer`（真实中文名）。建议顺序：T11 步骤 1–8 → T12 → T11 步骤 9–12。T12 还没做时用 T10 的 `HumanizeLocalizer`。

### 涉及文件
新增：
- `apps/server/src/db/migrations/004_danbooru_i18n.sql`
- `apps/server/src/services/danbooru/{types,rateLimiter,client,copyright,catalog,sync,apply,matcher}.ts`
- `apps/server/src/services/danbooru/__tests__/*.test.ts` 与 `__tests__/fixtures/*.json`
- `apps/server/scripts/danbooru-probe.ts`

修改：`apps/server/src/config.ts`、`apps/server/src/net/http.ts`（加测试用的 `FetchLike` 类型）、`services/catalog/characterCatalog.ts`（加 `relinkWorks`）、`SqliteDataSource.ts`（open 里组装、给 tag 阶段注入 `makeCatalog`、注册 danbooru 阶段）、`packages/shared/src/domain.ts`（**只改注释**：API key「可提高速率限制」→「可选，用于标识身份」，因为官方文档写明读接口限速与账号无关）。

### 实现步骤

**1. 依赖**
不需要新依赖：`undici` 已由 T09 安装，`zod@4.6.5` 仓库里已有。（`opencc-js` 在 T12 安装。）

**2. 迁移** `apps/server/src/db/migrations/004_danbooru_i18n.sql`（T12 用到的表也在这里一起建；别名的 origin/visible/position 和 name_locked/works_locked 已在 002 里）：
```sql
-- T11/T12：Danbooru 缓存扩展 + 中文词库 + 自建角色匹配
ALTER TABLE danbooru_tags ADD COLUMN alias_of           TEXT;     -- 已被 Danbooru alias 到的新标签名
ALTER TABLE danbooru_tags ADD COLUMN implies            TEXT;     -- JSON string[]：直接 implication 的 consequent
ALTER TABLE danbooru_tags ADD COLUMN is_deprecated      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE danbooru_tags ADD COLUMN not_found          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE danbooru_tags ADD COLUMN wiki_fetched_at    TEXT;
ALTER TABLE danbooru_tags ADD COLUMN related_fetched_at TEXT;

CREATE TABLE tag_i18n (             -- T12 导入的中文词库
  tag             TEXT PRIMARY KEY,
  category        INTEGER NOT NULL,   -- 0 general / 3 copyright / 4 character
  zh              TEXT,
  aliases         TEXT NOT NULL DEFAULT '[]',
  copyright_guess TEXT,
  post_count      INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE tag_name_keys (        -- 反查：searchKey(名字) → 标签
  search_key TEXT NOT NULL,
  tag        TEXT NOT NULL,
  kind       TEXT NOT NULL,           -- zh | alias | other_name | tag
  source     TEXT NOT NULL,           -- dict | danbooru
  PRIMARY KEY (search_key, tag, kind)
) WITHOUT ROWID;
CREATE INDEX idx_tag_name_keys_tag ON tag_name_keys(tag);

CREATE TABLE tag_renames (          -- 旧标签名 → 新标签名（WD14 训练时的名字可能已被 Danbooru 改名）
  old_name TEXT PRIMARY KEY,
  new_name TEXT NOT NULL,
  source   TEXT NOT NULL            -- danbooru（优先，INSERT OR REPLACE）| dict（INSERT OR IGNORE）
) WITHOUT ROWID;

CREATE TABLE custom_character_matches (
  character_id          INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  danbooru_tag          TEXT    NOT NULL,
  score                 REAL    NOT NULL,
  reason                TEXT    NOT NULL,   -- 例：'zh:圣园未花 + work:blue_archive'
  existing_character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  dismissed             INTEGER NOT NULL DEFAULT 0,
  computed_at           TEXT    NOT NULL
);
```
约定：not_found 的行 `category = -1`；`implies` / `copyrights` / `other_names` 都是 JSON 字符串数组；`copyrights` 第一个是主作品。

**3. 配置** `config.ts` 增加：
```ts
/** 开发时可指向 https://testbooru.donmai.us；离线测试可指向 http://127.0.0.1:9 */
danbooruBaseUrl: process.env.EMAKI_DANBOORU_URL ?? 'https://danbooru.donmai.us',
appVersion: '0.1.0',
/** User-Agent 里的项目地址；上传 GitHub 后填真实地址 */
appRepoUrl: 'https://github.com/<owner>/emaki',
```
（`httpProxy` 已由 T09 加，`assetsDir` 已由 T10 加。）

**4. `net/http.ts` 增加测试注入用的类型**（不要再建第二份 http 封装）：
```ts
/** 测试里可注入的最小 fetch 形状（避免 undici Response 与全局 Response 类型不兼容） */
export interface HttpResponse { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<HttpResponse>;
export const defaultFetchLike: FetchLike = (url, init) => httpFetch(url, init);
```

**5. 响应类型** `services/danbooru/types.ts`（zod 4；`z.object` 默认丢弃未知字段，正合适）：
```ts
import { z } from 'zod';
export const DanbooruCategory = { general: 0, artist: 1, copyright: 3, character: 4, meta: 5 } as const;
export const TAG_ONLY = 'name,category,post_count,is_deprecated,antecedent_alias[consequent_name,status],antecedent_implications[consequent_name],consequent_aliases[antecedent_name]';
export const TagSchema = z.object({
  name: z.string(), category: z.number().int(), post_count: z.number().int(),
  is_deprecated: z.boolean().default(false),
  /** 这个标签本身已被 alias 到别的标签（旧名）时才有；没有时字段不出现 */
  antecedent_alias: z.object({ consequent_name: z.string(), status: z.string() }).nullish(),
  antecedent_implications: z.array(z.object({ consequent_name: z.string() })).default([]),
  consequent_aliases: z.array(z.object({ antecedent_name: z.string() })).default([]),
});
export const AliasSchema = z.object({ antecedent_name: z.string(), consequent_name: z.string() });
export const WikiSchema = z.object({ title: z.string(), other_names: z.array(z.string()).default([]), is_deleted: z.boolean().default(false) });
const MiniTag = z.object({ name: z.string(), category: z.number().int(), post_count: z.number().int() });
export const RelatedSchema = z.object({
  query: z.string(), post_count: z.number(), tag: MiniTag.nullable(),
  related_tags: z.array(z.object({ tag: MiniTag, frequency: z.number() })),
});
export const AutocompleteSchema = z.object({
  type: z.string(), label: z.string().optional(), value: z.string(),
  category: z.number().int().optional(), post_count: z.number().int().optional(), antecedent: z.string().nullish(),
});
export type DbTag = z.infer<typeof TagSchema>;
export type DbAlias = z.infer<typeof AliasSchema>;
export type DbWiki = z.infer<typeof WikiSchema>;
export type DbRelated = z.infer<typeof RelatedSchema>;
export type DbAutocomplete = z.infer<typeof AutocompleteSchema>;
```

**6. 限速器 + 客户端** `rateLimiter.ts`、`client.ts`。以下行为全部于 2026-09-27 实测：

| 用途 | 请求（只用 GET；`POST + _method=get` 实测返回 500，不要用） |
|---|---|
| 批量标签元数据 | `/tags.json?search[name_comma]=a,b,c&limit=<批大小>&only=${TAG_ONLY}` |
| 旧名 → 新名 | `/tag_aliases.json?search[antecedent_name_comma]=a,b&search[status]=active&limit=<n>&only=antecedent_name,consequent_name` |
| wiki 其他名字 | `/wiki_pages.json?search[title_comma]=a,b&limit=<n>&only=title,other_names,is_deleted` |
| 角色 → copyright | `/related_tag.json?query=<tag>&category=copyright&limit=10` |
| 名字 → 标签（自建匹配） | `/autocomplete.json?search[query]=<名字>&search[type]=tag_query&limit=10` |

- 批大小 100（URL 约 2.2 KB；实测 200 也行）。**必须传 `limit=批大小`**：不传默认只回 20 条（实测 100 个名字只回 20，且不报错）。
- 名字里含逗号的标签不能放进 `*_comma`，单独用 `search[name]=` / `search[title]=` 查。
- 参数一律用 `URLSearchParams` 编码（标签含 `'` `/` `:` `(`，例如 `jeanne_d'arc_alter_(fate)`、`honkai:_star_rail`）。
- User-Agent：`Emaki/${config.appVersion} (+${config.appRepoUrl})`，填了用户名时追加 `; user <username>`。**实测 UA=`node`（Node 内置 fetch 的默认值）和 `Mozilla/5.0` 都会拿到 403 + 响应头 `Cf-Mitigated: challenge` + HTML「Just a moment...」**，自定义 UA 则 200。官方 help:api 也要求「不要伪装浏览器、不要用库的默认 UA」。
- 认证可选：`Authorization: Basic base64(login:api_key)`。**不要**把 `api_key` 放进 URL（会进日志和错误信息）。读接口有全局限速：突发 10 req/s、与账号无关，持续使用建议约 1 req/s；读响应里没有 `x-rate-limit` 头（实测），不用解析。
- 限速：串行，相邻两次请求的开始时间 ≥ 1000 ms。
- 超时 20 s：`AbortSignal.any([signal, AbortSignal.timeout(20_000)])`。
- 重试：网络错误、429、5xx 最多重试 3 次，退避 2 s / 4 s / 8 s（有 `Retry-After` 就用它）；403 且（`cf-mitigated: challenge` 或正文含 `Just a moment`）→ 立刻抛 `blocked`，**不重试**；401 → `auth`；其他非 200 → `http`；JSON 解析或 zod 校验失败 → `parse`。先 `text()` 再 `JSON.parse`，不要直接 `res.json()`（挑战页是 HTML）。
```ts
// rateLimiter.ts
import { setTimeout as sleep } from 'node:timers/promises';
export class RateLimiter {
  private nextAt = 0;
  constructor(private readonly minIntervalMs = 1000, private readonly now = () => Date.now()) {}
  async wait(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.minIntervalMs;
    if (at > now) await sleep(at - now, undefined, { signal });
  }
}

// client.ts（核心）
export type DanbooruErrorKind = 'network' | 'blocked' | 'auth' | 'http' | 'parse';
export class DanbooruError extends Error {
  constructor(message: string, readonly kind: DanbooruErrorKind, readonly status?: number) { super(message); }
}
export interface DanbooruClientOptions {
  baseUrl?: string; login?: string; apiKey?: string;
  fetchImpl?: FetchLike; limiter?: RateLimiter; timeoutMs?: number; maxRetries?: number;
}
export class DanbooruClient {
  // constructor：baseUrl 默认 config.danbooruBaseUrl；fetchImpl 默认 defaultFetchLike；
  // headers = { 'User-Agent': ..., Accept: 'application/json', Authorization?: 'Basic ...' }
  async request<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      await this.limiter.wait(signal);
      let res: HttpResponse;
      try {
        res = await this.fetchImpl(url.href, { headers: this.headers, signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) });
      } catch (err) {
        if (signal.aborted) throw err;
        if (attempt < this.maxRetries) { await sleep(2000 * 2 ** attempt, undefined, { signal }); continue; }
        throw new DanbooruError('网络不可用，连不上 Danbooru（已改用本地词库）', 'network');
      }
      const body = await res.text();
      if (res.status === 403 && (res.headers.get('cf-mitigated') === 'challenge' || body.includes('Just a moment')))
        throw new DanbooruError('被 Cloudflare 拦截：检查代理 / 换个网络 / 稍后再试', 'blocked', 403);
      if (res.status === 401) throw new DanbooruError('Danbooru 用户名或 API Key 无效', 'auth', 401);
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(ra > 0 ? ra * 1000 : 2000 * 2 ** attempt, undefined, { signal });
        continue;
      }
      if (res.status !== 200) throw new DanbooruError(`Danbooru 返回 HTTP ${res.status}`, 'http', res.status);
      let json: unknown;
      try { json = JSON.parse(body); } catch { throw new DanbooruError('Danbooru 返回的不是 JSON', 'parse'); }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new DanbooruError(`Danbooru 响应格式变了：${parsed.error.message}`, 'parse');
      return parsed.data;
    }
  }
  tagsByNames(names: string[], signal: AbortSignal): Promise<DbTag[]>;             // 分批 100，limit=批大小
  aliasesByAntecedents(names: string[], signal: AbortSignal): Promise<DbAlias[]>;
  wikiByTitles(titles: string[], signal: AbortSignal): Promise<DbWiki[]>;
  relatedCopyrights(tag: string, signal: AbortSignal): Promise<DbRelated>;
  autocomplete(query: string, signal: AbortSignal): Promise<DbAutocomplete[]>;
}
```

**7. 作品选择（纯函数，重点单测）** `copyright.ts`。related_tag 的 copyright 候选有噪音：`mika_(blue_archive)` 的候选里有 `comiket_106`（展会也是 category 3，frequency 0.0026）、`blue_archive_the_animation`（0.0048）；多作品角色如 `artoria_pendragon_(fate)`：fate_(series) 0.999 / fate/grand_order 0.566 / fate/stay_night 0.366。规则：
1. 只留 `category === 3 && frequency >= 0.3`，按 frequency 降序、post_count 降序；
2. 与最高分相差 ≤ 0.02 的算「并列」；并列里去掉「被其他并列候选 implies 的」（那是上层系列），剩下的第一个为**主作品**（更具体：kafka → 崩坏：星穹铁道，而不是 崩坏系列）；
3. 其余 frequency ≥ 0.5 的候选作为次作品，但**跳过 implies 主作品的**（那是动画版等子作品）；总数最多 3。
`implies` 用缓存里的 implication 做传递闭包（最多 5 层）。
```ts
export interface CopyrightCandidate { name: string; frequency: number; postCount: number; implies: string[] /* 传递闭包 */ }
export function pickCopyrights(cands: CopyrightCandidate[], o = { minFrequency: 0.3, secondaryMin: 0.5, tieEpsilon: 0.02, max: 3 }): string[] {
  const c = cands.filter((x) => x.frequency >= o.minFrequency)
    .sort((a, b) => b.frequency - a.frequency || b.postCount - a.postCount);
  const top = c[0];
  if (!top) return [];
  const tied = c.filter((x) => top.frequency - x.frequency <= o.tieEpsilon);
  const tiedNames = new Set(tied.map((x) => x.name));
  const umbrellas = new Set(tied.flatMap((x) => x.implies.filter((n) => tiedNames.has(n))));
  const primary = tied.find((x) => !umbrellas.has(x.name)) ?? top;
  const out = [primary.name];
  for (const x of c) {
    if (out.length >= o.max) break;
    if (x.name === primary.name || x.frequency < o.secondaryMin) continue;
    if (x.implies.includes(primary.name)) continue;
    out.push(x.name);
  }
  return out;
}
/** 离线兜底：mika_(blue_archive) → 限定词 blue_archive → 查 copyright */
export function guessCopyrightFromQualifier(tag: string, lookup: (qualifier: string) => string | null): string | null {
  const m = /_\(([^()]+)\)$/.exec(tag);
  return m ? lookup(m[1]!) : null;
}
```
单测夹具用下列实测数据（存 `__tests__/fixtures/related-copyrights.json`，每项含 name / frequency / post_count / implies），期望：
- mika_(blue_archive)（blue_archive 0.9998, 458840；blue_archive_the_animation 0.0048；comiket_106 0.0026）→ `['blue_archive']`
- artoria_pendragon_(fate)（fate_(series) 0.9992；fate/grand_order 0.5658 implies fate_(series)；fate/stay_night 0.3664 implies fate_(series)）→ `['fate_(series)']`
- jeanne_d'arc_alter_(fate)（fate_(series) 1；fate/grand_order 0.992 implies fate_(series)）→ `['fate/grand_order','fate_(series)']`（两者并列，fate_(series) 被 implies 成为「上层系列」，所以更具体的 fate/grand_order 是主作品）
- kafka_(honkai:_star_rail)（honkai_(series) 1, 191132；honkai:_star_rail 1, 135426 implies honkai_(series)）→ `['honkai:_star_rail','honkai_(series)']`
- gawr_gura（hololive 1；hololive_english 1 implies hololive）→ `['hololive_english','hololive']`
- kaname_madoka（mahou_shoujo_madoka_magica 1；mahou_shoujo_madoka_magica_(anime) 0.823 implies 前者）→ `['mahou_shoujo_madoka_magica']`
- 2b_(nier:automata)（nier_(series) 0.9966；nier:automata 0.9952 implies nier_(series)）→ `['nier:automata','nier_(series)']`
- pikachu（pokemon 1；pokemon_(anime) 0.218）→ `['pokemon']`；空数组 → `[]`

**8. 本地缓存 `catalog.ts`**（全部同步方法，better-sqlite3 prepared statements）：
```ts
export interface CachedTag { name: string; category: number; postCount: number; copyrights: string[] | null; otherNames: string[]; aliasOf: string | null; implies: string[]; notFound: boolean; fetchedAt: string; wikiFetchedAt: string | null; relatedFetchedAt: string | null }
export class DanbooruCatalog implements CopyrightSource {
  constructor(private readonly db: Database.Database, private readonly offline: CopyrightResolver /* T10，提供 character-ips.json */) {}
  get(name: string): CachedTag | null;
  needsMeta(name: string, staleBefore: string): boolean;          // 没有行 / fetched_at 过期
  upsertBase(t: DbTag, now: string): void;
  markAlias(oldName: string, newName: string, now: string): void;  // 同时 INSERT OR REPLACE INTO tag_renames(old,new,'danbooru')
  markNotFound(name: string, now: string): void;
  setOtherNames(name: string, names: string[], now: string): void; // 同时刷新 tag_name_keys(kind='other_name', source='danbooru')
  setCopyrights(name: string, list: string[], now: string): void;  // 同时写 related_fetched_at
  canonicalize(tag: string): string;        // 顺着 tag_renames 最多 3 跳
  impliesClosure(tag: string): string[];    // implies 传递闭包，最多 5 层
  baseCharacter(tag: string): string;       // 服装变体 → 本体
  /** 给 T10 CharacterCatalog 的 normalizeTag：baseCharacter(canonicalize(tag)) */
  normalizeTag(tag: string): string;
  /** 完整回退链（CopyrightSource）：在线 > 离线表 > 词库猜测 > 限定词猜测 > [] */
  copyrights(characterTag: string): string[];
}
```
关键 SQL：
```sql
-- upsertBase（不碰 copyrights / other_names）
INSERT INTO danbooru_tags (name, category, post_count, fetched_at, implies, is_deprecated, not_found, alias_of)
VALUES (@name, @category, @post_count, @now, @implies, @is_deprecated, 0, NULL)
ON CONFLICT(name) DO UPDATE SET category = excluded.category, post_count = excluded.post_count,
  fetched_at = excluded.fetched_at, implies = excluded.implies, is_deprecated = excluded.is_deprecated,
  not_found = 0, alias_of = NULL;
-- markAlias
INSERT INTO danbooru_tags (name, category, fetched_at, alias_of) VALUES (?, -1, ?, ?)
ON CONFLICT(name) DO UPDATE SET alias_of = excluded.alias_of, fetched_at = excluded.fetched_at, not_found = 0;
-- markNotFound
INSERT INTO danbooru_tags (name, category, fetched_at, not_found) VALUES (?, -1, ?, 1)
ON CONFLICT(name) DO UPDATE SET not_found = 1, fetched_at = excluded.fetched_at;
-- canonicalize 单步
SELECT new_name FROM tag_renames WHERE old_name = ?;
```
`copyrights(tag)`：`t = canonicalize(tag)`；
1. `related_fetched_at` 非空且 copyrights 非空 → 用它；
2. 否则 `offline.offline[t]`（T10 的 character-ips.json）非空 → 用它；
3. 否则 `SELECT copyright_guess FROM tag_i18n WHERE tag = ?` 非空 → `[guess]`；
4. 否则 `guessCopyrightFromQualifier(t, lookup)`，lookup 依次：`SELECT tag FROM tag_i18n WHERE tag = ? AND category = 3` → `SELECT k.tag FROM tag_name_keys k JOIN tag_i18n i ON i.tag = k.tag AND i.category = 3 WHERE k.search_key = ? ORDER BY i.post_count DESC LIMIT 1`（参数 `searchKey(qualifier)`，这样 `saber_(fate)` 的 `fate` 能对上 `fate_(series)`）→ `SELECT name FROM danbooru_tags WHERE name = ? AND category = 3`；
5. 都没有 → `[]`。

`baseCharacter(tag)`：先看 impliesClosure 里 category=4 的标签（在线数据，实测 `mika_(swimsuit)_(blue_archive)` implies `mika_(blue_archive)`）；没有则用正则 `^(.+)_\([^()]+\)_\(([^()]+)\)$` 得到 `$1_($2)`，且它在 tag_i18n、danbooru_tags（category=4）或离线表的 key 里存在时才采用；否则返回原 tag。

`Localizer` 接口、`HumanizeLocalizer`、`replaceAutoAliases` 都已由 T10 建好，本任务直接用，**不要改签名**。

**9. 同步任务** `sync.ts`：
```ts
export interface DanbooruSyncDeps {
  db: Database.Database; danbooru: DanbooruCatalog; getCatalog(): CharacterCatalog; localizer: Localizer;
  getDanbooru(): { enabled: boolean; username: string; apiKey: string | null }; // = { ...readSettings(db).danbooru, apiKey: getDanbooruApiKey(db) }
  setLastSyncAt(iso: string): void;                                           // = patchSettingsInternal(db, 'danbooru', { lastSyncAt })
  fetchImpl?: FetchLike; limiter?: RateLimiter;                               // 测试注入
}
export function createDanbooruSyncRunner(deps: DanbooruSyncDeps): JobRunner;
```
流程（**每次网络请求结束后才开同步事务写库**——`db.transaction(fn)` 里不能 await）。常量：`BATCH=100, MIN_FREQ=0.3, TTL_DAYS=30, NOT_FOUND_TTL_DAYS=7, MAX_RELATED_PER_RUN=1500, ONLINE_MATCH_PER_RUN=50`。

0. `enabled=false` → `ctx.setMessage('联网同步已关闭，只用本地词库整理')`，执行 E 后 return（**零网络请求**）。每次运行都从 `getDanbooru()` 读最新设置并新建 DanbooruClient（改 API key 后不用重启）。

A. 收集需要查的标签：
```sql
WITH wanted(name) AS (
  SELECT danbooru_tag FROM characters WHERE danbooru_tag IS NOT NULL
  UNION SELECT danbooru_tag FROM works WHERE danbooru_tag IS NOT NULL
  UNION SELECT danbooru_tag FROM character_suggestions
  UNION SELECT name FROM tags WHERE category IN ('character', 'copyright')
)
SELECT w.name FROM wanted w LEFT JOIN danbooru_tags d ON d.name = w.name
WHERE d.name IS NULL
   OR (d.not_found = 0 AND d.fetched_at < @staleBefore)
   OR (d.not_found = 1 AND d.fetched_at < @notFoundStaleBefore);
```
`fetchTagMeta(names, depth = 0)`：`tagsByNames` → 每批一个事务：
- **返回的行带 `antecedent_alias` 且 `status === 'active'`** → `markAlias(name, antecedent_alias.consequent_name)`，**不要** `upsertBase`（2026-09-27 实测：`tags.json?search[name_comma]=gojou_satoru` 会**返回**这个旧名，`post_count: 0`、`antecedent_alias: { consequent_name: 'gojo_satoru', status: 'active' }`；只靠「没返回的才查 alias」会把旧名当成一个 0 张的正常角色存下来，改名解析就永远不会发生）；
- 其余返回的行 → `upsertBase`；
- 完全没返回的 → `aliasesByAntecedents` → `markAlias`（兜底）；
- 上面两种 alias 的 consequent 若 `needsMeta` 则递归一次（depth ≤ 1）；仍没有的 → `markNotFound`。

**不要同步 general 标签**（8000+ 个，没意义）。

C. 角色 → 作品（按库里张数优先，每次最多 1500 个，首跑中断后下次接着跑）：
```sql
SELECT d.name FROM danbooru_tags d
LEFT JOIN characters c ON c.danbooru_tag = d.name
LEFT JOIN image_characters ic ON ic.character_id = c.id
WHERE d.category = 4 AND d.not_found = 0 AND d.alias_of IS NULL
  AND (d.related_fetched_at IS NULL OR d.related_fetched_at < @staleBefore)
GROUP BY d.name ORDER BY COUNT(ic.image_id) DESC, d.post_count DESC LIMIT 1500;
```
逐个 `relatedCopyrights(name)`：若返回的 `tag` 为 null → `setCopyrights(name, [])`；若 `tag.name !== name`（related_tag 会自动解析别名，实测 `gojou_satoru` 返回 `tag.name = gojo_satoru`）→ `markAlias(name, tag.name)`，结果写到新名上；取 `category === 3 && frequency >= 0.3` 的候选，不在缓存的先 `fetchTagMeta`（为了拿 implication），再 `pickCopyrights`（implies 用 `impliesClosure`）→ `setCopyrights`；每个角色前检查 `ctx.shouldYield()`（为 true 时 `ctx.requeue()` 并结束本次运行，已写的保留）；`ctx.advance(1, `查询所属作品 ${i}/${n}`)`。

B. wiki：对 category ∈ (3, 4)、`not_found = 0`、`alias_of IS NULL`、`wiki_fetched_at` 为空或过期的行，`wikiByTitles` 分批 → `setOtherNames`（没有 wiki 的写 `[]`，也记 wiki_fetched_at）。放在 C 之后，这样 C 里新发现的作品也能拿到其他名字。

D. 自建角色在线匹配（最多 50 个还没有本地匹配的自建角色）：对名字和前 2 个别名各调一次 `autocomplete`，保留 `category === 4 && searchKey(antecedent ?? value) === searchKey(查询词)` 的结果 → 对这些标签 `fetchTagMeta` + wiki，并 `INSERT OR IGNORE INTO tag_name_keys (search_key, tag, kind, source) VALUES (searchKey(查询词), tag, 'other_name', 'danbooru')`。实测查询「圣园未花」「聖園ミカ」都返回 `type: 'tag-other-name', value: 'mika_(blue_archive)', antecedent: <查询词>`。

E. `applyToLibrary(deps)`（步骤 10），然后 `deps.localizer.invalidate()`；A–D 全部成功才 `setLastSyncAt(now)`。

错误处理：`try { A–D } finally { if (!ctx.signal.aborted) E }`；DanbooruError 继续抛出 → JobQueue 把任务标 failed，message 形如「同步 Danbooru：网络不可用，连不上 Danbooru（已改用本地词库）」。成功时 runner 返回摘要字符串，例如 `同步 Danbooru：更新 120 个标签 · 作品 45 个角色 · 别名 80 条`。每次请求前检查 `ctx.signal.aborted`，并把 `ctx.signal` 传给 client。
进度：先 `ctx.setTotal(A 批数 + C 个数)`，C 之后再 `ctx.setTotal(已完成数 + B 批数 + D 个数)`。

**10. 落库** `apply.ts`（复用 T10 的 `CharacterCatalog`，不要再写 ensureWork / 新建角色的第二份实现）：
- 在 `characterCatalog.ts` 里给 `CharacterCatalog` 加一个方法：
```ts
/** 用给定的作品列表替换角色的作品（顺序即 position）；列表为空、与现有顺序相同、或 works_locked = 1 时都不动 */
relinkWorks(characterId: number, copyrightTags: string[], now: string): void
// 现有：SELECT w.danbooru_tag FROM character_works cw JOIN works w ON w.id = cw.work_id WHERE cw.character_id = ? ORDER BY cw.position
// 不同：DELETE FROM character_works WHERE character_id = ?; 然后按顺序 ensureWork + INSERT (character_id, work_id, position = 下标)
```
- `applyToLibrary(deps)`：一个事务里，对每个 `source = 'danbooru' AND danbooru_tag IS NOT NULL` 的角色：① `canon = danbooru.canonicalize(tag)`，不同且没有别的角色占用 canon → `UPDATE characters SET danbooru_tag = ? WHERE id = ?`（被占用则跳过并 warn，留给用户在 T14 里合并）；② `catalog.relinkWorks(id, danbooru.copyrights(canon), now)`。之后调用 T12 的 `relocalizeAll(db, localizer)`（T12 未完成前先只对每个角色 / 作品调用 `replaceAutoAliases(localizer.aliasesFor(...))`）；最后 `recomputeCustomMatches(db, danbooru)`（它自己开事务）。

**11. 自建角色匹配器** `matcher.ts`（T13 getStats、T14 用）：
```ts
export interface DanbooruMatch { danbooruTag: string; score: number; postCount: number; reason: string; existingCharacterId: number | null }
export function findDanbooruMatches(db, danbooru: DanbooruCatalog, characterId: number): DanbooruMatch[];
export function decideMatch(cands: DanbooruMatch[]): DanbooruMatch | null;
export function recomputeCustomMatches(db, danbooru: DanbooruCatalog, characterIds?: number[]): void;
```
算法：
1. keys = 该角色 `name` 与全部 aliases 的 `searchKey`，去重；纯 ASCII 的 key 长度 < 3、其他 < 2 的丢掉（防止「ba」「未」这类误配）。
2. 候选（只做精确 key 匹配，不做子串）：
```sql
SELECT k.tag, k.kind, COALESCE(d.post_count, i.post_count, 0) AS post_count
FROM tag_name_keys k
LEFT JOIN tag_i18n i ON i.tag = k.tag
LEFT JOIN danbooru_tags d ON d.name = k.tag
WHERE k.search_key IN (SELECT value FROM json_each(?))
  AND COALESCE(NULLIF(d.category, -1), i.category) = 4;
```
3. 每个 tag（先 canonicalize 再去重）取最高的 kind 分：zh 1.0 / other_name 0.9 / alias 0.8 / tag 0.7。
4. 作品校验：自建角色所属作品里有 danbooru_tag 的集合 W（并上各自 impliesClosure）；候选 `copyrights(tag)` 并上闭包 = C。W 非空时：C∩W 非空 +0.3；C 非空但不相交 −0.5；W 为空不加减。
5. `decideMatch`：按 score、post_count 降序；最高分 ≥ 0.9，且（没有第二名 或 分差 ≥ 0.2 或 post_count ≥ 第二名 3 倍）才算匹配。服装变体 `mika_(swimsuit)_(blue_archive)` 的中文名 key 与本体相同，靠 post_count（16024 vs 1642）分出来。
6. 写表：
```sql
INSERT INTO custom_character_matches (character_id, danbooru_tag, score, reason, existing_character_id, computed_at)
VALUES (?, ?, ?, ?, (SELECT id FROM characters WHERE danbooru_tag = ?), ?)
ON CONFLICT(character_id) DO UPDATE SET danbooru_tag = excluded.danbooru_tag, score = excluded.score, reason = excluded.reason,
  existing_character_id = excluded.existing_character_id, computed_at = excluded.computed_at,
  dismissed = CASE WHEN custom_character_matches.danbooru_tag = excluded.danbooru_tag THEN custom_character_matches.dismissed ELSE 0 END;
```
没匹配 → `DELETE FROM custom_character_matches WHERE character_id = ?`。`characterIds` 省略 = 所有 `source = 'custom' AND danbooru_tag IS NULL` 的角色。纯本地、同步。
T13 的 `getStats().customMatchableCount` 用：
```sql
SELECT COUNT(*) FROM custom_character_matches m JOIN characters c ON c.id = m.character_id
WHERE c.source = 'custom' AND c.danbooru_tag IS NULL AND m.dismissed = 0;
```

**12. 接线与调试脚本**
- `SqliteDataSource.open`（迁移之后）：
```ts
const offline = CopyrightResolver.fromAsset(db);
const danbooru = new DanbooruCatalog(db, offline);
const localizer: Localizer = new HumanizeLocalizer();          // T12 完成后换成 new SqliteLocalizer(db, danbooru)，并先 importDictIfNeeded(db)
const makeCatalog = () => ({ catalog: new CharacterCatalog(db, { copyrights: danbooru, localizer, normalizeTag: (t) => danbooru.normalizeTag(t) }), copyrights: danbooru });
// 把 T10 注册的 tag 阶段改成带 makeCatalog 的版本
pipeline.register({
  tag: createTagStage({ …T10 原有参数, makeCatalog }),
  danbooru: {
    shouldRunAfterTag: () => readSettings(db).danbooru.enabled && hasUncachedCharacterTags(db),   // 有 character 标签在 danbooru_tags 里还没有行
    run: createDanbooruSyncRunner({ db, danbooru, getCatalog: () => makeCatalog().catalog, localizer, getDanbooru, setLastSyncAt }),
  },
});
```
- `apps/server/scripts/danbooru-probe.ts`：`npx tsx apps/server/scripts/danbooru-probe.ts <tag...> [--log]`，用真实 DanbooruClient（内存 SQLite + 迁移）查询并打印 canonical 名、category、copyrights（pickCopyrights 结果）、other_names 前 5 个；`--log` 打印每次请求的开始时间戳。

### 跨任务约定（请在对应任务里照做）
- `characters.danbooru_tag` 一律存**规范化后**的名字（`normalizeTag` 之后）。T10 / T15 新建 Danbooru 角色统一用 `CharacterCatalog.ensureCharacter`。
- T13：`Character.aliases` / `Work.aliases` = `SELECT alias FROM aliases WHERE owner_type = ? AND owner_id = ? AND visible = 1 ORDER BY position, alias`；搜索 keys 用全部别名（包括 visible = 0）；customMatchableCount 用上面的 SQL。
- T14：改 name → `name_locked = 1`；改 workIds → `works_locked = 1`；改 aliases → 删该对象 `origin = 'user'` 的行，按传入顺序插入 `origin = 'user', visible = 1, position = i`，并 `UPDATE aliases SET visible = 0 WHERE owner_type = 'character' AND owner_id = ? AND origin <> 'user'`；createCharacter / updateCharacter / mergeCharacter 之后调用 `recomputeCustomMatches(db, danbooru, [id])`；给自建角色绑定 danbooruTag 时若该 tag 已属于别的角色 → 409，提示合并。
- T15：`CharacterSuggestion.name / workName` 用 `CharacterCatalog.describeTag(tag)`。
- T20：搜索走全部别名的 search_key（包括 visible = 0）。
- T02：API key 存在 `settings` 表的 `secret.danbooruApiKey`（T02 已定），`getSettings` 只回 `hasApiKey`；`danbooru.enabled` 默认 `false`，由 T21 的首次启动引导让用户选择。

### 坑
- 不设 UA / 用浏览器 UA → Cloudflare 403 挑战页（HTML）；直接 `res.json()` 会抛语法错误，要先 `text()` 再判断。
- `tags.json` 等列表接口默认 `limit=20`，漏传会静默丢数据。
- related_tag 慢（实测 0.3–3.5 s / 次），首跑 500 个角色约 10–20 分钟；必须串行、可取消、每条立即落库。
- related_tag 的 copyright 候选里有展会 / 企划类标签（comiket_106 等），只能靠 frequency 阈值过滤；不要用 `wiki_page_tags` 推作品（实测 hatsune_miku 的 wiki 链接里有 my_little_pony、fortnite、2026_fifa_world_cup）。
- WD14 v3 的部分角色标签在 Danbooru 已改名（实测 gojou_satoru→gojo_satoru、kousaka_honoka→kosaka_honoka、uraraka_ochako→uraraka_ochaco、toujou_nozomi→tojo_nozomi），必须走 alias 解析。
- other_names 里有大量梗名（blue_archive 有 28 个，含「ジョジョアーカイブ」「LobotomyKivotos」），显示用的别名要少而精（交给 T12 的 visible 规则）。
- Danbooru 返回的时间带 -04:00 偏移，我们不存；`fetched_at` 用自己的 `new Date().toISOString()`（与 staleBefore 同格式才能字符串比较）。
- 不要在日志里打印 Authorization 头或 API key。
- 同步失败不能影响 `SqliteDataSource.open`；联网只发生在后台任务里。

### 验收标准
1. `npm run typecheck` 无错误。
2. `npx vitest run apps/server/src/services/danbooru` 全部通过（测试一律不连外网），至少包含：
   - pickCopyrights 的 9 个夹具用例（步骤 7）。
   - guessCopyrightFromQualifier：`saber_(fate)` → `fate_(series)`、`kafka_(honkai:_star_rail)` → `honkai:_star_rail`、`hakurei_reimu` → null（内存库；T12 未完成时手工插入 tag_i18n / tag_name_keys 行）。
   - client（注入假 fetch）：UA 以 `Emaki/` 开头且不是 `node`；403 + `cf-mitigated: challenge` → 抛 kind = `blocked` 且 fetch 只被调用 1 次；500、500、200 → 成功且调用 3 次；150 个名字 → 2 次请求，`limit` 分别为 100、50；配了 key → 请求头有 `Authorization: Basic ...` 且 URL 不含 `api_key`。
   - RateLimiter（`vi.useFakeTimers()`）：连续 5 次 `wait` 的开始时间间隔都 ≥ 1000 ms。
   - sync：`enabled = false` 时假 fetch 调用 0 次、applyToLibrary 仍执行；A 阶段查不到的名字写 `not_found = 1`；假 tags.json 对 `gojou_satoru` 返回 `{ name: 'gojou_satoru', category: 4, post_count: 0, antecedent_alias: { consequent_name: 'gojo_satoru', status: 'active' } }` 时，写入 `tag_renames('gojou_satoru' → 'gojo_satoru', source = 'danbooru')`、`danbooru_tags.alias_of = 'gojo_satoru'`，并且**没有**调用 `tag_aliases.json`；完全不返回的名字才走 `tag_aliases.json` 兜底；同一批数据跑第二次，fetch 调用 0 次（缓存未过期）。
   - copyrights 回退链：只有离线表时返回离线表的结果；写入在线结果后返回在线结果。
   - matcher：内存库插入 mika_(blue_archive)（tag_i18n：zh 圣园未花，copyright_guess blue_archive，post_count 16024）与 mika_(swimsuit)_(blue_archive)（post_count 1642）；自建「圣园未花」+ 作品 blue_archive → 匹配 mika_(blue_archive)；自建「未花」无作品 → 不匹配；自建「未花」+ 作品 blue_archive → 匹配；自建「我的原创角色」→ 不匹配。
3. 在线手测（本机能访问 Danbooru；需要代理时先 `$env:EMAKI_HTTP_PROXY='http://127.0.0.1:7890'`）：`npx tsx apps/server/scripts/danbooru-probe.ts 'mika_(blue_archive)' gojou_satoru 'kafka_(honkai:_star_rail)' 'artoria_pendragon_(fate)' gawr_gura --log`，期望 copyrights 依次为 `[blue_archive]`、`gojou_satoru → gojo_satoru: [jujutsu_kaisen]`、`[honkai:_star_rail, honkai_(series)]`、`[fate_(series)]`、`[hololive_english, hololive]`；日志中相邻请求间隔 ≥ 1000 ms。
4. 端到端（`EMAKI_DATA_SOURCE=sqlite`，`EMAKI_DATA_DIR=F:/Claude/emaki/data/dev`，库里已有打过标签的图；先在设置里打开联网同步：`Invoke-RestMethod -Method Put http://127.0.0.1:5174/api/settings -ContentType 'application/json' -Body '{"danbooru":{"enabled":true}}'`）：
   ```powershell
   Invoke-RestMethod -Method Post http://127.0.0.1:5174/api/jobs -ContentType 'application/json' -Body '{"kind":"danbooru-sync"}'
   # 等到 GET /api/jobs 里该任务 status = done
   npx tsx apps/server/scripts/db-query.ts "SELECT name FROM works WHERE danbooru_tag = 'blue_archive'"          # T12 完成后为「蔚蓝档案」
   npx tsx apps/server/scripts/db-query.ts "SELECT COUNT(*) n FROM danbooru_tags WHERE related_fetched_at IS NOT NULL"   # > 0
   (Invoke-RestMethod http://127.0.0.1:5174/api/settings).danbooru.lastSyncAt                                   # 已更新
   ```
5. 离线：`$env:EMAKI_DANBOORU_URL='http://127.0.0.1:9'` 启动再跑同步 → 任务 failed，message 含「网络不可用」；角色名 / 作品仍来自本地词库。去掉这个变量重跑 → done。
6. （T13、T14 完成后补验）`GET /api/stats`：新建自建角色「圣园未花」（所属作品 = 蔚蓝档案）后 `customMatchableCount` = 1；把它改名为「我的原创角色」后 = 0。

### 难度
L

### 给实现模型的提示
- 先写纯函数（pickCopyrights、guessCopyrightFromQualifier、RateLimiter）和单测，再写 client（注入假 fetch 测），最后写 catalog / sync / apply / matcher。
- 夹具直接用本任务里写的真实数值，不要自己编。
- 所有 DB 访问用 better-sqlite3 同步 API（`prepare().get/all/run`、`.pluck()`、`db.transaction(fn)()`），不要引入 ORM；`json_each` 在 better-sqlite3 自带的 SQLite 里可用。
- 不改 `packages/shared` 的接口类型（只改那一行注释）；新列、新表只写在迁移文件里，不要改 schema.sql。

## T12 中文名本地化（角色/作品中文显示名字典来源与匹配）

### 目标
角色 / 作品默认显示简体中文名（`mika_(blue_archive)` → 圣园未花，`blue_archive` → 蔚蓝档案），**离线可用**；生成搜索用别名（聖園ミカ / Misono Mika / 未花…）；同时给 T11 提供离线的「角色 → 作品」猜测、旧标签名 → 新标签名映射和名字反查索引（自建角色匹配、以后中文搜标签）。

### 数据来源（已调研，按优先级）
1. **用户改过的名字**（`name_locked = 1`）永远不覆盖。
2. **内置词库：ame-la/danbooru-tags-data-zh（MIT）**——以 Danbooru 标签原名为键的简体中文翻译，2026-08 快照（收录图片数 > 50 的标签）：character 35,382 / copyright 8,413 / general 30,664 条，CSV 列 `tag,category,aliases,zh,count,notes`。HF：https://huggingface.co/datasets/ame-la/danbooru-tags-data-zh（修订 `1b0900609723e8704c5b69329ed9fde65f5457d5`）；GitHub：https://github.com/amenorira/danbooru-tags-data-zh（commit `5805e4700f52dbe66567b84a157e29a41b3a5bcc`）。实测：WD14 v3 的 2,751 个角色标签里 2,648 个直接命中，加上词库 aliases 里的旧标签名映射后 2,722 个（98.9%）。该项目只有 1 star、单人维护 → **固定修订号，把压缩后的精简词库提交进仓库**（实测约 1.4 MB gz），运行时不依赖它在线。
3. **Danbooru wiki other_names**（T11 同步，最新）：经常直接含简体中文（mika_(blue_archive) 的 other_names 有「圣园未花」「圣园弥香」，blue_archive 有「碧蓝档案」「蔚蓝档案」）。用 opencc-js 判断简繁；只有繁体 / 日文汉字时用 `jp → cn` 转换（实测 博麗霊夢 → 博丽灵梦、蔚藍檔案 → 蔚蓝档案、聖園彌香 → 圣园弥香）。
4. other_names 里第一个含假名的日文名。
5. 标签人性化（`mika_(blue_archive)` → Mika）。

不采用（写进 NOTICE 的「备选」即可）：EhTagTranslation（https://github.com/EhTagTranslation/Database，CC BY-NC-SA 3.0，不能随本仓库分发；键是 e-hentai 的「名 姓」顺序，如 `reimu hakurei`，需要额外对齐；以后可做成可选的运行时下载）；byzod Tags-zh-full-pack（MIT，但 2022 年、约 1 万行，质量差：mika_(blue_archive) 译成「米卡（蓝色档案）」）。

### 依赖
- T01、T10（`humanize.ts`、`Localizer` 接口、`replaceAutoAliases`）、T11 第 1–8 步（004 迁移里的 `tag_i18n` / `tag_name_keys` / `tag_renames`，`DanbooruCatalog.canonicalize`）。
- 读取 `danbooru_tags.other_names`（T11 写入；为空时自动降级，不阻塞）。

### 涉及文件
新增：
- `apps/server/scripts/build-zh-dict.ts`（开发时运行，生成词库）
- `apps/server/assets/i18n/danbooru-zh.json.gz`（生成物，**提交到 git**）
- `apps/server/assets/i18n/NOTICE.md`（来源、修订号、MIT 许可全文、署名）
- `apps/server/src/services/i18n/{script,dict,relocalize}.ts`
- `apps/server/src/services/i18n/__tests__/*.test.ts`
- `apps/server/scripts/zh-coverage.ts`

修改：`apps/server/package.json`（依赖；script `"build:zh-dict": "tsx scripts/build-zh-dict.ts"`）、`services/i18n/humanize.ts`（加两个函数）、`services/i18n/localizer.ts`（加 `SqliteLocalizer`）、`.gitattributes`（没有就新建，加一行 `*.json.gz binary`；T23 会再补其他行）、`SqliteDataSource.open`（启动时导入词库、换成 `SqliteLocalizer`）。可选：`apps/web/src/features/settings/components/DanbooruSection.tsx` 底部加一行小字「中文名词库：danbooru-tags-data-zh（MIT，2026-08 快照）」。

### 实现步骤

**1. 安装与生成词库脚本** `apps/server/scripts/build-zh-dict.ts`：
```powershell
npm i opencc-js@^1.4.2 -w @emaki/server
npm i -D csv-parse@^7.0.3 -w @emaki/server
```
（两个包都没有安装脚本。opencc-js 自带类型，不要装 `@types/opencc-js`。）
- 下载源（按顺序尝试，第一个 200 且行数合格的就用；`HF_ENDPOINT` 环境变量可覆盖 HF 地址，与 T09 的约定一致）。请求用 `net/http.ts` 的 `httpFetch`，带 `User-Agent: Emaki-build/0.1` 和 `AbortSignal.timeout(60_000)`：
```ts
const HF_REV = '1b0900609723e8704c5b69329ed9fde65f5457d5';
const GH_REV = '5805e4700f52dbe66567b84a157e29a41b3a5bcc';
const HF = process.env.HF_ENDPOINT ?? 'https://huggingface.co';
const BASES = [
  `${HF}/datasets/ame-la/danbooru-tags-data-zh/resolve/${HF_REV}/tags/`,
  `https://hf-mirror.com/datasets/ame-la/danbooru-tags-data-zh/resolve/${HF_REV}/tags/`,
  `https://raw.githubusercontent.com/amenorira/danbooru-tags-data-zh/${GH_REV}/tags/`,
  `https://cdn.jsdelivr.net/gh/amenorira/danbooru-tags-data-zh@${GH_REV}/tags/`,
];
const FILES = [['character.csv', 4, 30000], ['copyright.csv', 3, 7000], ['general.csv', 0, 25000]] as const; // [文件, category, 最少行数]
```
（2026-09-27 实测：huggingface.co 与 hf-mirror.com 的固定修订 URL 均 200；raw.githubusercontent 与 jsDelivr 可用。）
- 解析：`import { parse } from 'csv-parse/sync'; parse(buf, { columns: true, bom: true, relax_quotes: true, skip_empty_lines: true, trim: true })`。
- 清洗：`const clean = (s: string) => s.trim().replace(/^['"]+|['"]+$/g, '').trim();`；aliases 按 `|` 切 → clean → 去空、去重、去掉等于 tag 本身的、长度 > 40 的；zh 为空写 null；count 转 number。
- 角色的作品猜测 `copyrightGuess`（离线用，按顺序）：
  a. 限定词：`/_\(([^()]+)\)$/` 取括号内 q；copyright 表有 tag === q 就用；否则 `copKey.get(searchKey(q))`。`copKey` = 把 copyright 行按 count 降序遍历，把 `tag`、`zh`、每个 alias 的 `searchKey` 映射到 tag（先到先得）。
  b. notes 里第一个《…》内的文字 → `copKey.get(searchKey(...))`（hakurei_reimu「《东方Project》的主角…」→ touhou）。
  c. notes 开头到「中的 / 的 / 旗下 / 所属」之前的片段，或 notes 按空白 / 逗号切出的第一个词，查 copKey（hatsune_miku「VOCALOID 虚拟歌姬…」→ vocaloid；gawr_gura「hololive English 的…」→ hololive_english）。
  实测三条规则合计让 WD14 角色标签 2,563 / 2,751（93%）有作品猜测。
- 旧名映射 `renames`：角色 aliases 里匹配 `/^[a-z0-9_().:'!&\/+-]+$/`、含 `_`、且本身不是词库 tag 的 → 映射到该行 tag（冲突保留先出现的）；约 6,700 条（例 gojou_satoru → gojo_satoru）。
- 输出 `apps/server/assets/i18n/danbooru-zh.json.gz`（`zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 })`）：
```ts
interface ZhDictFile {
  format: 1;
  source: 'ame-la/danbooru-tags-data-zh';
  revision: string;          // HF_REV
  license: 'MIT';
  generatedAt: string;
  // tag → [category(0|3|4), zh|null, aliases, copyrightGuess|null, postCount]
  tags: Record<string, [number, string | null, string[], string | null, number]>;
  renames: Record<string, string>;   // 旧标签名 → 新标签名
}
```
- 同时写 `NOTICE.md`：来源 URL、修订号、生成时间、MIT 许可全文（从数据集的 LICENSE 文件下载）、说明「数据根据 Danbooru 公开的标签信息整理」。
- 脚本最后打印：各类行数、有 zh 的比例、有 copyrightGuess 的角色数、renames 数、gz 字节数。

**2. 文字脚本判断** `services/i18n/script.ts`：
```ts
import * as OpenCC from 'opencc-js';
const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const HAN = /\p{Script=Han}/u;
let cn2tw: ((s: string) => string) | undefined;
let jp2cn: ((s: string) => string) | undefined;
const toTw = (s: string) => (cn2tw ??= OpenCC.Converter({ from: 'cn', to: 'tw' }))(s);
export const toSimplified = (s: string) => (jp2cn ??= OpenCC.Converter({ from: 'jp', to: 'cn' }))(s);
export const hasKana = (s: string) => KANA.test(s);
export const isHanName = (s: string) => HAN.test(s) && !KANA.test(s) && !HANGUL.test(s);
/** 含简体特有字、且没有繁体 / 日文新字体：圣园未花 ✓，聖園彌香 ✗，博麗霊夢 ✗ */
export const isSimplifiedZh = (s: string) => isHanName(s) && toTw(s) !== s && toSimplified(s) === s;
/** 简繁同形：未花、初音 */
export const isNeutralHan = (s: string) => isHanName(s) && toTw(s) === s && toSimplified(s) === s;
export const isLatinName = (s: string) => /^[\x20-\x7e]+$/.test(s) && /[a-z]/i.test(s);
```
opencc-js 的 Converter 首次创建要加载字典（包约 6 MB），务必懒加载并复用；只在 server 端用。

**3. 在 `humanize.ts` 里追加**（T10 已有 `humanizeCharacterTag`、`humanizeCopyrightTag`，规则不变）：
```ts
/** 只去掉结尾最后一个全角/半角括号：圣园未花（泳装）（蔚蓝档案）→ 圣园未花（泳装）；去完为空则原样返回 */
export function stripZhQualifier(zh: string): string;
/** wiki other_name 清理：'_' → 空格、去掉结尾 (…) / （…）、trim；长度 > 40 或含 http 返回 null */
export function cleanOtherName(s: string): string | null;
```

**4. 导入** `services/i18n/dict.ts`：
```ts
export function importDictIfNeeded(db: Database.Database, file = path.join(config.assetsDir, 'i18n/danbooru-zh.json.gz')): { imported: boolean; count: number; ms: number };
```
- `version = `${source}@${revision}#${format}``；与 settings 表键 `i18n.dictVersion` 的值（JSON 字符串，读时 `JSON.parse`）相同则跳过，日志「中文词库已是最新」。
- 否则一个事务里：
```sql
DELETE FROM tag_i18n;
DELETE FROM tag_name_keys WHERE source = 'dict';
DELETE FROM tag_renames WHERE source = 'dict';     -- danbooru 来源保留（优先级更高）
INSERT INTO tag_i18n (tag, category, zh, aliases, copyright_guess, post_count) VALUES (?, ?, ?, ?, ?, ?);
INSERT OR IGNORE INTO tag_name_keys (search_key, tag, kind, source) VALUES (?, ?, ?, 'dict');
INSERT OR IGNORE INTO tag_renames (old_name, new_name, source) VALUES (?, ?, 'dict');
INSERT INTO settings (key, value) VALUES ('i18n.dictVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```
- 每个条目写入的 key：kind `zh` = `searchKey(stripZhQualifier(zh))`；kind `alias` = 每个 alias 的 searchKey；kind `tag` = `searchKey(tag)`。key 为空、或纯 ASCII 且长度 < 2 的跳过。
- 约 7.4 万条 + 约 30 万 key，用 prepared statement 单事务插入，目标 < 5 秒；日志打印条数和耗时。
- 在 `SqliteDataSource.open` 迁移之后调用；真的导入了就接着在一个事务里调用 `relocalizeAll`。

**5. Localizer 实现**：在 `services/i18n/localizer.ts` 里加 `export class SqliteLocalizer implements Localizer`，构造参数 `(db, danbooru: DanbooruCatalog)`，结果用 Map 缓存，`invalidate()` 清空。
```ts
characterName(rawTag: string): LocalizedName {
  const tag = this.danbooru.canonicalize(rawTag);
  const d = this.dict(tag) ?? this.dict(rawTag);          // SELECT zh, aliases FROM tag_i18n WHERE tag = ?
  if (d?.zh) return { name: stripZhQualifier(d.zh), source: 'dict' };
  const names = this.otherNames(tag);                     // danbooru_tags.other_names → cleanOtherName → 去 null
  const zh = names.find(isSimplifiedZh) ?? names.find(isNeutralHan);
  if (zh) return { name: zh, source: 'wiki-zh' };
  const han = names.find(isHanName);
  if (han) return { name: toSimplified(han), source: 'wiki-converted' };
  const ja = names.find(hasKana);
  if (ja) return { name: ja, source: 'wiki-ja' };
  return { name: humanizeCharacterTag(tag), source: 'tag' };
}
```
`workName` 同理，但 dict 分支**不去括号**，兜底用 `humanizeCopyrightTag`。
`aliasesFor(tag, owner, displayName)`：
- 可见（角色最多 4 个、作品最多 3 个，按顺序）：① other_names 里第一个含假名的，或非简体的汉字名（日文正式名，如 聖園ミカ）；② 第一个带空格或下划线的拉丁名（Misono_Mika → Misono Mika），没有就用人性化标签（作品：Blue Archive）；③ 词库 aliases 里的汉字名（如 未花、碧蓝档案）。
- 隐藏（visible = false，只用于搜索，最多 40 个）：其余 other_names（cleanOtherName 后）、词库全部 aliases、词库 zh 全称、原始标签、人性化标签。
- 统一按 `searchKey` 去重，丢掉与 `searchKey(displayName)` 相同的；origin：来自 other_names 的为 `danbooru`，其余为 `dict`。
示例（以夹具为准）：mika_(blue_archive)（显示名 圣园未花）→ 可见 `['聖園ミカ', 'Misono Mika', '未花']`；blue_archive（蔚蓝档案）→ 可见 `['ブルアカ', 'Blue Archive', '碧蓝档案']`。

**6. 全库重算** `services/i18n/relocalize.ts`：
```ts
export function relocalizeAll(db: Database.Database, localizer: Localizer): { renamed: number };
```
① 所有 `source = 'danbooru' AND name_locked = 0` 的角色：`UPDATE characters SET name = ? WHERE id = ? AND name <> ?`；② 所有 `danbooru_tag IS NOT NULL AND name_locked = 0` 的作品同理（用 workName）；③ 同名消歧：库里 name 相同但 danbooru_tag 不同的未锁定角色（实测 saber_(fate) 与 artoria_pendragon_(fate) 在词库里都是「阿尔托莉雅·潘德拉贡（Fate系列）」），post_count 最大的保留原名，其余改为 `${name}（${humanizeCharacterTag(tag)}）`，例「阿尔托莉雅·潘德拉贡（Saber）」；④ 对每个有 danbooru_tag 的角色 / 作品调用 `replaceAutoAliases(db, owner, id, localizer.aliasesFor(tag, owner, 当前名字))`。由调用方包事务（T11 的 applyToLibrary 已在事务内；启动导入时自己包一个）。

**7. 接线**：`SqliteDataSource.open` 里把 T11 第 12 步的 `new HumanizeLocalizer()` 换成 `new SqliteLocalizer(db, danbooru)`，并在它之前调用 `importDictIfNeeded(db)`（导入了就 `db.transaction(() => relocalizeAll(db, localizer))()`）。

**8. 覆盖率脚本** `apps/server/scripts/zh-coverage.ts <selected_tags.csv>`：读取 WD14 的 selected_tags.csv（`category === '4'` 的行），对每个 name 调 `characterName` 与 `danbooru.copyrights`，打印 source 分布、source = 'dict' 的比例、有作品的比例。

### 坑
- 词库 zh 有 18,355 条带作品后缀（「圣园未花（蔚蓝档案）」），角色显示名必须去掉最后一个括号，否则角色卡上重复作品名；作品名不要去。
- `searchKey` 会先 NFKC（全角括号 → 半角）再去掉结尾括号，所以「圣园未花（泳装）」和「圣园未花」的 key 相同——这是预期行为，T11 的匹配器靠 post_count 区分。
- CSV 有 BOM 和不规范引号：必须 `bom: true, relax_quotes: true`，否则第一列名会变成 `﻿tag` 或直接抛错。
- 词库 aliases 里有俗称 / 不雅昵称（例：genshin_impact 的 alias 里有 R18 梗），只能 visible = 0 做搜索，不能显示。
- 不要把「运行时联网下载词库」做成必需步骤（国内网络 + 单人维护的数据源都不可靠）；gz 随仓库分发，更新时手动改修订号重跑脚本。
- `settings.value` 是 JSON：写 `JSON.stringify(version)`，读 `JSON.parse`。
- 必须保留 NOTICE.md（MIT 要求保留版权和许可声明）；T23 打包时 `apps/server/assets` 要一起带上。
- opencc 的 `jp → cn` 对含假名的字符串只转汉字部分（「艦隊これくしょん」→「舰队これくしょん」），所以含假名的名字不要走转换分支。

### 验收标准
1. `npx tsx apps/server/scripts/build-zh-dict.ts` 成功，打印 character ≈ 35382、copyright ≈ 8413、general ≈ 30664；生成的 gz < 3 MB；`node -e "const z=require('zlib'),f=require('fs');const d=JSON.parse(z.gunzipSync(f.readFileSync('apps/server/assets/i18n/danbooru-zh.json.gz')));console.log(d.tags['mika_(blue_archive)'],d.renames['gojou_satoru'])"` 输出 `[4,'圣园未花（蔚蓝档案）',[...],'blue_archive',16024]` 和 `gojo_satoru`。
2. `npm run typecheck` 无错误。
3. `npx vitest run apps/server/src/services/i18n` 通过（内存库 + T01 migrate + importDictIfNeeded），至少：
   - `characterName('mika_(blue_archive)')` → `{ name: '圣园未花', source: 'dict' }`
   - `characterName('mika_(swimsuit)_(blue_archive)')` → `圣园未花（泳装）`
   - `characterName('gojou_satoru')` → `五条悟`（经 renames）
   - `workName('blue_archive')` → `蔚蓝档案`；`workName('fate_(series)')` → `Fate系列`
   - 词库里没有、other_names 为 `['聖園ミカ','Misono_Mika','圣园未花']` 的假标签 → `圣园未花`（wiki-zh）
   - other_names 仅 `['博麗霊夢','Hakurei_Reimu']` → `博丽灵梦`（wiki-converted）
   - other_names 仅 `['ホシノ']` → `ホシノ`（wiki-ja）
   - 都没有：`some_new_char_(foo_bar)` → `Some New Char`；不在词库的 copyright `fate/grand_order_test` → `Fate/Grand Order Test`
   - `isSimplifiedZh`：圣园未花 true、未花 false、聖園彌香 false、博麗霊夢 false
   - `aliasesFor` 结果按 searchKey 无重复、不含与显示名同 key 的项、可见数 ≤ 4
   - relocalizeAll：name_locked = 1 的角色名字不变；saber_(fate) 与 artoria_pendragon_(fate) 同时在库时两者 name 不同
   - importDictIfNeeded 第二次调用返回 `imported: false`
4. 覆盖率：用 T09 已下载的 `data/models/SmilingWolf__wd-eva02-large-tagger-v3/selected_tags.csv`，`npx tsx apps/server/scripts/zh-coverage.ts F:/Claude/emaki/data/models/SmilingWolf__wd-eva02-large-tagger-v3/selected_tags.csv` 打印 source = 'dict' 的比例 ≥ 98%、有作品的比例 ≥ 90%（均为离线、未做 Danbooru 同步时）。
5. sqlite 模式启动后端两次：第一次日志「导入中文词库 N 条，耗时 X ms」（X < 5000），第二次日志「中文词库已是最新」。
6. 端到端（断网：`$env:EMAKI_DANBOORU_URL='http://127.0.0.1:9'`）：给用户的插画打标签（T10）后，`npx tsx apps/server/scripts/db-query.ts "SELECT c.name, w.name AS work FROM characters c LEFT JOIN character_works cw ON cw.character_id=c.id AND cw.position=0 LEFT JOIN works w ON w.id=cw.work_id WHERE c.source='danbooru' ORDER BY random() LIMIT 10"`：至少 9 个角色名和作品名是中文。（T13 完成后补验：`GET /api/characters?q=<某个角色的日文或中文别名>` 能搜到它。）

### 难度
M

### 给实现模型的提示
- 先写并单测 `script.ts`、`humanize.ts` 新增的纯函数，再写构建脚本并把 gz 生成出来提交，最后写 dict / localizer / relocalize。
- `Localizer` 的接口签名以 T10 为准，不要改。
- 所有 DB 访问用 better-sqlite3 同步 API；导入用一个 `db.transaction(() => {...})()` 包住所有 INSERT，prepared statement 在循环外创建。
- 不要改 `packages/shared` 的类型；`searchKey` 从 `@emaki/shared` 导入。

# M3 查询与整理

> M3 的推荐顺序：T19 → T13 → T14 → T15 → T17 → T18 → T16 → T20。T19 最先做：T14 / T15 / T17 / T18 都用它的 `ctx.mutate`。M3 起所有可撤销的修改都走 `ctx.mutate`。

## T13 角色/作品/统计查询（getStats、listWorks、getWork、listCharacters、topCharacters、getCharacter）

### 目标
实现 `getStats / listWorks / getWork / listCharacters / topCharacters / getCharacter`，排序、过滤、计数口径、分页与 MockDataSource 一致。引入内存「派生缓存」`Derived`（与 mock 的 `idx` 同一思路）：每个角色 / 作品的张数等聚合结果缓存起来，数据变化时失效重建。

### 依赖
T01、T02、T24 阶段 A（种子数据 + 契约测试，否则没有数据可测）。T10（`util/color.ts`、`services/i18n/humanize.ts`）、T11（`customMatchableCount` 的 SQL）已在 M2 完成。

### 计数口径
见「全局约定 → 数据口径」。另外：
- newCount = 该角色在计入张数的图中，`image_characters.added_at > COALESCE(characters.last_seen_at, characters.created_at)` 的条数。

### 涉及文件
- `apps/server/src/datasource/sqlite/derived.ts`（新）
- `apps/server/src/datasource/sqlite/library.ts`（新：本任务的查询与映射）
- `apps/server/src/datasource/sqlite/SqliteDataSource.ts`（6 个方法委托）
- 复用：`util/color.ts`（`hslToHex`、`hashString`）、`services/i18n/humanize.ts`（T10 建的；不要从 mock 目录 import）

### 实现步骤
1. `derived.ts`：
```ts
export interface CharacterRec {
  id: number; name: string; danbooruTag: string | null; source: CharacterSource; aliases: string[]; workIds: number[];
  coverImageId: number | null; coverFocus: FocusPoint | null; pinned: boolean; lastSeenAt: string | null; createdAt: string;
  imageCount: number; newCount: number; lastAddedAt: string | null; effectiveCoverId: number | null;
  /** effectiveCoverId 那张图的 images.rating；没有封面时 'general'（前端据此模糊敏感封面） */
  coverRating: Rating;
  /** searchKey(名字、标签、全部别名（含隐藏的）、所属作品名和别名)；listCharacters 的 q 与 T20 搜索用 */
  keys: string[];
}
export interface WorkRec {
  id: number; name: string; danbooruTag: string | null; aliases: string[]; color: string;
  imageCount: number; recentImageCount: number; characterCount: number; coverImageId: number | null;
  coverRating: Rating;   // 同上，取作品封面图的分级
  keys: string[];
}
export interface DerivedData { characters: Map<number, CharacterRec>; works: Map<number, WorkRec>; builtAt: number }
export class Derived {
  constructor(private readonly ctx: SqliteContext) {}
  invalidate(): void            // 置脏
  get(): DerivedData            // 脏了、或 builtAt 距今超过 5 分钟（recent 窗口随时间移动）就重建
}
```
`ctx.invalidate()` 调用 `derived.invalidate()`。T22 会细分 entities/stats 两级，这里先整体重建。

2. 重建 SQL（`now = ctx.clock()`，`:cutoff = iso(now - 30*DAY)`；本任务里所有「现在」都用 `ctx.clock()`，不要用 `Date.now()`，契约测试靠注入的 NOW 才能和 mock 对上）：
```sql
-- A 基础行
SELECT id, name, danbooru_tag, source, cover_image_id, cover_focus_x, cover_focus_y, pinned, last_seen_at, created_at FROM characters;
SELECT character_id, work_id FROM character_works ORDER BY character_id, position, work_id;
SELECT owner_type, owner_id, alias, visible FROM aliases ORDER BY position, alias;   -- visible=1 的进 aliases，全部进 keys
SELECT id, name, danbooru_tag, color FROM works;
-- B 角色统计
SELECT ic.character_id AS id, COUNT(*) AS image_count, MAX(i.added_at) AS last_added_at,
       SUM(ic.added_at > COALESCE(c.last_seen_at, c.created_at)) AS new_count
FROM image_characters ic
JOIN v_counted_images i ON i.id = ic.image_id
JOIN characters c ON c.id = ic.character_id
GROUP BY ic.character_id;
-- C 兜底封面：tagger 分数最高（manual 记 0.5），同分取最新
SELECT character_id, image_id FROM (
  SELECT ic.character_id, ic.image_id,
         ROW_NUMBER() OVER (PARTITION BY ic.character_id
                            ORDER BY COALESCE(ic.score, 0.5) DESC, i.added_at DESC, i.id DESC) AS rn
  FROM image_characters ic JOIN v_counted_images i ON i.id = ic.image_id)
WHERE rn = 1;
-- D 显式封面仍然可见的角色
SELECT c.id FROM characters c JOIN v_counted_images i ON i.id = c.cover_image_id;
-- E 作品统计
SELECT w.work_id AS id, COUNT(*) AS image_count, SUM(i.added_at >= :cutoff) AS recent_count
FROM v_image_works w JOIN v_counted_images i ON i.id = w.image_id
GROUP BY w.work_id;
-- F 作品的角色数（mock：关联了就算，不看张数）
SELECT work_id, COUNT(*) AS n FROM character_works GROUP BY work_id;
```
组装：
- `effectiveCoverId` = 显式封面仍可见 ? cover_image_id : (C 的结果 ?? null)。
- 作品封面（mock 规则）：该作品的角色中有封面的、imageCount 最大的那个的封面（并列取 id 小的）。
- `coverRating`（`Character.coverRating` / `Work.coverRating` 是契约里的必填字段，mock 的 `coverRating()`）：把所有封面 id 收集起来，一次 `SELECT id, rating FROM images WHERE id IN (SELECT value FROM json_each(?))` 查出分级；没有封面 → `'general'`。
- 作品颜色：`works.color ?? hslToHex(hashString(name) % 360, 62, 58)`。
- keys：角色 = `[name, danbooruTag, ...全部别名, ...每个所属作品的 name 与全部别名].filter(Boolean).map(searchKey)`；作品 = `[name, danbooruTag, ...全部别名]` 同理。

3. 映射（`library.ts`）：
```ts
toCharacter(r): Character = { id: toId(r.id), name, danbooruTag, source, aliases, workIds: r.workIds.map(toId), imageCount, newCount,
  coverImageId: r.effectiveCoverId === null ? null : toId(r.effectiveCoverId), coverRating: r.coverRating, coverFocus, lastAddedAt, pinned }
toWork(w): Work = { id: toId(w.id), name, danbooruTag, aliases, characterCount, imageCount, recentImageCount,
  coverImageId: w.coverImageId === null ? null : toId(w.coverImageId), coverRating: w.coverRating, color }
```
（字段名以 `packages/shared/src/domain.ts` 为准。）

4. `getStats()`：
```sql
SELECT
  (SELECT COUNT(*) FROM v_counted_images)                                            AS image_count,
  (SELECT COUNT(*) FROM v_images WHERE excluded_by IS NOT NULL)                      AS excluded_count,
  (SELECT COUNT(*) FROM v_counted_images i
     WHERE NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id))  AS unrecognized_count,
  (SELECT COALESCE(SUM(bytes), 0) FROM v_counted_images)                             AS total_bytes,
  (SELECT COUNT(*) FROM duplicate_groups g
     WHERE g.resolved_at IS NULL AND g.ignored = 0
       AND (SELECT COUNT(*) FROM duplicate_members m JOIN v_images vi ON vi.id = m.image_id
             WHERE m.group_id = g.id) >= 2)                                          AS duplicate_group_count,
  (SELECT MAX(last_scan_at) FROM library_roots WHERE removed_at IS NULL)             AS last_scan_at;
```
近 7 天（本地时区，与 mock 相同：下标 6 = 今天）：
```ts
const today = new Date(now); today.setHours(0, 0, 0, 0);
const params = { todayEndMs: today.getTime() + DAY, since: iso(today.getTime() - 6 * DAY) };
```
```sql
-- d = 0 表示今天，1 表示昨天……（今天 [0 点, 24 点) 内的时间都算出 0）
SELECT CAST((:todayEndMs - 1 - unixepoch(added_at, 'subsec') * 1000) / 86400000 AS INTEGER) AS d, COUNT(*) AS n
FROM v_counted_images WHERE added_at >= :since GROUP BY d;
```
`days[6 - d] = n`（只取 0 ≤ d ≤ 6；下标 0 最旧，6 是今天）。写一个单测核对：今天 0:00 和 23:59 入库的图都落在下标 6，6 天前的落在下标 0。
characterCount / workCount = Derived 中 imageCount > 0 的个数；customMatchableCount = T11 给出的 SQL（`custom_character_matches` 表）；duplicateGroupCount 口径与 T16 的 listDuplicates 一致（未解决、未忽略、可见成员 ≥ 2）。

5. `listWorks({ sort })`：Derived 里 imageCount > 0 的作品；`name` → `zhCollator.compare(a.name, b.name)`（`const zhCollator = new Intl.Collator('zh')`，等价于 mock 的 `localeCompare(b, 'zh')`）；`recent` → recentImageCount 降序；默认 imageCount 降序；并列按 id 升序。`getWork(id)`：parseId 失败或不存在 → null（mock 对 0 张作品也返回）。

6. `filterCharacters({ workId, q, source })`（逐行对照 mock）：
   - `source` 相等；
   - `workId === 'recent'` → `lastAddedAt !== null && lastAddedAt >= cutoff`；其他 workId → parseId 后 `workIds.includes`（解析失败 → 空结果）；
   - `q`：`const k = searchKey(q); if (k && !rec.keys.some((x) => x.includes(k))) 排除`（与 `matchesQuery` 等价）。
   - listCharacters **不**过滤 0 张的角色（mock 如此）。

7. `listCharacters`：pinned 在前；再按 sort：`name`（zhCollator）、`recent`（`(b.lastAddedAt ?? '').localeCompare(a.lastAddedAt ?? '')`）、`newCount`（newCount 降序再 imageCount 降序）、默认 imageCount 降序；并列保持 id 升序（先按 id 排好，再用稳定的 `Array.prototype.sort`）。分页用 `paginateOffset`（整个列表已在内存，偏移分页足够，游标是数字字符串，与 mock 相同）。只对当前页调用 `toCharacter`。

8. `topCharacters({ limit = 9, workId })`：`filterCharacters({ workId })` → imageCount > 0 → imageCount 降序（不管 pinned，mock 如此）→ `slice(0, limit)`。

9. `getCharacter(id)`：不存在 → null；works = 按 position 顺序映射存在的作品（不过滤 0 张）；related：
```sql
SELECT o.character_id AS id, COUNT(*) AS shared
FROM image_characters me
JOIN v_counted_images i ON i.id = me.image_id
JOIN image_characters o ON o.image_id = me.image_id AND o.character_id <> me.character_id
WHERE me.character_id = ?
GROUP BY o.character_id
ORDER BY shared DESC, o.character_id ASC
LIMIT 8;
```
（返回结构以 `GetCharacterResponse` 为准，对照 mock 的 `getCharacter`。）

### 坑
- 统计口径只看「全局约定 → 数据口径」；mock 旧代码里 totalBytes / addedLast7Days 含被排除的图、lastScanAt 取第一个 root、重复组不看可见性——T24 阶段 A 已把 mock 改成同一口径。
- `SUM(条件)` 没有行时是 NULL，读出后 `?? 0`。
- 中文排序不能靠 SQL（SQLite 按码点排），一律在 JS 用 `Intl.Collator('zh')`，实例建一次复用。
- Derived 重建会阻塞事件循环（10 万张约 0.2–0.4s），只在失效后的第一次读取时重建，不要每个请求都重建。
- 角色 `coverImageId` 尽量非空（兜底封面），否则前端角色卡是空白。
- `Character.aliases` 只返回 `visible = 1` 的别名；搜索 keys 用全部别名。

### 验收标准
- 把 `T13` 加进 `SQLITE_READY`，`npx vitest run contract`：stats / works / characters / topCharacters / getCharacter 用例在 mock 与 sqlite 两边通过（id 已映射；newCount 绝对值除外）。
- 用种子库手动对比：
```powershell
npx tsx apps/server/scripts/seed-mock.ts F:/Claude/emaki/data/seed    # T24 阶段 A 提供
$env:EMAKI_DATA_SOURCE='sqlite'; $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/seed'; $env:EMAKI_NO_AUTOSCAN='1'; npm run dev
```
  前端首页统计、角色页排序与筛选（作品 chip、「最近」、搜索 ミカ / mika / 未花）与 mock 模式一致。种子库的图片没有真实文件：缩略图 404、只显示主色占位是正常的；`EMAKI_NO_AUTOSCAN=1` 避免启动扫描 / 缩略图任务去碰假路径（mock 的根是 `D:/Pictures/插画`、`E:/下载/pixiv`）。验完 `Remove-Item Env:EMAKI_NO_AUTOSCAN`。
- T22 的 10 万张性能库上：`GET /api/characters?limit=60` 缓存热时 < 50ms。

### 难度
M–L

### 给实现模型的提示
- 先写 Derived，再写 6 个方法，方法本身都应该很短。
- 行为有疑问时以 MockDataSource 为准，逐行对照 `filterCharacters`、`listCharacters`、`topCharacters`、`getStats`。

## T14 角色编辑、合并、自建角色、「自建角色能对上 Danbooru」检测

### 目标
- 实现 `createCharacter / updateCharacter / markCharacterSeen / mergeCharacter`（行为、提示文案与 mock 一致，可撤销）。
- 提供可撤销版的「按 Danbooru 标签建角色」`insertDanbooruCharacter()`（T15 采纳建议用），底层就是 T10 的 `CharacterCatalog.ensureCharacter`。
- 编辑后重算「自建角色能对上 Danbooru」（T11 的 `recomputeCustomMatches`），让 `stats.customMatchableCount` 实时更新。

### 依赖
T10（`CharacterCatalog`）、T11（`DanbooruCatalog`、`matcher.ts`）、T13、T19（`ctx.mutate` / `UndoRecorder`）。

### 涉及文件
- `apps/server/src/datasource/sqlite/characters.ts`（新）
- `SqliteDataSource.ts`（4 个方法委托）
- 可选（T14.x，默认不做）：`packages/shared/src/api.ts`、`DataSource.ts`、`routes/library.ts`、`MockDataSource.ts`、`apps/web/src/lib/api.ts` + `lib/queries.ts`

### 实现步骤
1. 公共函数（`characters.ts`）：
```ts
/** 可撤销地按标签新建 danbooru 角色（必要时新建作品）。调用方必须在 ctx.mutate 里调用 */
export function insertDanbooruCharacter(ctx: SqliteContext, u: UndoRecorder, catalog: CharacterCatalog, tag: string,
  opts: { coverImageId?: number | null; now: string }): { id: number; created: boolean } {
  const r = catalog.ensureCharacter(tag, opts.coverImageId ?? null, opts.now);
  if (r.created) {
    // 记录顺序决定撤销顺序（撤销时逆序）：先删角色别名 → 删角色（级联 character_works）→ 删作品别名 → 删作品
    for (const wid of r.createdWorkIds) { u.inserted('works', wid); u.sql("DELETE FROM aliases WHERE owner_type = 'work' AND owner_id = ?", [wid]); }
    u.inserted('characters', r.id); u.sql("DELETE FROM aliases WHERE owner_type = 'character' AND owner_id = ?", [r.id]);
  }
  return { id: r.id, created: r.created };
}
function normalizeAliases(xs: string[] | undefined): string[]   // trim、去空、保序去重、最多 50 个、每个 ≤ 100 字
/** 用户编辑别名（T11 约定）：替换 origin='user' 的行，自动别名改成只供搜索 */
function writeUserAliases(ctx, ownerType: 'character' | 'work', ownerId: number, aliases: string[]): void
  // DELETE FROM aliases WHERE owner_type = ? AND owner_id = ? AND origin = 'user';
  // 逐个 INSERT OR REPLACE (owner_type, owner_id, alias, search_key = searchKey(alias), origin = 'user', visible = 1, position = 下标)
  // UPDATE aliases SET visible = 0 WHERE owner_type = ? AND owner_id = ? AND origin <> 'user';
function writeCharacterWorks(ctx, characterId: number, workIds: number[]): void
  // DELETE FROM character_works WHERE character_id = ?; INSERT (character_id, work_id, position = 下标)
function assertTagFree(ctx, tag: string, exceptCharacterId?: number): void
  // 被别的角色占用（characters.danbooru_tag 或 danbooru_tag_redirects）→ ConflictError(`标签 ${tag} 已属于「${name}」，可以用「合并」把两个角色合在一起`)
```
`catalog` 用 T11 第 12 步的 `makeCatalog().catalog`（带完整回退链、`normalizeTag` 和 Localizer）。标签查角色一律用 `catalog.resolveCharacterId(tag)`。

2. `createCharacter(body)`：
   - 事务外校验：`name.trim()` 空 → `BadRequestError('角色名不能为空')`；workIds 逐个 parseId，`SELECT id FROM works WHERE id IN (SELECT value FROM json_each(?))` 缺的 → `NotFoundError(`作品 ${id}`)`；danbooruTag trim，空串当 null，非空则 `assertTagFree`。
   - `ctx.mutate((u) => { ... })`：
```sql
INSERT INTO characters (name, danbooru_tag, source, pinned, name_locked, works_locked, last_seen_at, created_at) VALUES (?, ?, ?, 0, 1, ?, ?, ?);
```
     source = danbooruTag ? 'danbooru' : 'custom'（mock 规则）；`name_locked = 1`（名字是用户起的）；`works_locked = workIds.length > 0 ? 1 : 0`；last_seen_at = created_at = now。记录顺序：`u.inserted('characters', id)`，`u.sql("DELETE FROM aliases WHERE owner_type = 'character' AND owner_id = ?", [id])`（aliases 没有外键，撤销时要手动删），再 `writeCharacterWorks`、`writeUserAliases`。最后 `u.onUndo(() => recomputeCustomMatches(db, danbooru, [id]))`（撤销后行已不在，重算会顺带清理）。
   - 事务提交后 `recomputeCustomMatches(db, danbooru, [id])`。
   - 返回 `{ ...result, character: toCharacter(...) }`，提示 `已新建角色「${name}」`。

3. `updateCharacter(id, body)`：不存在 → `NotFoundError('角色')`。mutate 里先记录：若改 workIds → `u.set('character_works', 'character_id = ?', [id])`；若改 aliases → `u.set('aliases', "owner_type = 'character' AND owner_id = ?", [id])`；最后 `u.columns('characters', ['name', 'danbooru_tag', 'source', 'cover_image_id', 'cover_focus_x', 'cover_focus_y', 'pinned', 'name_locked', 'works_locked'], [id])`。然后按字段更新（mock 规则）：
   - `name`：trim 后为空则保持原名；有变化时 `name_locked = 1`；
   - `aliases`：`writeUserAliases(normalizeAliases(...))`；
   - `danbooruTag`：`assertTagFree(tag, id)`；非 null 时 `source = 'danbooru'`（设为 null 时 source 不变）；
   - `workIds`：校验存在后整体替换，`works_locked = 1`；
   - `coverImageId`：非 null 时图片必须存在，否则 `NotFoundError('图片')`；
   - `coverFocus`：null → 两列都 NULL；
   - `pinned`。
   提交后 `recomputeCustomMatches(db, danbooru, [id])`。提示 `已更新「${新名字}」`。

4. `markCharacterSeen(id)`：不存在 → NotFound；Derived 里该角色 newCount 为 0 → 直接 return（mock 不发事件）；否则 `UPDATE characters SET last_seen_at = ? WHERE id = ?` + `ctx.touch()`，不可撤销。

5. `mergeCharacter(id, targetId)`：
   - 事务外：`id === targetId` → `BadRequestError('不能合并到自己')`；任一不存在 → NotFound；存在 `exclusions(kind = 'character', target = id)` → `BadRequestError('这个角色有排除规则，请先在「已排除」里恢复')`。
   - mutate 里**严格按此顺序记录**（撤销逆序执行：先把目标的标签还原，再插回被合并的角色，再恢复各子表）：
```ts
u.set('image_characters', 'character_id = ?', [targetId]);
u.set('image_characters', 'character_id = ?', [id]);
u.set('aliases', "owner_type = 'character' AND owner_id IN (?, ?)", [id, targetId]);
u.set('character_works', 'character_id = ?', [id]);
u.set('danbooru_tag_redirects', 'character_id IN (?, ?)', [id, targetId]);
u.set('custom_character_matches', 'character_id IN (?, ?) OR existing_character_id IN (?, ?)', [id, targetId, id, targetId]);
u.set('characters', 'id = ?', [id]);                               // 被合并角色整行
u.columns('characters', ['danbooru_tag', 'source'], [targetId]);   // 必须在上一行之后记录，避免撤销时 UNIQUE 冲突
```
   - 执行：
```sql
-- 1 关联搬家：保留原 origin/score/added_at；目标已有的保持目标自己的
INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at)
  SELECT image_id, :to, origin, score, added_at FROM image_characters WHERE character_id = :from;
-- 2 指向被合并角色的重定向改指向目标
UPDATE danbooru_tag_redirects SET character_id = :to WHERE character_id = :from;
```
     3 标签：from 有 danbooru_tag 时——目标没有标签：先 `UPDATE characters SET danbooru_tag = NULL WHERE id = :from`，再给目标设 `danbooru_tag = from.tag, source = 'danbooru'`；目标已有标签：`INSERT OR REPLACE INTO danbooru_tag_redirects (tag, character_id) VALUES (:fromTag, :to)`（**这一步最容易漏**：不写的话，T10 下次打标签会把被合并的角色重新建出来）。
     4 别名（mock：目标别名 = 去重(目标原别名 + from.name + from.aliases)）：
```sql
INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position)
  VALUES ('character', :to, :fromName, :fromNameKey, 'user', 1, 50);
INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position)
  SELECT 'character', :to, alias, search_key, origin, visible, position + 1000 FROM aliases WHERE owner_type = 'character' AND owner_id = :from;
DELETE FROM aliases WHERE owner_type = 'character' AND owner_id = :from;
```
     5 `DELETE FROM characters WHERE id = :from`（级联删 image_characters / character_works / custom_character_matches）。
   - 提交后 `recomputeCustomMatches(db, danbooru, [targetId])`。
   - 提示 `已把「${from.name}」合并进「${to.name}」（${n} 张）`，n = 合并前 from 的关联行数（mock 数全部图）。
   - newCount 与 mock 不同（mock 是相加；这里按目标的 last_seen_at 重新计算）——有意差异，契约不比较。

6. `getStats().customMatchableCount`：T13 已用 T11 的 SQL（`custom_character_matches`），本任务只负责在每次编辑后调用 `recomputeCustomMatches` 让它保持最新。

7.（T14.x 可选，默认不做：需要同时改契约和前端）新接口 `GET /api/characters/danbooru-matches`：返回 `{ characterId, candidates: [{ danbooruTag, name, workName, postCount }] }[]`，数据来自 `custom_character_matches`（`dismissed = 0`）+ `describeTag`。现在前端的提示是「在角色的『编辑』里关联即可」，不做这个接口也能用。

8.（可选，默认关闭）绑定标签后回填：`character_suggestions` 中该标签且 `score >= tagger.autoAcceptThreshold` 的图自动 `INSERT OR IGNORE INTO image_characters (..., origin) VALUES (..., 'tagger')`，放在同一个撤销记录里。

### 坑
- aliases 表没有外键：删角色要手动删别名，撤销时要恢复。
- 合并时改标签注意 UNIQUE(danbooru_tag)：先清 from 的标签再设目标；撤销记录顺序见第 5 步。
- `searchKey` 会去掉括号后缀：`mika_(blue_archive)` 和 `mika_(idolmaster)` 的 key 都是 `mika`，匹配时必须按作品过滤候选（T11 的 matcher 已经做了）。
- 所有写操作都在 `ctx.mutate` 里完成（一个事务 + 撤销记录），不要在事务外零散写库。`recomputeCustomMatches` 自己开事务，放在 mutate 之后调用。
- 提示文案照抄 mock。

### 验收标准
- 把 `T14` 加进 `SQLITE_READY`，`npx vitest run contract` 两边通过（characters.mutations 契约）：新建（重复标签 409、作品不存在 404、空名 400）、修改各字段、pinned 排到最前、合并后 from 消失且目标张数 = 两者图集合并集大小、合并提示里的张数。
- sqlite 专属（`npx vitest run characters`）：每个操作「执行 → 撤销」后 `dumpCore(db)` 与执行前完全相同；合并带标签的角色进另一个有标签的角色后 `catalog.resolveCharacterId(被合并的标签) === targetId`；`insertDanbooruCharacter` 新建了作品时，撤销后作品和它的别名也不在了。
- 自建匹配（测试库）：插入 `tag_i18n('mika_(blue_archive)', 4, NULL, '[]', 'blue_archive', 16024)` 和 `tag_name_keys('mika', 'mika_(blue_archive)', 'tag', 'dict')`（导入了 T12 词库的库里本来就有），新建自建角色「Mika」、作品选 danbooru_tag = `blue_archive` 的作品 → `GET /api/stats` 的 customMatchableCount = 1；把作品换成别的 → 0。

### 难度
M

## T15 未识别队列与采纳建议

### 目标
- `listUnrecognized`：顺序与 mock 一致，用**键集分页**（采纳后下一页不会漏图）。
- `acceptSuggestion`：必要时新建角色，可撤销。
- 完善 T05 建的 `loadSuggestions`：没有对应角色的建议也显示中文名和作品名。

### 依赖
T05（`loadImageItems`、`loadSuggestions`）、T10（`CharacterCatalog.describeTag`）、T13、T14（`insertDanbooruCharacter`）、T19。T17 完成后接上排除规则（M3 顺序里 T17 在 T15 之后，先留 `// TODO(T17)`）。

### 涉及文件
- `apps/server/src/datasource/sqlite/suggestions.ts`（T05 已建，本任务完善）
- `apps/server/src/datasource/sqlite/unrecognized.ts`（新）

### 实现步骤
1. `loadImageItems(db, ids)`：T05 已实现，直接复用（返回顺序 = ids 顺序；`status`、`dominantColor`、`source` 的映射以 T05 为准）。

2. 完善 `loadSuggestions`（SQL 不变，见 T05 第 3 步；签名改成 `loadSuggestions(ctx, imageIds, catalog: CharacterCatalog)`，catalog 用 T11 第 12 步的 `makeCatalog().catalog`，同一个请求里只建一次）。映射（对照 mock 的 `suggestionsFor`）：
   - 有对应角色（含合并重定向）→ `name = 角色名`，`workName = 角色第一个作品名 ?? null`；
   - 没有 → `const d = catalog.describeTag(tag)`：`name = d.name`（T12 之后是中文名，之前是 humanize），`workName = d.workName`；
   - `characterId = toId(...) | null`；`score`。

3. `listUnrecognized({ cursor, limit })`（mock 顺序：有建议的在前，组内入库时间倒序；再加 id 倒序保证稳定）：
```sql
SELECT * FROM (
  SELECT i.id, i.added_at,
         EXISTS (SELECT 1 FROM character_suggestions s WHERE s.image_id = i.id) AS h
  FROM v_counted_images i
  WHERE NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id)
)
WHERE :h IS NULL
   OR h < :h
   OR (h = :h AND (added_at < :a OR (added_at = :a AND id < :i)))
ORDER BY h DESC, added_at DESC, id DESC
LIMIT :take;      -- take = limit + 1，多取一条判断是否有下一页
```
游标 = `encodeCursor({ h, a: added_at, i: id })`（本页最后一条；首页三个参数都传 null）；校验函数检查 `h` 是 0/1、`a` 是字符串、`i` 是正整数。limit 默认 60，夹在 1..200。total：
```sql
SELECT COUNT(*) FROM v_counted_images i WHERE NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id);
```
（必须等于 `stats.unrecognizedCount`。）items = `{ image, suggestions, tagged: tagged_at !== null }`，用批量函数，一页只查几次库。
为什么不用偏移分页：用户在这个页面不断采纳，图离开列表后偏移分页的下一页会跳过同样数量的图；前端失效后 TanStack Query 会用新数据逐页重新计算游标，键集分页天然正确。

4. `acceptSuggestion(imageId, danbooruTag)`：
   - 事务外：图片必须可见（`SELECT 1 FROM v_images WHERE id = ?`）否则 `NotFoundError('图片')`；tag trim 后为空 → `BadRequestError('标签不能为空')`；查这条建议的 score（没有则 null）。
   - `ctx.mutate` 里：
     1. `u.set('character_suggestions', 'image_id = ? AND danbooru_tag = ?', [imageId, tag])`；
     2. `characterId = catalog.resolveCharacterId(tag)`；没有 → `insertDanbooruCharacter(ctx, u, catalog, tag, { coverImageId: imageId, now })`（新角色封面 = 这张图；和 T10 自动采纳一样会按 copyright 挂作品，必要时新建作品——这点和 mock 不同，mock 不建作品；撤销时一并删除）；
     3. `INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, 'manual', ?, ?)`；`changes === 1` 时记录 `u.sql('DELETE FROM image_characters WHERE image_id = ? AND character_id = ?', [imageId, characterId])`；
     4. `DELETE FROM character_suggestions WHERE image_id = ? AND danbooru_tag = ?`；
     5. T17 完成后调用 `applyExclusionRules(ctx, { imageIds: [imageId] })`（新角色可能命中「角色」排除规则），并先 `u.columns('images', ['excluded_by'], [imageId])`。
   - 提示：新建 → `已新建角色「${name}」并归入`；否则 `已归到「${name}」`（mock 原文）。

### 坑
- 游标里的 `h` 是整数（better-sqlite3 返回的 EXISTS 是 0/1 数字），`a` 是字符串；比较类型要一致。
- 不要在同一层 SELECT 的 WHERE 里引用 EXISTS 的别名，用子查询包一层（上面的写法）。
- 采纳后删除这条建议（mock 保留；领域定义是「还没被采纳的建议」）——有意差异。
- 新建角色不要调 T14 的 `createCharacter`（那是自建角色逻辑，提示也不同），用 `insertDanbooruCharacter`。
- 禁止在循环里逐张查库。

### 验收标准
- 把 `T15` 加进 `SQLITE_READY`，`npx vitest run contract` 两边通过（unrecognized 契约）：首页顺序（有建议的在前、入库时间倒序）；`limit=5` 翻完所有页无重复无遗漏且数量 = total = stats.unrecognizedCount；采纳已有角色 / 新角色（提示文案、unrecognizedCount 减 1、新角色出现在 listCharacters）；撤销后恢复原状。
- sqlite 专属：边翻页边采纳每页第一张，最终遍历到的图集合 = 初始未识别集合（证明不漏）。
- T22 性能库：`GET /api/unrecognized?limit=60` 首页与第 20 页 p95 < 100ms。

### 难度
M

## T16 查重（sha256 完全重复 + dHash 相似 + BK-tree，resolve/ignore）

> 近邻搜索改用多索引哈希（MIH），不用 BK-tree。理由见「关键技术决策 → 相似查重」。

### 目标
后台任务 `dedupe`：
- **完全重复**：同一个 sha256 的计入张数的图片 ≥ 2 张 → `kind: 'exact'`，similarity 1
- **相似**：64 位 dHash（T04 已经算好）汉明距离 ≤ 阈值（`settings.dedupe.hammingThreshold`，默认 8，实际生效值限制在 0..16），用并查集连成组 → `kind: 'similar'`，similarity = 1 − 组内最大两两距离 / 64
- 和已有的组对账：已忽略、已处理的不重复报；过时的未处理组删掉
- 实现 `listDuplicates`、`resolveDuplicate`（保留选中的，其余移到回收站）、`ignoreDuplicate`

### 为什么用 MIH
本机（Node 24）实测 10 万条 64 位哈希（70% 随机 + 30% 近似重复）、阈值 8：
- BK-tree：平均每次查询访问 44,819 个节点，总查询时间 **601 秒**（不可用）
- MIH（切成 4 段 16 位，每段在半径 ⌊T/4⌋ 内枚举）：平均候选 417 个，总时间 **1.8 秒**；T=12 为 7.5 秒；T=16 为 24 秒

原理（Norouzi 等人的 Multi-Index Hashing）：64 位切成 4 段，两条哈希距离 ≤ T，则至少有一段的距离 ≤ ⌊T/4⌋（鸽巢原理）→ 对每段建 65536 个桶的倒排表，查询时枚举 popcount ≤ ⌊T/4⌋ 的掩码。结果是**精确**的，不会漏。

### 依赖
- T04（`images.dhash`；`thumbs.ensure` 给已删除的图显示缩略图）、T05（`hydrateImages`）、T07（Pipeline 的 dedupe 阶段）、T18 第 1–2 步（`moveToRecycleBin`、`assertRecyclable`；M3 顺序里 T18 在 T16 之前）、T19（ignore 的撤销）
- T13 的 `getStats.duplicateGroupCount` 口径与这里的 `listDuplicates` 一致

### 涉及文件
- 新建 `apps/server/src/services/dedupe/hamming.ts`：`popcount32`、`parseDHash`、`findSimilarPairs`（MIH）
- 新建 `apps/server/src/services/dedupe/unionFind.ts`
- 新建 `apps/server/src/services/dedupe/pickKeep.ts`
- 新建 `apps/server/src/services/dedupe/DedupeService.ts`：`run(ctx)`
- 修改 `SqliteDataSource.ts`：`listDuplicates`、`resolveDuplicate`、`ignoreDuplicate`；在 open 里 `pipeline.register({ dedupe })`
- 新建 `apps/server/scripts/dedupe-once.ts`、`apps/server/scripts/bench-dedupe.ts`
- 测试：`hamming.test.ts`、`pickKeep.test.ts`、`DedupeService.test.ts`

### 实现步骤

#### 1. `hamming.ts`
```ts
export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}
export const parseDHash = (hex: string): [number, number] => [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0];

/** 对 hi/lo 数组里所有距离 ≤ T 的对（a < b）调用 onPair。T 必须在 0..16 */
export function findSimilarPairs(hi: Uint32Array, lo: Uint32Array, T: number, onPair: (a: number, b: number, d: number) => void): void {
  const N = hi.length, R = Math.floor(T / 4);
  const chunk = (i: number, k: number) => (k === 0 ? hi[i]! & 0xffff : k === 1 ? hi[i]! >>> 16 : k === 2 ? lo[i]! & 0xffff : lo[i]! >>> 16);
  const masks: number[] = []; for (let m = 0; m < 65536; m++) if (popcount32(m) <= R) masks.push(m);
  const tables = [0, 1, 2, 3].map((k) => {                       // CSR 倒排表：cnt 是前缀和，ids 按桶排列
    const cnt = new Uint32Array(65537); for (let i = 0; i < N; i++) cnt[chunk(i, k) + 1]!++;
    for (let v = 0; v < 65536; v++) cnt[v + 1]! += cnt[v]!;
    const pos = cnt.slice(), ids = new Uint32Array(N); for (let i = 0; i < N; i++) ids[pos[chunk(i, k)]!++] = i;
    return { cnt, ids };
  });
  const seen = new Int32Array(N).fill(-1);
  for (let q = 0; q < N; q++) for (let k = 0; k < 4; k++) {
    const c = chunk(q, k), { cnt, ids } = tables[k]!;
    for (const m of masks) { const v = c ^ m;
      for (let p = cnt[v]!; p < cnt[v + 1]!; p++) { const j = ids[p]!;
        if (j <= q || seen[j] === q) continue; seen[j] = q;
        const d = popcount32((hi[q]! ^ hi[j]!) >>> 0) + popcount32((lo[q]! ^ lo[j]!) >>> 0);
        if (d <= T) onPair(q, j, d);
      } }
  }
}
```

#### 2. `pickKeep.ts`：推荐保留哪一张
排序键依次为：像素数 `width*height` 降序 → `bytes` 降序 → 文件名**不像副本**的优先（`/(\s\(\d+\)|\s*-\s*(副本|复制|copy)(\s*\(\d+\))?)$/i` 作用于去掉扩展名的文件名）→ `added_at` 升序 → id 升序。

#### 3. `DedupeService.run(ctx)`
1. 读取候选（计入张数的图）：
```sql
SELECT i.id, i.sha256, i.dhash, i.width, i.height, i.bytes, i.added_at, i.file_name FROM v_counted_images i
```
2. 按 sha256 分桶：成员 ≥ 2 的桶就是完全重复的簇。每个 sha 选一个代表（有 dhash 的）进入相似搜索，N 因此变小。
3. 相似搜索：代表数组 → `hi`、`lo`；跳过低信息量的哈希（`popcount(hi)+popcount(lo) ≤ 4` 或 `≥ 60`，也就是纯色 / 空白图）；`T = clamp(readSettings(db).dedupe.hammingThreshold, 0, 16)`；`findSimilarPairs` 的回调里再加一道宽高比检查：`Math.abs(Math.log((w1/h1)/(w2/h2))) > 0.15` 的对不连边；通过的对做 `union(a, b)`。
4. 组装分组：并查集连通分量（展开成它们 sha 桶里的所有图片）∪ 纯完全重复的簇。分量超过 30 张时丢弃并计数（多半是误报，比如同一模板的图）。`kind`：全部同 sha → 'exact'，否则 'similar'。`similarity`：exact 为 1；similar 为 `1 - maxPairDist / 64`（组内两两计算，同 sha 的距离算 0）。`suggestedKeepId = pickKeep(members)`。
5. 对账（一个事务里做）：
```sql
SELECT g.id, g.resolved_at, g.ignored, group_concat(m.image_id) AS members
FROM duplicate_groups g JOIN duplicate_members m ON m.group_id = g.id GROUP BY g.id
```
   在 JS 里把成员排序后拼成 key。对每个新组：已有同 key 的组 → 未处理的就更新 `kind / similarity / suggested_keep_id`，已处理或已忽略的就跳过；成员是某个 `ignored = 1` 组成员的**子集** → 跳过；否则 `INSERT` 新组和成员（`created_at = now`）。最后把没有匹配上的**未处理**旧组删掉（已处理的保留作历史）。
6. 进度：`ctx.setTotal(代表数)`，每 1000 个 `advance`；开始前检查 `ctx.shouldYield()`（为 true 时 `ctx.requeue()` 并返回「已让出给扫描」）；最后 emit `library-changed`。返回 `查找重复：12 组（完全重复 5，相似 7）· 3 张还没有感知哈希`。

#### 4. 三个接口
`listDuplicates({ resolved = false })`：
```sql
SELECT id, kind, similarity, suggested_keep_id, resolved_at, ignored FROM duplicate_groups
WHERE (@resolved = 1 AND resolved_at IS NOT NULL) OR (@resolved = 0 AND resolved_at IS NULL AND ignored = 0)
ORDER BY created_at DESC, id DESC
```
成员用 `SELECT m.group_id, ${IMAGE_COLS} FROM duplicate_members m JOIN images i ON i.id = m.image_id JOIN library_roots r ON r.id = i.root_id WHERE m.group_id IN (SELECT value FROM json_each(?))` 一次查出，再用 `hydrateImages` 转换。未处理的组只保留可见成员（在 `v_images` 里），少于 2 张就不返回；已处理的组保留全部成员（包括已删除的，缩略图从缓存出）。`suggestedKeepId` 不在可见成员里时重新 `pickKeep`。`resolved: resolved_at != null`。（返回结构以 `DuplicateGroup` 类型为准，对照 mock。）

`resolveDuplicate(id, keepIds)`：组不存在 → NotFound('重复组')；keepIds 为空 → BadRequest('至少保留一张')；keepIds 不是组成员的子集 → BadRequest。要删的 = 可见成员 − keepIds → 对涉及的根逐个 `assertRecyclable` → `moveToRecycleBin`（T18，带删除后校验）→ 成功的 `UPDATE images SET trashed_at = @now`。全部成功才 `UPDATE duplicate_groups SET resolved_at = @now`。提示 `已保留 ${keep} 张，${ok} 张移到回收站`，有失败时追加 `，${fail} 张失败（文件可能被占用）`。**undoToken 为 null**（回收站没法用程序还原，文案里提示「可在系统回收站还原」）；如果一张都没删（全部保留），就用 `ctx.mutate` 返回一个能撤销 resolved_at 的 undo。
`ignoreDuplicate(id)`：`ctx.mutate`：`u.columns('duplicate_groups', ['ignored', 'resolved_at'], [id])`，`UPDATE duplicate_groups SET ignored = 1, resolved_at = @now`（和 mock 一样会出现在「已处理」里）；提示「已标记为「不是重复」」。

### 坑
- **不要用 BK-tree**：实测 10 万条、阈值 8 要 10 分钟。
- 位运算一律 `>>> 0` 转成无符号，popcount 里用 `Math.imul`，避免精度和符号问题。
- 同一 sha 的多行只选一个代表进 MIH，否则完全重复会让候选数暴涨。
- 纯色 / 空白图的 dHash 接近全 0，会把大量无关图片连成一片 → 低信息量过滤 + 分量上限 30。
- 并查集的传递性会把 A~B、B~C 连成一组（A、C 可能距离 16）：similarity 用最大两两距离，如实显示，让用户判断。
- 阈值上限 16：API 允许到 64，但 T > 16 时 MIH 候选暴涨，而且结果本身已没有意义。
- 对账时 group_concat 的顺序不确定，要在 JS 里排序后再比较。
- resolve 必须依赖 T18 的「删除后校验」，不能在 `trash()` resolve 之后就认定成功。

### 验收标准
1. `npx vitest run apps/server/src/services/dedupe`：
   - `hamming.test.ts`：`popcount32(0xffffffff) === 32`；`findSimilarPairs` 在 2000 条随机哈希上，T=0/4/8/12/16 的结果与 O(N²) 暴力法完全一致
   - `pickKeep.test.ts`：同尺寸同大小时 `a.png` 胜过 `a (1).png` 和 `a - 副本.png`；分辨率高的胜出
   - `DedupeService.test.ts`（`:memory:`）：对账逻辑——重跑不重复插入；ignored 组的子集不再上报；过时的未处理组被删除
2. 基准：`npx tsx apps/server/scripts/bench-dedupe.ts` 对 10 万条（30% 近似重复）T=8 → 打印耗时 < 5 秒（本机实测核心循环约 1.8 秒）。
3. fixtures（T04 验收用过的库，扫描的是原样的 `fixtures-lib`）：
```powershell
$env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t04'
npx tsx apps/server/scripts/dedupe-once.ts
```
   输出恰好 2 组：exact {`98765432_p0.jpg`, `98765432_p0 - 副本.jpg`}，similarity 1，推荐保留前者；similar {`123456789_p0.png`, `123456789_p0 (1).png`, `resized_A.jpg`}，similarity ≥ 0.85，推荐保留 `123456789_p0.png`。（「恰好 2 组」依赖 T03 make-fixtures 的「图案分配规则」：其余每张图都用独有种子。如果多出别的组，先检查 make-fixtures 是否复用了图案，而不是去调阈值。）
4. HTTP：`GET /api/duplicates` 返回 2 组；`POST /api/duplicates/<id>/ignore` 之后在 `?resolved=true` 里可见；重新跑 dedupe 后该组不再出现在未处理列表里。
5. 在 fixtures 的**副本**上（`npx tsx apps/server/scripts/make-fixtures.ts F:/Claude/emaki/data/fixtures-t16`，用单独的 `EMAKI_DATA_DIR`）resolve 相似组（保留 1 张）：另外 2 个文件出现在 Windows 回收站，`GET /api/images` 的 total −2，`GET /api/stats` 的 duplicateGroupCount −1。

### 难度
L

### 给实现模型的提示
- `findSimilarPairs` 直接照上面的代码写（已实测），先用暴力法对拍。
- 分三层：纯算法（hamming、unionFind、pickKeep）→ 分组（纯函数，输入行数组，输出组数组）→ 写库对账。前两层都能不连数据库测试。
- 测 resolve 时一定用 fixtures 的副本目录，别用用户的真实图库。

## T17 排除规则（image/folder/tag/character，扫描新图时也要应用）

### 目标
- 实现 `listExclusions / createExclusion / deleteExclusion`（image / folder / tag / character 四种），可撤销，提示文案与 mock 一致。
- 提供 `applyExclusionRules()`：扫描到新图（T03）、打完标签（T10）、采纳建议（T15）后调用，让规则对新数据也生效。
- 提供 `createExclusionInTx()`，T18 批量排除复用。

### 依赖
T01（`exclude_exempt` 列）、T02（`normalizeRootPath`）、T19。

### 涉及文件
- `apps/server/src/datasource/sqlite/exclusions.ts`（新）
- `SqliteDataSource.ts`（3 个方法 + 把规则接进 T03 / T10 / T15 的钩子）

### 实现步骤
1. 完整路径表达式（盘符根目录 `D:/` 已带结尾斜杠）：
```ts
export const FULL_PATH_SQL = `CASE WHEN substr(r.path, -1) = '/' THEN r.path || i.rel_path ELSE r.path || '/' || i.rel_path END`;
```
2. 各类规则的谓词（i = images，r = library_roots）：
```ts
function predicate(kind: ExclusionKind): string {
  switch (kind) {
    case 'image':     return `i.id = CAST(:target AS INTEGER)`;
    case 'folder':    return `substr(lower(${FULL_PATH_SQL}), 1, length(:prefix)) = lower(:prefix)`;   // :prefix = 规范化路径 + '/'
    case 'tag':       return `EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = i.id AND t.name = :target)`;
    case 'character': return `EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id AND ic.character_id = CAST(:target AS INTEGER))`;
  }
}
```
3. 应用规则（导出）：
```ts
/** 按 created_at 顺序把现有规则应用到指定图（不传 imageIds = 全部）；返回新排除的张数。必须在事务内调用。 */
export function applyExclusionRules(ctx: SqliteContext, scope: { imageIds?: number[] } = {}): number
```
每条规则执行：
```sql
UPDATE images SET excluded_by = :eid
WHERE excluded_by IS NULL AND exclude_exempt = 0
  AND id IN (SELECT i.id FROM images i JOIN library_roots r ON r.id = i.root_id
             WHERE <predicate>
               AND (:scope IS NULL OR i.id IN (SELECT value FROM json_each(:scope))));
```
4. `listExclusions()`（mock：created_at 倒序；imageCount 与预览只看可见的图，包括被排除的）：
```sql
SELECT e.id, e.kind, e.target, e.label, e.created_at,
       (SELECT COUNT(*) FROM v_images v WHERE v.excluded_by = e.id) AS image_count
FROM exclusions e ORDER BY e.created_at DESC, e.id DESC;
-- 每条规则的预览（最多 4 张）
SELECT id FROM v_images WHERE excluded_by = ? ORDER BY added_at DESC, id DESC LIMIT 4;
```
（返回字段以 `Exclusion` 类型为准，对照 mock。）
5. `createExclusion({ kind, target })`：
   - `target.trim()` 为空 → `BadRequestError('排除目标不能为空')`。
   - 按 kind 得到规范化 target 与 label（mock 文案）：`tag` → `标签 · ${t}`；`folder` → `normalizeRootPath(t)`（不要求文件夹存在）→ `文件夹 · ${p}`，`prefix = p.endsWith('/') ? p : p + '/'`；`character` → 角色必须存在（`NotFoundError('角色')`）→ `角色 · ${name}`；`image` → 图片必须可见（`NotFoundError('图片')`）→ `单张 · ${file_name}`。
   - `(kind, target)` 已存在 → `ConflictError('已经有这条排除规则了')`。
   - mutate 里：`INSERT INTO exclusions (kind, target, label, created_at) VALUES (?, ?, ?, ?)` → `u.inserted('exclusions', eid)`；`kind === 'image'` 时先 `u.columns('images', ['exclude_exempt'], [imageId])` 再 `UPDATE images SET exclude_exempt = 0 WHERE id = ?`（用户明确要排除它）；然后执行第 3 步的 UPDATE（只针对这一条规则；与 mock 一样对全库生效，包括回收站里的图）；再记录 `u.sql('UPDATE images SET excluded_by = NULL WHERE excluded_by = ?', [eid])`（撤销逆序：先把图还原，再删规则）。
   - 提示：`已排除：${label}（${n} 张）`，n = UPDATE 的 `changes`。
   - 把「规范化 + 插入 + 应用 + 记录撤销」抽成导出函数 `createExclusionInTx(ctx, u, kind, target): { eid: number; label: string; changed: number }`，T18 批量排除复用（多张图一个撤销记录）。
6. `deleteExclusion(id)`：不存在 → `NotFoundError('排除规则')`。mutate 里：
   - `affected = SELECT id FROM images WHERE excluded_by = ?`；`u.columns('images', ['excluded_by'], affected)`；`u.set('exclusions', 'id = ?', [id])`；
   - `UPDATE images SET excluded_by = NULL WHERE excluded_by = ?`；`DELETE FROM exclusions WHERE id = ?`；
   - `applyExclusionRules(ctx, { imageIds: affected })`：同时被其他规则覆盖的图（例如也在被排除的文件夹里）继续保持排除。**这是与 mock 的有意差异**（mock 全部恢复），契约夹具里不要放重叠规则。
   - 提示：`已恢复：${label}（${n} 张）`，n = affected.length。
7. 接线（本任务负责把钩子接上）：
   - T03 扫描：`new Scanner({ …, onNewImagesInTx: (ids) => applyExclusionRules(ctx, { imageIds: ids }) })`（folder 规则）。
   - T10 打标签：`createTagStage({ …, afterBatchInTx: (ids) => applyExclusionRules(ctx, { imageIds: ids }) })`（tag / character 规则）。
   - T15 采纳建议：把 T15 留的 `// TODO(T17)` 换成真实调用。
   - T18 批量：`exclude` = 对每张图调 `createExclusionInTx(kind='image')`，全部放在一个 mutate 里；`restore` 见 T18。

### 坑
- 文件夹前缀匹配**不要用 LIKE**：路径中的 `_` / `%` 是通配符。用 substr + lower。
- SQLite 的 lower() 只处理 ASCII，对中文路径没影响，符合 Windows 不区分大小写的习惯。
- 一张图只记一个 excluded_by（先到先得），删规则时必须重新应用其余规则。
- `exclusions.target` 是 TEXT，image / character 类型存数字字符串，比较时 `CAST(:target AS INTEGER)`。
- SQL 中出现的具名参数都要在对象里提供（值可以是 null），例如 `{ eid, target, prefix: null, scope: null }`。

### 验收标准
- 把 `T17` 加进 `SQLITE_READY`，`npx vitest run contract` 两边通过（exclusions 契约）：四种规则各建一次，imageCount 与夹具预期一致；stats.imageCount 相应减少、excludedCount 增加；listImages 默认不返回被排除的图、`status=excluded` 能列出；删规则恢复；每步都可撤销（sqlite 另测 `dumpCore` 一致）。
- sqlite 专属（`npx vitest run exclusions`）：先建 folder 规则 A，再建与之重叠的 tag 规则 B；删除 A 后，B 范围内的图仍被排除（excluded_by = B）。
- 路径含下划线的规则 `F:/tmp/a_b` 不会误伤 `F:/tmp/axb` 里的图。
- 新扫描进来的、位于被排除文件夹里的图直接是 excluded（Scanner 钩子生效）。

### 难度
M

### 给实现模型的提示
- 先写 `predicate` 与 `applyExclusionRules` 并单测，再写 3 个方法。

## T18 批量操作与回收站（bulkImages，移到系统回收站而不是删除）

### 目标
实现 `bulkImages({ ids, action })` 的全部 7 种动作，语义和提示文案与 `MockDataSource.bulkImages` 一致：assign、unassign、exclude、restore、favorite、rating 可撤销；`trash` 把文件移到 **Windows 回收站**（绝不永久删除），并逐个确认删除成功。同时提供可复用的 `moveToRecycleBin` 服务（T16 resolve 也用）。

### 依赖
- T05（`requireVisibleImages`、`toAbs`）、T17（`createExclusionInTx`、`exclude_exempt` 规则）、T19（`ctx.mutate`）

### 涉及文件
- 新建 `apps/server/src/services/trash/recycleBin.ts`：`moveToRecycleBin`、`chunkPaths`
- 新建 `apps/server/src/services/trash/driveType.ts`：`assertRecyclable(rootPath)`
- 修改 `SqliteDataSource.ts`：`bulkImages`
- 测试：`recycleBin.test.ts`、`driveType.test.ts`
- 依赖：`npm i trash@^10.1.1 -w @emaki/server`（纯 ESM，没有安装脚本，不需要 approve-scripts）

### 调研要点（写代码前必读）
- `trash` 10.1.1 在 Windows 上会调用包里自带的 `lib/windows-trash.exe`（sindresorhus/recycle-bin），每 200 个路径 `execFile` 一次。
- 这个 exe 用 `IFileOperation` 加 `FOFX_RECYCLEONDELETE | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOFX_EARLYFAILURE`；它的 `PreDeleteItem` 在「不能进回收站」时返回 `E_ABORT` → **不会永久删除**。这点是安全的。
- 但是 trash 10.1.1 自带的 exe 是 **recycle-bin 2.0.0**（没有 2.1.0 才加的 subst 盘处理）。2.0.0 有已知问题 #9「删除失败时静默、没有错误输出」。→ **`trash()` resolve 不代表成功，必须逐个检查文件是否还在。**
- `trash()` 的 `glob` 选项**默认是 true**：`[pixiv] a[1].png` 这类文件名会被当成通配符，可能匹配到别的文件。→ **一定要传 `{ glob: false }`**。
- 不存在的路径会被静默忽略。
- Windows 命令行最长 32767 字符：200 个长路径会超长 → 自己按总长度分块。
- 打包成 Electron（T23 可选部分）时，exe 在 app.asar 里执行不了，需要 `asarUnpack: ['node_modules/trash/lib/windows-trash.exe']`。

### 实现步骤

#### 1. `driveType.ts`
```ts
const cache = new Map<string, string>();
/** U 盘 / 网络盘没有回收站：提前拒绝，给出明确提示（exe 本身也会拒绝，这里是为了更好的提示文案） */
export async function assertRecyclable(rootPath: string): Promise<void> {
  if (process.platform !== 'win32') return;
  if (/^(\/\/|\\\\)/.test(rootPath)) throw new BadRequestError('网络路径没有回收站，已拒绝删除（避免永久删除）');
  const letter = /^([a-zA-Z]):/.exec(rootPath)?.[1]?.toUpperCase(); if (!letter) return;
  let type = cache.get(letter);
  if (!type) {
    try {
      const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `[System.IO.DriveInfo]::new('${letter}:').DriveType.ToString()`], { windowsHide: true, timeout: 10_000 });
      type = stdout.trim();                       // Fixed / Removable / Network / CDRom / Ram / Unknown（.NET 枚举名，不受系统语言影响）
    } catch { type = 'Fixed'; }                   // 查询失败时放行：exe 自己也不会永久删除
    cache.set(letter, type);
  }
  if (type !== 'Fixed') throw new BadRequestError(`${letter}: 盘（${type}）没有回收站，已拒绝删除（避免永久删除）`);
}
```

#### 2. `recycleBin.ts`
```ts
import trash from 'trash';
export interface TrashResult { trashed: string[]; alreadyGone: string[]; failed: { path: string; reason: string }[] }
/** 按命令行长度分块：总长 ≤ maxChars，并且每块 ≤ maxCount 个 */
export function chunkPaths(paths: string[], maxChars = 28_000, maxCount = 50): string[][] { /* ... */ }

export async function moveToRecycleBin(absPaths: string[], impl: (p: string[], o: { glob: false }) => Promise<void> = trash): Promise<TrashResult> {
  const res: TrashResult = { trashed: [], alreadyGone: [], failed: [] };
  const existing: string[] = [];
  for (const p of absPaths) (await exists(p) ? existing : res.alreadyGone).push(p);
  for (const chunk of chunkPaths(existing)) {
    let err: unknown = null;
    try { await impl(chunk, { glob: false }); } catch (e) { err = e; }
    for (const p of chunk) {                       // 逐个核实：文件还在 = 失败（被占用 / 没有回收站 / exe 静默失败）
      if (await exists(p)) res.failed.push({ path: p, reason: err instanceof Error ? err.message : '文件可能被其他程序占用' });
      else res.trashed.push(p);
    }
  }
  return res;
}
```
`exists` 用 `fs.promises.access`，ENOENT 为 false，其他错误视为存在。

#### 3. `bulkImages`
公共部分：ids 去重 → `parseId` → `requireVisibleImages(ids)`（任意一个不可见或不存在 → `NotFoundError('图片')`，**不做任何改动**，和 mock 一样）；`n = ids.length`；可撤销的动作在 `ctx.mutate((u) => …)` 里改库；`trash` 走第 4 步。`@ids = JSON.stringify(数字数组)`，`@now = new Date().toISOString()`。每个 action 写成一个私有方法，返回 `{ message }`，撤销记录用下表「撤销记录」一列的 UndoRecorder 调用。

| action | SQL | 撤销记录（UndoRecorder） | 提示（和 mock 一致） |
|---|---|---|---|
| assign | 先确认角色存在（NotFound('角色')）；`INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at) SELECT value, @cid, 'manual', NULL, @now FROM json_each(@ids)` | 先查出这次真正要新插入的 image_id；插入后 `u.sql('DELETE FROM image_characters WHERE character_id = ? AND image_id IN (SELECT value FROM json_each(?))', [cid, 新插入的 ids])` | `已将 ${n} 张图归到「${name}」` |
| unassign | `DELETE FROM image_characters WHERE character_id=@cid AND image_id IN (SELECT value FROM json_each(@ids))` | 删除前 `u.set('image_characters', 'character_id = ? AND image_id IN (SELECT value FROM json_each(?))', [cid, ids])`（原样插回，保留 origin / score） | `已从「${name}」移除 ${n} 张图` |
| exclude | 只处理 `excluded_by IS NULL` 的图：对每张调用 T17 的 `createExclusionInTx(ctx, u, 'image', String(id))`（它会写规则、应用、记录撤销） | 由 `createExclusionInTx` 记录 | `已排除 ${n} 张图` |
| restore | 先 `u.columns('images', ['excluded_by', 'exclude_exempt'], ids)`；对每张图：excluded_by 指向 kind='image' 的规则 → `u.set('exclusions', 'id = ?', [eid])` 后删除该规则；否则（被文件夹 / 标签 / 角色规则排除）→ `exclude_exempt = 1`（规则重新应用时不再排除它）；最后 `UPDATE images SET excluded_by = NULL WHERE id IN (json_each)` | 左列里的 columns + set | `已恢复 ${n} 张图` |
| favorite | `UPDATE images SET favorite=@v WHERE id IN (json_each)` | `u.columns('images', ['favorite'], ids)` | `已收藏 ${n} 张图` / `已取消收藏 ${n} 张图` |
| rating | `UPDATE images SET rating=@v, rating_manual=1 WHERE id IN (json_each)` | `u.columns('images', ['rating', 'rating_manual'], ids)` | `已把 ${n} 张图设为 ${value}` |
| trash | 见下 | 无（undoToken 为 null） | 见下 |

restore 的撤销：T19 按原 id 插回被删除的规则。如果在撤销之前又新建了规则并恰好复用了同一个 id（SQLite 会复用最大的 rowid），撤销会按 T19 的规则报冲突「无法撤销：相关的数据已经变了」并整体回滚——可以接受，不要自己做 id 重映射。

#### 4. trash
1. 查出这些图的 `abs = toAbs(root.path, rel_path)`，按根分组，对每个涉及的根执行 `await assertRecyclable(root.path)`（任一失败 → 400，不做任何删除）
2. `const r = await moveToRecycleBin(abs 列表)`
3. `trashed ∪ alreadyGone` 对应的 id：`ctx.write(() => { UPDATE images SET trashed_at=@now WHERE id IN (json_each); return 文案 })`
4. 一张都没成功 → 抛 `ConflictError('没有文件被移到回收站：' + 第一条失败原因)`（409，前端 toast 显示错误）
5. 文案：`已把 ${ok} 张图移到回收站（可在系统回收站还原）`，有失败时追加 `，${failed} 张失败（文件可能被其他程序占用）`；`undoToken: null`
6. 用户以后从回收站还原文件 → T08 监听 / 扫描发现同路径、同大小、同 mtime 的文件 → 清掉 trashed_at，**原来的 id、角色、收藏都还在**

#### 5. 可选子步骤 T18.x：可撤销删除（先不做，记下来）
先 `rename` 到同一卷上的 `<root>/.emaki-trash/<id>_<name>`（同盘改名，瞬间完成；扫描器会跳过点开头的目录），撤销时改回去；撤销条目过期（UndoStack 淘汰）或进程退出时再批量 `moveToRecycleBin`；启动时把残留的暂存文件送进回收站。这样 trash 也能 Ctrl+Z，代价是更复杂。

### 坑
- `glob: false` 必须传（见调研要点）。
- 不能相信 `trash()` 的返回，要**逐个 `access` 验证**。
- 自己分块，别依赖 trash 内部的 200 个一批（超过命令行长度会导致 spawn 失败）。
- 被 sharp 或我们自己的读流占用的文件删不掉：T04 已设置 `sharp.cache(false)`；删除前不要在同一请求里读文件。
- U 盘、网络盘没有回收站：`assertRecyclable` 提前拒绝；万一放行了，exe 的 `PreDeleteItem` 也会中止，再由验证步骤报失败。**绝不能退化成 `fs.unlink`**。
- 以 SYSTEM 或服务账户运行时，文件会进那个账户自己的回收站；本应用以当前用户身份运行，没有问题，不要把后端做成 Windows 服务。
- 5000 个 id 用 json_each 一条 SQL 搞定，不要循环执行 5000 条语句（exclude 的 `createExclusionInTx` 是每张一条规则，这是 mock 的语义，可以接受）。

### 验收标准
1. `npm run typecheck` 通过；`npx vitest run apps/server/src/services/trash`：
   - `chunkPaths`：60 个 600 字符的路径 → 每块总长 ≤ 28000 且每块 ≤ 50 个；空数组 → `[]`
   - `moveToRecycleBin` 注入假的 impl：impl 静默不删除 → 结果里全是 failed；impl 删掉一半 → trashed / failed 各一半；不存在的路径 → alreadyGone；确认调用时 `glob` 为 false
   - `assertRecyclable`：`//nas/share` 与 `\\nas\share` 抛错；本机 `C:` 通过
2. 手工（sqlite 模式，**图库根指向单独生成的副本**）：
```powershell
npx tsx apps/server/scripts/make-fixtures.ts F:/Claude/emaki/data/fixtures-t18
$env:EMAKI_DATA_SOURCE='sqlite'; $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t18'; npm run dev:server
# 另开终端：把 fixtures-t18 加为图库并等扫描完成，然后：
$ids = (Invoke-RestMethod 'http://127.0.0.1:5174/api/images?limit=3').items.id
$body = @{ ids = $ids; action = @{ type = 'trash' } } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post http://127.0.0.1:5174/api/images/bulk -ContentType 'application/json' -Body $body
```
   （`action` 的具体结构以 `BulkImagesBody` 为准。）返回「已把 3 张图移到回收站（可在系统回收站还原）」，undoToken 为 null；这 3 个文件出现在回收站里（「原位置」正确）；`/api/images` 的 total −3。在回收站里「还原」→ 几秒后（T08）或下次扫描后，3 张图以原来的 id 回来，收藏状态没丢。
3. 文件锁：`$f = [System.IO.File]::Open('<某张图>', 'Open', 'Read', 'None')` 独占打开后再 trash 这张图 → 409 或文案里「1 张失败」，这张图仍然可见；`$f.Close()` 之后重试成功。
4. 文件名带方括号和逗号的那张（`插画, 测试 [1].png`）能被正确删除，同目录的其他文件不受影响。
5. 其余 6 种动作：把 `T18` 加进 `SQLITE_READY`，bulk 契约两边通过；执行后 `POST /api/undo/<token>` 之后与执行前的 `GET /api/images/<id>` 完全一致（逐字段比较，包括 characterIds、status、favorite、rating），sqlite 另测 `dumpCore` 一致。
6. ids 里混进一个不存在的 id → 404，其他图没有任何变化。
7. 如果手边有 U 盘：把 U 盘上的目录加为根 → trash → 400，提示「没有回收站」，文件还在。

### 难度
M

### 给实现模型的提示
- 先写 `recycleBin.ts` 和测试（注入假 impl），再接 `bulkImages`。
- 测试删除时只动 fixtures 副本；不要在用户的真实图库上跑验收。

## T19 撤销（SQLite 版：反向操作 / 快照）

### 目标
给 sqlite 数据源一套通用的「修改前快照 → 放进 UndoStack → 撤销时逆序恢复」机制：所有可撤销的修改都经过 `ctx.mutate()`（一个事务 + 自动收集撤销数据）；实现 `undo(token)`。

### 依赖
T01。**M3 第一个做**（T14 / T15 / T16 / T17 / T18 都依赖它）。

### 设计
- 撤销数据只存内存（沿用 `core/undo.ts` 的 UndoStack：最多 50 条、重启清空）。
- 不用触发器、不用 session 扩展（better-sqlite3 没有暴露 session API）：修改前快照 + 逆序恢复，简单可测。
- 四种记录：
  1. `columns(table, cols, ids)`：修改前记下这些行的这些列 → 撤销 = 逐行 `UPDATE ... SET col = 旧值 WHERE id = ?`（只用于有 `id` 主键的表）；
  2. `set(table, where, params)`：修改前记下满足条件的整行集合 → 撤销 = `DELETE FROM table WHERE where` + 逐行 `INSERT` 写回（链接表、被删除的行都用它）；
  3. `inserted(table, id)`：插入新行后记录 → 撤销 = `DELETE WHERE id = ?`；
  4. `sql(sql, params)`：自定义反向 SQL（例如 `UPDATE images SET excluded_by = NULL WHERE excluded_by = ?`，比快照 2 万行便宜）。
  另有 `onUndo(fn)`：非数据库的补偿，在数据库撤销事务提交后执行。
- 规则：**先记录子表，再记录父行**；撤销逆序执行，父行先恢复，子行外键不会失败。若恢复父行会和另一行的 UNIQUE 冲突，把冲突那一行的 `columns` 记录放在父行之后（见 T14 合并）。

### 涉及文件
- `apps/server/src/datasource/sqlite/undo.ts`（新）
- `apps/server/src/datasource/sqlite/context.ts`（加 `mutate` / `write`）
- `SqliteDataSource.ts`（`undo`）
- `apps/server/test/helpers/dump.ts`（新，给 T24 用）
- `apps/server/src/datasource/sqlite/undo.test.ts`（新）

### 实现步骤
1. `undo.ts`：
```ts
export type UndoTable = 'images' | 'characters' | 'works' | 'character_works' | 'aliases' | 'image_characters'
  | 'image_copyrights' | 'character_suggestions' | 'exclusions' | 'library_roots' | 'duplicate_groups'
  | 'duplicate_members' | 'danbooru_tag_redirects' | 'custom_character_matches';
type Row = Record<string, unknown>;
type Op =
  | { t: 'columns'; table: UndoTable; rows: Row[] }
  | { t: 'set'; table: UndoTable; where: string; params: unknown[]; rows: Row[] }
  | { t: 'inserted'; table: UndoTable; ids: number[] }
  | { t: 'sql'; sql: string; params: unknown[] };
export class UndoRecorder {
  private readonly ops: Op[] = [];
  private readonly after: (() => void | Promise<void>)[] = [];
  constructor(private readonly db: Db) {}
  columns(table: UndoTable, cols: string[], ids: number[]): void {
    if (!ids.length) return;
    const rows = this.db.prepare(`SELECT id, ${cols.join(', ')} FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as Row[];
    this.ops.push({ t: 'columns', table, rows });
  }
  set(table: UndoTable, where: string, params: unknown[] = []): void {
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...params) as Row[];
    this.ops.push({ t: 'set', table, where, params, rows });
  }
  inserted(table: UndoTable, id: number): void { this.ops.push({ t: 'inserted', table, ids: [id] }); }
  sql(sql: string, params: unknown[] = []): void { this.ops.push({ t: 'sql', sql, params }); }
  onUndo(fn: () => void | Promise<void>): void { this.after.push(fn); }
  get isEmpty(): boolean { return this.ops.length === 0 && this.after.length === 0; }
  /** 生成撤销函数：一个事务内逆序执行所有 op，然后逆序执行 onUndo 回调 */
  build(): () => Promise<void>
}
```
`build()` 的 apply：`columns` → 每行 `UPDATE table SET c1 = @c1, ... WHERE id = @id`；`set` → `DELETE FROM table WHERE where` 后逐行 `INSERT INTO table (列…) VALUES (@列…)`（列名取 `Object.keys(row)`）；`inserted` → `DELETE FROM table WHERE id IN (SELECT value FROM json_each(?))`；`sql` → `run(...params)`。整体 `db.transaction(() => { for (const op of [...ops].reverse()) apply(op); })()`；捕获 `err.code` 以 `SQLITE_CONSTRAINT` 开头的错误 → 抛 `ConflictError('无法撤销：相关的数据已经变了（例如图片已被删除）')`（事务已自动回滚，不会半撤销）。之后逆序 `await` 每个 after 回调。表名、列名都是代码里写死的白名单，不接收外部输入。
（`custom_character_matches` 的主键是 `character_id`，只能用 `set` / `sql` 记录，不能用 `columns` / `inserted`。）

2. `context.ts` 增加：
```ts
/** 所有可撤销修改的唯一入口 */
mutate<T extends { message: string }>(fn: (u: UndoRecorder) => T): MutationResult & Omit<T, 'message'>
/** 不可撤销的修改 */
write(fn: () => string): MutationResult
```
`mutate` 实现：
```ts
const u = new UndoRecorder(this.db);
const out = this.db.transaction(() => fn(u))();
this.touch();
const { message, ...rest } = out;
if (u.isEmpty) return { ...rest, ...done(message) };
const revert = u.build();
return { ...rest, ...this.undo.result(message, async () => { await revert(); this.touch(); }) };
```
`write`：`const msg = this.db.transaction(fn)(); this.touch(); return done(msg);`

3. `SqliteDataSource.undo(token) { return this.ctx.undo.run(token); }`（找不到 token → UndoStack 已抛 404「可能已过期」；以 `core/undo.ts` 的实际方法名为准）。

4. `test/helpers/dump.ts`：`dumpCore(db)` 按主键排序导出 images、characters、works、character_works、aliases、image_characters、image_copyrights、character_suggestions、exclusions、library_roots、duplicate_groups、duplicate_members、danbooru_tag_redirects、custom_character_matches 的全部行，用于「执行 → 撤销 → 状态相同」断言。

5.（可选）把 T02 的 updateLibraryRoot / removeLibraryRoot、T05 的 updateImage 改为 `ctx.mutate`，行为不变。

### 坑
- `fn` 必须是同步函数（better-sqlite3 事务里不能 await）；异步准备（stat 文件等）放在 mutate 之前，文件系统的补偿放 `onUndo`。
- `set()` 的 where 只能依赖「这次修改不会改到」的列（如 `character_id = ?`），否则撤销时 DELETE 的范围不对。
- 被 ON DELETE CASCADE 删掉的子行，必须在删父行之前用 `set()` 记下，否则撤销后子行丢失。
- 对同一范围记录两次没关系（逆序执行，最早的快照最后写回，结果就是最初状态）。
- 撤销旧操作会覆盖之后对同一行的修改（与 mock 相同的「后写赢」），可以接受。
- 上万行「整体归零」类反向操作优先用 `sql()`；5000 行以内用 `columns()` 没问题。

### 验收标准
- `npx vitest run apps/server/src/datasource/sqlite/undo`（内存库、临时表）：插入 / 改列 / 删父行（带级联子行）/ 自定义 sql 四种操作各自撤销后，表内容与操作前 deep equal；撤销前故意删掉被引用的父行 → 撤销抛 ConflictError 且库保持撤销前的状态。
- 契约测试中所有带 undoToken 的操作（T02 / T05 / T14 / T15 / T17 / T18）：执行 → `ds.undo(token)` → `dumpCore` 与执行前相同；同一 token 再撤销 → 404。
- 前端顶栏撤销按钮 / Ctrl+Z 在 sqlite 模式下可用。

### 难度
M

### 给实现模型的提示
- 代码量不大（约 120 行），但每个细节都被别的任务依赖：先把单元测试写好再给别人用。

## T20 搜索（别名表 + searchKey，角色/作品/标签）

### 目标
实现 `search({ q, limit })`（⌘K 命令面板）：角色、作品、标签三类结果，匹配与排序与 mock 完全一致（`searchKey` 子串匹配）；维护标签计数缓存 `tags.image_count`。

### 依赖
T13（Derived 中的 keys）；标签计数依赖 T10 写入的 image_tags；T07 的 Pipeline（`afterTag` 钩子）。

### 为什么在内存里匹配
- mock 的规则是 `searchKey(候选).includes(searchKey(q))`。SQL 的 `LIKE '%q%'` 本来就要全表扫，还要处理 `_` / `%` 转义与大小写差异；角色 / 作品最多几千到一万、tagger 标签全集约 1.1 万个，JS 扫一遍 < 5ms，且与 mock 逐条一致。
- aliases 表的 `search_key` 照样写（T10 / T14 已写），将来做前缀索引 / 拼音时用。

### 涉及文件
- `apps/server/src/datasource/sqlite/search.ts`（新）
- `apps/server/src/datasource/sqlite/derived.ts`（加标签列表缓存）
- `SqliteDataSource.ts`（`search`；`pipeline.register({ afterTag })`）

### 实现步骤
1. 标签计数（导出给 T10 / T17 / T18 调用）：
```ts
export function refreshTagCounts(ctx: SqliteContext): void
```
```sql
UPDATE tags SET image_count = 0 WHERE image_count <> 0;
UPDATE tags SET image_count = c.n
FROM (SELECT it.tag_id, COUNT(*) AS n
      FROM image_tags it JOIN v_counted_images i ON i.id = it.image_id
      GROUP BY it.tag_id) AS c
WHERE c.tag_id = tags.id;
```
（`UPDATE ... FROM` 需要 SQLite ≥ 3.33，better-sqlite3 13 自带 3.53。）调用时机：打标签任务结束（`pipeline.register({ afterTag: () => refreshTagCounts(ctx) })`）；排除规则 / 回收站变化后防抖 5 秒（`setTimeout` 合并多次调用）；启动时若 image_tags 非空但没有任何 image_count > 0。调用后让标签缓存失效。

2. Derived 增加 `generalTags: { name: string; key: string; count: number }[]`：
```sql
SELECT name, image_count FROM tags WHERE category = 'general' AND image_count > 0;
```
key = searchKey(name)。

3. `search({ q, limit = 20 })`：
```ts
const text = q.trim(); if (!text) return [];
const k = searchKey(text); if (!k) return [];
const d = derived.get();
const chars: SearchHit[] = [...d.characters.values()].filter((c) => c.keys.some((x) => x.includes(k)))
  .sort((a, b) => b.imageCount - a.imageCount || a.id - b.id).slice(0, limit)
  .map((c) => ({ type: 'character', character: toCharacter(c), workName: d.works.get(c.workIds[0] ?? -1)?.name ?? null }));
const works: SearchHit[] = [...d.works.values()].filter((w) => w.keys.some((x) => x.includes(k)))
  .sort((a, b) => b.imageCount - a.imageCount || a.id - b.id).slice(0, 5)
  .map((w) => ({ type: 'work', work: toWork(w) }));
const tags: SearchHit[] = d.generalTags.filter((t) => t.key.includes(k))
  .sort((a, b) => b.count - a.count).slice(0, 5)
  .map((t) => ({ type: 'tag', tag: t.name, imageCount: t.count }));
return [...chars, ...works, ...tags].slice(0, limit);
```
（mock：角色、作品都不过滤 0 张；标签只算 general 且张数 > 0。`SearchHit` 的字段以契约为准，对照 mock 的 `search`。）

4.（可选，建议做）拼音：`pinyin-pro@^3.29.4`，构建 keys 时给含中文的名字 / 别名额外加入全拼与首字母（`pinyin(name, { toneType: 'none', type: 'array' }).join('')`、`pinyin(name, { pattern: 'first', toneType: 'none', type: 'array' }).join('')`），让「weihua / wh」能搜到「未花」。只改 keys，不改 API；为保持契约一致，把生成拼音 key 的函数放在 `packages/shared` 并让 mock 的 `filterCharacters` 也用它。

### 坑
- 空查询、全空白、searchKey 后为空（例如只输入 `_`）都返回 `[]`。
- `workName` 取角色的**第一个**作品（position 0）。
- 不要每次搜索都查库：全部来自 Derived 缓存。

### 验收标准
- 把 `T20` 加进 `SQLITE_READY`，`npx vitest run contract`：search 契约两边一致：`未花`、`ミカ`、`みか`、`mika`、`Mika_(Blue_Archive)`、作品别名、`girl`（标签）、空串。
- T22 性能库：`GET /api/search?q=mi` p95 < 30ms。

### 难度
S

# M4 收尾

> M4 的推荐顺序：T21 → T22 → T23 → T24 阶段 B。

## T21 前端切换到真实数据 + 首次启动引导

### 目标
1. 前端数据调用一行不改，只靠后端配置从 mock 切到 sqlite；默认数据源改为 sqlite，mock 改用 `npm run dev:mock`。
2. 没有任何图库文件夹时进入「首次使用引导」`/welcome`：选文件夹 → 识别设置 → 开始整理（实时进度）。
3. 新增 `POST /api/system/pick-folder`：由后端弹出 Windows 原生「选择文件夹」对话框（浏览器拿不到绝对路径）。

这是唯一需要改前端的任务。**界面必须有设计感**：沿用现有的「绘卷」视觉语言（暖灰纸色画布 + 纸张卡片 + 朱色点缀 + 衬线数字），和现有页面放在一起不能看出是后加的。

### 依赖
T02、T07（任务进度）、T13；页面依赖前端已有的 `components/ui`。端到端验收最好在 M1–M3 都完成后。

### 涉及文件
- `apps/server/src/config.ts`、`apps/server/package.json`、根 `package.json`、`.env.example`（**已存在**，按第 1 步更新）、`.claude/launch.json`
- `apps/server/src/system/pickFolder.ts`（新）、`apps/server/src/routes/system.ts`、`apps/server/src/app.ts`（health 字段）
- `packages/shared/src/api.ts`（新类型 `HealthResponse`、`PickFolderResponse`）
- `apps/web/src/lib/api.ts`、`lib/queries.ts`（`useHealth`）
- `apps/web/src/features/onboarding/WelcomePage.tsx`（新）
- `apps/web/src/features/settings/components/LibraryRootsEditor.tsx`（新）：**从现有的 `LibrarySection.tsx` + `AddFolderDialog.tsx` 里抽出来**，设置页改为使用它，不要另写一份
- `apps/web/src/features/settings/components/AboutSection.tsx`（版本号、数据目录改读 `useHealth`，删掉写死的 `APP_VERSION` / `DATA_DIR`）
- 文案：`features/gallery/components/SelectionBar.tsx`、`components/media/lightbox/InfoPanel.tsx`、`features/duplicates/components/ResolveAllDialog.tsx`（见第 8 步）
- `apps/web/src/router.tsx`、`components/layout/AppShell.tsx`、`components/layout/Sidebar.tsx`

### 实现步骤
1. `config.ts`（在定义 config 对象**之前**加载 .env）：
```ts
try { process.loadEnvFile(path.join(repoRoot, '.env')); }
catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
// 优先级：命令行 --mock > 环境变量 > 默认 sqlite
dataSource: (process.argv.includes('--mock') ? 'mock' : (process.env.EMAKI_DATA_SOURCE ?? 'sqlite')) as DataSourceKind,
```
（本机实测：`loadEnvFile` 不覆盖已存在的环境变量；文件不存在抛 ENOENT。）确认 `dataDir` / `modelsDir` 的相对路径是按 `repoRoot` 解析的（T09.2 已改；没改就在这里改：`path.resolve(repoRoot, process.env.EMAKI_DATA_DIR ?? 'data')`），否则 `.env` 里的 `EMAKI_DATA_DIR=./data` 会落到 `apps/server/data`。`.env.example`（已存在）改为列出 `EMAKI_DATA_SOURCE`、`EMAKI_DATA_DIR`、`EMAKI_MODELS_DIR`、`EMAKI_PORT`、`EMAKI_HOST`、`EMAKI_LOG_LEVEL`、`EMAKI_HTTP_PROXY`、`HF_ENDPOINT`，每个一行中文注释。同步更新 `docs/ARCHITECTURE.md` 的「配置」一节（默认数据源已改成 sqlite）。

2. 脚本：`apps/server/package.json` 加 `"dev:mock": "tsx watch --clear-screen=false src/index.ts --mock"`；根加 `"dev:mock": "concurrently -k -n server,web -c magenta,cyan \"npm:dev:mock -w @emaki/server\" \"npm:dev -w @emaki/web\""`；`.claude/launch.json` 增加 `emaki-mock` 配置（`npm run dev:mock`，port 5173）。npm scripts 在 Windows 下跑在 cmd.exe，`FOO=bar cmd` 写法不可用，所以用 `--mock` 参数。

3. `/api/health` 返回 `{ ok: true, dataSource, version, dataDir }`（version 读根 package.json；dataDir = `config.dataDir`，只监听 127.0.0.1，返回本机路径没有问题）；shared 加 `export interface HealthResponse { ok: true; dataSource: 'mock' | 'sqlite'; version: string; dataDir: string }`；前端 `api.health()` + `useHealth()`（staleTime Infinity）；Sidebar 底部在 mock 模式显示小 `Badge`「演示数据」；设置页「关于」的版本号和数据目录改读 `useHealth()`（FRONTEND.md「需要后端配合的改进」里 `/api/about` 那一条就用这个解决，不另开接口）。

4. `system/pickFolder.ts`：
```ts
let busy = false;
export async function pickFolder(): Promise<string | null> {
  if (process.platform !== 'win32') throw new BadRequestError('当前系统不支持，请直接粘贴文件夹路径');
  if (busy) throw new ConflictError('已经打开了一个选择窗口');
  busy = true;
  try {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$d.Description = '选择存放插画的文件夹'",
      '$d.ShowNewFolderButton = $false',
      'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
      '$owner.Dispose()',
    ].join('; ');
    // -EncodedCommand 要 UTF-16LE 的 Base64：中文和引号都不用转义
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000 });
    return stdout.trim() || null;
  } finally { busy = false; }
}
```
路由 `app.post('/api/system/pick-folder', async () => ({ path: await pickFolder() }))`（不经过 DataSource，mock 与 sqlite 通用）；shared 加 `export interface PickFolderResponse { path: string | null }`；前端 `api.pickFolder()`。

5. `LibraryRootsEditor`（设置页「图库文件夹」一节与引导页共用；从现有 `LibrarySection.tsx` / `AddFolderDialog.tsx` 重构出来，设置页的外观和行为保持不变，只是多了「浏览…」按钮）：
   - 一行：`Input`（placeholder `D:\Pictures\插画`，回车 = 添加）+ `Button` ghost「浏览…」（调 pickFolder，拿到路径直接添加）+ 墨色主按钮「添加」。400 错误文案显示在输入框下方（`text-danger` 小字），不弹 toast。
   - 列表每行：路径（可截断，title 显示全路径）、`formatCount(imageCount)` 张、上次扫描 `formatRelative`、`Switch` 启用、`IconButton label="移除"`（带撤销 toast）。所有修改走 `useMutate`。

6. 引导页 `/welcome`（顶级路由，放在 AppShell 之外：`{ path: 'welcome', element: <WelcomePage /> }`）：
   - **SSE 订阅**：现在 `useServerEvents()` 只在 `AppShell` 里调用，放在 AppShell 之外的页面收不到 job 事件，第三步的进度条不会动。`WelcomePage` 顶部也要调用一次 `useServerEvents()`（两个页面不会同时挂载，不会重复订阅）。
   - 版式：`bg-canvas` 满屏，中间一张 `bg-sheet` 圆角纸（`max-w-[960px]`、`rounded-[var(--radius-sheet)]`、`shadow-[var(--shadow-sheet)]`）。左栏 260px 竖排三个步骤：大号 `numeral` 数字「一 / 二 / 三」+ 步骤名，当前步骤前一个朱色（`bg-shu`）小圆点，已完成步骤用 `text-fg-subtle`；右栏是当前步骤内容，切换时 `animate-rise`。顶部小字「絵巻 Emaki」，标题「把你的插画收进来」（`text-[28px] font-semibold tracking-tight`），副标题 `text-fg-muted`「Emaki 只读取文件：不会移动、改名或上传任何图片。」
   - 一「选择文件夹」：`LibraryRootsEditor`；至少一个文件夹后「下一步」可用。说明：可添加多个；子文件夹一起扫描；移动硬盘拔掉后图片只是暂时隐藏，不会删除记录。
   - 二「识别设置」：`Switch`「用显卡加速识别（DirectML）」→ tagger.device dml / cpu；`Segmented`「识别严格度」宽松 / 平衡（默认）/ 严格 → characterThreshold 0.25 / 0.35 / 0.5，autoAcceptThreshold 0.75 / 0.85 / 0.92；`Switch`「联网同步 Danbooru 标签资料」（界面上默认打开，保存时写入 `danbooru.enabled`；说明：只发送标签名、下载公开的标签信息，用来把角色归到作品、支持别名搜索，不上传图片）；`Switch`「敏感分级默认模糊」默认开。点「下一步」时一次 `api.updateSettings`。
   - 三「开始整理」：列出 `useLiveJobs` 中的任务（扫描 → 缩略图 → 识别，按 JobKind 显示中文名），每个一条细的朱色进度条 + `progress / total`；右侧大号 `numeral` 显示 `useStats().imageCount`（SSE 自动刷新）；一个次要按钮「开始识别角色」（`api.startJob('tag')`，首次会下载约 1.3 GB 模型，按钮下方小字说明）；主按钮「进入 Emaki」随时可点（任务在后台继续）→ `navigate('/')`。没有任务在跑且 imageCount = 0 时提示「这个文件夹里没有找到图片（支持 jpg / png / webp / gif / avif / bmp）」并给「返回上一步」。
   - 禁止 emoji、紫色渐变、居中大 hero；只用语义 token（见 docs/FRONTEND.md）。亮色 / 暗色两种主题都要检查一遍。

7. 跳转守卫（AppShell）：`const settings = useSettings().data; if (settings && settings.libraryRoots.length === 0) return <Navigate to="/welcome" replace />;`。这行 `return` 必须放在 AppShell **所有 hook 调用之后**（`useServerEvents()`、`useGlobalHotkeys()` 等），否则违反 React hooks 规则（设置从空变成非空时 hook 数量变化会报错）。已有文件夹时直接访问 `/welcome` 也允许停留（方便从设置页重新打开）；mock 模式有两个假文件夹不会被跳转，调试引导页直接访问 `/welcome`。

8. 切换核查清单（sqlite 模式下逐项点一遍，问题记给对应任务）：
   - `Get-ChildItem apps/web/src -Recurse -Include *.ts,*.tsx | Select-String -Pattern "'(w|c|i|x|root)[0-9]+'"` 无结果（前端没有写死 mock id；本机不一定装了 rg）；
   - **回收站文案**：sqlite 版的「移到回收站」和「重复 → 保留选中，其余移到回收站」**不能撤销**（undoToken 为 null，见 T16 / T18），但前端现在写着「移到系统回收站（可撤销）」（`SelectionBar.tsx`、`lightbox/InfoPanel.tsx`）和「提示里的『撤销』可以把这些组一次性恢复原样」（`ResolveAllDialog.tsx`）。改成按 `useHealth().dataSource` 区分：sqlite 时写「移到系统回收站（可在回收站里还原）」，ResolveAllDialog 的说明改为「文件会移到系统回收站，可以在回收站里还原；这一步不能在 Emaki 里撤销」；`undoAll` 在 tokens 为空时不显示「撤销」按钮（现有代码已经这样判断，确认一下）；
   - 空库时每个页面显示 EmptyState 而非报错；有数据时没有 501；
   - 缩略图响应是 `image/webp`；原图能打开；「在资源管理器中显示」可用；
   - 撤销（toast 按钮与 Ctrl+Z）可用；重启后数据与设置都在；
   - 扫描过程中页面不会疯狂闪烁（依赖 T22 的事件节流）。

9. **FRONTEND.md「需要后端配合的改进（做 T21 时一起处理）」逐条处置**（那张表是前端作者留给 T21 的，本任务必须对每一行有明确结论；「默认不做」的保持前端现状即可，但要在 FRONTEND.md 那张表里加一列「处置」写上结论）：

   | FRONTEND.md 里的一行 | 处置 |
   |---|---|
   | 「能对上 Danbooru」不知道是哪几个角色 | 默认不做：点击仍跳 `/characters?source=custom`；完整方案是 T14.x 的 `GET /api/characters/danbooru-matches` |
   | 「最近在收」角色数要多发一个请求 | 默认不做（本地请求很便宜）。要做就给 `LibraryStats` 加 `recentCharacterCount`（shared → mock → sqlite 的 T13 getStats → 前端），并补契约用例 |
   | 未识别「其中 N 张有建议」只能从已加载数据里数 | **做**（改动小）：`ListUnrecognizedResponse = Page<UnrecognizedItem> & { suggestedCount: number }`；sqlite 用 `SELECT COUNT(DISTINCT s.image_id) FROM character_suggestions s JOIN v_counted_images i ON i.id = s.image_id WHERE NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id)`；mock 同口径；前端副标题改读它 |
   | 需要新建角色的建议不能批量采纳 | 默认不做（前端逐张调 `acceptSuggestion`） |
   | 重复「全部按推荐处理」逐组调用 | 默认不做：sqlite 的 resolve 本来就不可撤销（第 8 步已改文案），合并成一个接口没有收益 |
   | 已处理的组不知道当时保留了哪张 | 默认不做 |
   | 排除页预览图要单独请求详情拿分级和主色 | 默认不做；若 T22 发现排除页请求过多再加 `Exclusion.previewImages` |
   | 版本号、数据目录写死在前端 | **做**：第 3 步的 `HealthResponse.version / dataDir` |
   | 添加文件夹只能手输路径 | **做**：T02 已校验路径存在；第 4 步的 `pick-folder` |
   | 选 GPU 时不知道 DirectML 是否可用 | 默认不做：T09 失败会自动回退 CPU，并在任务消息里说明 |
   | `startJob` 返回 `Job`，页面各自包了一层 | **做**（纯前端）：`lib/queries.ts` 加 `useStartJob()`，把首页 / 设置 / 未识别 / 重复里各自的包装换掉 |

   改了 `packages/shared` 的（`suggestedCount`、`HealthResponse`、`PickFolderResponse`）按「契约三处一起改」：shared → 后端路由 / 两个数据源 → 前端 `lib/api.ts`，`npm run typecheck` 必须通过。

### 坑
- PowerShell 5.1 默认输出编码不是 UTF-8，必须在脚本里设 `[Console]::OutputEncoding`，否则中文路径乱码。
- 对话框可能被浏览器挡住：用 TopMost 的 owner 窗体；若 `windowsHide: true` 时对话框不出现，改成 false（会闪一下控制台）。
- WinForms 对话框必须 `-STA`。
- 浏览器的 `<input type="file" webkitdirectory>` 拿不到绝对路径，别用。
- 引导跳转要等 settings 加载完再判断，避免闪一下首页。

### 验收标准
- `$env:EMAKI_DATA_DIR='F:/Claude/emaki/data/empty'; npm run dev`（默认即 sqlite）→ 打开 http://localhost:5173 自动跳到 `/welcome`。
- 点「浏览…」弹出系统对话框，选择含中文的文件夹（用户提供的本地插画目录）→ 路径正确出现在列表；手动粘贴带引号的路径也能添加。
- 完成三步 → 进度条随扫描推进 → 进入首页能看到图；重启后不再进入引导。`GET /api/settings` 里的阈值和 `danbooru.enabled` 与引导里选的一致。
- `npm run dev:mock` 仍是演示数据，侧栏显示「演示数据」。
- 设置页「关于」显示的版本号 = 根 `package.json` 的 version，数据目录 = 实际的 `EMAKI_DATA_DIR`（例如上面的 `F:\Claude\emaki\data\empty`）。
- 未识别页副标题「其中 N 张 tagger 有建议」的 N = `(Invoke-RestMethod 'http://127.0.0.1:5174/api/unrecognized?limit=1').suggestedCount`；unrecognized 契约（T24）加一条 `suggestedCount` 断言，mock 与 sqlite 两边通过。
- sqlite 模式下看图器 / 多选栏里「移到回收站」的提示不再写「可撤销」。
- `npm run typecheck` 通过；`npm run build` 通过。
- 截图：亮色和暗色下的引导页三步各一张，放进 `docs/screenshots/`（`welcome-1.png` … `welcome-3-dark.png`）。

### 难度
M

## T22 性能（10 万张图：索引、分页、计数缓存）

### 目标
在 10 万张图 / 5000 角色 / 800 作品 / 约 250 万条 image_tags 的库上：
- 列表类接口（`/api/images` 首页与深翻页及各种筛选、`/api/characters`、`/api/works`、`/api/unrecognized`、`/api/exclusions`、`/api/search`、`/api/stats`、`/api/characters/:id`）缓存热时 **p95 < 100ms**（多数应 < 50ms）；
- 修改后的第一次请求（派生缓存重建）< 500ms；
- 服务进程内存 < 500MB。

### 依赖
T05、T13、T15、T17、T20 已实现（本任务 = 测量 + 调优）。

### 涉及文件
- `apps/server/scripts/gen-perf-db.ts`、`apps/server/scripts/bench.ts`（新）
- `apps/server/src/db/migrations/008_perf_indexes.sql`（新）
- `apps/server/src/datasource/sqlite/derived.ts`、`context.ts`（缓存分级、计数缓存、事件节流）
- T05 的 listImages（按需调整）

### 实现步骤
1. 造数据 `gen-perf-db.ts`（`npx tsx apps/server/scripts/gen-perf-db.ts --images 100000 --out F:/Claude/emaki/data/perf`）：
   - 用 `migrate()` 建库，然后一个事务里用预编译语句批量插入；伪随机固定种子（mulberry32），结果可复现。
   - 分布：1 个 root（路径不存在没关系）；入库时间跨 3 年、越近越多；5000 角色按 Zipf 分布（少数角色几千张）；每张图 0–3 个角色（约 25% 未识别）；800 作品，每个角色 1–2 个作品；标签词表 1.1 万、每张图 25 个 general 标签；3% 的图被 3 条规则排除；1% 在回收站；200 个重复组；未识别图中一半有 1–3 条建议。
   - 60 秒内完成，最后 `PRAGMA optimize`。
2. 测量 `bench.ts`（`npx tsx apps/server/scripts/bench.ts F:/Claude/emaki/data/perf`）：
   - `SqliteDataSource.open(bus, dir, { autoJobs: false })` + `buildApp(ds, bus)`，用 `app.inject()` 请求（不走网络）。
   - 每个场景预热 5 次、测 50 次，输出表格：场景 / p50 / p95 / max / 预算；任一 p95 超预算则 `process.exitCode = 1`。
   - 场景与预算（ms）：images 首页 60；深翻页（沿 nextCursor 翻 30 页后的一页）60；`characterId=<最大角色>` 60；`workId=<最大作品>` 80；`rating=explicit` 60；`orientation=landscape` 60；`favorite=true` 60；`q=girl` 100；`sort=fileName` 60；`sort=bytes&order=asc` 60；characters 首页 50；characters `q=mi` 50；works 30；stats 50；unrecognized 首页 80；exclusions 50；search `q=mi` 30；`characters/:id` 50；执行一次 PATCH 后的第一个 characters 请求 500。
3. 索引 `008_perf_indexes.sql`（以 EXPLAIN QUERY PLAN 为准调整）：
```sql
-- 图片列表键集分页：排序列 + id；部分索引只含「活着」的图
CREATE INDEX idx_images_live_added    ON images(added_at, id)    WHERE trashed_at IS NULL AND missing = 0;
CREATE INDEX idx_images_live_modified ON images(modified_at, id) WHERE trashed_at IS NULL AND missing = 0;
CREATE INDEX idx_images_live_bytes    ON images(bytes, id)       WHERE trashed_at IS NULL AND missing = 0;
CREATE INDEX idx_images_live_name     ON images(file_name COLLATE NOCASE, id) WHERE trashed_at IS NULL AND missing = 0;
DROP INDEX IF EXISTS idx_images_added;
-- 覆盖索引：按角色找图、按标签找图不回表
CREATE INDEX idx_ic_character_image    ON image_characters(character_id, image_id);
CREATE INDEX idx_image_tags_tag_image  ON image_tags(tag_id, image_id);
DROP INDEX IF EXISTS idx_image_tags_tag;
CREATE INDEX idx_duplicate_members_image   ON duplicate_members(image_id);
CREATE INDEX idx_character_suggestions_tag ON character_suggestions(danbooru_tag);
```
检查：`db.prepare('EXPLAIN QUERY PLAN ' + sql).all(params)`，默认列表（sort=addedAt desc）必须出现 `USING INDEX idx_images_live_added` 且**没有** `USE TEMP B-TREE FOR ORDER BY`。部分索引只有当查询 WHERE 字面包含 `trashed_at IS NULL AND missing = 0` 才会用到——T05 的 `VISIBLE` 常量满足，不要改写这两个条件。
4. 对 T05 listImages 的要求（不满足就改）：
   - 键集分页：`ORDER BY <col> <dir>, id <dir>`，游标格式保持 T05 的 `[排序值, id]`，条件 `(col < :v OR (col = :v AND id < :i))`（asc 用 `>`）；`random` 用 `ORDER BY ((id * 2654435761) % 4294967296), id` + 偏移分页（稳定即可）。
   - 文件名排序用 `file_name COLLATE NOCASE`（SQLite 做不到 localeCompare，与 mock 顺序有差异，属预期）。可选：新增 `images.name_sort` 列（数字段左补零的自然排序键，扫描时写入），让 `p2 < p10`。
   - `total`：同样的 WHERE 做 `COUNT(*)`，走第 6 步的计数缓存。
   - q：标签部分先在内存（T20 的标签缓存）找出 key 含 q 的 tag id，再 `EXISTS (SELECT 1 FROM image_tags it WHERE it.image_id = i.id AND it.tag_id IN (SELECT value FROM json_each(:tagIds)))`；文件名部分保持和 mock 一致的 `instr(search_key(i.file_name), :qk) > 0`。如果这一项超预算，在 008 迁移里加 `images.name_key` 列（= `searchKey(file_name)`，扫描器插入 / 改名时写入，迁移里用 `UPDATE images SET name_key = search_key(file_name)` 回填），查询改用 `instr(i.name_key, :qk)`。
5. 派生缓存分级（`derived.ts`）：
   - `entities`（角色 / 作品 / 别名 / 名字索引）：只在角色、作品、别名变化时失效；
   - `stats`（张数、newCount、封面、作品统计、标签计数列表）：任何图片 / 关联 / 排除 / root 变化都失效；
   - `ctx.invalidate(scope, { soft })`：后台任务（扫描 / 打标签）每提交一批调用 `invalidate('stats', { soft: true })`——只标记过期，读取时若距上次重建 < 3 秒就先返回旧数据，否则重建；用户操作（mutate）永远硬失效。
6. 计数缓存：`Map<string, { gen: number; total: number }>`（LRU 最多 100 条），key = 去掉 cursor / limit / sort / order 后的查询参数 JSON，gen = stats 代数。
7. 事件节流 `ctx.emitChanged(reason)`：后台任务调用时最多每 3 秒发一次 `library-changed`（尾部触发，最后一次一定发出）；用户操作仍立即发。把 T03 / T04 / T10 里各自的节流代码换成它。前端收到后会让**所有** query 失效并逐页重拉已加载的页面，任务期间频繁发事件会把服务压垮。
8. 维护：打开时 `PRAGMA optimize=0x10002`、每小时 `PRAGMA optimize`（T01 已做）；首次大批量扫描结束后再跑一次 `PRAGMA optimize`。
9. 若第 2 步「修改后首个请求」仍 > 500ms：把 Derived 的统计重建放进 `worker_threads`，用只读连接计算（WAL 允许并发读），主线程先返回旧数据。这是最后手段，先用前面的办法。

### 坑
- 图片分页不要用 OFFSET：第 50 页要先跳过 6000 行，且前端每次失效都会逐页重拉。
- 键集分页的排序表达式必须与索引一致（包括 COLLATE），否则用不上索引。
- 带 q 的 `COUNT(*)` 很贵，必须走计数缓存。
- better-sqlite3 是同步的：任何 > 50ms 的查询都会卡住整个服务（包括 SSE 心跳和缩略图请求），所以预算这么严。
- 性能库没有对应图片文件，缩略图 404 正常。

### 验收标准
```powershell
npx tsx apps/server/scripts/gen-perf-db.ts --images 100000 --out F:/Claude/emaki/data/perf   # < 60s
npx tsx apps/server/scripts/bench.ts F:/Claude/emaki/data/perf                              # 全部 p95 在预算内，退出码 0
npx tsx apps/server/scripts/db-info.ts F:/Claude/emaki/data/perf                            # user_version = 8（M5 的 005、006、007 之后）
```
- `$env:EMAKI_DATA_SOURCE='sqlite'; $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/perf'; npm run dev`：图库页快速滚到底、切换筛选无明显卡顿；任务管理器中 node 进程内存 < 500MB。
- `npx vitest run contract` 仍然全绿（调优没有改变行为）。
- 把 bench 结果表写进 `docs/PERF.md`。

### 难度
L

## T23 一键启动与打包（Windows 启动脚本 / 可选 Electron）

### 目标
- 普通用户：双击仓库根目录 `start.bat` → 检查 Node → 按需安装依赖 → 按需构建前端 → 以 sqlite 模式启动后端（后端同时托管前端）→ 就绪后自动打开浏览器；已在运行时只打开浏览器。
- 开发者：`npm start` 做同样的事（跨平台脚本）。
- 本地服务的安全加固（只接受本机页面的请求）。
- 可选：Electron 桌面壳（以后再做）。

### 依赖
T21（默认 sqlite、引导页）；其他功能任务不必全部完成。

### 涉及文件
- `start.bat`（新）、`scripts/start.mjs`（新，纯 JS，不需要 tsx）
- 根 `package.json`、`.gitattributes`（T12 可能已建，合并）、`README.md`
- `apps/server/src/app.ts`（安全钩子）

### 实现步骤
1. `start.bat`（**只用 ASCII 字符**，CRLF 换行）：
```bat
@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [Emaki] Node.js was not found. Install Node.js 24 LTS from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)
node scripts/start.mjs %*
if errorlevel 1 pause
```
2. `scripts/start.mjs`（ESM，只用 Node 内置模块）：
   1. Node 主版本 < 22 → 中文提示（推荐 24 LTS）后 `process.exit(1)`。
   2. 依赖：`package-lock.json` 的 sha256 与 `node_modules/.emaki-install-hash` 比较；不同或不存在 → `npm install`，成功后写入 hash。
   3. 前端构建：取 `apps/web/src/**`、`apps/web/index.html`、`apps/web/vite.config.ts`、`packages/shared/src/**` 的最大 mtime，与 `apps/web/dist/index.html` 比较；更新或不存在 → `npm run build`。`--rebuild` 强制构建。
   4. 已在运行：`fetch('http://127.0.0.1:5174/api/health', { signal: AbortSignal.timeout(800) })` 成功 → 打开浏览器后退出 0。端口被其他程序占用 → 提示在 `.env` 里改 `EMAKI_PORT`。
   5. 启动后端：`spawn('npm', ['run', 'start', '-w', '@emaki/server'], { stdio: 'inherit', shell: true, env: { ...process.env, EMAKI_DATA_SOURCE: process.env.EMAKI_DATA_SOURCE ?? 'sqlite', UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? '8' } })`；`--mock` 参数改为 mock。（`UV_THREADPOOL_SIZE=8`：sharp 和文件读写共用 libuv 线程池，见 T04。）
   6. 每 300ms 探测 `/api/health`，最长 60 秒；就绪后打开浏览器：Windows `spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref()`（explorer 退出码是 1，忽略），macOS `open`，Linux `xdg-open`；`--no-open` 跳过。打印「Emaki 已启动：http://127.0.0.1:5174（关闭这个窗口即退出）」。
   7. 子进程退出时以相同退出码退出。
3. 根 `package.json`：`"start": "node scripts/start.mjs"`，`"start:server": "npm run start -w @emaki/server"`，`build` 保持。
4. `.gitattributes`（与 T12 的那一行合并）：
```
* text=auto
*.bat text eol=crlf
*.cmd text eol=crlf
*.ps1 text eol=crlf
*.sh  text eol=lf
*.json.gz binary
```
5. 安全加固（`app.ts`，注册路由之前）：
```ts
app.addHook('onRequest', async (req, reply) => {
  // 防 DNS rebinding：只接受本机 Host
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    return reply.code(403).send({ ok: false, error: '只允许本机访问', code: 'bad_request' });
  }
  // 防跨站 POST：写操作必须是 JSON（跨站页面发 JSON 会触发 CORS 预检并被拒绝）
  if (req.method === 'POST' && req.url.startsWith('/api/') && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
    return reply.code(415).send({ ok: false, error: '请求必须是 JSON', code: 'bad_request' });
  }
});
```
（错误体的字段以现有 `toApiError` 的格式为准。先确认前端 `api.ts` 的 `post` 总会带 JSON body 和 `content-type: application/json`，包括 `/api/characters/:id/seen`、`/api/undo/:id` 这类没有参数的 POST；不是的话在前端补上 `{}` body。fastify 默认会解析 text/plain，不加这条的话无 body 的 POST 可以被任意网页触发。）
6. README「一键启动」：克隆 / 下载 → 装 Node 24 LTS → 双击 `start.bat`；数据在 `data/`（备份就复制这个文件夹）；在 `.env` 里改端口 / 数据目录 / 代理；国内网络 `npm config set registry https://registry.npmmirror.com`。
7.（可选）桌面快捷方式：`scripts/create-shortcut.ps1` 用 `WScript.Shell` 在桌面创建「Emaki 絵巻.lnk」指向 `start.bat`（图标需另外从 favicon.svg 生成 .ico）。
8.（可选，以后再做）Electron 壳 `apps/desktop`：`electron@^44`、`electron-builder@^26`；把 `index.ts` 重构出 `startServer({ port: 0, dataDir })` 供主进程调用；用 esbuild 把后端打成 `dist/server.mjs`（`better-sqlite3`、`sharp`、`onnxruntime-node`、`trash` 设 external），并把 `src/db/schema.sql`、`migrations/` 和 `apps/server/assets/` 复制到产物旁（migrate 用 `import.meta.dirname` 找）；T09 的 tagger 子进程入口要改成编译后的 `host.js`；`asarUnpack` 包含 `**/*.node`、sharp / onnxruntime 目录和 `node_modules/trash/lib/windows-trash.exe`；dataDir 用 `app.getPath('userData')`。better-sqlite3 13 是 N-API，不需要 electron-rebuild。

### 坑
- Node ≥ 18.20.2 / 20.12.2 起，`spawn` 执行 `.cmd` / `.bat`（Windows 上 npm 就是 npm.cmd）必须 `shell: true`，否则 `EINVAL`。
- `.bat` 里写中文：cmd 按系统代码页（GBK）读批处理，UTF-8 中文会乱码甚至拆坏命令；所以 bat 只写英文，中文提示放 start.mjs。
- `.bat` 若被 git 转成 LF 换行，`goto` / 标签会出诡异错误，所以要 `.gitattributes`。
- 不要用 `start "" http://...` 打开网址（含 `&` 时会被 cmd 截断）；用 explorer.exe。
- 生产模式后端只监听 127.0.0.1，不要改成 0.0.0.0（局域网内任何人都能看你的图）。

### 验收标准
- 新目录 `git clone` 本仓库 → 双击 `start.bat`：自动 `npm install`、`npm run build`，浏览器打开 `http://127.0.0.1:5174` 并进入 `/welcome`。
- 关闭窗口 → 进程退出；再次双击：不再安装 / 构建，5 秒内打开浏览器；服务运行中再双击：只打开浏览器。
- 修改 `apps/web/src` 任意文件后双击 → 重新构建。
- `curl.exe -s -H "Host: evil.example" http://127.0.0.1:5174/api/health` → 403；`curl.exe -s -X POST http://127.0.0.1:5174/api/undo/x` → 415；前端所有操作正常（包括撤销、标记已看过）。

### 难度
M

## T24 测试（vitest：services 单元测试 + DataSource 契约测试 mock 与 sqlite 共用）

### 目标
- monorepo 统一的 vitest：`npm test` 跑全部。
- **DataSource 契约测试**：同一套用例分别跑在 MockDataSource 和 SqliteDataSource 上，结果（id 映射后）一致——这是「前端不改就能切到 sqlite」的保证。
- 开发种子：把 mock 的假数据导入 SQLite（开发、演示、测试共用）。
- GitHub Actions CI（Windows）。

### 分两阶段
- **阶段 A（紧接 T01 之后，属于 M0）**：第 1–6 步（vitest 骨架、mock 可注入与口径修正、种子、契约框架、第一批用例、`SQLITE_READY` 机制）。
- **阶段 B（随各任务补齐，M4 收尾）**：每个任务完成时把自己的编号加进 `SQLITE_READY`、把对应契约用例从 `it.todo` 改成真实用例；最后做第 7–10 步。

### 依赖
T01。

### 涉及文件
- 根 `package.json`、根 `vitest.config.ts`、`packages/shared/vitest.config.ts`、`apps/server/vitest.config.ts`
- `apps/server/src/datasource/mock/MockDataSource.ts`（构造参数、统计口径修正）
- `apps/server/src/datasource/sqlite/seed.ts`、`apps/server/scripts/seed-mock.ts`（新）
- `apps/server/test/fixtures/contract-db.ts`、`apps/server/test/contract/*.ts`、`apps/server/test/helpers/*.ts`（新）
- `.github/workflows/ci.yml`（新）

### 实现步骤
1. 安装与配置（仓库根目录执行，写入根 devDependencies）：
```powershell
npm install -D vitest@^5.0.2
```
（vitest 5.0.2：peer `vite ^6 || ^7 || ^8`，本仓库 vite 8；engines `node ^22.12 || ^24 || >=26`；没有安装脚本。）根 scripts：`"test": "vitest run"`、`"test:watch": "vitest"`。
根 `vitest.config.ts`（`workspace` 文件自 vitest 3.2 起废弃，用 `test.projects`）：
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { projects: ['packages/shared', 'apps/server'] } });
```
`packages/shared/vitest.config.ts`：`defineProject({ test: { name: 'shared', include: ['src/**/*.test.ts'] } })`
`apps/server/vitest.config.ts`：`defineProject({ test: { name: 'server', environment: 'node', include: ['src/**/*.test.ts', 'test/**/*.test.ts'], pool: 'forks', testTimeout: 20_000 } })`（原生模块用 forks 池更稳）。
之后所有任务都在仓库根目录用 `npx vitest run <路径片段>` 跑测试。

2. MockDataSource 可注入（不改行为）：
```ts
constructor(private readonly bus: EventBus, opts: { db?: MockDb; now?: number } = {}) {
  this.now = opts.now ?? Date.now();
  this.db = opts.db ?? buildMockDb(this.now);
  this.jobs = new JobQueue(bus, (kind) => this.mockRunner(kind));
}
```
（`now` / `db` 改成构造函数里赋值的 readonly 字段；`buildMockDb` 的实际名字以 `fixtures.ts` 为准。）同时把 mock 的 `getStats` 修正到领域口径（与 T13 一致）：`totalBytes` 与 `addedLast7Days` 只统计未被排除的图；`lastScanAt` 取所有 root 的最大值；`duplicateGroupCount` = 未解决且可见成员 ≥ 2 的组数（与 listDuplicates 的长度一致）。

3. 种子 `datasource/sqlite/seed.ts`：
```ts
export interface IdMap { roots: Map<string, number>; works: Map<string, number>; characters: Map<string, number>;
  images: Map<string, number>; exclusions: Map<string, number>; duplicates: Map<string, number> }
export function seedFromMockDb(db: Db, mock: MockDb, opts: { now: number }): IdMap
```
一个事务里依次插入：library_roots（path / enabled / last_scan_at）→ works（name、danbooru_tag、`color = hslToHex(hue, 62, 58)`、created_at）+ aliases → characters（name、danbooru_tag、source、pinned、cover_focus、`created_at = '2000-01-01T00:00:00.000Z'`）+ aliases + character_works(position) → exclusions（image / character 类的 target 在对应行插入后再 UPDATE 成新 id）→ images（root_id 映射、`sha256 = 'seed:' + mockId`、dominant_color 用 mock 相同公式、`tagged_at = tagged ? added_at : null`、excluded_by 映射、`trashed_at = trashed ? now : null`）→ image_characters（origin 'tagger'、score 0.95、added_at = 图片 added_at）→ image_copyrights（mock 图片的 workIds 里不经角色得到的那部分）→ tags + image_tags → character_suggestions → duplicate_groups + duplicate_members → 回填 characters.cover_image_id。
**newCount 还原**：mock newCount = N 的角色，把它计入张数的关联按 added_at 倒序，`last_seen_at` = 第 N+1 条的 added_at（N = 0 → now；N ≥ 条数 → `'1970-01-01T00:00:00.000Z'`）。
`apps/server/scripts/seed-mock.ts <dataDir>`：库为空时用 mock 的默认数据（`Date.now()`）导入并打印数量；非空则拒绝执行（避免覆盖真实数据）。

4. 契约夹具 `test/fixtures/contract-db.ts`：`buildContractDb(now: number): MockDb`，小而全、完全确定（不用随机数），注释里写清每张图的用途与预期计数：
   - 2 个 root（一个启用；一个停用且有 3 张图）；
   - 3 个作品：蔚蓝档案（blue_archive，别名 ブルーアーカイブ、BA）、原神（genshin_impact）、一个自建作品（danbooruTag null）；
   - 7 个角色：圣园未花（mika_(blue_archive)，别名 ミカ、未花）、早濑优香、空崎日奈、芙宁娜（furina_(genshin_impact)）、纳西妲、一个跨两个作品的角色、一个自建角色（custom、无标签）；其中 1 个 pinned；
   - 40 张图：入库时间分布在今天、3 天前、10 天前、40 天前、400 天前；覆盖 4 种分级、横 / 竖 / 方、收藏、多角色同图、只有 copyright 没角色、未识别（其中 5 张带建议，1 张建议指向库中不存在的角色标签 `test_girl_(emaki_test)`——这个标签不在任何词库和离线表里，mock 和 sqlite 都会显示成「Test Girl」、作品为 null）、2 张在回收站；
   - 排除：1 条 folder 规则、1 条 tag 规则（互不重叠）；
   - 1 个未解决重复组（2 张）、1 个已解决组。

5. 契约框架：
```ts
// test/contract/ready.ts —— 已完成的 sqlite 任务；每个任务做完把自己的编号加进来
export const SQLITE_READY = new Set<string>(['T01']);

// test/contract/harness.ts
export type Kind = 'root' | 'work' | 'character' | 'image' | 'exclusion' | 'duplicate';
export interface ContractEnv {
  name: 'mock' | 'sqlite';
  ds: DataSource;
  events: ServerEvent[];                    // 订阅 bus 收集的事件
  now: number;
  id(kind: Kind, mockId: string): string;   // 夹具 mock id → 本实现 id
  back(kind: Kind, id: string): string;     // 反向，用于比较输出
  close(): Promise<void>;
}
export type ContractFactory = () => Promise<ContractEnv>;
export const NOW = Date.parse('2026-09-27T12:00:00.000Z');
export const mockFactory: ContractFactory;    // new MockDataSource(bus, { db: buildContractDb(NOW), now: NOW })；id / back 恒等
export const sqliteFactory: ContractFactory;  // SqliteDataSource.open(bus, tmpDir, { memory: true, clock: () => NOW, autoJobs: false })，
                                              // seedFromMockDb(ds.ctx.db, buildContractDb(NOW), { now: NOW })，再 ds.ctx.invalidate()
/** 把输出里的所有 id 换回 mock id，便于两边 deep equal */
export function canon<T>(env: ContractEnv, value: T): T;
/** 契约分组：sqlite 这边只有 task 在 SQLITE_READY 里时才跑，否则 skip（mock 永远跑） */
export function contract(task: string, title: string, make: ContractFactory, name: 'mock' | 'sqlite', body: () => void): void;
```
`test/contract/contract.test.ts`：
```ts
describe.each([['mock', mockFactory], ['sqlite', sqliteFactory]] as const)('%s', (name, make) => {
  settingsContract(make, name); statsContract(make, name); worksContract(make, name); charactersContract(make, name);
  characterMutationsContract(make, name); unrecognizedContract(make, name); exclusionsContract(make, name); searchContract(make, name);
  imagesContract(make, name); duplicatesContract(make, name); bulkContract(make, name); undoContract(make, name);
});
```
每组契约声明自己对应的任务（settings → T02、stats / works / characters → T13、characterMutations → T14、unrecognized → T15、exclusions → T17、search → T20、images → T05、duplicates → T16、bulk → T18、undo → T19）。每个 `xxxContract` 的 `beforeEach` 新建环境（用例互不影响）；断言写从夹具推算出的**具体期望值**（数字、顺序），两边对同一个标准。另加 `cross.test.ts`：两边各跑同一组只读查询，`canon` 后 deep equal（忽略字段：`newCount`、`coverImageId` 与 `coverRating`（兜底封面两边选法不同，分级随之不同）、`dominantColor`、`color`、`customMatchableCount`、`previewImageIds` 的顺序；只对两边都 ready 的接口比较）。阶段 A 先写 settings / stats / works / characters 四组的真实用例，其余 `it.todo`。

6. 有意差异清单（写进 `test/contract/README.md`，契约中不断言）：newCount 绝对值；角色兜底封面；删除排除规则后重新应用其余规则；采纳建议后删除该建议；采纳建议新建角色时可能新建作品；文件名排序（NOCASE vs localeCompare）；random 排序；合并后的 newCount；listExclusions 预览顺序；customMatchableCount（依赖名字索引数据）；listImages 的游标格式（sqlite 是不透明的 base64url，mock 是数字字符串）。

7. sqlite 专属测试：`apps/server/src/db/migrate.test.ts`（全新库 → 最新版本、幂等、坏迁移回滚、降级保护）；`undo.test.ts`（T19）；用 `test/helpers/dump.ts` 的 `dumpCore` 做「执行 → 撤销 → 状态相同」断言，覆盖所有可撤销操作。

8. 其他任务的单元测试放在源码旁（`*.test.ts` 或 `__tests__/`），各任务自己写；阶段 B 检查它们都在 `npm test` 里跑到了。另外补 shared 的 `searchKey` 测试（全角、片假名、括号后缀、下划线）。

9. HTTP 冒烟 `test/http.smoke.test.ts`：`buildApp(new MockDataSource(bus), bus)` + `app.inject` 请求每个路由一次，断言状态码与 JSON 结构（路由与 zod 校验接线正确）。

10. CI `.github/workflows/ci.yml`：`runs-on: windows-latest`；`actions/setup-node@v4`（node-version 24、cache npm）→ `npm ci` → `npm run typecheck` → `npm test`。需要模型 / GPU / 外网的测试一律 `skipIf`（CI 上没有）。

### 坑
- 契约用例不要依赖 `Date.now()`：两边都注入 `NOW`（mock 的 recent / 7 天统计也基于它）。
- SQLite 的 id 是整数字符串，mock 是 `c1` / `w1`；断言一律经 `env.id()` / `canon()` 转换，不要写死。
- sqlite 用 `:memory:` 库，每个测试新建；`dataDir` 仍给一个 `fs.mkdtempSync(path.join(os.tmpdir(), 'emaki-'))` 目录（缩略图缓存等会用），`afterEach` 删除。
- 测试里 `autoJobs: false`，否则 open 时会自动扫描。
- vitest 并行跑多个文件，每个文件用自己的临时目录，不要共享数据库文件。

### 验收标准
- 阶段 A：`npm test` 通过（mock 的 settings / stats / works / characters 契约通过；sqlite 那边因为 T02 / T13 还没 ready 而 skip，其余为 todo）；T02 做完后把 `T02` 加进 `SQLITE_READY`，settings 契约两边都通过。
- 阶段 A：`npx tsx apps/server/scripts/seed-mock.ts F:/Claude/emaki/data/seed` 成功导入（T13 做完后，sqlite 模式的前端显示的角色 / 作品数量与 mock 模式一致）。
- 阶段 B：`SQLITE_READY` 包含所有有契约的任务，契约用例没有 todo，`npm test` 全绿；推到 GitHub 后 CI 通过。

### 难度
L（阶段 A：M）

### 给实现模型的提示
- 先写 `buildContractDb` 并在注释里算好每个预期数字，后面的断言都照着写。

---

# M5 视觉打磨与内容整理

> 2026-09-27 加入。起因：用户导入真实图库（约 2 万张）后，对照 @shio_vinyl 的 Illustash 截图提出「审美上可以更进一步」，并希望「截图或者本来就是文本的图分类存放」。
> 依据是三轮审查：逐页审查、审美方向竞选加内容分类，最后对本计划本身做的对抗审查（实现者、用户、代码三个视角）。完整规格在 `docs/design/m5/`：
> - `01-page-review.md`：逐页审查。编号为 OV（总览）、CB（封面与模糊）、HO（首页）、BR（浏览）、TR（整理），bug 记作「区域-Bn」；另有交叉审查的修正 CR、合并建议 MG、遗漏 MS。
> - `02-aesthetic.md`：审美方向「私人画集」。SEL-n 是最终入选的设计时刻，文件里还有 token 改动、统一原则和不采纳的点。
> - `03-content-kind.md`：非插画内容分类。CL 是分类体系；VF 是换样本反证后的规则修正；BI 是产品行为和数据模型的问题。
> - `classify-rules.reference.cjs`：分类规则的参考实现，已在真实库上抽样验证。移植时按 T27 第 1a 条改。
>
> **优先级规则**：本节 > CR / VF / BI > MG > 各提案原文。提案原文里的行号可能已经过时（CR-8），一律按符号定位。MS-10 建议沿用旧任务的子编号；本计划改为新增 T25–T37，因为这些工作横跨好几个旧任务。
> **与「怎么用这份文件」第 6 条的关系**：M5 明确改写的口径、契约和前端，以 M5 为准。T27、T28 的第 0 步会先改「全局约定 → 数据口径」，再写代码。
> 截图和原型在本机 `F:/Claude/.work/review/`，参考图复制在 `F:/Claude/.work/review/ref/{2.webp,3.png,4.webp}`。这些都含用户真实图库的缩略图，**不要复制进仓库**。

## M5 的设计主张（T36 写进 FRONTEND.md）

以「私人画集」为主干：评审打分最高，而且在真实库里开着模糊、封面糊掉、混着截图时依然好看。角色总览的信息结构对齐参考图，再嫁接「按类型陈列」「空间连续」和「印与纸」这几类微交互。原则如下（覆盖 `02-aesthetic.md` 里与之冲突的写法）：

1. **内容是印刷品，控件是器物。**
   - 封面类统一用 `--radius-plate: 12px`，包括 Top 卡、扇形卡、plate 图版和首页扇形小样。扇形卡保留 3px 白边（`ring-raised`）。
   - 网格缩略图用 `--radius-plate-sm: 6px`，头像是圆形，控件保持胶囊。
   - 「印刷品」的感觉靠图注、标题排版和纸色建立，**不靠方角**。
   - 书架卡片（plate）不在图上压白字，名字写在图版下方。Top 卡（overlay）和看图器是例外。
2. **层级靠字体和线。** 页头由 kicker、标题和双线组成；章节写成「01 小标题 ——— 注释」。中文衬线只用于页面大标题、kicker 和章节标题（D8）。卡片上的名字一律用无衬线 `font-semibold tracking-tight`，与参考图一致。
3. **朱色只用来做「印」**，每屏朱色面积 < 1%。**+N 全站只有两种写法**（MS-9 定稿）：
   - 叠在图上（圆头像、plate 图版）时，用 `Badge tone="ink" dot="var(--c-ok)"`；
   - 写在文字行里（扇形卡的「76 位 · 1,695 张 · +7」）时，用 `font-semibold text-ok`。
   - Seal（印章）只用于类型印、卷号、选中；不用于 +N。`02-aesthetic.md`「Token 改动·九」里「删掉 +N 前的小绿点」「+N 白文印」两处作废。
4. **插画与别册。** 截图、漫画、文字、照片、表情和动图自动分开放。分类要能解释原因，手动修改优先，可以撤销，**不移动文件**。
5. **动效像纸与印。** 参数全部来自 `lib/motion.ts`；全站包在 `<MotionConfig reducedMotion="user">` 里（CR-10）。
6. **按 10 万张图定性能预算。** 网格里不做逐格的 filter、tilt、backdrop-filter；吸顶头部用不透明的纸；新网格一律虚拟化。

## 决策（全部已于 2026-09-27 由用户确认）

| # | 问题 | 决定 |
|---|---|---|
| D1 | 审美主干 | **已确认**：「私人画集」+ 参考图的总览结构；Top 保留「一大多小」的 Bento（不换 TopRow） |
| D2 | 图库默认只显示插画吗？ | **已确认**：是，但**一定要有「全部」**：KindIndex 最前面放一项「全部 {总数}」（`/gallery?kind=all`）；从标签或 ⌘K 跳到图库时，URL 显式带上 `kind=all`。分类第一次生效后，图库和首页顶部各显示一次可关闭的提示条：「已把 N 张截图、漫画……分开放进别册 · 去看看 · 图库改为显示全部」。选了「显示全部」就写进 `usePrefs.galleryKinds` |
| D3 | 漫画页计入角色张数吗？ | **已确认**：不计入 `imageCount`（排名和 Top 都只看插画），另给 `otherCount`，卡片张数行写「5 张 · 另有 18 张漫画等」。~~只有漫画的角色照常显示~~ → **2026-09-28 用户改定**：插画 0 张的角色（含只有漫画的）都默认隐藏，书架末尾留一行「另有 N 位角色只出现在漫画、截图等里 · 显示」 |
| D4 | GIF 单列「动图」吗？ | 是，类型值为 `animated`（中文名「动图」，印章字「动」，图标 lucide `Film`） |
| D5 | 非插画分区叫什么？ | **「别册」**（用户 2026-09-27 选定），用于侧栏、页面标题、提示条、toast 和首页小节。副标题一定要写清内容：「截图 · 漫画 · 文字 · 照片 · 表情 · 动图，自动分好，不计入角色」，第一次出现时的提示条也要说明「截图、漫画等都在别册里」。界面上不出现「正卷」。代码里的路由和组件名叫 annex |
| D6 | 照片 / 文字默认模糊吗？（真实库里有证件照，BI-17） | **已确认**：相机拍的照片默认模糊，文字图不模糊。只在全局模糊开关（B 键）打开时生效；默认只模糊**照片**，「文字也模糊」可以在设置里勾选。开关存在 `usePrefs`，只作用于本机 |
| D7 | 要不要在磁盘上把非插画移到别的文件夹 | **已确认**：先不做，只在应用里分开。T37 保留规格，暂不排期 |
| D8 | 中文衬线用在哪？ | **已确认**：要「画册」的感觉——页面大标题（H1）、kicker、章节标题用中文衬线；卡片上的名字仍用无衬线 |

## 检查点（给用户看截图，确认后再继续）

- **A（T25.5 之后）**：真实库 `/characters` 首屏截图，和 `F:/Claude/.work/cmp/chars-real.png` 并排对比。
- **B（T30 之后）**：总览截图，亮色、暗色各一张，外加扇形卡悬停截图。由用户决定 Bento 还是 TopRow、D8 的字体，并确认 D2–D6。
- **C（T27 + T32a 之后）**：别册各类截图，外加分类数字（每类张数、抽样精确率）。
- **D（T38e 之后，第二轮）**：合集书架、布面（按 RV-C-11 重拍）、扉页、阅读器的截图，外加判定结果（多少本、哪些目录没成册）。

## M5 第二轮（2026-09-27 用户反馈，全部已确认）

### 用户原话要点
1. Top 保留「一大多小」。
2. 要营造「画册」的感觉。
3. 相机拍的照片默认模糊。
4. 作品扇形卡一排五个改成四个，扇形略小。
5. 圆形头像不错，但观感要再优化，更有画册的感觉。
6. 未识别也分大类：
   - 插画、漫画放在一起，排在前面，其中更像插画的排最前；
   - 在这一类里，腿、胸、敏感这类画面主题各自归成一组；
   - 照片、文本先归到一个类，用户以后再看情况处理。
7. 文件夹里的本子，每一页可以直接整理成「一本」；插画集（画集）也一样；角色也要能索引到画集里的图片。

### 规格与优先级
- 完整规格：`docs/design/m5/04-round2.md`。三路设计分别是未识别分大类、画册感视觉、合集（本子 / 画集）。每路都在真实库副本上实测过、做了原型截图，然后经过对抗审查。
- 审查意见编号：RV-T-n（未识别）、RV-A-n（画册感）、RV-C-n（合集）。
- 参考实现：合集判定见 `docs/design/m5/collections-detect.reference.cjs`；其中 judged 与页序以 RV-C-1 为准。
- **优先级：本节 > 各条 RV 的「改法」> 04-round2.md 的规格原文**。每条 RV 不论 major 还是 minor 都要照改法处理；本节下面只写三路设计之间的冲突怎么定，以及几处改法之间的取舍。

### 三路设计之间的冲突，以本节为准
1. **逐张「未识别」队列的口径（最终）**：计入 v_counted_images 且满足以下全部条件：
   - `content_kind IN ('illustration','comic')`；
   - 不在任何合集里：`collection_id IS NULL`；
   - 没有放下：`shelved_at IS NULL`；
   - 没有角色。

   在 `sql.ts` 里写成一个常量 `QUEUE`，getStats、分段、侧栏共用（MG-9）。**分两步写**：T27 补充按 04-round2 第「T27 补充」节写 `QUEUE`（这时还没有 `collection_id` 列）；T38c 只在同一个 `QUEUE` 末尾追加 `AND i.collection_id IS NULL`。04-round2 里 T38c 新建 `QUEUE_UNRECOGNIZED`（只含插画）、把 `UNTAGGED_UNRECOGNIZED` 改回「不排除漫画」的那几句作废，`UNTAGGED_UNRECOGNIZED` 保持 RV-T-1 ③ 的写法。
   - 「已认出 X%」：分母去掉合集页，即 `1 − (unrecognizedCount + shelvedCount) / (kindCounts.illustration + kindCounts.comic − 合集页数)`（RV-T-4 ②按此修正）。侧栏待办 = `unrecognizedCount − untaggedCount + pendingCollectionCount`。
   - **本子**的页整本退出逐张队列，在未识别页的「成册待整理」里整本处理（T38f）。
   - **画集**的页同样整本处理：按 RV-C-10，只要还有没认出的插画页，这本就算待整理；点开进入目次的「未认出」筛选。
   - **不在合集里的散页漫画**（聊天群、贴吧里存的漫画格等）留在逐张队列的「漫画」组里，识别过的和没识别的都算（RV-T-1 ①–④）。
   - **T34d（漫画组按本排列）取消**，由 T38f 的「成册待整理」代替。只为 T34d 服务的内容一并作废：T34a 的 book 模式、mock 里的「本子/…」路径（RV-T-2）、RV-T-7、RV-T-3 的 selectBook、RV-T-1 的 ⑥、T34a 验收 5。RV-T-1 ④ 改为「合集外的散页漫画」；RV-T-1 ⑤ 的验收改为：漫画组张数 = 合集外、没有角色、没放下的漫画页数。
2. **迁移编号**：005 = T25.5（已用）；006 = T27（`content_kind` 等列，以及 T27 补充的 `theme`、`art_score`、`shelved_at` 三列，写在同一个文件里）；007 = T38b（合集）；**008 = T22**（性能索引）。
   - 如果真实库在 T27 补充完成前就已经升到 006，按 RV-T-5 新建一个迁移补这三列，后面的编号依次顺延。
   - 要同步修改：「迁移编号」表、里程碑推荐顺序、M5「顺序」一行、T22 正文里的文件名，以及 T22 验收里的 `user_version`（改为 8）。
3. **合集刷新时机**（按 RV-C-8、RV-C-9）：
   - 启动时全量重算；
   - 扫描有变化（`added + updated + moved + missing + restored > 0`）时全量重算；扫描结果拿不到图片 id，改名、移动留下的旧目录和孤行（RV-C-14）只有全量重算才清得掉；
   - 识别任务结束后（afterTag）全量重算：「已判定」看 `tagged_at`，识别会改变判定；
   - RV-C-8 列出的写操作（改类型、排除 / 恢复、移到回收站、增删排除规则、启用 / 停用文件夹）只重算涉及的目录（`refreshDirs`），并在 `mutate` 里加 `u.onUndo`，撤销后同样重算。
4. **本子的模糊**：开着模糊开关时，**没识别过**的本子页一律按敏感处理（RV-C-12）。封面换成「布面」，目次、阅读器、书卡底页也都模糊。给用户看的原型要按 RV-C-11 重拍（大约 9 成本子会显示成布面）。
5. **悬停显示默认关**：`revealOnHover` 默认 false（RV-A-1，同 CR-12）。相机照片默认模糊，按 D6 已确认的写法做，见 T29b-4。
6. **纸纹**：只按 RV-A-4 的 `background-attachment: local` 做；做完如果滚动掉帧，就去掉纸纹，其余照做。
7. **吸顶**：页头高度按 RV-A-6 的数字验收（239±3）。`SectionBar` 吸在页头下面，按 RV-A-5，用 `--page-head-h` 定位。
8. **原 T29b 里没被拆进 T29b-1 到 T29b-4 的部分**（Seal、看图器暗房 bg-stage、网格 6px 圆角、sonner 覆写），归到新任务 **T29b-5**（RV-A-12），做法照原 T29b 的规格。
9. **SEL-20「漫画成册」和 `/api/images/folders` 不做**，由合集（T38）代替；T32b 的规格来源里删掉这两项（RV-C-13）。
10. **截图验收一律用 mock**：规格里写的 `npm run dev:mock` 固定用 5173 / 5174 端口，而用户的真实后端通常正在这两个端口上跑（RV-A-15）。所以 mock 验收改为：
    - `EMAKI_PORT=5190 npx tsx apps/server/src/index.ts --mock`；
    - `cd apps/web && EMAKI_PORT=5190 npx vite --port 5191`。
    
    **不许结束 5173 / 5174 上的进程**；不要用真实库截图做仓库里的文档图（RV-C-18）。
11. **章节编号**：T29b-3 改用 CSS 计数器自动编号、`SectionTitle` 不再有 `index` 属性。04-round2 里 T34b、T38d、T38f 传 `index={n}` 的地方一律删掉；「放下的」那一组传 `numbered={false}`。

### 第二轮的默认决定（合集判定和阅读器方向已在检查点 D 由用户确认，2026-09-27）
- **合集判定**：
  - 一个文件夹最多一本。
  - 本子还是画集，看已判定页里漫画是否 ≥ 50%。
  - 杂项目录名单、截图 / 照片 / 表情 / 动图页超过 20%、不足 8 页的目录都不成册。
  - 画师月包不自动成册，用户可以在看图器里手动「成册」。
- **画集的图**在图库里照常逐张平铺；角色「收录于」的阈值：画集 ≥ 1 页，本子 ≥ max(2, ceil(10% × 页数))。
- **阅读器**：汉化本也默认右开，按 R 切换，切换结果会记住。
- **侧栏**：在「角色」下面加「合集」入口（lucide `LibraryBig`，不显示数字）。
- **未识别页**：
  - 大类页签是「插画 · 漫画」「照片 · 文字等」；
  - 分段是 有建议 / 没认出 / 待识别 / 放下的；
  - 主题组以 04-round2.md 里按实测数据定的表为准；
  - 「放下」的意思是：暂时不处理，这张退出队列，但不排除、不删除，随时可以拿回来。
- **作品网格**：1024 以下 2 列，1024–1279 为 3 列，**1280 以上一律 4 列**（用户原话「一排五个改成四个」，1920 全屏也不回到 5 列；覆盖 04-round2 里「1800 以上 5 列」的写法）。扇形宽度取列宽的 96%，上限 400px，侧卡外移 45%（悬停 58%）（原定 76%/248px/34%，用户看后说偏小、作品之间太空）。
- **圆头像**：按 04-round2.md「T30 修订 2」做「卡纸框」加图注细线；「更多常看的」不写名次数字。

### 第二轮的实现顺序
1. **马上做**（不依赖 T27，直接回应第 2、4、5 点）：T29b-1 → T29b-2 → T29b-3 → T30 修订 1 → T30 修订 2 →〔给用户看截图〕
2. **T27 + T27 补充 + T32a**（同一批合入；按 MS-8 在 `data/dev-m5` 上开发）→〔检查点 C〕
3. **T29b-4（模糊策略）→ T29b-5 → T32b**（合集的界面要用 Seal、新的模糊判断和 `lib/kinds.ts`，所以先做）
4. **合集**：T38a → T38b → T38c → T38d → T38e →〔检查点 D：书架、布面、阅读器截图〕
5. **T33 → T38f**（第 1–3、5 点）**→ T34a → T34b**（含 T38f 第 4 点「成册待整理」，作为「插画·漫画」的第一块）**→ T34c → T34 其余**（TR-4～TR-11、TR-B2：重复页、侧栏、引导、已排除页）**→ T31 → T35 → T36**
6. **M4 剩余**：T22（迁移 008；按 RV-T-10、RV-C-9(c) 加上未识别汇总、合集全量重算和单张改类型的性能场景，并把合集列表加进计数缓存清单）→ T23 → T24 阶段 B

每个任务的验收照 04-round2.md，并先套上对应 RV 的改法。每完成一项，在「任务一览」表的状态列写上日期。

## 任务一览与实现顺序

| 任务 | 标题 | 难度 | 依赖 | 建议模型档位 | 状态 |
|---|---|---|---|---|---|
| T25 | 任务链与实时状态热修 | S | — | 中档 | 已完成（2026-09-27） |
| T25.5 | 封面止血（先行，含迁移 005） | M | T25 | 中高档 | 已完成（2026-09-27），等检查点 A 确认 |
| T26 | 数据契约 v2（封面 / 统计 / 导入 / 未识别分段） | M | T25.5 | 中高档 | 已完成（2026-09-27）；mock 的 first-import 场景留给 T31 |
| T28 | 作品封面与计数口径 | M | T26 | 中高档 | 已完成（2026-09-27）：作品 3 张封面、焦点推断、recent 排序；CB-B7 脚本、CB-9 未做 |
| T29a | 前端共用件（总览要用的） | M | T26 | 中高档 | 已完成（2026-09-27）；截图 review/after/T29a-devui*.png |
| T30 | 角色总览改版 | M | T28、T29a | 中高档 | 已完成（2026-09-27），检查点 B 已通过；第二轮修订见 T30 修订 1/2 |
| T27 | 内容分类数据层 + 迁移 006 | L | T26 | 中高档 | 已完成（2026-09-27），实测见 T27「实测」；检查点 C 用户确认（2026-09-27）：照片、表情精确率接受；FLOWERS 翻拍的 17 张由用户手动改回插画，不另加规则 |
| T32a | 别册：最小可见版 | M | T27 | 中档 | 已完成（2026-09-27）：侧栏「别册」、/annex/:kind、图库类型筛选与首次提示、看图器「类型」、多选 C「归入…」、详情页「插画／全部」、未识别 N「不是插画」 |
| T29b | 画集语汇（token、字体、页头、Seal、模糊范围） | M | T29a、T27 | 中高档 | |
| T31 | 首页改版 | M | T27、T29b、T30 | 中档 | 已完成（2026-09-28）：首次导入面板（HO-2，四步分别判断，适配两条道并行）；统计条只数插画 + 别册提示、识别中写「已看过」、作品名加引号、全 0 时隐藏柱状图（HO-3/10/B2）；01 今日一枚（SEL-9，daySeed，开模糊只抽已识别的全年龄图，R 换一张）；02 待处理自适应（HO-3/4/5/8/B3/B4，另有 N 本待整理）；03 最近 30 天在收头像行 / 空时收得最多（HO-6/7）；04 最新入库提示（HO-12）；横幅纸色细线、数字只出现一次（HO-9）；相对时间向零取整（HO-B6） |
| T32b | 别册：正式版（印章、按类陈列、首页入口） | M | T29b、T32a | 中档 | 已完成（2026-09-27）：目次（图库、别册共用）、截图竖卡 / 文字纸页 / 表情贴纸、看图器类型印章、首页「别册」、侧栏移到主组并加数字键 6 |
| T33 | 浏览页（看图器、角色扉页、作品页、网格） | L | T29b、T30 | 中高档 | 已完成（2026-09-27）：看图器跨页翻到最后一张、计数显示总数、关掉后网格定位（BR-B1）；从格子拿起 / 缩回（SEL-12）；面板头部先说是谁（BR-8）；角色扉页（SEL-8）+「01 常一起出现」头像行（BR-3）+「恢复自动封面」（MG-14 前两步，CB-7 候选面板留 P2）+「新」改小朱点（BR-B3）；作品页扇形 + Top 4 + 头像两整行（BR-4、CR-13）；网格悬停浮起、角色名、心形收藏（BR-5，`ImageItem.characterNames`）。「收录于」章节留给 T38f |
| T34 | 整理页（未识别分段、重复、侧栏、引导） | M | T26、T27、T29b | 中档 | 已完成（2026-09-28）：未识别见 T34a/b/c；侧栏精确数字 + 悬停说明、可点的任务环（两条道各一个）、首页小圆点（TR-4/7/8）；重复页行高 360 + Z 同步放大镜、完全相同组高亮不同的路径段、三种空状态（TR-5/11/B2）；引导页 01/02/03（TR-6）；已排除照片堆在左（TR-9）；同建议全选 A（TR-3）；识别中未识别列表只标记过期 +「有新结果」（TR-12）；队列 >300 项虚拟化（TR-13）。TR-10 由 T29b 吸顶头部覆盖 |
| T34e | 画面筛选（用户 2026-09-28）：图库、角色页、作品页按 腿·足 / 胸 / 泳装 / 兽耳 / 女仆·和服 / 多人 筛，多归属（THEME_FILTERS，与未识别主题同一套标签阈值） | S | T34a | 中档 | 已完成（2026-09-28）：契约 +1；dev-m5 每次 0.26–0.45 秒，需要更快时在 T22 预存主题位 |
| T29c | 底色与徽记（用户 2026-09-28）：米纸 / 黑白 / 薄荷 / 天青 / 雾紫 × 浅深；徽记「相角徽环」替换「絵」印章，颜色跟底色；卷首改相簿说法（第一册…扉页）；标签页图标跟底色 | S | T29b | 中档 | 已完成（2026-09-28） |
| T35 | 质感与微交互 | M | T29b | 中档 | 已完成（2026-09-28）：装裱式选中 + 勾选涟漪（SEL-10）；引信撤销 toast（SEL-11，`components/ui/Toast.tsx`，Ctrl+Z / 顶栏 / 命令面板都经它原地变「已撤销」，悬停 / 聚焦 / 切后台停烧，减少动效时照常烧；顶栏撤销图标点头）；封面长成扉页（SEL-14，`lib/viewTransition.ts`，书架 / Top / 圆头像三处入口，后退反向变形并恢复滚动，扉页先用列表缓存顶上）；四角印框焦点、控件焦点收紧、作品 chip 墨块（SEL-15）；放映（SEL-16，扉页「放映」、今日一枚「放映今天的 20 张」）；机械计数（SEL-18，`RollingNumber`，首页 / 侧栏 / 别册 / 选择栏）；识别胶卷（SEL-19，ServerEvent `job-item` 每秒最多 4 条、不触发失效，首页导入第 3 步 / 任务横幅的胶卷 + 「识别为 …」小签 + 进度条扫光，侧栏任务环心跳；剩余时间沿用服务端整轮平均速度，没另做 EMA）。另：看图器按 C 打开「归入…」菜单；CB-7「换封面」候选面板（`GET /api/characters/:id/cover-candidates`） |
| T36 | 文档定稿与视觉验收 | S | T30–T35 | 小模型可做 | 已完成（2026-09-28）：FRONTEND.md 写入六条原则、token 与五种底色、`lib/motion.ts` 用法、+N 两种写法、徽记 / 相簿卷首 / 引信 toast / RollingNumber / 封面长成扉页 / 放映 / 印框焦点，§3 改成 Top / 最近在收（更多常看的）/ 作品三段；「数据口径」按代码核对补上 newCount、recentCount、角色与作品封面、QUEUE 最终版（「只有漫画的角色被隐藏」用户确认保持，D3 已改）；README 截图用 mock 重拍亮 / 暗两套各 12 张（WebP，共约 0.8 MB） |
| T29b-1/2/3 | 画册 token 与中文衬线、页头、章节标题（第二轮） | S–M | T29a | 中高档 | 已完成（2026-09-27）：另修 PageHeader 首次挂载拿不到滚动容器、--page-head-h 为空的问题（改用 useEffect） |
| T30 修订 1/2 | 作品网格一排四个、圆头像「卡纸框」（第二轮） | S | T30、T29b-1 | 中档 | 已完成（2026-09-27）：5 档尺寸实测与验收一致；之后按用户反馈：扇形盒子放大到列宽 96%、上限 400px，侧卡外移 34%→45%（悬停 48%→58%），列间距 xl 改 gap-x-6、行距 gap-y-7，作品之间不再显空；≥1800 断点写成 min-[112.5rem]（px 写法会被排在 xl 前面而失效） |
| T29b-4 | 模糊策略：分级范围 + 相机照片默认模糊（第二轮） | M | T27、T29b-1 | 中高档 | 已完成（2026-09-27）：照片默认模糊、模糊范围 / 文字 / 悬停显示（默认关）四个设置，角标移到右上 |
| T29b-5 | 原 T29b 剩余：Seal、看图器暗房、网格圆角、sonner（RV-A-12） | S | T29b-1 | 中档 | 已完成（2026-09-27）：ui/Seal、看图器暗房 bg-stage、网格圆角、toast 缓动 |
| T38a | 合集判定纯函数（第二轮） | M | —（验收要 T27） | 中高档 | 已完成（2026-09-27）：副本（145 个目录）判出 63 本（本子 44 · 画集 19），必含 / 必不含清单全对；脚本 380 ms（库已 2.1 万张） |
| T38b | 迁移 007 + CollectionService | M | T27、T38a | 中高档 | 已完成（2026-09-27）：副本 63 本、2,270 页，首次 164 ms、再启动 73 ms 且无变化；写操作按目录重算并在撤销后重算 |
| T38c | 合集契约与接口 | L | T38b | 中高档 | 已完成（2026-09-27）：契约 T38 九条两边全绿；副本 63 本、待整理 33 条，早苗 → 東方睡姦4（21 页）、善子 → MIGNON 四本、楪祈 []；未识别 10,743 → 8,832 |
| T38d | 合集书架、系列页、扉页、侧栏入口 | L | T38c、T29b-1/2/3、T29b-4、T29b-5 | 中高档 | 已完成（2026-09-27）：书架（系列卡、布面）、扉页奥付、出场角色、目次；另修合集摘要里作品命中的慢查询（11 秒 → 10 ms） |
| T38e | 阅读器 BookReader | M | T38c、T38d | 中高档 | 已完成（2026-09-27）：双页右开 / 单页、胶片条、预读、结尾卡接下一话、记住进度、本册不模糊；没识别过的本子页开模糊时按未识别模糊（RV-C-12） |
| T38f | 接入：收录于、成册待整理、别册·漫画「成册 / 散页」 | M | T38c、T38d、T32b、T33 | 中档 | 第 1–3、5 点已完成（2026-09-27）：角色 / 作品「收录于」（CollectionsStrip，空时整章不渲染）、看图器「收录于《书名》第 N / M 页」和「把这个文件夹做成合集…」（toast 带撤销和「去看看」）、别册·漫画「成册 / 散页」。书卡图注用「N 页出现」代替「N 页有她」（角色不都是女性）。第 4 点并进 T34b |
| T27 补充 | 主题列、放下列、未识别口径（写进迁移 006，与 T27 同批） | M | T27 | 中高档 | 已完成（2026-09-27） |
| T34a/b/c | 未识别分大类（契约 v3、页骨架、印样批量处理；第二轮，替代原 T34 的分段前端） | L | T27 补充、T38c、T29b-1..5、T32b | 中高档 | 已完成（2026-09-27）：T34a 汇总接口 / 四段 / 主题 / 放下（契约 +5、分页单测 +2，dev-m5 各列表 15–31 ms）；T34b 大类页签、分段（含 T38f 第 4 点「成册待整理」，作为第一段）、目次 + 印样、本组说明、TR-1 前端；T34c 多选批量（放下 H / 改类型 C / 设分级 R / 排除 E / 全选本组 / 新建自建角色并归入）。T34d 取消 |
| T37 | （可选，待确认）在磁盘上分类存放 | M | T27、T32b | 中高档 | 未排期 |

**顺序**：T25 → T25.5 →〔检查点 A〕→ T26 → T28 → T29a → T30 →〔检查点 B〕→ T27 + T32a（同一批合入）→〔检查点 C〕→ T29b → T31 → T32b → T33 → T34 → T35 → T36。**第二轮反馈之后的顺序见上面「M5 第二轮 → 实现顺序」，以那里为准。** 最后回到 M4 的 T22（迁移为 008）→ T23 → T24 阶段 B。

**真实库安全（MS-8）**：开发模式下后端是 `node --watch`。改任何 `.ts` 都会重启，并立刻执行磁盘上当时的迁移文件（`.sql` 本身不被监视）；已经升过版本的库不会再跑改过的迁移。所以 T25.5 和 T27 在开发迁移和分类回填期间，**不要让 dev 服务连着真实库**：

1. 先停掉 `npm run dev`，把 `data/emaki.sqlite`、`emaki.sqlite-wal`、`emaki.sqlite-shm` 一起复制到 `data/dev-m5/`。
2. 开发时一律用 `$env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-m5'; npm run dev`。迁移写错了，就删掉 `data/dev-m5` 重新复制。
3. `npx vitest run migrate` 和契约测试全绿、迁移文件定稿后，先把 `data/emaki.sqlite*` 复制到 `data/backup/<日期>/`，再用默认数据目录启动一次，让真实库升级。执行器还会自动留一份 `emaki.v<N>.bak.sqlite`（同名文件会被覆盖，所以手动备份不能省）。
4. 分类规则改了之后要把 `CLASSIFIER_VERSION` 加一，否则已经判过的行不会重算。

---

## T25 任务链与实时状态热修

### 已完成（2026-09-27，330 个测试通过）
1. `apps/server/src/services/pipeline.ts`：扫描没有新图时改走 `afterThumbnail()`，只要还有没识别的图就接着识别（HO-B1 / TR-B1）。新增 `tagPaused`：用户取消识别后，不再自动续跑，直到 `startJob('tag')` 才恢复（`SqliteDataSource.startJob` 里调用 `pipeline.noteManualStart`）。测试在 `pipeline.test.ts`。
2. `apps/web/src/lib/events.ts`：EventSource 的 `onopen`（首次连上和重连）用 `GET /api/jobs` 重置 `useLiveJobs`，并让全部 query 失效。修复「后端重启后页面一直显示正在识别」（TR-B3）。
3. `apps/server/src/services/watch/LibraryWatcher.ts`：新增 `known(rootId, rel)`，图片的 `change` 事件在 flush 时比对大小和修改时间，都没变就不标脏。修复备份或同步软件反复改文件属性，每十几秒触发一次扫描、打断识别的问题。有测试。
4. `apps/server/package.json`：`dev` 和 `dev:mock` 从 `tsx watch` 改为 `node --watch --import tsx`。`tsx watch` 在 Node 24 下，只要 stdin 是打开的（真实终端或预览面板），导入 globby（`trash` 的依赖）时就会死锁，服务永远不监听。

（对应 MG-10、HO-B1、TR-B1、TR-B3。）

### 已完成（续）
1. **查重排在识别之前**（CR-14）：dHash 在缩略图阶段就算好了，查重不依赖识别结果。`afterThumbnail()` 改为：`dedupeDirty` 为真时先 `enqueue('dedupe')`，再判断要不要 `enqueue('tag')`。队列按优先级串行，dedupe 的优先级 2 高于 tag 的 3，几秒就跑完。
2. 识别进行中列表会随 `library-changed` 每 5 秒重排，这个问题放到 T30 第 7 步。

### 验收
- 用 `data/dev-m5` 的副本重启后端：30 秒内 `GET /api/jobs` 出现正在跑的 dedupe 或 tag；如果两者都需要跑，dedupe 在前。

---

## T25.5 封面止血（先行）

目的：尽快让用户在真实库上看到明显变化。只改现有文件，不引入新组件和新 token。按 MS-8 在 `data/dev-m5` 上开发。

规格来源：CB-1、CB-2（只做第 1 期，CR-11）、MG-2、MG-6、CR-2、CR-3、CR-1、MS-2、MS-11、OV-B3、OV-B4；修复 CB-B1 与 OV-B1（tagger 把第一张识别到的图写死成封面），以及 OV-B2 与 HO-B5（首次导入时满屏 +N）。

0. 先改「全局约定 → 数据口径」：newCount 的新公式，以及「自动封面只在 `cover_manual=0` 时计算」。
1. 迁移 `005_covers_import.sql`（CR-2：只建这一个 005）：
   - `ALTER TABLE characters ADD COLUMN cover_manual INTEGER NOT NULL DEFAULT 0`，加上 CB-1 的两条回填 UPDATE（把 tagger 自动写入的封面识别出来并清空）；
   - `ALTER TABLE library_roots ADD COLUMN imported_at TEXT`，加上 HO-1 的回填。
2. MG-2：tagger 写入器的两处、`insertDanbooruCharacter`、采纳建议的地方，都不再写封面。`updateCharacter` 设封面时写 `cover_manual=1`；新增「恢复自动封面」（`coverImageId: null` 时清掉 manual），按钮留给 T33。
3. `derived.ts`：只有 `cover_manual=1` 时才用 `cover_image_id`。兜底封面按下面的顺序排序（CB-2 第 1 期，CR-11）：
   - 分级档位（questionable 和 explicit 排最后）
   - 同一张图上的角色数升序
   - 带 comic、monochrome、greyscale、4koma 标签的图往后
   - 竖图优先（MS-11）
   - 角色标签分数降序
   - `added_at` 降序

   在 JS 里用全局 `used` 集合给兄弟角色去重；实在找不到，就允许重复（比如只有一张合影的角色）。作品的单张 `coverImageId` 暂时取「张数最多、分级安全、跨作品不重复」的角色封面，3 张的 `covers` 留给 T28。
4. newCount（CR-3、MG-6）：`SUM(i.added_at > COALESCE(c.last_seen_at, @cutoff))`，`@cutoff` 用 derived.ts 里已有的 30 天 cutoff。
5. 前端小改：
   - TopBento 的排名数字改成描边写法（CR-1）；删掉 HeroShare 和 `shareOf`。
   - Top 卡不显示 +N：CharacterCover 加 `showNew` 属性，默认 true，TopBento 传 false（MS-2）。
   - Bento 底行高度 220px 改为 260px。
   - SectionBar 改用 rootMargin（OV-B3）。
   - ChipAvatar 加上 rating，遵守模糊开关（OV-B4 的临时版，T29a 再改成走 Thumb）。
   - WorkChips 在最近在收为 0 时隐藏这个 chip。

### 验收
- 契约测试全绿（夹具的 c1 加 `coverManual: true` 并保留 i1 和它的焦点；c4 去掉 coverImageId；seed.ts 写入 `cover_manual`）。真实库升级后 `user_version = 5`，`data/backup/` 下有手动备份。
- 真实库只读 SQL：`cover_manual=0`、有 general 或 sensitive 候选、自动封面却是 questionable 或 explicit 的角色数 = 0。共用同一封面的角色数比改前至少少 25%。
### 实测（2026-09-27，真实库副本 data/dev-m5）
- 手动封面 0 / 1126（启发式把旧封面全部转成自动）；有安全候选却用了 questionable / explicit 封面的角色 = 0；共用同一封面的角色 333 → 149（-55%）；Top 9 全是 general / sensitive，没有 +N。
- 截图：`F:/Claude/.work/review/after/A-chars-after.png`。剩下的问题留给后续任务：第 8 名的封面是一张聊天截图（T27 分类后自动排除）；部分封面裁到躯干（T29a 焦点兜底）。

### 检查点 A 的用户反馈（2026-09-27，已处理）
- 「聊天记录不要放封面，封面尽量好看高质量」：自动封面改成「分级档位 → 画面质量分」排序（`derived.ts` 的 `coverQuality`：截图、聊天、界面、文字、漫画格、黑白、多人、无人、照片扣分，单人、看向镜头、高分辨率、竖图加分，相当于 CB-2 的完整权重表，只是没做滞回）；`isUnfitCover` 把截图 / 聊天 / 界面 / 文字为主的图和 `Screenshot_` 文件名直接排除，宁可显示名字首字。测试在 `coverQuality.test.ts`。结果：不合适的封面 0 张，86 位只出现在截图里的角色显示首字，Top 9 全是高分辨率单人竖图（`A2-chars-after.png`）。
- 「排名数字也不需要了」：Top 卡不再显示排名。**以后所有任务（T29a 的 CharacterCover 改版、T30、T31 的『收得最多』、T33 的作品页 Top 4）都不加排名数字**，CR-1 / MG-13 里「描边排名」的部分作废。
- 焦点（用户 2026-09-27 定）：**不做固定偏上**（CB-3、MG-3 的 y=0.15 兜底不做，也不建 `components/media/focus.ts`），改做 **CB-8「按标签推断焦点」**，并且有腿部标签时稍微下移。放在 T28 实现，规则见 T28「自动封面焦点」。没有命中规则的封面保持居中；手动设过焦点的永远用手动焦点。

- **检查点 A**：真实库 1440×900 截 `/characters` 首屏，和 `chars-real.png` 并排：Top 里被模糊的不超过 1 张（原来是 7/9），没有 +N 角标，没有「<1%」，也没有「最近在收 0」。把截图发给用户。

---

## T26 数据契约 v2（封面 / 统计 / 导入 / 未识别分段）

把 T28–T34 要用的共享字段一次改完，按「shared → mock → sqlite → web」四处一起改。例外：内容分类相关的 `kind`、`rated`、`seed` 在 T27；`ImageItem.characterNames` 在 T33。

### 规格来源
MG-1（CoverRef，**以它为准**）、MG-9（统计与设置契约）、OV-4、HO-1、CR-5、TR-1、MS-7。

### 字段（最终版）
- `domain.ts`：`interface CoverRef { imageId: ID; rating: Rating; color: string | null; focus: FocusPoint | null }`。
- `Character`：加 `coverManual: boolean`、`coverColor: string | null`、`recentCount: number`（30 天内按 `images.added_at` 计的张数，CR-5）。
- `Work`：加 `covers: CoverRef[]`（0–3 张，选法见 T28）、`coverColor: string | null`。
- `LibraryStats`：
  - 加 `untaggedCount`（还没跑过识别的计入张数）；
  - 加 `recentImport: { at: ISODate; count: number } | null`（HO-1：7 天内有文件夹首次导入时，`at` 取这些文件夹里最晚的 `imported_at`，`count` 取这些文件夹里计入张数的图；没有就是 null）；
  - 加 `lastAddedAt`。
- `Settings.dedupe`：
  - 加 `lastRunAt: ISODate | null`。存在 settings 表里，不需要迁移。
  - `DedupeService.run` 成功（没被取消）后调用 `patchSettingsInternal(db, 'dedupe', { lastRunAt })`；`applySettingsPatch` 像保护 `danbooru.lastSyncAt` 那样保护它。
  - Pipeline 通过新依赖 `initialDedupeDirty()` 初始化 dirty 标记：`lastRunAt === null || (SELECT MAX(thumb_at) FROM images) > lastRunAt`。
- `LibraryRoot`：加 `importedAt: ISODate | null`。
- 未识别分段（TR-1，**契约和服务端都在本任务做**，T34 只做前端）：
  - `ListUnrecognizedQuery` 加 `bucket?: 'suggested' | 'unsure' | 'untagged'`；
  - 响应加 `unsureCount`、`untaggedCount`；
  - 做 zod 校验、mock 和 sqlite 实现，并补分段契约用例（01 文件 TR-1 的服务端部分）。
- 「待识别」的谓词全项目只写一份（MG-9），getStats 和未识别分段共用。
- **不加** `GetCharacterResponse.newImageIds`（CR-4）。

### 验收
`npm run typecheck` 通过，并完成以下契约改动：
1. `groups.ts` 的「getStats 口径」补上 `untaggedCount: 1`（i30）、`recentImport: null`、`lastAddedAt: new Date(NOW - 60_000).toISOString()`（按夹具实际值核对）。
2. `contract-db.ts`：`settings.dedupe` 加 `lastRunAt: null`，两个 root 加 `importedAt: null`；`seed.ts` 写入 `imported_at` 和 `dedupe.lastRunAt`。
3. `cross.test.ts` 的 IGNORED 加上 `covers` 和 `coverColor`；`test/contract/README.md` 的「有意差异」加一行「作品 covers 具体是哪几张、封面主色」。`harness.ts` 的 idFields 学会把 `covers[].imageId` 换回 mock id。
4. `recentCount`、`coverManual`、`untaggedCount`、`recentImport`、`lastAddedAt`、`importedAt`、`lastRunAt` 在两个数据源里必须一致；mock 的 `recentCount` 要从图片现算，不能写进种子。
5. 首次运行时 dedupe 跑完后 `settings.dedupe.lastRunAt` 不为 null；在「扫描完、查重前」重启，重启后仍会补跑查重。

---

## T28 作品封面与计数口径

0. 先改「全局约定 → 数据口径」里 recentCount 和作品封面的写法。

### 规格来源
MG-1（作品 covers，**以它为准**，不用 OV-4 的四轮挑选）、CB-5、CB-B3、CB-B4、CB-B6、CR-5（recentCount 与 recent 排序）、HO-13、CB-9；P2：CB-8；CB-B7 / OV-B5 的后半。

### 要点
- **作品 covers**：
  - 先按 `imageCount` 降序遍历作品，维护一个全局 `used` 集合。
  - 候选是这部作品上各角色已经算好的有效封面，排序为：主作品优先（`c.workIds[0] === w.id`）→ 分级档位 → `imageCount` 降序 → id。
  - 跳过已在 `used` 里的图、本作品已选过的图，以及去掉括号后缀后同名的角色。
  - 不足 3 张时，从作品自己的图里按角色封面的同一排序补位；仍然不足时，才允许跨作品重复。
  - `covers[0].imageId === coverImageId`。
- **recentCount 与 recent 排序**：sqlite 的 `topCharacters` 在 `workId === 'recent'` 时，按 `recentCount` 降序、再按 `imageCount` 降序排；置顶角色不插队。mock 同步。
- **CB-B6**：mock 和 sqlite 的封面焦点兜底统一到 `components/media/focus.ts`（MG-3，由 T29a 建）。在那之前，服务端的焦点兜底为 null，由前端兜底。
- **CB-9**：mock 种子数据里加入不适合做封面的标签和灰度占位图，让 mock 也能验证评分。
- **CB-B7 / OV-B5**：
  - `danbooru/catalog.ts` 的 `baseCharacter` 补上单括号规则：只有当 `m[1]` 是已知角色标签、`m[2]` 不是 copyright 时，才归到本体。这只影响之后新识别的标签。
  - **不自动合并已有角色**。原因是与 T11 `applyToLibrary`「留给用户合并」的做法一致，而且撤销栈在重启后就失效（风险 23）。
  - 新增只读脚本 `apps/server/scripts/list-variant-dupes.ts`，列出候选对和各自张数，结果记进本节「实测」，由用户在角色详情里用「合并角色」逐个合并。
- **自动封面焦点**（CB-8 + 用户要求）：derived 算自动封面时顺带读封面图的构图标签，推断 `coverFocus`（x 固定 0.5）。只有 `cover_manual=0` 的封面用推断值，按顺序取第一条命中的（标签分数 ≥ 0.5）：
  1. `thigh_focus`、`feet_focus`、`foot_focus`、`ass_focus`（腿、脚是画面重点）→ y = 0.65；
  2. `full_body` → y = 0.08（看得到头顶）；
  3. `upper_body`、`portrait`、`close-up` → y = 0.28；
  4. `cowboy_shot` → y = 0.18；
  5. `thighs`、`legs`、`thighhighs`、`pantyhose`、`barefoot`、`feet` 任一 ≥ 0.6（画面里有腿，但不是特写）→ y = 0.58（比居中稍微下移）；
  6. 都没有 → null（前端居中）。
  写成纯函数 `inferCoverFocus(tags)`，带单测；mock 用同一个函数。P2：CB-8 第 2 条的 `coverAspect`（横图封面请求 960 缩略图）。
- 本任务在 T27 之前做：newCount、recentCount 和兜底封面的查询先写在 `v_counted_images` 上，T27 再统一换成 `v_illust_images`。

### 验收
- `GET /api/works` 里，Love Live! 和 Love Live! Sunshine!! 的 `covers[0]` 不同；前 20 部作品中，有 3 位以上角色的作品 `covers` 长度都是 3，而且 imageId 互不相同。
- 真实库只读 SQL：同一部作品下，封面相同、并且各自还有别的图可选的角色对数 = 0。

---

## T29a 前端共用件（总览要用的）

### 规格来源
SEL-2、CR-10、MS-4、MG-3、MG-4、CR-12、CB-B5、MG-5、CR-6、MG-8、OV-2、HO-11、MG-7、CR-7、MG-13、CR-9、SEL-4（只取 plate 版式，覆盖见下文）、SEL-13。

### 内容
- `lib/motion.ts`（SEL-2）：统一现有 24 个文件里的 26 处 EASE。App 根部包一层 `<MotionConfig reducedMotion="user">`。
- `components/media/focus.ts`（MG-3、CB-3）：导出 `COVER_FOCUS_FALLBACK` 和 `coverFocusOf`。所有封面类组件和 chip 头像都用它，默认焦点偏上。
- Thumb 的模糊 API 一次定型（MG-4，吸收 CB-4 和 BR-1）：
  - `blurBadge: 'center' | 'corner' | 'none'`，按容器尺寸自动选择；
  - 模糊半径统一；用封面主色垫底，修掉羽化边透出灰色的问题（CB-B5）；
  - `revealOnHover` 默认 **false**（CR-12）。
- ChipAvatar 改成走 Thumb（MG-5），8 个调用点见 CR-6。这修复 OV-B4 和 CB-B2（作品 chip 头像绕过模糊开关）。
- `components/media/CoverFan.tsx`（MG-8）：全站唯一的扇形叠放组件。
  - 3 张的几何和悬停参数照 OV-2（原型验证过）；另外支持 count=5，几何照 HO-11 第 4 点换算成百分比。
  - 侧卡 `blurBadge='none'`；中卡用 480 缩略图，侧卡用 240。
  - token 只加这些：`--ease-fan`、`--shadow-fan`、`--shadow-fan-hover`、`--radius-plate: 12px`、`--radius-plate-sm: 6px`、`--shadow-plate`。
- `components/media/AvatarTile.tsx` 和 `RecentStrip`（MG-7，命名见 CR-7）。
- `CharacterCover` 改版（MG-13）：
  - 描边排名数字、`showNew`、`thumbWidth`（CR-9：由调用方按卡宽 × DPR 传 480 或 960）。
  - 新增 `variant: 'overlay' | 'plate'`，**默认 `'overlay'`**，现有 7 处调用外观不变。
  - 用法分配：
    - overlay：总览 Top Bento（T30）、首页「收得最多」回退（T31）、作品页 Top 4（T33），都带描边排名，`showNew={false}`。
    - plate：选中作品后的书架，以及书架视图 ShelfGrid（T30）。
    - 「常一起出现」、作品页其余角色、最近在收一律用 AvatarTile，不用 CharacterCover。
  - plate 的 +N 按原则 3 的写法，不用 SEL-4 的骑缝白文印；plate 下方名字用无衬线（D8）。
- SEL-13：缓存命中的图不重播淡入。

### 验收
- 新建开发页 `/dev/ui`（只在 `import.meta.env.DEV` 时注册），并排展示：CoverFan（1 / 2 / 3 / 5 张）、CharacterCover 的两种 variant、四种分级的 Thumb、AvatarTile。亮色和暗色各截一张。
- `/characters`、首页、作品页在 T29a 合入前后各截一张图，确认外观没变（除了 ChipAvatar 的模糊）。
- DevTools 开启 reduced motion：CoverFan 悬停时几何不变，motion 入场动画直接显示终态。
- `Get-ChildItem apps/web/src -Recurse -Include *.ts,*.tsx | Select-String -Pattern '\[0?\.22, ?1, ?0?\.36'` 只命中 `lib/motion.ts`（本机没有 rg）。

---

## T30 角色总览改版

### 规格来源
- 结构：OV-1，以 **CR-1 与 MS-3** 为准：参考图的 Top 其实是 Bento，所以保留 Bento，TopRow（OV-5）只作为可选项。
- 作品网格：OV-2、OV-3，用 T29a 的 CoverFan。
- 最近在收：OV-6 + CR-5。
- 其余：OV-7（P2）、MS-1、MS-5、MS-6、TR-12。

### 要点
1. 总览（没有选作品、没有搜索时）从上到下依次为：
   - **01 你最常看的**：T25.5 已经改好的 Bento。
   - **02 最近 30 天在收**：RecentStrip，数据用 `useTopCharacters({ workId: 'recent', limit: 24 })`。30 天内没有新图时**不隐藏**，同一个组件改显示「更多常看的」：数据用 `useTopCharacters({ limit: 34 })` 去掉前 10 位（Top 里已经展示过），hint 写「按张数」，不显示 +N 和「全部」链接；一旦有了 30 天内的新图，自动换回。真实库的 `added_at` 全是 2022 年，平时看到的就是这个回退状态。
   - **03 作品**：WorksShelf，扇形卡网格。1440 宽每行 5 张，1024 宽每行 4 张；长尾作品收成 chip 云；网格末尾放「按角色浏览全部 N 位 →」。
   - 某一段不显示时，后面的编号依次前移。
2. 删除 `GroupedShelf.tsx` 和 `MoreTile`。「全部角色」有三个入口：点作品扇形卡、切到「列表」、网格末尾的链接。**不做** SEL-7「题签」，因为它原本挂在已删除的分组书架上。
3. 选中作品后显示该作品的 Top 和书架，书架卡片用 `variant='plate'`。
4. 头部吸顶（MS-1）：背景是不透明的纸，不用 backdrop-blur。吸顶后收起 kicker 和双线，h1 缩到 20px，搜索框和「书架 / 列表」切换并到标题同一行，保留作品 chip 行。1440×900 下，吸顶头部总高不超过 150px。
5. 回到总览时，按 scope 恢复滚动位置（MS-5）。存在 sessionStorage 里，读写都包 try/catch。
6. 如果检查点 B 用户没有明确要求换成 TopRow，就保留 Bento。
7. 识别进行中（MS-6、TR-12）：收到 `library-changed` 且 `reason='tag'` 时，works 和 top 两个查询只标记 stale，不自动重拉；页面上方显示一条「有更新 · 刷新」的小条。这和 T34 的未识别队列共用 `lib/events.ts` 的同一处改动。
8. P2：OV-7 作品排序菜单；SEL-17「柱」（书眉），作品网格超过 60 部时再考虑。

### 验收
- 1440×900 截图，对照 `F:/Claude/.work/review/ref/2.webp`、`4.webp` 和原型 `F:/Claude/.work/review/overview/proto-1440-5col*.png`。
- 悬停扇形卡：侧卡外移约 20px、外转 4°，中卡上浮约 7px；动画约 0.5 秒，略带回弹，但不来回弹跳。Tab 聚焦时效果相同。开启 reduced motion 时几何不变。
- 真实库和 mock 各截亮色、暗色两张；没有横向滚动条；总览不再发出一串 `workId=…&limit=12` 的请求。
- **检查点 B**：把上面的截图、悬停截图，以及 H1 用衬线和用无衬线的两张对比图（D8）发给用户，并确认 D2–D6。

---

## T27 内容分类数据层 + 迁移 006

> **第二轮修订**：第 4 条的口径、hydrate、BI-9、验收里的 BI-8 一句，按 04-round2「未识别分大类 → 与 M5 现有任务的冲突 · 一」第 1–5 条改（未识别 = 插画和漫画、不含放下的，常量 `QUEUE`）；同批做「T27 补充」（`theme`、`art_score`、`shelved_at` 三列写进本迁移 006）。

**与 T32a 同一批合入。** T27 一生效，首页数字、角色张数、未识别都会变，没有别册页面，用户会以为图丢了。T27 完成、T32a 还没完成之前，不要让连着真实库的后端重启；或者设 `EMAKI_CLASSIFY=0` 跳过启动回填，此时所有查询按全部类型统计，保持旧值。按 MS-8 在 `data/dev-m5` 上开发。

0. 先改「全局约定 → 数据口径」：加上 `v_illust_images` 的定义，写明哪些数字只数插画、未识别的判定只看插画。

### 规格来源
`03-content-kind.md` 的 CL（分类体系、数据模型、产品行为）；**VF 的规则修正和 BI-1…BI-18 优先**。规则照 `classify-rules.reference.cjs` 移植，按下面第 1a 条修改。
**SEL-1 不作为依据。** 它的打分式分类器、字段名、启动后 setImmediate 后台回填、`kind.test.ts` 的用例和回填数量区间，都已经被 CL、VF、BI 和本节取代（其中 4 条用例和参考实现的结果相反）。SEL-1 只保留【api.ts】里的 `rated`、`seed` 两个查询参数（见第 9 条）。

### 决定（以本节为准）
1. 类型：`illustration | comic | screenshot | text | photo | meme | animated`（D4）。

   1a. 移植 `classify-rules.reference.cjs` 时要做的改动：
   - 删掉第 43 行的 `tags-smalltext → meme`。这是 VF-text 试过但没采纳的规则（BI-18）。
   - 第 32 行的 `format === 'gif'` 改为判定 `animated`，位置不动，仍在文件名、文件夹、相机规则之后，所以 `表情包2/a.gif` 仍判为 meme（来源 folder）。
   - `x.camera === true` 改为「camera 是非空字符串」。
   - 来源映射到 `ContentKindSource`：`dir` → `folder`；`gif` → `format`；`dims`、`dims+tags`、相机尺寸 → `size`；`wx_camera_`、`mmexport_camera` 文件名 → `name`（BI-6）；EXIF 相机 → `camera`；`tags*` → `tags`；兜底插画 → `default`。
   - 原型里的细分标签（如 `tags-page`、`camera+text`）和具体数值写进 `content_kind_evidence`，例如「文件夹「表情包2」」「comic 0.93」「尺寸 1080×2244」「HUAWEI EML-AL00」。
2. 迁移 `006_content_kind.sql`：
   - 列：`content_kind TEXT NOT NULL DEFAULT 'illustration'`（**不加 CHECK**，以后增减类型不用重建表，BI-3）、`content_kind_source TEXT`（NULL 表示还没判断过）、`content_kind_evidence TEXT`、`content_kind_manual INTEGER NOT NULL DEFAULT 0`、`content_kind_version INTEGER`、`camera TEXT`（`''` 表示读过但不是相机）、`kind_signals TEXT`（JSON，可空，第一版不写，留给 BI-5）。
   - 索引：`CREATE INDEX idx_images_kind_live ON images(content_kind, added_at, id) WHERE trashed_at IS NULL AND missing = 0`。只筛一种类型时，listImages 写成 `i.content_kind = @kind`。
   - 视图 `v_illust_images`：计入张数，并且 `content_kind = 'illustration'`。
3. 计算时机：
   - 扫描入库或内容变化时，按文件名、路径、尺寸、格式判一次；新扫描的 JPEG 顺带读文件头取 EXIF 相机。
   - 打标签后按标签重算，只在 `content_kind_manual=0` 时重算。只从 SEL-1 借接入点②的写法：writer 写完 image_tags 就重算。
   - 启动时在 migrate 之后、HTTP 开始监听之前，同步分批回填（BI-4：实测全库约 0.9 秒）。**不新增** `classify` 这个 JobKind。
   - **已入库 JPEG 的 EXIF 回填**：放在 `thumbnail` 任务 `runBackfill` 的末尾，并让 `pixelPendingCount()` 把 `format='jpeg' AND camera IS NULL` 也算进去，这样启动扫描后会自动排上。每批 200 张，只读前 128KB，批与批之间 `setImmediate`，可以取消；非 JPEG 直接写 `''`。读到后，对 `content_kind_manual=0` 的行立即重算。读文件不改大小和修改时间，T25 的 `known()` 不会因此触发扫描。
4. 口径（D3）：
   - 只数插画（改用 `v_illust_images`）：角色和作品的 `imageCount`、`recentImageCount`、`recentCount`、排名、+N、`Character.lastAddedAt`、`stats.characterCount`（只数有插画的角色）、`stats.lastAddedAt`、首页大数字、`addedLast7Days`（BI-11）。T28 写在 `v_counted_images` 上的 newCount、recentCount 和兜底封面，在这一步换成 `v_illust_images`。
   - 仍是全部类型：`stats.imageCount`、`totalBytes`。
   - 角色和作品加 `otherCount`。
   - 未识别队列、`suggestedCount`、`unrecognizedCount`，以及 T26 的 `untaggedCount`、`unsureCount` 和三个分段，都只数插画，同一口径。契约断言 `stats.unrecognizedCount >= stats.untaggedCount`。另加 `LibraryStats.pendingTagCount`（全部类型里 `tagged_at IS NULL` 的计入张数），给首页识别进度用。
   - hydrate：非插画又没有角色的图，status 返回 `'recognized'`，不新增 ImageStatus 取值，契约不变。`domain.ts` 的注释改为「有角色，或不是插画」。listImages 的 `status=unrecognized` 条件加 `i.content_kind = 'illustration'`（BI-9）。
   - 同框角色只统计插画和漫画（BI-12）。
   - `listCharacters` 只隐藏「插画和漫画都为 0、但有其他类型」的角色，另给 `otherOnlyCount`；0 张图的新建自建角色照常显示（BI-2）。
   - 自动封面候选只用插画；没有插画时，用有角色的漫画页兜底；截图、文字、表情、动图永远不用。所以 CL 契约 3 里「兜底封面永远不选非插画」这一条断言不写。
5. 写入器（BI-15）：只有 illustration 或 comic 的图，才会因为未知角色自动新建角色；screenshot、text、photo、meme、animated 上的未知角色只写进 character_suggestions（每张图仍然最多 5 条）。promoteSuggestions 的查询直接排除这五类。用户手动把图改成 illustration 或 comic 时，当场把这张图上分数 ≥ autoAccept 的建议提升为角色关联。
6. 标签截断（BI-5，P1）：分类用到的少量信号标签由 tagger host 额外输出 ≥ 0.2 的原始分数，存进 `images.kind_signals`。第一版可以先读 image_tags。
7. 扫描器接入点的两个细节，见 BI-14。本任务不新增 JobKind，所以 BI-13 列的那些改动都不需要。
8. 物理移动不在本任务里做（T37）。
9. 共享类型和 API（定稿）：
   - `export type ContentKind = 'illustration'|'comic'|'screenshot'|'text'|'photo'|'meme'|'animated'`；`CONTENT_KINDS` 按这个顺序；`ANNEX_KINDS` 为 `CONTENT_KINDS` 去掉 illustration；`ContentKindSource = 'name'|'folder'|'camera'|'format'|'size'|'tags'|'manual'|'default'`。
   - `ImageItem` 加 `kind`；`ImageDetail` 加 `kindSource`、`kindReason`（由 `content_kind_evidence` 拼成一句话）。
   - `ListImagesQuery` 加：
     - `kind?: ContentKind[] | 'all'`；
     - `rated?: boolean`（true 表示 `i.tagged_at IS NOT NULL OR i.rating_manual = 1`）；
     - `seed?: number`（整数 0–1073741823，只在 `sort='random'` 时生效；有 seed 时 `RANDOM_EXPR` 为 `(((i.id + @seed) * 2654435761) % 4294967296)`，mock 按 `hash(id ^ seed)` 排序）。
     - zod 写法照 SEL-1【api.ts】【查询】。契约用例：同一个 seed 两次结果相同，seed 不同时第一张不同。
   - `UpdateImageBody.kind` 和 bulk 的 `{ type: 'kind'; value }` 取 `ContentKind | 'auto'`；`'auto'` 会清掉 manual 并当场重算。bulk 操作可撤销。
   - `ListCharactersQuery.includeOther?: boolean`；`ListCharactersResponse` 加 `otherOnlyCount`。
   - `ListUnrecognizedResponse` 加 `annexCount`。
   - `LibraryStats` 加 `kindCounts: Record<ContentKind, number>` 和 `pendingTagCount`。
   - 新接口 `GET /api/content-kinds`：返回每一类的张数、最近张数和预览。
   - mock 按 `hash(id) % 100` 分配类型；契约夹具 `contract-db.ts` 不动，默认都是 illustration（BI-7）；`groups.ts` 的 getStats 补上 `kindCounts`（illustration 32，其余 6 类为 0）和 `pendingTagCount`。

### 验收
- `services/classify/rules.test.ts` 用表驱动，每条用例写明宽、高和格式：
  - CL「四、分类器」的全部用例（其中「1080x2160 且 tags=null」的期望改为 illustration）；
  - 再加 VF 明确写出的这几条：
    - `QQ_Images/x.jpg` 750x1334、tags=null → screenshot/size；
    - 750x1334 + `{1girl:.99, solo:.97}` → illustration；
    - `{text_focus:.82, 1girl:1, monochrome:.99, greyscale:.99}`（1200x1700）→ comic/tags；
    - 3024x4032 jpeg、camera=''、tags=null → photo/size；
    - `立绘/表情差分/01.png` → illustration；
    - `a.gif` → animated/format；
    - 600×600 + `{text_focus:.86}` → text（**不是** meme）。
- 在 `data/dev-m5` 上回填，先取消 tag 任务，保证识别没在跑。用只读 SQL 每类抽 20 张看缩略图：截图、漫画、照片、动图的精确率 ≥ 90%，文字、表情 ≥ 85%。结果记进本节「实测」。EXIF 回填完成后，`SELECT COUNT(*) FROM images WHERE format='jpeg' AND camera IS NULL` = 0。
- 未识别数的减少量 = 「非插画并且没有角色关联」的计入张数（BI-8）。
- **检查点 C**（和 T32a 一起）：把各类张数、抽样精确率和别册页面截图发给用户。

### 实测（2026-09-27，data/dev-m5，21,252 张全部已识别）
- 迁移 006 + 启动回填：21,252 行 2.1–2.5 秒（读分类标签 0.6–0.8 s，计算 0.44 s，写 0.37 s）。只在 `CLASSIFIER_VERSION` 变化时发生，平时启动 0 行；高于 RV-T-6 的 1.5 秒，未再优化。按名字 JOIN 读标签要 3.5 s，已改成先换 tag_id 再一次读全库。
- EXIF 回填：17,919 张 JPEG 读完（`format='jpeg' AND camera IS NULL` = 0），认出 230 张相机照片。
- 类型张数：插画 13,817 · 截图 2,698 · 漫画 2,515 · 文字 1,032 · 照片 492 · 表情 411 · 动图 287。unrecognizedCount 10,743 = QUEUE 的只读 SQL。
- 验收 3a：`tagged_at IS NOT NULL AND theme IS NULL` = 0；`tagged_at IS NULL AND theme IS NOT NULL` = 0。
- 抽样（每类随机 24 张，印样在 F:/Claude/.work/review/t27/）：截图约 23/24（B 站逐帧截图按定义算截图）；漫画 23/24；动图 24/24；文字约 21/24（88%）；**照片约 20/24（83%）**；**表情约 18/24（75%）**。照片的误判主要是两类：`FLOWERS版画重制分享计划` 17/47 张带 HUAWEI BAC-AL00 相机 EXIF（手机翻拍的版画，看上去就是插画），以及带相机 EXIF 的手机截屏。试过「相机 + 人物标签 ≥ 0.85 + 无写实标签 → 插画」，抽 30 张里只有约 7 张是翻拍插画，其余是手办、拍屏、截屏，规则不采纳；按 RV-T-16 不改规则，检查点 C 报告用户（可以多选后按 C 改回插画）。表情类的误判是新闻截图、聊天截图、人物照片拼图。
- CL 验收的三个文件夹：Hisuitegallery 770/772 插画；CG 133/136；**FLOWERS 30/47**（上面的相机 EXIF）。
- 主题抽样（没认出段，每组 24 张）：腿·足约 22、胸约 20、泳装约 21、兽耳约 20、女仆·和服约 20、多人约 18（门槛 16）、不像插画约 20 张确实不是插画；「其他」按 art_score 前 24 张全部是插画。全部达标。

---

## T32a 别册：最小可见版（与 T27 同一批合入）

只用现有组件，目的是在 T27 改变口径的同时，让用户能看到这些图去了哪里。
- 侧栏在「已排除」上方加「别册」入口，计数只显示总数。
- `/annex/:kind?`：用 ImageGrid（rowHeight 180）展示；类型切换先用现有的 Chip。不带 kind 时显示第一个非空的类型。
- 图库默认只看插画。按 D2：KindIndex 前面放「全部 {总数}」（`kind=all`），副标题写「10,570 张插画 · 另有 8,512 张在别册 →」，加首次提示条和 `usePrefs.galleryKinds`。从标签或 ⌘K 跳过来时显式带上 `kind=all`（BI-10）；`kind=all` 时网格里显示类型小标记。
- 看图器信息面板加「类型」一行：普通按钮加判定原因，以及「改成…」。
- 多选后按 `C` 弹出「归入…」菜单：插画加 6 个别册类型，共 7 项，数字键 1–7 直接选，另有「恢复自动判断」。执行后先用现有的撤销 toast，T35 完成后会自动换成引信样式。
- 角色和作品详情加「插画 | 全部」切换，Hero 显示「另有 N 张漫画等」。
- 角色书架和列表末尾加一行「另有 N 位角色只出现在截图等图片里 · 显示」（`?other=1`）。
- 未识别页的 DecisionPanel 加「不是插画」（N 键）；BatchPanel 加「标为…」（CL「界面」第五条）。
- 不做「重新判断」按钮：没有 classify 任务，规则升级靠 `CLASSIFIER_VERSION` 在启动时重算。CL「界面」里用到 `useStartJob('classify')` 的两处也不做。

### 验收
- 真实库副本上，每一类都能打开并截图。随机把 5 张截图改回插画，再撤销，前后状态一致。首页和图库的数字口径一致（BI-11）。

---

## T29b 画集语汇

> **第二轮已拆分**：拆成 T29b-1（token 与中文衬线）、T29b-2（页头）、T29b-3（章节标题）、T29b-4（模糊策略）、T29b-5（其余：Seal、看图器暗房、网格圆角、sonner）。规格见 `docs/design/m5/04-round2.md` 和上面「M5 第二轮」一节；本节原文只作为 T29b-5 的依据。

### 规格来源
- 颜色 token：`02-aesthetic.md`「Token 改动」里的颜色部分，包括暖色纸、暗色「夜和纸」、`--c-seal`、`--c-rule`、`--c-stage`、纸纹。圆角按原则 1，`--radius-plate` 取 12px，**不是** 02 里写的 6px。
- 页头骨架：SEL-3（kicker、标题、双线、章节编号）。章节编号表改为：
  - 角色页：「01 你最常看的 · 02 最近 30 天在收（或『更多常看的』）· 03 作品」；
  - 首页：见 T31 的「首页顺序」。
- 字体：`@fontsource-variable/noto-serif-sc`（npm 上有，5.3.0，OFL-1.1；按 unicode-range 分片加载，dist 约增加 6 MB），只用于 H1、kicker 和章节标题（D8）。
- Seal：新建 `components/ui/Seal.tsx`，朱文印和白文印，规格见 **SEL-4【Seal 组件】**。白文印只用于扉页奥付里的「新」「自」（SEL-8）和别册类型印，**不用于 +N**。
- 模糊范围：
  - CB-6：默认模糊 questionable 和 explicit，「轻微」不模糊，文案里讲清原因；
  - D6：`usePrefs.blurAnnex`（默认只模糊照片；「文字也模糊」单独一个选项），只存本机，设置页注明；
  - Thumb 的 image 加可选 `kind?: ContentKind`；模糊判断统一成 `shouldBlur(rating, level, kind, prefs)`，Lightbox 和 PreviewStage 也改用它；
  - B 键同时切换全局模糊和这个开关。封面类（CoverRef、角色封面）不传 kind。

### 验收
- `/dev/ui` 和主要页面，亮色、暗色各截一张；设置页的模糊选项都能生效；首页 H1 用衬线和用无衬线各截一张（交给检查点 B）。

---

## T31 首页改版

### 规格来源
- 首次导入与任务横幅：HO-2（ImportPanel）、HO-9；ImportPanel 的识别进度改用 `pendingTagCount`。
- 待处理卡：
  - HO-3；
  - HO-4 与 HO-B3：从没查过重时不能显示「已清空」；文案按 CR-14，运行中写「正在查找」，排队中写「马上开始查找」；
  - HO-5：去掉 4 / 5 键帽；
  - HO-8；HO-B4；
  - HO-B2：「未识别」和「已认出 X%」都要扣掉待识别的图。
- 最近在收：HO-6、HO-7（复用 RecentStrip）。
- 统计条与细节：HO-10、HO-12、HO-B6（`formatRelative` 改用 `Math.trunc`）、TR-8。
- 扇形小样：HO-11，用 CoverFan 的 5 张版本。
- 页头：SEL-3。
- 今日一枚：SEL-9，用 T27 的 `seed` 和 `rated`；开着模糊时只取 `rated: true` 且分级为 general 的图。

### 首页顺序（定稿）
1. JobBanner 或 ImportPanel
2. StatsStrip：第一格用 `kindCounts.illustration`，hint 写「另有 N 张在别册」
3. 01 今日一枚
4. 02 待处理
5. 03 最近在收（为空时换成「收得最多」）
6. 04 最新入库（只取插画）
7. 05 别册：T32b 的 AnnexIndex，本任务先留占位

### 验收
- 用 `EMAKI_MOCK_SCENARIO=first-import npm run dev:mock`（HO-1 定义的 mock 场景）截「首次导入」状态，用普通 mock 截「有新图」状态；真实库只做只读截图。
- 首页不再出现与实际不符的「已清空」，没有 4 / 5 键帽，也没有虚线空洞。
- 「今日一枚」同一天刷新不变；点「换一张」连续 8 次，得到 8 张不同的图。

---

## T32b 别册：正式版

### 规格来源
- SEL-5：目次（KindIndex 用 Seal 朱文印放左下，最前面有「全部」一项）、页面结构、首页 AnnexIndex（接到 T31 留的「05 别册」占位）。
- SEL-6：按类型陈列。截图用 9:16 竖卡，悬停时往下翻；文字像一页页纸；表情用贴纸格。
- ~~P2：SEL-20，漫画按文件夹成册~~：不做，由合集（T38）代替（第二轮，RV-C-13）。
- CL「界面」只取第五、六、八条（已在 T32a 做过）。不做 CL 的 `/sorted` 别册页、KindDrawer、T 键、KindBadge、KindPicker，也不做 Top「占全部收藏」。

### 验收
- `/annex` 每一类都截亮色、暗色两张。KIND_META 里 animated 的配置为 `{ label: '动图', glyph: '动', icon: Film }`。

---

## T33 浏览页

### 规格来源
- 看图器：
  - BR-B1（**P0**）：翻到已加载的最后一张就到头了。要能自动加载下一页，计数显示总数。
  - SEL-12「拿起与暗房」：**替代** BR-6 和 BR-7。舞台用不透明的暗色，不用氛围背景。
  - BR-8。
- 角色详情：
  - SEL-8「角色扉页」：**替代** BR-2。奥付区里只保留 SEL-8 那一行文字链接。
  - 「常一起出现」：扉页下方的独立章节「01 常一起出现」（SEL-3 的编号），用 BR-3 的 AvatarTile 头像行。
  - BR-B2。
  - MG-14：`CharacterHero.tsx` 里按顺序做：扉页 → 「恢复自动封面」按钮（T25.5 的接口）→ CB-7 换封面候选面板（P2）。
  - BR-B3 + CR-4：T25.5 修好 newCount 后，现有「取前 newCount 张」的写法就是对的，只把「新」角标改成小朱点。
- 作品页：BR-4 + CR-13。读 `work.covers` 做扇形；角色区为 Top 4（overlay）加 AvatarTile 头像网格。
- 图库网格：BR-5。悬停时显示角色名，需要 `ImageItem.characterNames` 这个小契约，四处一起改。**不采用** BR-5 里对 gap 和圆角的改动，网格圆角按原则 1 用 `--radius-plate-sm`。

### 验收
- mock 的角色详情、作品详情，亮色、暗色各截一张。
- 看图器能从第 1 张一直翻到最后一张（跨分页）；关掉看图器后，网格定位到刚才那张图。

---

## T34 整理页（只做前端，数据来自 T26、T27）

> **第二轮修订**：未识别页改由 T34a / T34b / T34c 实现（大类、分段、主题组、印样批量处理），**T34d 取消**，本子由 T38f 的「成册待整理」处理，规格见 04-round2.md。本节里重复页、侧栏、引导页、已排除页的部分（TR-4 到 TR-11、TR-B2）仍然照做。

### 规格来源
- 未识别：
  - TR-1：分「有建议 / 没把握 / 待识别」三段；
  - TR-2、TR-3；
  - TR-12：识别进行中不整体重排，和 T30 第 7 步共用；
  - TR-13（P2）：待识别分段的队列虚拟化。
- 侧栏：
  - TR-4 与 MG-11：需要人处理的数 = `unrecognizedCount − untaggedCount`（T27 之后两者口径一致，不会小于 0），显示精确数字，加 Tooltip；
  - TR-7：任务环。
- 重复：
  - TR-B2 与 MG-12：`useDedupeState()`，没查过重时不能显示「已清空」；
  - TR-5、TR-11。
- 引导与其他：
  - TR-6：引导页编号改为 01 / 02 / 03；
  - TR-9。
  - TR-10 已被 T29b 的吸顶头部取代（不透明的纸加 1px 细线，不用 backdrop-blur），这里只核对重复页的效果。

### 验收
- 用 `EMAKI_MOCK_SCENARIO=first-import` 的 mock（识别进行中）打开 `/unrecognized`：三段计数与 `GET /api/unrecognized` 一致，列表不会每 5 秒整体重排。
- 重复页在「从没查过」「正在查」「查完没有重复」三种状态下文案都正确。

---

## T35 质感与微交互

### 规格来源
- P1：
  - SEL-10 装裱式选中；
  - SEL-11 引信撤销：新建 `components/ui/Toast.tsx`；开启 reduced motion 时引信照常显示。T32a 的归类 toast 自动换成这个样式。
- P2：
  - SEL-14 封面长成扉页（View Transitions）；
  - SEL-15 印框焦点与 chip 墨块；
  - SEL-16 放映：用 T27 的 `seed` 和 `rated`；
  - SEL-18 机械计数；
  - SEL-19 识别胶卷：接到 T31 的任务横幅上。
- 不做：`02-aesthetic.md`「不采纳的点」里的全部内容（指针倾斜与高光、加载时显影、拖拽分拣、氛围光）。

### 验收
- 每个时刻录一段 GIF 或截图序列，存到 `F:/Claude/.work/review/after/`。
- 在 `/gallery` 执行 `new PerformanceObserver(l => console.log(l.getEntries().map(e => e.duration))).observe({ type: 'longtask' })`，快速滚动 10 秒，控制台没有大于 50 的值。

---

## T36 文档定稿与视觉验收

- `docs/FRONTEND.md`：
  - 写入 M5 的六条原则、token 表、`lib/motion.ts` 的用法、+N 的两种写法；
  - §3 角色总览改写成三段式（Top / 最近在收或「更多常看的」/ 作品）；
  - 忽略 `02-aesthetic.md`「Token 改动·九」里关于 +N 的两处。
- 「全局约定 → 数据口径」：核对 T25.5、T27、T28 第 0 步写入的内容和最终实现一致。
- `README.md` 的截图全部重拍：用 mock 数据，亮色、暗色各一套，**不要**用用户真实图库的截图。截图用 `F:/Claude/.work/shot.mjs`，它的 Chrome 配置目录在 `F:/Claude/.work/.chrome-profiles/`，不进仓库。`.gitignore` 已加 `chrome-cdp-*/`。

---

## T37 （可选，待确认后再排期）在磁盘上分类存放

默认不做：Emaki 承诺只读，不移动文件。用户确认后，按 `03-content-kind.md`「在磁盘上分类存放」一节实现：
- 手动触发，先预览要移动哪些文件；
- 目标目录为 `{库根}/_Emaki/<类型>/`；
- 移动后按 sha256 认出是同一张图，id 不变；
- 可以一键还原；
- 分类规则要跳过 `_Emaki/` 下的路径段，否则文件夹规则会把被误判、又被整理进去的图锁死（BI-16）；
- 移动失败时必须删掉占位文件。这是「永远不删除文件」的唯一例外，要写明。

---

## 风险与未决问题

### 技术风险

1. **DirectML 稳定性**：DirectML EP 已进入 sustained engineering，有 ORT.DirectML 1.24.x 建 session 时原生崩溃的报告（[OpenUtau PR #2443](https://github.com/openutau/OpenUtau/pull/2443)）。缓解：子进程隔离、自动回退 CPU、onnxruntime-node 精确锁定 1.30.0；如果本机 DML 反复崩溃，试降到 1.23.2。另一个 GPU 方案是 onnxruntime-node 自带的 WebGPU EP（实验性），但要扩展 `TaggerDevice` 类型（改 shared 契约）。
2. **DXGI 适配器顺序**：适配器 0 可能不是 RTX 3070（本机还有 MuMu 虚拟显示适配器）。T09 的探测 + `dml-device.json` 缓存能处理，但探测会多加载一次 1.26 GB 模型；万一选错，用 `EMAKI_DML_DEVICE_ID` 手动指定。验收时一定要在任务管理器里确认是 NVIDIA GPU 在跑。
3. **速度未实测**：eva02 在 3070 Laptop + DML 的速度是估算。回退到 CPU 时 10 万张要 1–3 天；UI 只提示用户换 SwinV2，不自动换（会改变 `tagger_model` 的语义）。DML session 空闲时占约 3 GB 显存，60 秒后回收；边打游戏边识别可能显存不足，靠崩溃转 CPU 兜底。
4. **模型与新角色**：WD v3 训练数据截至 2024-02-28，更新的角色认不出来，只会落进「未识别」。PixAI v0.9（数据到 2025-01）是可选预设，但没有 rating 输出，ModelScope 上也没有镜像。
5. **下载源可信度**：ModelScope 的 `fireicewolf/*` 是第三方镜像，内容可信完全靠写死的 sha256；上游更新模型时 revision 和 sha 要人工更新。hf-mirror 对部分客户端会 308 回 huggingface.co（本机 2026-09-27 实测也是如此，所以国内网络下 hf-mirror 不一定真的更快）。ModelScope 小文件对 Range 请求返回非标准的「200 + Content-Range」，T09.4 已按 Content-Range 处理；以后换别的镜像源也要先用 `curl.exe -s -D - -o NUL -H "Range: bytes=100-1123" <url>` 看一眼响应头。
6. **better-sqlite3 13.x 很新**（2026-07 发布的 N-API 重写）。如果遇到回归：锁定 12.10.1（要从 GitHub 下预编译包，国内常失败，失败后要装 VS Build Tools），或启用 T01 第 10 步的 `node:sqlite` 适配器（`EMAKI_SQLITE_DRIVER=node`）。
7. **npm 12 会默认拦截未审核的安装脚本**：T01 / T09 必须按规程 approve。每次升级 esbuild（随 vite / tsx 升级）或 onnxruntime-node，都要重新 `npm approve-scripts`（钉住的是具体版本）。
8. **同步 API 阻塞事件循环**：better-sqlite3 是同步的，扫描、对账、批量操作、Derived 重建（10 万张约 0.2–0.4 秒）都会短暂卡住 HTTP 和 SSE。计划里要求小事务 + 让出事件循环，T22 兜底；超预算时 Derived 要改成 worker_threads + 只读连接，复杂度会明显上升。
9. **首次扫描是 IO 瓶颈**：sha256 要读全部字节（10 万张 × 3 MB ≈ 300 GB），机械盘可能要几十分钟到数小时。图片会逐步出现，但「全部入库」会很慢；机械盘上把 `EMAKI_SCAN_CONCURRENCY` 设成 1。
10. **文件监听不可靠的场景**：`fs.watch` 在大批量拷贝时可能缓冲溢出丢事件，网络盘上可能完全没有事件，被监听目录改名后会静默失效。计划里有 null 文件名时整根重扫、60 秒可达性重试、默认 180 分钟定时兜底，但实时性不能保证。监听中的根目录会让 U 盘「无法安全弹出」，界面上应该提示用户先停用该文件夹。
11. **回收站**：trash 打包的 recycle-bin.exe 是 2.0.0，失败时可能静默，所以必须逐个验证；`glob` 默认为 true，二次元文件名里的 `[ ] ( ) { } !` 会被当成通配符，所有调用必须 `{ glob: false }` 并有单测断言。Electron 打包时 exe 要 asarUnpack。trash 操作不可撤销（mock 里可以），可撤销的暂存区方案作为 T18.x 保留。
12. **sharp 格式支持**：预编译 sharp 不支持 BMP 和 HEIC。BMP 用自写解码器（只支持 24/32 位未压缩），T09 预处理遇到 BMP 返回 UNSUPPORTED（这些图不会被识别）；HEIC 不收录。
13. **Danbooru 的 Cloudflare 策略随时可能变化**：用 VPN 或机房 IP 的国内用户即使 UA 正确也可能被挑战。代码会降级为本地推断，但多作品角色（Fate、崩坏）的次作品会丢失。related_tag 很慢（0.3–3.5 秒/次，约 1 req/s 串行），首跑 500 个角色约 10–20 分钟，前端进度条要显示 n/N。
14. **中文词库依赖单人维护的数据源**：ame-la/danbooru-tags-data-zh 只有 1 star，可能停更或删库。已固定修订号并把生成的 gz 提交进仓库；以后更新要人工重跑脚本。词库译名是社区叫法，个别和官方不同，用户改名后会被 `name_locked` 保护。

### 产品决策（已按下列默认实现，可随时调整）

15. **识别阈值默认值改为 0.35 / 0.85**（mock 原来是 0.85 / 0.9）。eva02 的校准偏保守（P=R 阈值 0.53，swinv2 是 0.27），换模型后同样的阈值效果会不同，需要用用户真实图库调一轮。
16. **主作品规则在离线和联网之间不一致**：离线表「母 IP 在前」（hololive），联网同步「并列时更具体的在前」（hololive English、崩坏：星穹铁道）。联网同步后以在线为准；两种规则下角色都同时挂在母系列和子作品下，只影响卡片上显示哪个作品名。如果希望统一成「母 IP 在前」，只需改 T11 的 `pickCopyrights` 第 2 条规则和夹具。
17. **服装变体归到本体**（`mika_(swimsuit)_(blue_archive)` → 圣园未花）：按角色整理时更合理，但用户可能想要单独的「泳装未花」。离线时只能靠标签名模式推断，覆盖不全（例如 `shiroko_terror_(blue_archive)` 推断不出来）。
18. **建议角色的作品归属**（`image_copyrights`）：没被自动采纳、但建议角色所属作品已存在时，图会出现在该作品下。这让「只有作品、没有确认角色」的图也能按作品浏览，代价是偶尔会把错误建议对应的作品算进来。不满意的话，去掉 T10.5 里写 `image_copyrights` 的那几行即可（视图和其他查询不用改）。
19. **`danbooru.enabled` 默认关闭**，由首次启动引导让用户选择（引导页上的开关默认打开）。只发送标签名、不上传图片，但仍是联网行为，所以不在后台默认开启。
20. **新建角色的「+N」**：首次导入时，角色在第一批里被创建，同一次打标签后续批次归进来的图会算作「新增」，所以刚导入完很多角色会显示 +N。可以接受；如果不满意，T10 可以在任务结束时把本次新建角色的 `last_seen_at` 设为任务结束时间。
21. **与 mock 的有意差异**（契约测试不比较）：newCount 绝对值、兜底封面、删除排除规则后重新应用其余规则、采纳建议后删除该建议、采纳时可能新建作品、文件名排序、random 排序、合并后的 newCount、listImages 的游标格式。前端如果依赖了 mock 独有的行为，会在 T21 的核查清单里暴露。

### 未决问题（需要用户或后续任务确认）

22. **图库根迁移**：移动硬盘从 E: 变成 F:、或文件夹改名后，旧根不可达（行保留、不标 missing），新根里的图会被当作新图插入，角色和收藏不会自动迁移。需要以后做「根目录迁移」功能（按 sha256 批量重定向），不在当前计划内。
23. **撤销只在内存里**：重启后撤销失效，被软删除的图库文件夹也会在启动时被真正删除。设计上的取舍，界面上是否需要提示？
24. **重打标签没有「拒绝表」**：用户手动移除的 tagger 角色，在换模型重跑时可能被加回来（默认范围只重跑未识别的图，影响很小）。
25. **API key 明文存储**在本地 SQLite 的 settings 表。本机单用户场景可以接受；如果以后做多用户或云同步要改。`domain.ts` 注释「API key 可提高速率限制」与官方文档不符，T11 会改注释。
26. **数据库体积**：10 万张图约 350–400 万行 image_tags（约 200 MB）。如果用户在意，可以把 general 标签上限从 80 降到 40。
27. **User-Agent 里的仓库地址**：`config.appRepoUrl` 要在上传 GitHub 后填成真实地址（T11）。
28. **可选任务是否要做**：T09.12（PixAI 预设）、T14.x（`/api/characters/danbooru-matches` 接口，需要改前端）、T18.x（可撤销的删除）、T20 的拼音搜索、T23 的 Electron 壳。默认都不做，等核心功能稳定后再决定。
29. **用户本地插画**：T10 / T12 / T21 的端到端验收需要一批真实插画（含常见角色）。用户提供之前，这些验收只能先用 `fixtures-lib` 验证流程，识别准确度相关的检查要等图到位后补做。

