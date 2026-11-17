# 核心架构：现状盘点与已知不一致

> 配合 [core-architecture.md](core-architecture.md) 阅读。快照：`codex/flexible-collections` @ 13c677d，加上 desktop 上未提交的改动（2026-11-17）。
> 路径默认相对 `apps/server/src/`；`SDS` = `datasource/sqlite/SqliteDataSource.ts`，`Mock` = `datasource/mock/MockDataSource.ts`，`web/` = `apps/web/src/`。
> 行号会随代码变化，以函数名为准。

## 规模

- 「图里有哪个角色」（`image_characters`）有 13 个写入点，分布在 11 个文件里；写「建议」（`character_suggestions`）的有 7 个文件。
- 用户可以撤销的修改：36 处用 `ctx.mutate`，6 处手工拼撤销令牌。`ctx.touch` 有 21 处调用；合集刷新钩子有 13 处直接调用，另有 7 处间接调用。
- `DataSource` 接口有 63 个方法：29 个查询（其中 2 个会写东西），34 个命令。HTTP 有 84 个接口（67 个核心 + 17 个助手），MCP 有 17 个工具。
- Mock 约 3,800 行，其中约 74% 是业务逻辑而不是演示数据；SQLite 数据层（不含测试）约 7,900 行。两边共用的纯规则模块只有十来个。

## 一、归类（角色关联、建议、原创、作品）

| # | 不一致 | 位置 | 由谁解决 |
| --- | --- | --- | --- |
| 1 | 「能否自动关联」有 3 套实现。识别写入时，新角色能不能建档取决于它在批次里的先后（`services/tagger/writer.ts:150-161`）；补采纳按整批收集新标签（`datasource/sqlite/kinds.ts:84-90`）；Pixiv 有自己的 `automatic` 规则，不经过 `canAutoAcceptCharacter`，漫画能否参与看设置，而另外两处总是允许漫画（`services/pixiv/match.ts:351`、`services/pixiv/sync.ts:18`）。新加的 `characterAcceptance.ts` 只接进了前两处 | 见左 | 4.2 `decideAuto`；P3 |
| 2 | Pixiv 资格判断里写死了 `cs.score>=0.8`（`services/pixiv/sync.ts:21`），而设置里的自动采纳阈值默认是 0.85（`datasource/sqlite/settings.ts:29`） | 同左 | 4.2；P3 |
| 3 | 只有用户手动改类型时才会重新评估自动关联（`kinds.ts:58`）。相机识别、帧数检测、扫描重判这些自动改类型的路径都不会；图变成截图后，已有的自动关联也不会移除 | `classify/backfill.ts`、`ThumbnailService.ts:154,197`、`Scanner.ts:381` | `reevaluateAuto` 订阅 `image.kindChanged`；P2/P3 |
| 4 | 13 个写入点：识别写入、补采纳、单张采纳、批量 `assign` / `assignTag` / `unassign`、`updateImage` 整组替换、Pixiv、角色合并、查重合并、撤回自动绑定、撤回 Pixiv、撤回移动、漫画区同步。合并、查重合并、撤回移动重新插入关联时都不检查否决 | `bulk.ts:49-81`、SDS:756-771、`unrecognized.ts:273-311`、`characters.ts:403`、`duplicates.ts:56-64`、`changeLog.ts:183-345`、`classify/rootMode.ts:32-41` | 统一走 `curation.link` / `unlink`；P3 |
| 5 | 来历的记法随路径而异：单张采纳记成 `manual` 但带着模型分数（`unrecognized.ts:303`）；补采纳记成 `tagger`（`kinds.ts:112`）；Pixiv 记成 `tagger` 且分数为空（`pixiv/sync.ts:133`） | 同左 | 2.2 统一来历；P3 |
| 6 | 上一条的后果：漫画区同步会删掉补采纳和 Pixiv 的关联，却留下单张采纳的（`rootMode.ts:40`）；撤回自动绑定时，会顺带删掉不是这次绑定造成的补采纳和 Pixiv 关联（`changeLog.ts:176-180`）；查重合并只搬 `manual` 关联，补采纳的会丢（`duplicates.ts:61-63`） | 同左 | 2.2；P3 |
| 7 | Pixiv 的「原创」用 `image_copyrights` 加空分数来存，和手动原创的存法一样；识别写入把空分数当成手动（`writer.ts:66-67`）；撤回 Pixiv 靠时间戳相等来判断（`changeLog.ts:239-244`）；「原创」这个作品有两种建法：批量操作直接插入，不带颜色和别名（`bulk.ts:132`），Pixiv 用 `ensureWork`（`sync.ts:264`） | 同左 | D8；P3 |
| 8 | 建议里主要作品被写进 `image_copyrights`（`writer.ts:172-175`），而 `v_image_works`（迁移 030）会把它算作图的作品；采纳或移除关联后，这些行一直留到下次重新识别；Pixiv 的建议则从不写 | 同左 | 2.3 作品关联分开证据和决定；P3 |
| 9 | 两边写建议的方式冲突：模型的 upsert 会覆盖 Pixiv 的行（`writer.ts:64-65`），Pixiv 用 `INSERT OR IGNORE`（`sync.ts:135`，代码注释 `sync.ts:248` 自己也承认）；批量关联、整组替换、标原创、放下时都不清理建议，只靠读取时隐藏（`suggestions.ts:62`） | 同左 | 2.3 建议改为派生视图；P3 |

## 二、图片生命周期和连带处理

| # | 不一致 | 位置 | 由谁解决 |
| --- | --- | --- | --- |
| 10 | 文件内容变化有两种语义。扫描发现变化时，会清掉 `tagged_at`、主题、画质分并重判类型（`Scanner.ts:347-353`）；用户替换文件则这些都保留，尺寸、格式、帧数变了也不重新分类、不重新识别（`replaceImage.ts:14-17,110-115`）。两条路径都不重置 `artist_checked_at`；文档 `TASKS.md:614` 写的和代码不一样 | 同左 | D1；`image.fileChanged` + `analyze`；P4 |
| 11 | 移动文件有三条路径，后续处理各不相同。扫描发现的移动：重新解析来源、完整重分类，但不套排除规则；应用内「移动…」：套排除规则、同步漫画区，但不解析来源、不刷新合集、不重新识别；整理到子文件夹：什么都不做（`Scanner.ts:334,355-358,381`；SDS:892-939；`organizeCollection.ts:64-80`） | 同左 | `image.moved` + 反应；P2/P4 |
| 12 | 查重合并直接搬字段：不套排除规则，丢掉补采纳的关联，不带「放下」，搬来源时不重排 Pixiv（`duplicates.ts:56-99`）；Mock 会把所有角色都搬过去（Mock:1773） | 同左 | 改为调用归类命令；P3 |
| 13 | 来源变化后的处理因路径而异：启动修补和改来源模式会重排 Pixiv、清掉过期建议（SDS:208,1104-1111）；扫描结束时的修补不传回调（`Scanner.ts:542`）；扫描发现的移动用 `COALESCE` 保留旧来源；手动改来源只刷新同投稿组（SDS:729-743）；查重合并来源时不重排 | 同左 | `image.sourceChanged` + 反应；P2 |
| 14 | 新增关联后要套排除规则：识别、Pixiv、单张采纳、`assignTag`、补采纳会套，批量 `assign`、`updateImage`、角色合并、查重合并不会（`bulk.ts:49-65`）。有的路径会记录以便撤回，有的不会 | 同左 | `reevaluateExclusions`；P2 |
| 15 | `excluded_by` 只加不减：移除角色或标签、从被排除的文件夹移出，都不会解除排除（`exclusions.ts:40-41`） | 同左 | 排除结果改为派生、可双向重算；P2 |
| 16 | 恢复被排除的图后不会重新排队识别，而识别任务会跳过被排除的图（`tagJob.ts:66`） | 同左 | `queueTagging` 订阅 `visibility.changed`；P2 |
| 17 | 合集不刷新的情况：应用内移动、撤回移动、整理到子文件夹、相机或帧数检测改了类型、中途让出或中止的识别和扫描（它们会跳过结束钩子，`pipeline.ts:94,111`）、单张采纳和 `assignTag` 以及 Pixiv 造成的排除变化 | `ThumbnailService.ts:152-155,197`、SDS:892-940 | `refreshFolderCollections`；P2 |
| 18 | 只有图库文件夹变化会标记「需要重新查重」（SDS:488-493）；恢复排除、删排除规则、撤销回收、文件丢失都不会，而查重会删掉成员已经不可见的未处理组。这些标记只存在内存里（`pipeline.ts:68-78`），重启就丢 | 同左 | `markDedupeDirty` 持久化；P2 |
| 19 | Pixiv 资格只在识别批次结束时排队（SDS:256-259）；之后类型、放下、原创、合集变化都不会让图重新排队 | 同左 | `queuePixivCheck`；P2 |
| 20 | 缓存约定被破坏。本来的约定是「用户操作强刷新，后台任务弱刷新」（SDS:455-463），但相机识别（SDS:403-406）、查重（SDS:446）、扫描后的漫画区同步（SDS:333）、合集刷新（SDS:531）、Pixiv 每个投稿的 `touch`（`pixiv/sync.ts:296`，还被标成 `mutation`）、后台自动绑定，都在强刷新；任务结束一律标成 `scan`（`core/jobs.ts:189`）；每个用户操作会强刷新两次 | 同左 | 提交后反应按 actor 决定；P2 |
| 21 | 「写完要调什么」靠调用方自觉：`ctx.touch` 21 处，合集钩子 20 处，排除、否决、自建角色匹配、设置和图库文件夹监听各自手工调用；`invalidate` 的 `scope` 参数被忽略；`ctx.write` 没人用；`stats` 事件从来没发过 | `datasource/sqlite/context.ts:46-81` | 变化集 + 反应注册表；P2 |
| 22 | 撤销后的连带处理靠手工接线（`u.onUndo` 10 处、`onUndoLast` 2 处），已经漏了：改来源模式后的重新匹配、`artist-auto` 的重排画师，撤销时都不会重跑；后台自动绑定会产生没人用的撤销令牌，占用 50 个名额 | `sqlite/undo.ts`、`characters.ts:144` | 5.3 撤销 = 还原 + 重跑反应；P2 |
| 23 | 版本和遗留：合集判定的 `DETECTOR_VERSION` 存了但从不检查（`CollectionService.ts:472`）；`image_fingerprints` 表没人读写；回收站里的行永远是移动匹配的候选，重新下载同样的文件会复活旧 id 和旧关联（`Scanner.ts:258-265,355`）；缩略图、动图缓存、替换备份从不清理；「分类只有一个入口」的注释已经不对（`classify/backfill.ts:2-5`，另有 `scan/imageRow.ts:13-17`，替换文件则完全绕过分类） | 同左 | `analyze` 唯一入口、派生数据带版本；P4 |

## 三、读取口径

| # | 不一致 | 位置 | 由谁解决 |
| --- | --- | --- | --- |
| 24 | 「可见」的条件在 10 个文件里内联了约 15 次；Mock 的 `isVisible` 没有判断 `missing`（Mock:198） | `CollectionService` ×3、`ThumbnailService` ×2、`exclusions` ×2、`duplicates` ×2 等 | 命名口径；P5 |
| 25 | 和「待处理队列」相似的条件抄了 5 份，各有出入：`tagJob.ts:73` 没有 `original_at`；`kinds.ts:75` 没有 `NOT_IN_BOOK`，也没看漫画设置；Pixiv 额外加了动图（`sync.ts:18`）；`library.ts` 里有两份（`library.ts:104,152`） | 同左 | 命名口径；P5 |
| 26 | 统计里的作品数（`library.ts:171-176`）直接数 `image_copyrights`，绕过了迁移 030「原创图只算原创作品」的规则；作品列表、派生计数和 Mock 都遵守这条规则，所以侧栏的作品数可能比列表多 | 同左 | 命名口径；P5 |
| 27 | `status='unrecognized'` 不等于「在待处理队列里」：它把放下的图、成册的页、漫画文件夹里的页、关闭漫画设置时的漫画都算进去。前端又各自推了一遍：`web/components/media/ImageGrid.tsx:381`、`web/components/media/lightbox/InfoPanel.tsx:214,267`；`web/features/unrecognized/useTriage.ts:298-312` 假定漫画一定留在队列里 | 同左 | 2.3 状态拆成三个事实；P5 |
| 28 | 「待处理有多少」前端有 4 种算法：侧栏 `未识别 − 待识别 + 待整理合集`（`web/components/layout/Sidebar.tsx:66`）、命令面板直接用未识别数（`palette/commands.ts:162`）、首页卡片 `max(0, 未识别 − 待识别)`（`home/components/TriageCards.tsx:45-47`）、统计条的比例（`StatsStrip.tsx:28`）。服务端的 `/api/unrecognized/summary` 是第 5 种 | 同左 | 汇总接口；P5 |
| 29 | 「已认出 X%」偏高：分母是插画加漫画，分子却只算队列里的（不含成册的页和漫画文件夹里的页）（`StatsStrip.tsx:28`） | 同左 | 汇总接口；P5 |
| 30 | 「能不能不打码显示」有好几套：`web/lib/blur.ts` 把没定分级的当作全年龄；今日一枚要求「已定分级且全年龄」（`DailyPlate.tsx:30`）；本子封面和页没识别过时一律打码或换成布面；服务端的敏感主题不看 `blurLevel` | 同左 | 共用规则移进 `packages/shared`；P5 |

## 四、两套实现、设置、接口

| # | 不一致 | 位置 | 由谁解决 |
| --- | --- | --- | --- |
| 31 | Mock 和 SQLite 的行为差异：Mock 改类型不触发补采纳（Mock:1093）；采纳后不删建议、不套排除（Mock:1671-1705）；查重合并搬所有角色；恢复和新建排除不看例外；合并时不检查排除、不搬否决（Mock:929）；取消原创会删掉所有原创关联（Mock:1438）；`rated` 筛选和待识别计数的口径不同；改 Pixiv 文件名模式没有撤销；不会重新判定合集。契约测试的说明里还列了 9 处「有意的差异」。演示改跑 SQLite 的阻碍：灌数据会丢合集、手动标记、否决、设置；没有图片文件；演示路径像真实路径（`fixtures.ts:462-463`）；任务、文件操作、网络都是真的；`:memory:` 用不了助手的只读 SQL；启动开销；前端的「演示数据」角标判断 `dataSource === 'mock'` | Mock 各处；`test/contract` | 第 8 节；P1 |
| 32 | 设置有三份存储（数据库、助手 JSON、浏览器本地）。服务端的 `ui.blurSensitive`、`ui.density` 写进去却从来没读过，生效的是浏览器本地那份（`web/lib/stores.ts:64-99`）；图库的类型筛选和收拢模式只存在本地、不进 URL，助手拿到的页面上下文和用户看到的不一致；阅读进度只存在浏览器里 | 同左 | 6 设置只有一份；P5 |
| 33 | 同一件事有好几个接口：角色关联可以走 PATCH 整组替换、批量 `assign` / `unassign` / `assignTag`、采纳、合集批量加角色；收藏、分级、类型既能 PATCH 单张也能走批量。`kind` 这个词在代码里有 6 种含义 | `routes/*` | 4.1 一件事一个命令；P6 |
| 34 | 任务种类是封闭的联合类型，相关的通道、优先级、校验、显示名表格散在约 8 处；`Pipeline.register` 后注册的会覆盖前面的；各种「该做」标记只在内存里 | `services/pipeline.ts:83`、`core/jobs.ts:48` | 第 7 节；P6 |
| 35 | MCP 的枚举是手抄的，已经和路由对不上（`update_images` 少了 `assignTag`、`trash`、`artist-auto`；类型枚举写死而没有用 `CONTENT_KINDS`）；`read_media` 和 `manage_job list` 绕过了 HTTP；写入不记 actor；助手的撤销状态存在单独的本地存储里 | `assistant/tools.ts` | 第 9 节；P6 |
| 36 | 每个用户操作会让前端重新获取两遍（`useMutate` 里的全部刷新，加上 SSE 事件，`web/lib/queries.ts:581`、`web/lib/events.ts`）；SSE 没有事件 id，断线重连后无法补发；刷新一律是「全部重新获取」 | 同左 | 第 9 节；P6 |

## 五、编目、否决和前端里的其他重复

| # | 不一致 | 位置 | 由谁解决 |
| --- | --- | --- | --- |
| 37 | 编目：标签规范化有 3 个函数，遇到冲突时一个合并、一个只记日志（SDS:233,239，`danbooru/apply.ts:34-45`）；「标签 → 角色」的解析实现了 3 次（`characterCatalog.ts:89-108,201-213`、`consolidate.ts:25-27`）；整理角色名时用名字比对，而不是看 `name_locked`（`consolidate.ts:52-53`）；机器生成的别名被记成 `user`，结果把自动别名都隐藏了（`characters.ts:433`、`consolidate.ts:60`、`aliases.ts:10-17`）；手动解绑 Danbooru 后 `source` 仍是 `danbooru`，撤回自动绑定时却改回 `custom`，而只有 `custom` 的才会被重新匹配；手动绑定不关联作品，自动绑定会 | 同左 | 编目模块唯一的 `resolve` 和来历；P3 |
| 38 | 前端里的其他重复：类型说明有两份，文字不同（`web/lib/kinds.ts`、`unrecognized/themes.ts:45`）；任务名称有三份，剩余时间是从服务端的消息文字里抠出来的（`home/utils.ts:64`）；判断「话」还是「册」的正则和服务端不同；排除规则的归一化只在网页表单里做，接口和助手传进来的不做；前端的搜索没用共享的 `searchKey`；无题时的显示名有三种写法 | 同左 | 共用规则；P5 |
| 39 | 否决：用户手动加回角色时不清除否决；合并、查重合并、撤回移动重新插入关联时都不看否决；Mock 合并时不搬否决 | `vetoes.ts`、`characters.ts:374-381` | D3；P3 |
