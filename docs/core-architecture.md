# Emaki 核心架构设计（v2 草案）

> 状态：D1、D2、D3、D4、D5、D7、D8 已批准（2026-11-17）；D6 和插件挪到下一阶段（第 13 节）。P0、P1、P2、P3、P4、P5 已完成（P3 完成于 2026-11-17，P4 完成于 2026-11-18：P4a 入库与分析收口，P4b 是 D5；P5 读模型与前端完成于 2026-11-18），见第 12 节。依据的代码快照：fork 的起点（`codex/flexible-collections` @ 13c677d 加上当时未提交的改动，2026-11-17）。
> 现状盘点和已知的不一致见 [core-architecture-inventory.md](core-architecture-inventory.md)。本文里「附录 #n」指那里的第 n 条。

## 0. 要解决什么

Emaki 的技术分层（网页 / HTTP / 数据源 / 后台任务 / SQLite）是清楚的，问题出在**业务规则没有主人**：

- 同一条事实有很多个地方在写。「图里有哪个角色」有 13 个写入点，分布在 11 个文件里；「能不能自动关联」有 3 套不同的判断（附录 #1–#4）。
- 写完之后要连带做的事（重算合集、套排除规则、记否决、重排 Pixiv、标记查重、刷新缓存、通知前端）由每个调用方自己记得去调。漏一个就出 bug：移动文件有 3 条路径，后续处理各不相同；文件内容变化有 2 种语义（附录 #10–#23）。
- 来历记不清。Pixiv 的关联和模型的关联存成同一种来源；分数为空同时表示「手动」和「Pixiv」。后来的撤销、漫画区同步、查重合并都会因此误删或漏删（附录 #5–#7）。
- 同一个口径定义了很多遍。「可见」的判断在 SQL 里抄了约 15 次；「待处理有多少」前端有 4 种算法，服务端还有第 5 种（附录 #24–#30）。
- 每条规则写两遍：演示用的 MockDataSource（约 2,800 行业务逻辑）和真实的 SQLite 各一套，已经出现至少 7 处行为差异（附录 #31）。

所以「改一个地方另一个地方不一样」不是个别疏忽，是结构决定的。只要规则散在调用方，修一处就会漏另一处；以后加插件，等于再加一批调用方，问题会成倍放大。

**目标**：每条事实只有一个主人；每条规则只写一次；写完后的连带处理自动发生，和是谁、从哪个入口写的无关；网页、AI 助手、后台任务走同一套命令。

**这一阶段只做基础设施**（P0–P6）。个性化页面和插件放到下一阶段（第 10 节），但这一阶段的设计要给它留好接口：稳定的查询、统一的命令、可以存个人配置的设置。

**不做的事**：不拆服务，不换数据库，不引入 ORM 或消息队列，不改前端的设计语言。SQLite + 同步事务 + 单进程保持不变；性能预算仍按 10 万张图算。

## 1. 设计原则

1. **事实分四类，各有各的改写规则。**
   - 观测：从文件系统看到的。
   - 派生：可以随时重算的。
   - 证据：模型或外部来源给出的主张。
   - 决定：图库最终认定的。

   详见第 2 节。四类事实混在一起，正是现在很多 bug 的来源，比如把建议的作品当成正式关联来计数（附录 #8）。
2. **用户的决定优先，自动的决定可以重算。** 每个决定都记来历：手动还是自动、由哪条规则或哪个来源做出、依据哪份证据。自动的决定永远不覆盖手动的决定。用户的「否定」（移除某个角色）也是决定，会一直生效到用户自己改。
3. **一条事实只有一个主人。** 每张表、每组列只由一个模块写入，其他模块要改就调用这个主人的命令。这条规则用测试强制检查（第 12 节，P0）。
4. **写操作只声明「改了什么」，连带处理由订阅者负责。** 主人写完发出一条「变化」，订阅这条变化的处理自动执行。撤销、恢复、后台任务都会产生同样的变化，所以都会触发同样的处理（第 5 节）。
5. **一个口径只定义一次。** 「可见」「计入统计」「待处理」「已识别」这类判断各有一个命名的定义，SQL、统计、前端都引用它，不再重抄。界面上显示的数都由服务端按这些口径算好，前端只负责展示（第 6 节）。
6. **所有入口走同一套命令。** 网页、HTTP、AI 助手、后台任务、启动修补、以后的插件，调用的都是同一批命令。每次执行都记下是谁做的：用户、助手、哪个任务、哪个插件（第 4、9 节）。
7. **业务逻辑只有一份实现。** 演示和开发也跑真实引擎，只是换掉文件、回收站、网络、模型这些会产生副作用的部件（第 8 节）。
8. **页面只是数据的一种展示。** 页面通过公开的查询拿数据、通过命令改数据，不在前端藏业务规则。这样页面以后才能被配置、被插件替换，或者由 AI 生成新页面（第 10 节）。

## 2. 领域模型

### 2.1 四类事实

| 类别 | 含义 | 谁能写 | 可否重算 | 例子 |
| --- | --- | --- | --- | --- |
| 观测 | 文件系统上看到的客观情况 | 只有「图库与文件」模块（扫描、导入、替换、移动、回收） | 重新扫描可得 | 路径、大小、sha256、修改时间、是否丢失、是否在回收站 |
| 派生 | 由观测、证据、决定纯计算出来的结果 | 只有对应的派生计算，带版本号，版本变了就重算 | 随时可以丢掉重算 | 缩略图、dHash、主色、帧数、自动判定的内容类型、是否动图、主题、画质分、按文件夹成册的合集、合集页码、排除结果、各种计数 |
| 证据 | 某个来源对图片提出的主张，本身不改变图库 | 只有这个来源的提供者，按「图片 × 来源」整体替换 | 来源重跑可得 | 模型打出的标签和角色分数、Pixiv 投稿标签和原创信号、文件名解析出的来源、查重的比对结果、Danbooru 元数据 |
| 决定 | 图库最终认定的事实，带来历 | 只有对应的主人模块，经过命令写入 | 手动的不可重算；自动的可由规则重算 | 图↔角色、图↔作品（手动）、原创、手动类型、手动分级、收藏、放下、排除例外、手选合集成员、画师、角色合并 |

目录实体（角色、作品、画师，以及它们的别名、合并重定向、Danbooru 绑定）也属于决定，由「编目」模块负责。

### 2.2 来历：统一的记法

所有决定用同一组字段记来历，取代现在 `origin = 'tagger' | 'manual'` 和「分数为空表示手动」这类约定：

| 字段 | 取值 |
| --- | --- |
| `decision` | `manual`：用户做的；`auto`：规则做的 |
| `actor` | `user`、`assistant`、`job:<任务>`、`plugin:<id>`、`system:<启动修补>` |
| `rule` | 自动决定所依据的规则和版本，例如 `auto-accept@3`、`pixiv-original@1` |
| `evidence` | 依据的证据：来源、候选项、分数。可以为空 |
| `at` | 时间 |

由此可以准确回答「这条关联是谁、凭什么加的」。撤销某个来源的一批自动决定、漫画区同步、查重合并时，就只动该动的那部分（附录 #5–#7）。

**P3a 的实现（2026-11-17，迁移 034）**：图 ↔ 角色（`image_characters`）先用上这组字段，取代 `origin` / `score`：

| 列 | 取值 |
| --- | --- |
| `decision` | `manual` / `auto`。单张采纳建议是用户点的，记 `manual`，证据照样保留 |
| `actor` | 写入时的 actor（`propagation/actor.ts`）；迁移转过来的自动关联是 `system:migration` |
| `rule` | 自动的必须有（表上有 CHECK）：`auto-accept@1` 识别写入、`promote@1` 补采纳、`pixiv@1` Pixiv 补充、`dedupe-merge@1` 查重合并搬来的；迁移转过来的是 `legacy:tagger`、`legacy:pixiv`、`legacy:tagger-evidence`、`legacy` |
| `evidence_provider` / `evidence_tag` / `evidence_score` | 证据的来源（`tagger` / `pixiv`）、候选（规范化后的标签）、分数；Pixiv 没有分数 |
| `added_at` | 就是 `at`（沿用原来的列名：索引和「最近在收」都按它） |

- 旧数据的转法见迁移文件的说明：`manual` → 手动；`tagger` 有分数 → 自动 / 模型；`tagger` 分数为空 → 能对上 Pixiv（检查记录是 linked 或 `change_log` 里有）的算 Pixiv，能对上模型证据（`image_tags` 里有解析到这个角色的标签）的算模型，其余记 `legacy`。迁移里校验条数和逐条对应，不对就回滚。
- 手动 / 自动类型、放下、画师等其他决定的来历还是原来的存法（`*_manual`、时间戳）；原创在 P3b 补上了来历（见下）。

**P3b 的实现（2026-11-17，迁移 035）**：

- **原创**（`images`）：`original_at` 仍是生效的标记，另加 `original_decision`（`manual` / `auto`）、`original_actor`、`original_rule`（`auto-original@1`；迁移认出来的 Pixiv 原创是 `legacy:pixiv`）、
  `original_evidence_provider`。`manual` 且 `original_at` 为空 = 用户取消过原创，自动不再标回来（D8）。迁移：能从 `change_log` 的 pixiv-sync 记录或
  Pixiv 检查记录（结果 original、时间相同）认出来的记成 Pixiv 的自动决定，其余标了原创的都记手动；Pixiv 判过原创、现在没标的（用户移出或撤回了那轮）记成手动取消。
- **图 ↔ 作品**：`image_copyrights` 只放手动指定的作品（去掉了分数列）；原创图属于「原创」作品由 `original_at` 派生，不再存行。
- 自动关联的规则统一成 `auto-accept@2`（decideAuto，第 4.2 节），依据哪个来源看 `evidence_provider`；P3a 的 `auto-accept@1`、`promote@1`、`pixiv@1` 只在那之前写的数据里。

### 2.3 需要拆开的几个概念

- **「状态」拆成三个独立的事实**：识别过没有（对当前文件版本有没有模型证据）、有几个角色、在不在某个待处理队列（队列成员是派生出来的，取决于类型、放下、合集、漫画区、设置）。现在一个 `recognized/unrecognized` 同时承担了这几种含义，前端又各自推了一遍（附录 #27）。
- **建议不再是一张单独写入的表**，而是一个派生视图：证据里分数够、还没关联、也没被否决的候选。现在写「建议」的有 7 处，模型和 Pixiv 还会互相覆盖（附录 #9）。
  P3b 实现：视图 `v_character_suggestions`。证据只记达到建议阈值的候选（识别器记全部达到建议阈值或自动阈值的候选，Pixiv 记匹配器给的全部候选），所以「分数够」在写证据时已经成立；
  视图按标签（或自建角色的 `character_id`）找角色，滤掉已经关联、被否决的。看的时候（`loadSuggestions`）再按角色目录规范化、去重，每张最多列 5 条。
- **作品关联分成证据和决定两部分**。模型给出的作品是证据；只有经过关联角色或手动指定得到的，才算图的作品（附录 #8）。
  P3b 实现：模型给的作品记在 `work_evidence`（按作品标签，不要求作品已建档）；`v_image_works` = 关联角色的作品 ∪ `image_copyrights`（手动指定）∪ 原创图 →「原创」作品，
  侧栏的作品数、作品筛选、合集的作品统计按同一口径。
- **内容类型 = 手动类型 ?? 自动类型**，两部分分开存。自动类型是派生的，手动类型是决定。只要最终类型变了，就发出一条变化，不管是谁改的。
  「动图」不是类型（D5，P4b 已实现）：类型是插画 / 漫画 / 截图 / 照片 / 文字 / 表情，互斥；**是否动图**是另一个维度，由帧数、格式派生（`images.animated`），
  不是手动选项，变了发 `image.animatedChanged`。动的插画就是插画。
- **来源（站点、投稿号）= 手动来源 ?? 解析来源**。解析来源是证据（来自文件名），手动来源是决定。

### 2.4 对象和主人

| 模块 | 负责的事实 | 主要命令 | 发出的变化 |
| --- | --- | --- | --- |
| 图库与文件 | 图库文件夹、漫画区设置、图片的观测列、扫描错误、回收批次、移动记录 | 加 / 改 / 移除图库文件夹、扫描、导入、替换文件、移动、移到回收站、从回收站恢复 | `image.added`、`image.fileChanged`、`image.moved`、`image.gone`、`image.returned`、`image.trashed`、`image.restored`、`root.visibilityChanged`、`root.modeChanged` |
| 分析 | 缩略图、dHash、主色、帧数、相机信息、自动类型、是否动图（D5）、主题、画质分 | 只有一个入口 `analyze(ids)`，由反应和任务调用 | `image.kindChanged`（最终类型变化）、`image.animatedChanged`（是否动图变化，P4b）、`image.analyzed` |
| 证据 | 模型标签和角色分数、Pixiv 缓存与投稿标签、文件名解析的来源、Danbooru 元数据 | 每个来源一个「提供者」写自己那一份 | `evidence.changed { provider }`、`image.sourceChanged` |
| 编目 | 角色、作品、画师、别名（带来历）、合并重定向、Danbooru 绑定、角色↔作品 | 建角色、改角色、合并、绑定 / 解绑 Danbooru、关联作品；`resolve(tag)` 只有这一个实现 | `catalog.characterChanged`、`catalog.merged`、`catalog.bindingChanged` |
| 归类 | 图↔角色、图↔作品（手动）、原创、手动类型、手动分级、收藏、放下、画师、否决 | `link`、`unlink`、`setOriginal`、`setKind`、`setRating`、`favorite`、`shelve`、`setArtists`；自动决定只经过「自动决定规则」写入 | `curation.charactersChanged`、`curation.originalChanged`、`curation.shelvedChanged` 等 |
| 可见性 | 排除规则、排除例外 | 加规则、删规则、恢复单张；排除结果（`excluded_by`）是派生的 | `visibility.changed` |
| 合集 | 合集行、手选成员、页序和标题等手动字段；按文件夹成册和同投稿的成员是派生的 | 成册、建组图、增删成员、改名、整理到子文件夹（经「图库与文件」的移动命令） | `collections.changed` |
| 查重 | 比对结果（证据）、重复组（派生）、处理结果（决定） | 处理重复组：保留哪张、其余的进回收站并合并整理信息（经「归类」命令）、忽略 | `duplicates.changed` |
| 设置 | 图库设置。只有一份，分节，每节有自己的 schema | 改设置 | `settings.changed { section, keys }` |

规则：**模块之间不直接写对方的表**。比如查重合并整理信息时，调用「归类」的 `link` 和 `setOriginal`，不再自己插入行（附录 #4、#12）。

## 3. 分层

```
入口      网页 · HTTP API · AI 助手(MCP) · 插件 · 后台任务 · 启动修补
            │ 只调用命令和查询
命令层    命令注册表：名字、输入 schema、权限范围、是否可撤销、是否幂等、actor
            │
领域模块  图库与文件 │ 分析 │ 证据 │ 编目 │ 归类 │ 可见性 │ 合集 │ 查重 │ 设置
            │ 主人写入时发出「变化」（同一事务）
变更传播  反应注册表：事务内反应 / 提交后反应 / 排队任务
            │
读模型    命名口径（可见、计入、队列、状态事实）、列表、计数、汇总
            │
基础设施  SQLite · 文件系统 · 回收站 · 缩略图解码 · 模型推理 · 网络（Pixiv / Danbooru） · 时钟
```

依赖方向只能向下：

- 领域模块之间只能调用对方的命令和查询，不碰对方的表。
- 只有基础设施层接触真实的文件、网络和模型；这一层抽象成可以替换的「端口」，演示模式和测试换成假的实现（第 8 节）。
- 现在的 `DataSource` 接口（63 个方法）在迁移过程中逐步退化成「命令 + 查询注册表」的一个外壳，最后删掉。

### 3.1 目录和表的主人（P0 定下）

领域模块的代码放在 `apps/server/src/domain/<模块>/`，命令层放在 `apps/server/src/commands/`。每张表只由主人目录里的代码写入；`images` 一张表按列组分给不同的主人。这张表由 `apps/server/test/architecture/owners.ts` 强制检查（单一写入者测试），现在主人目录之外的写入记在同目录的 `writers.allowlist.ts` 里，只许变短。

| 模块 | 目录 | 表 | `images` 的列 |
| --- | --- | --- | --- |
| 图库与文件 | `domain/library/` | `library_roots`、`comic_folders`、`scan_errors`、`pending_trash`、`pending_trash_items` | 新增、删除整行；`root_id`、`rel_path`、`file_name`、尺寸、`bytes`、`format`、`sha256`、`added_at`、`modified_at`、`missing`、`trashed_at` |
| 分析 | `domain/analysis/` | （P4a 删掉了没人读写的 `image_fingerprints`，迁移 037） | `dhash`、`dominant_color`、`thumb_at`、`decode_error`、`content_kind*`（手动标记除外）、`camera`、`kind_signals`、`theme`、`art_score`、`frame_count`、`animated`（P4b，迁移 038） |
| 证据 | `domain/evidence/` | `tags`、`image_tags`、`image_evidence`、`character_evidence`、`work_evidence`（P3b；建议是它们派生的视图 `v_character_suggestions`）、`pixiv_artwork_cache`、`pixiv_character_checks`、`pixiv_unavailable_posts`、`danbooru_tags`、`danbooru_artists` | `tagged_at`、`tagger_model`、`retag`、`artist_checked_at`、`source_site` / `source_post_id` / `source_artist` / `source_url` |
| 编目 | `domain/catalog/` | `characters`、`works`、`character_works`、`aliases`、`danbooru_tag_redirects`、`custom_character_matches`、`character_verified_forms`、`character_verified_names`、`artist_links`、`tag_i18n`、`tag_name_keys`、`tag_renames` | |
| 归类 | `domain/curation/`（P3a 建立） | `image_characters`、`image_copyrights`（手动指定的作品）、`image_artists`、`character_vetoes` | `rating`、`rating_manual`、`favorite`、`shelved_at`、`original_at` 和原创的来历列、`content_kind_manual`、`artist_manual`、`source_manual` |
| 可见性 | `domain/visibility/` | `exclusions` | `excluded_by`、`exclude_exempt` |
| 合集 | `domain/collections/` | `collections`、`collection_characters`、`collection_works` | `collection_id`、`page_no`、`collection_detached` |
| 查重 | `domain/duplicates/` | `duplicate_groups`、`duplicate_members`、`duplicate_comparisons` | |
| 设置 | `domain/settings/` | `settings` | |
| 命令层 | `commands/` | `change_log`，以及撤销回放这类按表名拼 SQL 的通用写入 | |
| 变更传播（P2） | `propagation/` | `pending_work`（排队状态和用户的暂停，迁移 033）、`derived_versions`（派生数据的版本，P4a，迁移 037） | |

- 永久例外只有 `demo/`：演示数据直接灌进空的一次性库，不经过命令。
- P2 已搬进主人目录的：合集（原 `services/collections/` → `domain/collections/`）、可见性（原 `datasource/sqlite/exclusions.ts` → `domain/visibility/`）；
  P3a 新建了归类（`domain/curation/`），`image_characters`、`character_vetoes` 只有它写；
  P3b 把其余归类、证据、编目的写入都收进了主人目录：画师（`curation/artists.ts`）、手动来源（`curation/source.ts`，来源的值由 `evidence/source.ts` 写）、手动类型标记（`curation/kinds.ts`）、
  原创和自动分级（`curation/marks.ts`）、手动指定的作品（`curation/works.ts`）；识别器、Pixiv 的证据和待查记录（`evidence/tagger.ts`、`evidence/pixiv.ts`、`evidence/store.ts`）、
  识别进度（`evidence/retag.ts`）、Danbooru 元数据（`evidence/danbooru.ts`）；编目表全部在 `domain/catalog/`。允许清单里已经没有这三个模块的表；
  各模块的反应放在 `domain/<模块>/reactions.ts`，变更传播层本身在 `propagation/`（第 5 节）。
  P4a 建立了图库与文件（`domain/library/`：扫描写库、显式导入、替换、移动、回收站、图库文件夹）和分析（`domain/analysis/`：唯一入口 `analyze`、缩略图回写、缓存回收），
  允许清单里已经没有这两个模块的表和列（`library_roots`、`comic_folders`、`scan_errors`、`pending_trash*`、`images` 的观测列和派生列）。
- 识别方式：扫描源码里所有字符串（含多行模板），找 `INSERT` / `REPLACE` / `UPDATE … SET` / `DELETE`；撤销记录器的 `u.columns` / `u.set` / `u.inserted` 也算写入。`images` 看 `SET` 的列名；看不出列（列名拼出来、整行快照）的记成 `images#?`，表名拼出来的记成 `<dynamic>`，这两种只能进允许清单或放进命令层。

## 4. 写入：命令和自动决定

### 4.1 命令

每个命令只定义一次：

```ts
defineCommand({
  name: 'curation.link',
  input: LinkInput,          // zod schema，放在 packages/shared，HTTP、MCP、插件共用
  scope: 'curate',           // 权限范围：read / curate / organize-files / settings / network …
  undoable: true,
  idempotent: true,          // 支持 operationId（现在 AI 助手已有的机制，推广到所有入口）
  run(tx, input, actor) { … } // 只调用领域模块；返回 { message, changes }
})
```

- 命令层负责事务、撤销记录、`operationId` 幂等、记下 actor，再把变化交给变更传播。领域模块不再各自调用 `ctx.mutate`、`touch`、`collectionsHook`。
- 一件事只有一个命令。比如角色关联，现在有 PATCH 整组替换、批量 `assign` / `unassign` / `assignTag`、采纳建议、合集批量加角色几条路（附录 #33），以后统一为 `curation.link` / `curation.unlink`，各个 HTTP 地址只是把参数转成这个命令。
- 不可撤销的命令（改设置、启动任务）在注册表里明确标出，前端的「撤销屏障」由此生成，不再各处自己判断。

### 4.2 自动决定规则

这是这次出 bug 的核心，单独定义：

```ts
decideAuto(image: ImageFacts, evidence: Evidence[], current: Decisions, settings: Settings, catalog: CatalogView)
  → { link: AutoLink[]; unlink: AutoLink[]; createCharacters: CharacterSeed[]; original?: AutoOriginal }
```

- **纯函数**：同样的输入一定得到同样的输出，可以单独测试。
- **输入**：
  - 图片事实：最终类型、放下、原创、所在合集是否整本处理、是否在漫画区、是否被排除。
  - 全部证据：各来源的候选和分数。
  - 当前决定：已有关联及其来历、否决。
  - 设置：每个来源的阈值，例如模型用 `autoAcceptThreshold`；Pixiv 不再写死 0.8。
  - 编目解析：标签对应哪个角色，能不能自动建档。
- **只有一个地方调用它**：反应 `reevaluateAuto(ids)`。下面任何一种变化都会触发它：证据变化（首次识别、重识别、Pixiv 补充、插件来源）、最终类型变化、放下或原创变化、合集是否整本处理变化、漫画区变化、否决变化、编目的合并或绑定变化。现在「首次识别」「补采纳旧建议」「改类型」「Pixiv 补充」是四条路各算一遍；以后是同一个函数，结果天然一致。
- **「按当前阈值补采纳」**（现在设置页的按钮）变成一个命令：对所选范围跑一遍 `reevaluateAuto`，作为一次可撤销的操作。
- Pixiv 现在自带一套「自动」判断（附录 #2）。以后它只负责把投稿标签解释成「候选 + 置信度」证据，采不采纳交给这条规则。
- **P3b 的实现（2026-11-17）**：`decideAuto` 在 `domain/curation/auto.ts`，只有反应 `reevaluateAuto`（`curation/reevaluate.ts`）调用它并写入结果。
  - 输入照上面：图片事实（最终类型、放下、原创和它的来历、是否整本处理、是否在漫画区、是否被排除或不可见）、各来源的证据（候选、置信度、原创信号，
    以及「这个来源的证据刚换过」）、当前决定（关联和来历、否决）、每个来源的自动阈值、编目解析（标签 → 角色，能不能建档，同一轮里别的图会不会建）。
  - 规则：可以加关联的图（没放下、没归原创、不在漫画区、没被排除）上，分数达到这个来源自动阈值的候选都关联，否决过的不加；还没有角色的候选只在插画、漫画上建档（P4b 之前还有类型「动图」；现在动的插画、漫画照样建档，D5），
    别的类型复用同一轮里别的图建的角色。一轮先跑一遍收集要建档的标签，再跑一遍得出结果，和图在批次里的先后无关（附录 #1）。
    整本处理的合集现在不影响决定（本子的页照样按证据关联，角色在本子里出现的页数靠它），只影响要不要去查 Pixiv；类型变了照样重新评估。
  - 阈值按来源取自设置 `tagger.autoAcceptBySource`（`tagger` / `pixiv` / `plugin:<id>`），没设的来源用 `autoAcceptThreshold`。
    Pixiv 的证据只有两档置信度：匹配器确认对上（1）和只是候选（0），所以默认阈值下确认对上的自动关联，候选只作建议。
  - `reevaluateAuto` 订阅 `evidence.changed`、`image.kindChanged`、`curation.shelvedChanged`、`curation.originalChanged`、`curation.vetoesChanged`、`collections.changed`、
    `root.modeChanged`、`catalog.merged`、`catalog.bindingChanged` 和补采纳命令声明的 `curation.autoRequested`；编目变了时评估证据里提到这些角色的图。
    自动标原创声明的是 `curation.autoOriginalChanged`（同一个事实，单独一个类型，免得它订阅到自己的输出成环）。
  - 撤销重放时不做决定（不然会把刚撤销的自动决定又做一遍），只把这些图的角色、原创声明成变化，让排除结果、合集按还原后的事实重算。
  - 补采纳是命令：`promoteSuggestions` 先用同一轮评估算出会加多少，再声明 `curation.autoRequested`，由反应写，作为一次可撤销的操作；没有新证据，所以只新增。
    设置页的预览数（`promotableSuggestions`）也是这同一轮评估，只是不写。
- 自动决定只增不减，还是在证据不再支持时也撤回，见第 13 节 D2（P3b 已实现：撤回）。

## 5. 变更传播

### 5.1 变化

主人模块每写一笔，就往当前事务的「变化集」里加一条，带上涉及的 id 集合和必要的细节（实现：`propagation/changes.ts`，写法见 `ARCHITECTURE.md`「变更传播」）：

| 变化 | 何时发出 | 关键细节 |
| --- | --- | --- |
| `image.added` / `image.gone` / `image.returned` | 入库、确认丢失、重新出现 | |
| `image.fileChanged` | 同一 id 的文件内容变了 | `reason`：扫描发现 / 用户替换（只记录在案，处理相同，D1）；`files`：新旧 sha；`probes`：读新文件头拿到的帧数、相机（`image.added` 同样带） |
| `image.moved` | 路径变了 | `reason`：扫描发现 / 应用内移动 / 整理到子文件夹 / 撤回移动 |
| `image.trashed` / `image.restored` | 回收与恢复 | |
| `root.visibilityChanged` / `root.modeChanged` | 图库文件夹启用、停用、移除；漫画区变化 | |
| `image.kindChanged` | 最终类型变化 | 自动重判和手动修改都会发出 |
| `image.animatedChanged` | 是否动图变化（P4b，D5） | 只有帧数、格式变了才会变：入库、换了文件、缩略图任务给旧图补读到帧数 |
| `image.sourceChanged` | 最终来源变化 | |
| `evidence.changed` | 某个来源的证据变了 | `provider` |
| `curation.*Changed` | 角色、原创、放下、分级、收藏、画师、否决变化 | 角色变化带上新增 / 移除和来历 |
| `catalog.*` | 角色改名、合并、绑定变化 | |
| `visibility.rulesChanged` | 排除规则或排除例外（决定）变化 | 要重新判定的图 |
| `visibility.changed` | 排除结果变化（新增排除或解除排除） | `excluded` / `released`，按操作之前的状态算 |
| `collections.changed` | 合集成员或类型变化 | 进出本子的图；要重排页序的合集 |
| `duplicates.changed` | 重复组生成或处理 | |
| `settings.changed` | 某节设置变化 | |
| `library.opened` | 启动修补做完 | 规则版本可能变了，全量对一遍派生数据 |

### 5.2 反应

反应在注册表里声明：订阅哪些变化、在哪个阶段执行。下表是 P2 实际注册的反应（`SqliteDataSource.registerReactions`，同一阶段按表里的顺序执行），取代以前各调用方手工维护的连带处理（来源见附录）：

| 反应 | 订阅 | 阶段 | 取代现在的 |
| --- | --- | --- | --- |
| `reparseSource` | `image.moved`（来源未手动锁定时） | 事务内 | 只有扫描时的移动会重新解析（附录 #13）。三条移动路径和撤回移动都发 `image.moved` |
| `staleFileEvidence`（P4a） | `image.fileChanged` | 事务内 | 文件内容变了（D1）：这份文件版本的识别过期（识别时间、模型、画师识别时间清空，排队重认）；以前只有扫描会清识别、替换全保留、两条路都不重置画师（附录 #10） |
| `analyze`（P4a，原 `reclassifyByPath`） | `image.added`、`image.fileChanged`、`image.moved`、`root.modeChanged` | 事务内 | 分析唯一的入口：入库判类型；内容变了清掉旧文件的像素派生、按新文件重判；路径相关的分类、漫画文件夹的类型和分级、去掉识别器的角色；声明 `image.kindChanged`、`image.animatedChanged`（P4b）、`curation.charactersChanged`（附录 #23） |
| `reevaluateAuto`（P3b） | 证据、最终类型、放下 / 原创、否决、合集、漫画区、编目合并 / 绑定、补采纳命令（见第 4.2 节） | 事务内 | 识别写入、补采纳、改类型、Pixiv 补充四条路各自的判断（附录 #1–#3）；证据不再支持时撤回（D2），Pixiv 原创（D8） |
| `dropStalePixivEvidence` | `image.sourceChanged` | 事务内 | 来源变了，按旧投稿号查的 Pixiv 证据和检查记录去掉（附录 #13）；以前只有改识别方式会做。P3b 起去掉证据声明 `evidence.changed`，依据它的自动关联由 `reevaluateAuto` 撤回 |
| `reevaluateExclusions` | `visibility.rulesChanged`、`curation.charactersChanged`、`evidence.changed`（标签）、`image.added`、`image.moved`、`library.opened` | 事务内，同时负责排除和解除排除 | 现在 6 处会套用排除规则、4 处没套，而且从来不解除（附录 #14、#15） |
| `queuePixivCheck` | `image.sourceChanged`、`image.kindChanged`、放下、原创、角色、`visibility.changed`、`evidence.changed`、`root.modeChanged`、`collections.changed` | 事务内登记（持久化的队列） | 现在只在识别批次结束时登记（附录 #19） |
| `refreshPostGroups` | `image.sourceChanged` | 事务内（后台任务延后到结束） | 只有部分来源修改的路径会刷新 |
| `refreshFolderCollections` | `image.*`、`image.kindChanged`、`image.animatedChanged`（P4b）、`visibility.changed`、`evidence.changed` | 事务内按 id（后台任务延后到结束全量） | `collectionsHook` 的 20 处调用，以及漏掉的移动、撤回移动、相机识别、让出或中止的任务（附录 #17） |
| `renumberCollections` | `collections.changed`（手动增删成员） | 事务内 | `onUndoLast` 里的页序重排 |
| `markDedupeDirty` | `image.added` / `fileChanged` / `gone` / `returned` / `trashed` / `restored`、`image.animatedChanged`（P4b：动图只认文件完全相同）、`visibility.changed`、`root.visibilityChanged` | 排队，持久化在 `pending_work` | 现在只有图库文件夹变化会标记，而且重启就丢（附录 #18） |
| `rescanRoots`、`queueTagging`、`queueAnalysis`、`queueArtists`、`schedulePixiv`、`rematchCachedPixiv` | 文件夹重新显示；放出排除、离开漫画文件夹、新图；新图和换了文件；改回自动画师；资格变了；来源变了 | 排队（只有用户和助手的操作直接拉起任务） | 恢复排除后不会重新识别（附录 #16）；撤销改识别方式、`artist-auto` 不会重跑（附录 #22） |
| `refreshAllCollections` | `root.*`、`library.opened` | 提交后（全量） | 文件夹启停、漫画设置变化后的手工全量重算。P4a：启动（`library.opened`）只在合集判定的版本变了、或者有没做完的延后重算时全量重判（附录 #23） |
| `recomputeCustomMatches` | `catalog.*` | 提交后 | 5 处手动调用 |
| `notifySettings`、`notifyRoots` | `settings.changed`；`root.*` | 提交后 | 设置和文件夹监听的手工通知 |
| `invalidateCaches` + 推送事件 | 任何写入 | 提交后 | 现在 `touch` 有 21 处调用，强刷新 / 弱刷新约定被后台路径破坏（附录 #20、#21） |

和最初设计的出入：`reevaluateAuto`（第 4.2 节）P3b 才加上（在 `dropStalePixivEvidence` 之后、`reevaluateExclusions` 之前）；`recomputeCustomMatches` 只订阅 `catalog.*`（它只看自建角色和标签，图上的角色变化不影响它）；
P4a 把 `reclassifyByPath` 扩成分析唯一的事务内入口 `analyze`，前面加了 `staleFileEvidence`（文件内容变了时先把识别标成过期，`analyze` 才按「还没识别」重算主题、画质分）；
缩略图、帧数、相机这些要读文件的部分仍由排队反应交给缩略图任务，任务算完交给分析模块写；第 2.4 节表里分析模块的 `image.analyzed` 没有加：
主色、dHash 这些像素派生回写时不传播（看图时生成缩略图不该让前端整页重拉，P2 的约定），只有类型变了才声明 `image.kindChanged`。
`library.opened` 不再无条件全量重算合集：派生数据按版本（`derived_versions`）决定要不要整体重算，后台任务延后的全量重算记在 `pending_work` 里，进程中途退出时下次启动补做。

三个阶段的含义：

- **事务内**：保证派生数据和事实一致，必须是幂等的重算，也就是从事实重新算出结果，而不是增量修补。反应自己写入的东西会再产生变化，处理到没有新变化为止；超过固定深度就报错，用测试检查有没有循环。
- **提交后**：刷新缓存、推送事件。强刷新还是弱刷新由 actor 决定：用户和助手的操作强刷新，后台任务弱刷新。不再由各处自己选择。
- **排队**：交给后台任务的工作，比如缩略图、识别、Pixiv、查重。排队状态持久化在数据库里，不再只放在内存。
- 后台任务和启动修补里昂贵的全量重算（合集）延后到任务结束时做一次（`defer`），不论任务是完成、让出还是被取消。

### 5.3 撤销

保留现有的撤销体验（第 11 节），把实现改成两步：

1. 按撤销记录把被改的事实还原。现在的 `UndoRecorder` 按行快照的机制可以保留。
2. 把还原的东西也当作变化，对涉及的对象**重新跑一遍反应**。

因为事务内反应都是幂等的重算，撤销后派生数据自然正确，不再需要现在的 `onUndo` / `onUndoLast` 手工接线（附录 #22）。撤回移动、撤回 Pixiv、撤回自动绑定这类「可跨重启撤回」的操作，同样走这条路。

## 6. 读取：读模型

- **命名口径只有一份。** 「可见」「计入统计」「插画」「待处理队列（按大类）」「待识别」「状态事实」都在一个模块里定义成 SQL 片段或视图。为了部分索引能命中，SQL 字面写法保持不变。所有查询、统计、任务都引用这一份，用测试检查有没有人内联抄写（附录 #24–#26）。
- **界面上的数都由服务端算。** 用一个汇总接口给出侧栏、首页、命令面板要显示的所有计数：待处理、已认出比例、别册、成册待整理等。前端不再自己加减（附录 #28、#29）。
- **前后端共用的展示规则放进 `packages/shared`**：类型、分级、任务的名称；「能否不打码显示」的判断（现在有好几套，附录 #30）；搜索文本的归一化（前端没用共享的 `searchKey`）；无题时的显示名（现在有三种写法）。
- **设置只有一份。** 分清「图库设置」（服务端）和「本机偏好」（浏览器）。现在 `ui.blurSensitive`、`ui.density` 写进服务端却从来没读过，生效的其实是浏览器本地那份（附录 #32）。会影响查询结果的本机偏好要写进 URL 或传给服务端，否则 AI 助手看到的页面和用户看到的不一样。

### 6.1 P5 的实现（2026-11-18）

**命名口径**（附录 #24–#26）：`apps/server/src/readmodel/terms.ts` 是唯一的定义，SQL 片段加上迁移里的视图：

| 口径 | 片段 / 视图 | 含义 |
| --- | --- | --- |
| 可见 | `VISIBLE`（要 JOIN `library_roots r`）、`LIVE_IMAGES`（不 JOIN）、视图 `v_images` | 文件在（`FILE_LIVE`：没丢、没进回收站）、所在图库文件夹可见（`ROOT_ACTIVE`）；被排除的也算可见 |
| 计入统计 | `COUNTED()`、`COUNTED_LIVE`、视图 `v_counted_images` | 可见且没被排除。张数、角色张数、队列都只数它 |
| 插画 | `ILLUSTRATION`、视图 `v_illust_images` | 角色张数、作品张数、图库默认只看它 |
| 要找角色的类型 / 别册 | `ART_KINDS_SQL`（插画、漫画）、`ANNEX_KINDS_SQL`（截图、文字、照片、表情） | |
| 待处理队列（按大类） | `QUEUE`（未识别「插画 · 漫画」）、`SHELVED_QUEUE`（放下的）、`ANNEX_QUEUE`（照片 · 文字等）、`ART_QUEUE_SCOPE`（「插画 · 漫画」的范围，含放下的和已认出的）、`ART_SCOPE`（逐张找角色的图，不看漫画设置：Pixiv 资格用它） | 「插画 · 漫画」= 插画，加上设置开着时的漫画页（`QUEUE_KINDS_SQL`），不在整本处理的合集里（`NOT_IN_BOOK`）、不在漫画区（`IN_COMIC`），没有角色也没归原创（`UNRECOGNIZED`） |
| 待识别 | `UNTAGGED_UNRECOGNIZED`（队列里还没识别的插画）、`TAGGABLE` / `TAG_PENDING`（识别任务会看的图 / 其中还没识别的：首页识别进度、导入面板、识别任务领图同一份） | |
| 图的作品 | 视图 `v_image_works`；大查询里用 `imageWorkRows`、`WORK_HAS_ILLUSTRATION`（同口径的三支，直接连底表） | 关联角色的作品 ∪ 手动指定的作品（原创图只算原创）∪ 原创图 →「原创」作品 |
| 在哪个队列 | `QUEUE_OF`（图片接口的 `queue`） | 和 `packages/shared` 的 `triageQueue` 是同一条规则 |

- 字面写法不变（`missing = 0 AND trashed_at IS NULL`、`animated = 1` 这些部分索引要的条件仍是字面 SQL），统计、未识别、列表、合集、缩略图、识别、画师补跑、Pixiv 资格、排除、标签张数、扫描、导入都引用它。
- `test/architecture/terms.test.ts` 扫描源码里所有字符串（含模板），口径模块之外出现这些条件的内联写法（可见、图库文件夹可见、有没有角色、整本处理的合集、漫画设置、类型集合、插画、待识别、图的作品、敏感分级）就失败；允许清单只许变短（现在是空的）。
  `src/readmodel/terms.test.ts` 用一个覆盖所有组合的库（6 类 × 5 种可见性 × 角色 × 原创 × 放下 × 5 种合集 × 漫画区 × 漫画设置）逐个比对 SQL 的 `QUEUE_OF` 和 JS 的 `triageQueue`，以及按索引找的 `BOOK_OR_COMIC_IDS`、`WORK_HAS_ILLUSTRATION` 和逐行判断的等价。
- 统计的作品数用 `WORK_HAS_ILLUSTRATION`，和作品列表（`imageCount > 0`）同一口径（附录 #26）；放下的张数改成和队列同一个范围（以前不看漫画区）。

**状态拆成三个事实**（附录 #27）：图片接口（`ImageItem`）去掉 `status`，改给 `tagged`（这份文件识别过没有，P4a 起换了文件就是 false）、`characterCount`、
`queue`（`art` / `shelved` / `annex` / `book` / `null`，服务端按 `QUEUE_OF` 算，列表里单独一条查询，不进排序的列）和 `excluded`。
看图器信息栏、网格悬停的「未识别」、未识别页改类型时「离不离开队列」都读这些事实；改类型的预判用共用的 `queueAfterKindChange`（关掉漫画设置时漫画不再假定留在队列）。
列表的旧筛选 `ListImagesQuery.status` 还在（MCP、合集页「只看没认出的」在用），含义写在 `ImageStatus` 上。

**汇总接口** `GET /api/summary`（`LibrarySummary`，`readmodel/summary.ts`，附录 #28、#29）：侧栏、首页、命令面板、统计条、图库标题要显示的计数都从这里来，前端不再加减。
数都来自统计那一遍扫描，和 `/api/stats` 共用一份缓存。两个唯一的定义：

- **待处理数** `triage.total` = 等你确认的张数 `triage.images`（未识别「插画 · 漫画」里模型看过还没认出的：有建议 + 没认出；漫画页不等识别）+ 成册待整理的条目数 `triage.books`（同一系列算一条）。
  不含待识别 `triage.waiting`（识别跑完会自动处理）、放下的、照片 · 文字等（别册不催）。侧栏角标、首页「待处理」、命令面板都是它；命令面板「运行识别」旁边写待识别的张数。
- **已认出比例** `recognition.ratio` = `recognized / scope`。分母 `scope` = 「插画 · 漫画」队列的范围（插画，加上设置开着时的漫画页；不在整本处理的合集里、不在漫画区；含放下的），
  分子 = 其中有角色或归为原创的。放下的不算认出。以前分母是全部插画 + 漫画，分子只扣队列里的，成册的页、漫画区的页被当成认出（附录 #29）。识别进行中首页写「已看过」（`tagging.seenRatio`）。
- 对账：`readmodel/summary.test.ts` 在演示数据和契约数据上逐项核对每个数是旧数的哪个加减（例如 `triage.images = unrecognizedCount − untaggedCount = 有建议 + 没认出`，
  旧分母 − `scope` = 成册、漫画区、关掉设置时的漫画页），并和按口径直接数的结果一致。

**共用的展示规则**（`packages/shared/src/rules.ts`，附录 #30、#38）：类型、分级、任务、合集类型的名称和说明（服务端的提示文案也用）；「能否不打码显示」只有 `blurReason` 一套，
场合是参数：`browse`（普通浏览：没识别的图按存的分级）、`cautious`（本子的封面和页 `bookBlurContext`、胶片条里还没拿到分级的图：分级不可信就打码）、
`showcase`（今日一枚、放映、书的底页：开着模糊时只放分级可信的全年龄图，服务端挑图用同一条 `showcaseQuery`）；敏感分级 `SENSITIVE_RATINGS` 服务端的「敏感」主题也用。
在哪个队列 `triageQueue`；「话 / 册」`CHAPTER_MARKS` / `volumeUnit`（服务端 `parseName` 用同一组）；无题的显示名 `collectionTitle`；排除标签的归一化 `normalizeExclusionTag`
（服务端做，网页表单只预览）；剩余时间 `formatEta`（任务带结构化的 `etaSeconds`）；组图整理的文件夹名 `organizeFolderName`。搜索的归一化 `searchKey` / `matchesQuery` / `searchRank`，
网页的作品、画师、组图选择器和命令面板都用它。

**设置的归属**（附录 #32）：按「换一台设备、一个浏览器，这个设置还该不该一样」判断。

| | 放哪 | 包括 |
| --- | --- | --- |
| 图库设置 | 服务端 `settings` 表（`Settings`），助手、后台任务读得到 | 图库文件夹、识别、Danbooru、查重、自定义画面、主题（`ui.theme`） |
| 本机偏好 | 浏览器 `usePrefs`（localStorage） | 模糊（开关、范围、照片、文字、悬停显示）、底色、网格密度和行高、书架 / 列表、封面裁剪、图库看哪些类型、收拢组图、阅读器的单双页和方向、侧栏收起 |

- `ui.blurSensitive`、`ui.density` 删掉：服务端读写都丢掉（接口收到也丢），迁移 039 清掉存着的旧值；设置页、首次使用引导只改本机偏好。
- 会影响查询结果的本机偏好写进 URL：图库的类型 `?kind=`、收拢组图 `?collapse=`（`lib/urlPrefs.ts`）。URL 没写时把偏好补进去（不多一条历史），URL 写了以 URL 为准，改了同时改偏好和 URL；
  助手拿到的页面上下文（地址）和用户看到的一致。
- 阅读进度留在这台设备上：它是浏览痕迹，不是整理决定，不该参与撤销、触发变更传播和刷新，每翻一页写一次库也不值得；只监听本机，多设备接着读不是现在的场景。
- 主题按这条规则其实更像本机偏好，现在仍存在服务端、前端读它（只有一份来源，不分裂）；搬动牵涉首屏防闪的内联脚本，留到下一阶段做个人布局时一起处理。

**页面区块**（第 10 节要留的接口）：`apps/web/src/blocks/registry.ts` 登记每个页面的区块（稳定 id、标题、用到的公开查询），`PageBlocks` 按注册表的顺序渲染（不加包裹元素，布局和章节编号不变）：

| 页面 | 区块 |
| --- | --- |
| 首页 | `home.import` 首次导入 · `home.stats` 统计条 · `home.daily` 今日一枚 · `home.triage` 待处理 · `home.recent` 最近 30 天在收 · `home.latest` 最新入库 · `home.annex` 别册 |
| 角色总览 | `characters.top` 你最常看的（作用域淡入里）· `characters.recent` 最近 30 天在收 · `characters.works` 作品（总览）· `characters.list` 角色列表（其余视图） |
| 角色扉页 | `character.hero` 扉页 · `character.related` 常一起出现 · `character.collections` 收录于 · `character.images` 全部插画 |
| 作品页 | `work.hero` · `work.characters` 角色 · `work.collections` 收录于 · `work.images` 全部插画 |
| 合集页 | 本子、画集：`collection.head` 封面和版权页 · `collection.cast` 出场角色 · `collection.contents` 目录；组图：`group.head` · `group.cast` · `group.contents` |

`test/architecture/blocks.test.ts` 检查 id 唯一且固定、登记的查询都是服务端真实的 GET 接口或 SSE 事件、每页都按注册表渲染。这一阶段没有配置界面；个人布局（隐藏、换顺序）以后在 `PageBlocks` 里按 id 处理。

## 7. 后台任务

- 任务只做两类事：产出证据（模型识别、Pixiv、Danbooru、查重比对），或者执行分析（缩略图、分类）。**任务不直接写决定**；决定由反应 `reevaluateAuto` 产生，自动决定和用户操作走同一套规则。
- 任务种类做成注册表：名称、所在的执行通道（io / gpu）、优先级、显示名、能否取消。现在 `JobKind` 是封闭的联合类型，相关的表格散在大约 8 处（附录 #34），插件没法加新任务。
- 「该做的事」持久化：待查重、待识别、Pixiv 待检查、暂停状态都存进数据库，重启不丢。
  P4a 核对完：待识别在图片行（`tagged_at` 为空或 `retag`），Pixiv 待检查在 `pixiv_character_checks`，待查重、延后的合集全量重算、用户的暂停（识别、画师补跑、Pixiv 补充）在 `pending_work`
  （`dedupe`、`collections`、`pause:<任务>`；暂停以前只在进程里，重启就丢）。
- 进度事件保持现状（`job`、`job-item`、节流）。任务结束时按任务种类发事件，不再一律标成 `scan`。

## 8. 一个实现：演示也跑真实引擎（D4）

**现在是什么**：服务端有两套完整的后端实现，路由层通过 `DataSource` 接口选其一。

- `SqliteDataSource`：真实的图库，数据在 SQLite，图片在磁盘上。
- `MockDataSource`：全部数据放在内存里的「假图库」，图片是 SVG 占位图。`npm run dev:mock`（命令行参数 `--mock`）就是跑它。

两者实现同一套接口，所以**每条业务规则都各写了一遍**：Mock 约 2,800 行业务逻辑，SQLite 数据层约 7,900 行。

**当初为什么要有**：项目刚开始时还没有真实后端，`ARCHITECTURE.md` 的「设计决策 2」写的就是先写一个完整的 mock，让前端可以独立开发；之后再逐个方法实现 SQLite 版，行为对齐 mock，并用契约测试同时测两套，保证一致。那时 mock 是「行为基准」，是脚手架。

它后来还承担了几项用途：

- README 的截图和每一轮界面验收都用它拍，避免碰到用户真实的图库（`TASKS.md`「截图验收一律用 mock」）。
- 不导入自己的图也能先看界面。
- 契约测试拿它当参照。

**现在为什么要删**：

- 脚手架的使命已经完成：SQLite 版全部实现完毕，真正的行为基准已经是 SQLite。
- mock 反过来成了负担：
  - 每个功能都要写两遍（PR #12 的每处修复都得在 mock 里再改一遍）。
  - 两边已经走样：至少 7 处行为不同，契约测试的说明里还列着 9 处「有意的差异」（附录 #31）。
  - 演示看到的不是真实行为，比如 mock 里没有「同一投稿自动成组」。
- 这正是「改一个地方，另一个地方不一样」的来源之一。

**删的是什么、留的是什么**：

- 删掉的只是**第二套业务逻辑**（`MockDataSource` 和 `mock/collections.ts`）。
- **演示能力保留**：`npm run dev:mock` 照样能用，演示数据（`fixtures.ts`、`seed-data.ts` 等）照样用，安全端口和截图流程不变。

改成这样：用真实的 SQLite 引擎，打开 `data/demo/` 下的一次性数据库，灌入同一份演示数据，再把会产生副作用的部件换成假的：

- 文件：返回 SVG 占位图。
- 回收站：只记录，不真删。
- 识别模型：关闭，或者用一个按演示数据给证据的假来源。
- 网络（Pixiv / Danbooru）：关闭。
- 扫描和监听：关闭；演示用的图库路径改成不可能真实存在的标记路径，免得扫进用户真实的 `D:/Pictures`。

**要补的东西**：

- 灌数据现在会丢掉合集、手动标记、否决、设置等内容。
- 还没有文件、回收站、网络的假实现。
- 启动时多出约 1 秒的词库导入；前端的「演示数据」角标判断要改。

这些在附录 #31 里列成了 9 个阻碍。现有契约测试已经有「SQLite + 灌数据」的做法（`sqliteFactory` + `seedFromMockDb`），可以在它的基础上做。契约测试改为对唯一的实现做接口测试，加上固定的演示数据快照。可替换的部件本来就该有：测试要用，以后页面插件的隔离也要用。

**P1 的做法（2026-11-17）**：

- 可替换部件集中在 `apps/server/src/infra/ports.ts`：时钟、系统回收站、盘符检查、图片文件读取、能否改动用户的图库文件夹、后台任务的执行者（扫描、识别模型、Pixiv / Danbooru 联网都只在后台任务里发生）、启动时的自动任务和词库导入。`SqliteDataSource.open` 的选项就是它的子集，再加上 `memory` 和 `seed`（迁移之后、启动修补之前灌数据）。
- 演示模式（`demo/engine.ts`）：文件数据库 `data/demo/emaki.sqlite`，每次启动清空重建；灌入演示数据后照常跑启动步骤；图片是 SVG 占位图，后台任务只走进度条，移动 / 导入 / 替换 / 在资源管理器中显示 / 添加图库文件夹 / 整理到子文件夹 / 移回原处一律拒绝，回收站只记录；图库路径是 `<演示图库>/…`；`/api/health` 的 `dataSource` 是 `demo`。
- 和以前 mock 的差异（真实规则带来的）：重复组里的副本和原图来源相同，按「同一投稿自动成组」多出 25 组组图；`hoshino_ai_(oshi_no_ko)` 在启动的角色收拢里改成了规范标签 `hoshino_ai`。其余统计、未识别汇总、4 本合集、Top 角色和以前一致（`test/contract/queries.test.ts`）。
- 启动耗时：演示引擎就绪约 4.5 秒（生成演示数据 0.3 秒、灌数据约 2 秒、启动步骤 0.4 秒，其余是加载模块），以前 mock 约 3 秒就能响应。

### 去掉 mock 后的测试

| 层级 | 怎么跑 |
| --- | --- |
| 纯逻辑单测（前端、`packages/shared`、服务端的纯函数） | 不变，不需要后端 |
| 引擎测试（服务端） | 真实引擎 + 每个测试一份一次性的 SQLite（内存或临时文件）+ 固定的测试数据。现在已经有 24 个测试文件是这样写的 |
| 契约测试 | 现有的 105 项只在真实引擎上跑一遍。比对两套实现的 `cross.test.ts` 删掉，换成几组关键查询的固定期望结果。HTTP 冒烟测试和 MCP 测试从 mock 换到同样的「真实引擎 + 测试数据」 |
| 端到端（以后再加） | 跑在演示模式上：真实引擎 + 演示数据 + 假部件，端口 5190/5191 |

- 跑的是真实的业务逻辑和 SQL，但：数据库一次性，绝不碰 `data/emaki.sqlite`；系统回收站、磁盘检查、网络、识别模型、时钟换成假的；后台任务和词库导入关闭。这些替换口子现在大多已有（`trashImpl`、`checkRecyclable`、`autoJobs: false`、`clock`），P1 把它们整理成正式的可替换部件，演示模式和测试共用。
- 「两套实现互相对照」由固定的期望结果和 P0 的跨入口一致性测试代替：同一份证据从不同入口进来，结果必须相同。
- 每个测试打开数据库都要跑一遍全部迁移；目前全量测试十几秒，变慢了就改成复制一份迁移好的模板库。

## 9. 对外接口

- **HTTP 路由和 MCP 工具都从命令 / 查询注册表生成**，共用同一份 schema。现在 MCP 的枚举是手抄的，已经和路由对不上，比如少了 `assignTag`、`trash`（附录 #35）。
- **每次写入都记 actor**，并写进审计记录。AI 助手做的修改，可以在网页的撤销栈里看到、撤销。
- **对外事件只提供领域变化的公开部分**，带类型、带事件 id，可以断线重连后补发。前端以后可以按事件类型精确刷新，不必每次全部重新获取；现在每个用户操作要重新获取两遍（附录 #36）。
- **顺手统一接口风格**：设置改用 PATCH；只读的预览接口一律用 GET；401 / 403 不再返回 `bad_request`。

## 10. 个性化页面与插件（下一阶段）

这一阶段不做，只记下目标，并说明这一阶段要为它留好什么。

**出发点**：每个人想看的页面、看每一页的频率都不一样。比如有人希望角色页默认显示角色排名。现在的每个页面应该只是一个**预设**：

- 可以通过配置隐藏或调整其中的区块；
- 可以被插件 / mod 修改；
- 个性化的调整留在自己那里，不必进入整个仓库。

AI 助手已经能读写图库，还可以让它直接写新页面（比如各种统计页），思路类似 MCP Apps：页面是一段在受控环境里运行、通过公开接口取数据的小程序。

**这一阶段要留好的接口**：

- **页面拿数据只走公开的查询**（第 6 节的读模型、第 9 节的查询注册表），改数据只走命令（第 4 节）。页面里不藏业务规则，否则换一个页面就得把规则再抄一遍。
- **页面由带稳定 id 的区块组成**。按 P5 整理前端时，把现有页面里的章节（比如角色页的「Top / 最近在收 / 作品」）整理成有名字的区块，配置和插件以后按 id 引用它们。P5 已做：区块注册表 `apps/web/src/blocks/registry.ts`（第 6.1 节）。
- **设置能存个人布局**：区块的显示、隐藏、顺序，以及页面默认视图。第 6 节把「图库设置」和「本机偏好」分清，就是为这个铺路。
- **查询和命令带权限范围**（第 4.1 节的 `scope`），以后给插件或 AI 生成的页面授权时直接用。

**下一阶段再设计的内容**：插件的形态（页面插件、区块插件、数据来源插件）、运行与隔离方式、信任模型（D6）、AI 生成页面的存放与分享、版本兼容。以前想到的「证据来源插件」（新的识别模型、来源站）也一并放到那时考虑。

## 11. 必须保留的现有行为

这些是用户已经依赖的，迁移中不能丢：

- 每个用户操作对应一个撤销令牌（即使一次改了多个字段）；toast 上的撤销按钮和 Ctrl+Z；撤销状态查询；前端撤销栈能感知服务重启；不可撤销的操作作为「屏障」；`expiredUndoTokens`。
- 撤销遇到冲突时拒绝（409），而不是悄悄改坏数据。
- 移到回收站有 5 批的延迟窗口；「全部处理」只算一批；退出和启动时把到期的批次送进系统回收站。
- 自动绑定、Pixiv 补充、移动可以跨重启撤回（`change_log`），撤回本身也可撤销；否决和已忽略的检查会阻止撤回掉的关联再长回来。
- 手动优先：`*_manual`、`name_locked`、`works_locked`、`cover_manual`、`collection_detached`、合集的 `origin = 'manual'`。迁移后统一由「来历」表达，但语义不变。
- 两级缓存和字面写死的 SQL 条件（为了命中部分索引），保证同步的 SQLite 在 10 万张图时仍然流畅。
- AI 助手的 `operationId` 幂等；写操作走业务接口；只读 SQL 直接查数据库文件。

## 12. 迁移路线

每一步都能单独上线，测试全绿后再做下一步。不停功能开发；但每进入一个阶段，那一块的新功能就必须按新结构写。

| 阶段 | 做什么 | 完成标准 | 规模 |
| --- | --- | --- | --- |
| **P0 护栏**（已完成 2026-11-17） | 确认本文和第 13 节的决定。加两类架构测试：① 单一写入者检查：扫描源码，找出在主人模块之外写某张表的地方，现有违例列入允许清单，之后只许减少；② 跨入口一致性测试的骨架。 | 两类测试进 CI；允许清单如实记录现状。已完成：`apps/server/test/architecture/` 的 `singleWriter.test.ts`（主人映射见第 3.1 节，允许清单 `writers.allowlist.ts`）和 `crossEntry.test.ts`（附录 #1、#2、#3、#5、#14 现状不一致的用例用 `it.fails` 标出） | S |
| **P1 一个实现**（已完成 2026-11-17） | 演示模式改跑真实引擎 + 假部件（第 8 节）；补全灌数据；删除 MockDataSource；契约测试改成对单一实现的接口测试 | `dev:mock` 不再依赖 MockDataSource；README 截图流程照常可用；附录 #31 关闭。已完成：可替换部件在 `infra/ports.ts`，演示模式在 `demo/`（`engine.ts`、`ports.ts`、`seed.ts`） | M |
| **P2 变更传播骨架**（已完成 2026-11-17） | 变化集、反应注册表、三个阶段；把现有的连带处理逐个搬成反应；撤销改为「还原 + 重跑反应」；同时补上盘点出来的漏处理（移动、替换、解除排除、恢复后重新识别、查重标记） | 主人模块之外不再直接调用 `collectionsHook` / `touch` / `invalidate`；附录 #13–#22 关闭。已完成：`propagation/`（变化、注册表、actor、排队状态 `pending_work`），反应在 `domain/<模块>/reactions.ts` 和 `propagation/engine.ts`；`test/architecture/sideEffects.test.ts` 检查连带处理只在主人模块和变更传播层，`changes.closure.test.ts` 逐条证明附录 #13–#22 已关闭 | L |
| **P3 归类收口**（已完成 2026-11-17） | 证据表和统一的来历字段（含旧数据迁移）；`decideAuto` 和 `reevaluateAuto`；13 个写入点全部改走 `curation.link` / `unlink`；建议改成派生视图；Pixiv 只产出证据；否决语义按 D3 | 对 `image_characters` 和证据表的允许清单清零；跨入口一致性测试全部通过；附录 #1–#9、#12、#37、#39 关闭。**P3a 已完成**：统一来历（迁移 034）；`domain/curation/`（`link` / `unlink` / `replaceCharacters` / `moveCharacterLinks` / `carryLinks`，收藏、分级、放下、原创在 `marks.ts`），13 个写入点全部改走它，`image_characters`、`character_vetoes` 的允许清单清零；查重合并按来历搬并带上放下；D3；附录 #4、#5、#6、#12、#39 关闭（`crossEntry.test.ts`、`db/linkProvenance.migration.test.ts`）。**P3b 已完成**：证据表（迁移 035：`image_evidence`、`character_evidence`、`work_evidence`）和派生视图 `v_character_suggestions`；`decideAuto` / `reevaluateAuto`（第 4.2 节），补采纳是可撤销的命令；
Pixiv 只产出证据和原创信号，原创是带来历的决定（D8）；证据不再支持时撤回（D2，记 `change_log` 的 auto-retract）；编目唯一的 `resolve`、规范化、别名来历、解绑语义（#37，迁移 036）；
归类、证据、编目的表都只由主人写，允许清单里没有它们了；附录 #1、#2、#3、#7、#8、#9、#37 关闭（`crossEntry.test.ts`、`evidence.closure.test.ts`、`catalog.closure.test.ts`、
`domain/curation/auto.test.ts`、`db/evidence.migration.test.ts`、`db/catalogOrigins.migration.test.ts`） | L |
| **P4 入库与分析收口**（已完成 2026-11-18） | 统一文件内容变化的语义（按 D1）；`analyze` 唯一入口；三条移动路径合一；合集判定版本号真正生效；派生数据都带版本。P4b：D5（类型拆成「类型」+「是否动图」两个维度） | 附录 #10、#11、#23 关闭。**P4a 已完成**：图库与文件（`domain/library/`）、分析（`domain/analysis/`）两个模块，允许清单里它们的表和列清零；
D1：扫描发现和用户替换都走 `recordFileChanged` → `image.fileChanged`，识别过期（`staleFileEvidence`）、派生重算（`analyze`）、过期证据不新加自动关联（`decideAuto` 规则 5）；
移动一条路径（`moveImages` / `revertMoveLog` / 扫描的 `recordMoved`），「不能动文件」只有 `assertFilesIdle` 一处；派生数据的版本统一记在 `derived_versions`（迁移 037），合集判定的版本真正生效；
删掉 `image_fingerprints`；回收站行的匹配规则；缓存回收；暂停持久化。附录 #10、#11、#23 关闭（`crossEntry.test.ts`、`library.closure.test.ts`、`domain/analysis/cacheGc.test.ts`）。
**P4b 已完成**（2026-11-18）：D5，类型拆成「类型」+「是否动图」（`images.animated`，迁移 038），实现说明见第 13 节 D5；
`crossEntry.test.ts`（同一张动图从扫描入库和改类型两条路进来结果一致）、`db/animated.migration.test.ts`、`queries/listImages.test.ts`（动图筛选和查询计划） | M |
| **P5 读模型与前端**（已完成 2026-11-18） | 命名口径唯一；状态拆成三个事实；汇总接口；共用的展示规则移进 `packages/shared`；前端删掉自带的业务规则；设置只有一份 | 附录 #24–#30、#32、#38 关闭。已完成（实现说明见第 6.1 节）：`readmodel/terms.ts` 唯一的口径和 `test/architecture/terms.test.ts`；图片的 `tagged` / `characterCount` / `queue`；`GET /api/summary`（`readmodel/summary.ts`，对账 `readmodel/summary.test.ts`）；`packages/shared/src/rules.ts`；设置的归属（迁移 039、`lib/urlPrefs.ts`）；页面区块注册表（`test/architecture/blocks.test.ts`）。关闭测试 `test/architecture/readmodel.closure.test.ts`、`src/readmodel/terms.test.ts`、`packages/shared/src/rules.test.ts` | M |
| **P6 命令注册表与接口** | 命令 / 查询注册表；HTTP 和 MCP 从注册表生成；记录 actor；带类型的事件；合并重复的接口 | `DataSource` 接口删除；附录 #33–#36 关闭 | M |
| 下一阶段 | 个性化页面与插件（第 10 节），另行设计 | | |

**顺序的理由**：

- P1 放在最前，因为后面每一步如果还有两套实现，就要改两遍，而且两边会继续走样。
- P2 先于 P3：归类收口依赖变化和反应，否则又得在每个写入点手工接连带处理。
- P6 放最后：它把收口后的命令和查询整理成注册表，这也是下一阶段页面插件和 AI 生成页面要用的接口；在命令和事件收口之前做，承诺的稳定接口就是空的。

## 13. 需要拍板的决定

| # | 问题 | 决定 |
| --- | --- | --- |
| D1 | 文件内容变化的语义。扫描发现外部改了文件，和用户主动替换高清版，现在一个会重置识别、一个全部保留 | **已批准**：统一成一种：发出 `image.fileChanged`；派生数据重算；这份文件版本的模型证据标记为过期并排队重新识别；手动决定保留；自动决定等新证据到了再按 D2 重算。`reason` 只记录在案，不改变处理方式。**P4a 已实现**：「过期」= 识别时间清空、证据行留着（`decideAuto` 不拿过期的模型证据新加关联，也不因为它撤回）；画师识别时间一起清空；像素派生清掉、缩略图按新 sha 重新生成；见 `ARCHITECTURE.md`「文件内容变化」 |
| D2 | 证据不再支持某个自动关联时（重新识别没再认出、来源插件被停用），要不要撤回 | **已批准**：只撤回「自动 + 依据的就是这个来源」的关联；手动的永远不动；撤回会记入审计，可以撤销。现在是只增不减，也就是旧模型的错误永远留着。**P3b 已实现**：只在这个来源的证据刚换过（重新识别、来源失效）时撤回，新证据里没有这个候选或分数低于这个来源的自动阈值；阈值调高、补采纳、改类型不撤回；来历不明的（rule `legacy`）和手动的不动；别的来源仍然支持时只改来历。撤回记 `change_log`（auto-retract），在「最近的自动改动」里撤回会把关联加回来并记成手动，这次撤回本身也能撤销；用户操作里连带的撤回随操作一起撤销 |
| D3 | 用户手动加回一个被自己否决过的角色 | **已批准**：加回时清掉否决。现在不清，导致以后的自动规则仍然认为「用户不要」（附录 #39） |
| D4 | 删掉 MockDataSource，演示改跑真实引擎 | **已批准**，P1 已完成（2026-11-17）。来龙去脉见第 8 节：只删第二套业务逻辑，演示能力和演示数据保留。`ARCHITECTURE.md` 的「设计决策 2」已改写 |
| D5 | 「动图」和「插画 / 漫画」是同一个互斥类型里的值，但一张图可以既是动图又是插画 | **已批准**：拆成「类型」（插画 / 漫画 / 截图 / 照片 / 文字 / 表情）+「是否动图」两个维度。别册里的「动图」变成按维度筛选。要改界面和统计，放在 P4 一起做。**P4b 已实现**（2026-11-18，见下方「D5 的实现」） |
| D6 | 插件的信任模型 | 挪到下一阶段，和个性化页面一起设计（第 10 节） |
| D7 | fork 之后和上游的关系 | 已定：独立演进。P2 之后结构差异会大到没法再直接合并上游，上游的修复按需手工移植；本文作为 fork 的架构基线 |
| D8 | Pixiv 的「原创」标记 | **已批准**：当作自动决定，由 `decideAuto` 根据 Pixiv 证据给出，可以被手动覆盖。现在 Pixiv 用的是和手动原创相同的存法（附录 #7）。**P3b 已实现**：证据里有原创信号、图还没有原创的决定也还没有角色时标成自动原创（`auto-original@1`）；手动标、手动取消（包括撤回那一轮 Pixiv）都是手动的决定，自动不再改；自动标的在 Pixiv 新证据没有原创信号时按 D2 撤回 |

**D5 的实现（P4b，2026-11-18，迁移 038）**：

- **数据**：`images.animated`（0 / 1）是分析模块的派生列，`isAnimated`（`services/classify/rules.ts`）按读文件头拿到的帧数和格式判：HTML 逐帧动画一律算；
  读过帧数的看帧数（> 1，多帧的 GIF / WebP / PNG / AVIF）；还没读过帧数的 GIF 先算动图，缩略图任务读到帧数后按帧数改（静态 GIF 不算）。
  分类器去掉了「GIF / 多帧 → animated」（`CLASSIFIER_VERSION` 1 → 2），动图照样按其余规则判类型：动的插画判插画，动的表情判表情，「3话」文件夹里的判漫画。
  `ContentKind` 去掉 `animated`；`ImageItem.animated`、`ImageDetail.animatedReason`（「GIF · 24 帧」）、`LibraryStats.animatedCount`（跨类型，`kindCounts` 只有六类）、
  `ListImagesQuery.animated`；HTTP 的 `kind=animated` 返回 400 并说明改用 `animated=true`，MCP 工具的类型枚举也去掉了它。
- **写入和传播**：分类的 UPDATE 顺带写 `animated`（手动类型的图也写：手动只保护类型）；缩略图任务给旧图补帧数走 `recordFrames`，只写帧数和是否动图、不重判类型。
  是否动图变了声明 `image.animatedChanged`，`refreshFolderCollections`（动图页太多的文件夹不成册）、`markDedupeDirty`（动图只认文件完全相同）订阅它；
  `reevaluateAuto`、`queuePixivCheck` 不订阅：它们只看类型。
- **按类型的规则保持原意**：自动建档（`AUTO_CREATE_KINDS`）、Pixiv 资格只看插画 / 漫画——动的插画和静态插画一样建档、一样去查 Pixiv，动的表情和静态表情一样不建档、不查；
  未识别里动的插画进「插画 · 漫画」，「照片 · 文字等」只剩截图 / 文字 / 照片 / 表情；启动补登 Pixiv 动图改看 `animated`；查重、合集判定改看 `animated`。
- **迁移 038**：先按上面的规则给所有图写 `animated`（表情包文件夹里的 GIF 这类原来被文件夹规则判成表情的动图也算）；原来类型是 `animated` 的图——自动判的和手动选的——
  手动标记清掉，类型放成插画占位、版本清空，启动时按新规则重判（手动选 animated 的本意是「这是动图」，现在由帧数决定，帧数显示不是动图的就不再是）；
  别的图版本直接记成 2：去掉的规则只会判出 animated，没被它判中的图结果不变，启动时不整库重判（10 万张合成数据：迁移约 0.9 秒，启动只重判原来的 animated，1000 张 0.15 秒）。
  统计的覆盖索引加 `animated`，只看动图按入库时间翻页走部分索引 `idx_images_animated_live`。迁移前后的核对：`apps/server/scripts/verify-migration-038.sql`
  （备份库只用迁移 010 之前就有的列，从多早的版本升上来都能跑）。
- **界面**：类型印（Seal）只给类型。目次（`KindIndex`）和首页别册在五类别册后面隔一道细线，写「筛选 · 动图」，记号是细线圆圈里的播放三角；
  点进去是 `/annex/animated`，各类里会动的图都在这里，格子带类型印。图库工具条有「动图」chip，在当前类型里再筛。网格左下角是墨色小签（播放三角 +「动」），
  和类型印、合集页码排成一行（`TileMarks`），悬停显示角色名时让位；看图器「类型」栏在六枚类型印下面写「动图 · GIF · 9 帧」。改类型的菜单没有动图。
