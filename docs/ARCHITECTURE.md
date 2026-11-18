# 架构

> Emaki 絵巻：本地运行的二次元插画收藏管理器。图片永远不离开你的电脑。

## 一张图看懂

```
┌─────────────────────────────── 浏览器 http://localhost:5173 ───────────────────────────────┐
│  apps/web  (React 19 · Vite · Tailwind v4 · TanStack Query · zustand · motion · radix)      │
│                                                                                              │
│  features/<页面>  ──用──▶  components/{ui,layout,media,overlays}                              │
│        │                                                                                     │
│        └──▶ lib/queries.ts (hooks) ──▶ lib/api.ts (fetch /api/*)      lib/events.ts (SSE)    │
└────────────────────────────────────────────┬─────────────────────────────────▲───────────────┘
                                             │ JSON over HTTP                   │ text/event-stream
┌────────────────────────────────────────────▼─────────────────────────────────┴───────────────┐
│  apps/server  (Fastify 5 · zod)                              http://127.0.0.1:5174            │
│                                                                                              │
│  routes/{library,images,system}.ts   ← 只做参数校验 + 调用 DataSource                           │
│              │                                                                               │
│              ▼                                                                               │
│  DataSource 接口 (datasource/DataSource.ts)                                                    │
│      └── SqliteDataSource  唯一的业务实现：SQLite + 文件系统                                     │
│              │   演示模式 / 测试：同一个引擎，换掉 infra/ports.ts 里的可替换部件（demo/）           │
│              ├── domain/  领域模块（主人）与它们的反应   propagation/  变化集 · 反应注册表 · actor  │
│              ├── core/  JobQueue（io / gpu 两条通道） UndoStack（撤销） EventBus（→ SSE）         │
│              └── services/  scanner · thumbnails · tagger(ONNX) · pixiv · danbooru · dedupe     │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                     packages/shared  —— 领域类型 + API 契约 + 搜索归一化（前后端共用）
```

## 目录

```
emaki/
├─ packages/shared/src/
│  ├─ domain.ts        领域模型：Work / Character / ImageItem / DuplicateGroup / Exclusion / Settings / Job …
│  ├─ api.ts           HTTP 契约：每个接口的路径、查询参数、请求体、响应类型
│  └─ search.ts        searchKey()：「未花 / ミカ / mika / Mika_(Blue_Archive)」归一化，前后端一致
├─ apps/server/src/
│  ├─ index.ts         启动：打开引擎（真实图库或演示数据）→ buildApp → listen
│  ├─ app.ts           Fastify 实例、错误处理、生产模式托管前端
│  ├─ config.ts        环境变量
│  ├─ routes/          HTTP 路由（zod 校验）
│  ├─ http/            错误类型（NotImplementedError 带任务编号）、校验工具
│  ├─ core/            JobQueue / UndoStack / EventBus
│  ├─ datasource/
│  │  ├─ DataSource.ts          接口（P6 换成命令 / 查询注册表后删掉）
│  │  └─ sqlite/                唯一的实现（context.ts：写入的唯一入口 ctx.mutate / ctx.apply）
│  ├─ domain/<模块>/   领域模块：表的主人（test/architecture/owners.ts）和它们的反应（P2 起逐步搬进来）；
│  │                   domain/evidence/ 证据、domain/curation/ 归类（含唯一的自动决定规则 decideAuto）、domain/catalog/ 编目（P3）；
│  │                   domain/library/ 图库与文件、domain/analysis/ 分析（P4a）
│  ├─ propagation/     变更传播：变化（changes.ts）、反应注册表和三个阶段（registry.ts）、actor、引擎层的反应、排队状态
│  ├─ infra/ports.ts   可替换部件：时钟、回收站、图片文件、图库文件夹、后台任务（扫描 / 模型 / 联网）
│  ├─ demo/            演示数据（fixtures、种子、占位图）、灌数据、演示用的假部件
│  └─ db/              迁移（schema.sql 是 v1，migrations/ 是之后的版本）
└─ apps/web/src/
   ├─ main.tsx / router.tsx
   ├─ styles/index.css          设计 token（亮 / 暗）
   ├─ lib/                      api · queries · stores · events · format · hotkeys
   ├─ components/
   │  ├─ ui/                    基础组件（Button / Chip / Segmented / Dialog / Menu …）
   │  ├─ layout/                AppShell · Sidebar · PageHeader · 全局快捷键 · 主题同步
   │  ├─ media/                 Thumb · ImageGrid（虚拟化等高行） · CharacterCover · Lightbox
   │  └─ overlays/              ⌘K 命令面板 · 帮助
   └─ features/<页面>/          首页 · 图库 · 角色 · 角色详情 · 作品 · 未识别 · 重复 · 已排除 · 设置
```

## 关键设计决策

### 1. 本地 Web 应用，而不是桌面壳
Node 后端 + 浏览器前端，`npm run dev` 就能用。以后要做成桌面程序，套一个 Electron / Tauri 壳即可（T23），前后端代码不用改。

### 2. 业务逻辑只有一个实现，演示也跑真实引擎
项目早期先写了一个完整的内存版 `MockDataSource` 让前端独立开发，再逐个方法实现 SQLite 版并用契约测试对齐两边。SQLite 版完成后，mock 反而成了第二套业务逻辑：每个功能写两遍、两边已经走样（[core-architecture.md](core-architecture.md) 第 8 节、附录 #31）。2026-11-17（P1）删掉了 mock：

- 业务逻辑只有 `SqliteDataSource` 一份。会产生副作用的部件集中在 `infra/ports.ts`：时钟、系统回收站、图片文件的读取、对用户图库文件夹的改动、后台任务（扫描、识别模型、Pixiv / Danbooru 联网都只在后台任务里发生）。
- **演示模式**（`npm run dev:mock`，命令行 `--mock`）：同一个引擎打开 `data/demo/emaki.sqlite`（每次启动清空重建），灌入 `demo/fixtures.ts` 的演示数据，换上 `demo/ports.ts` 的假部件——图片是 SVG 占位图，后台任务只走进度条，移动 / 导入 / 替换 / 在资源管理器中显示 / 添加图库文件夹一律拒绝，回收站只记录；演示用的图库路径是不可能存在的 `<演示图库>/…`。所以演示模式绝不读写用户真实的文件夹，看到的却是真实的规则（合集判定、同投稿成组等）。
- **测试**：引擎测试和契约测试都是「真实引擎 + 一次性的库 + 固定的测试数据」；HTTP 冒烟和 AI 助手的路由测试用演示部件。原来「两套实现互相对照」由固定的期望结果和跨入口一致性测试代替。

### 3. 契约放在 packages/shared
类型只写一遍。改接口的顺序：`shared/api.ts` → 后端 `routes/` → 前端 `lib/api.ts`。TypeScript 会把漏改的地方全部标红。

### 4. 服务端数据走 TanStack Query，UI 状态走 zustand
- 服务端数据只存在 Query 缓存里，失效策略极简：**任何修改成功 / 收到 SSE `library-changed` → 全部 invalidate**。本地后端请求很快，不值得做精细失效。
- zustand 只放纯 UI 状态：偏好（持久化）、看图器、多选、撤销栈、浮层开关。
- 页面筛选条件放 URL 查询参数，刷新 / 前进后退都保留。

### 5. 撤销
所有修改接口返回 `MutationResult { message, undoToken }`。服务端 `UndoStack` 保存反向操作（最近 50 条，内存）。前端 toast 上有「撤销」按钮，顶栏撤销按钮 / Ctrl+Z 撤销最近一次。这让「排除」「归类」「移到回收站」这类批量操作可以放心大胆地做。
撤销 = 还原事实 + 重放变化（见下一节）；后台的自动关联、Pixiv 补充、移动记在 `change_log` 里，重启后也能撤回，不占撤销栈。

### 5a. 变更传播：写操作只声明「改了什么」
（[core-architecture.md](core-architecture.md) 第 5 节，P2 起。）写操作只写自己负责的事实，然后声明一条「变化」；
套排除规则、重算合集、登记 Pixiv 补充、标记要查重、刷新缓存、推事件这些连带处理，由订阅这条变化的**反应**完成。
谁写的、从哪个入口写的（网页、AI 助手、后台任务、启动修补）都一样，撤销也一样。

**写一个新的写操作**：

```ts
// 可撤销：一个事务 + 撤销记录 + 变更传播
return this.ctx.mutate((u) => {
  u.columns('images', ['shelved_at'], ids);                     // 只记事实的快照
  db.prepare('UPDATE images SET shelved_at = ? …').run(…);
  this.ctx.changed({ type: 'curation.shelvedChanged', ids });   // 声明改了什么
  return { message: `已放下 ${ids.length} 张图` };
});
// 不可撤销的（后台任务、启动修补、自带撤销逻辑的文件操作）：ctx.apply(() => { …; ctx.changed(…) })
```

- 变化的类型在 `propagation/changes.ts`（第 5.1 节的表），都带涉及的图片 id；按图片的变化 id 为空时直接丢掉。
- **不要**自己调合集重算、`reevaluateExclusions`、缓存失效、推 `library-changed`、通知设置监听者：`test/architecture/sideEffects.test.ts` 会失败。
- 删掉会让派生数据跟着变的事实（例如删排除规则，外键会把 `excluded_by` 清空）时，**先声明变化再删**：反应在变化声明的那一刻记下「改之前」的样子（`snapshot`）。
- 撤销不需要接线：`ctx.mutate` 的撤销 = 按撤销记录还原事实 + 在同一个事务里把这次声明的变化重放一遍，反应都是重算，派生数据自然对。
  快照表达不了的还原步骤用 `u.custom(fn)`（在撤销事务里逆序执行，只还原事实）。`onUndo` 已经删掉了。

**图 ↔ 角色只经归类模块写**（P3a，[core-architecture.md](core-architecture.md) 第 2.2、2.4 节）：`image_characters` 和 `character_vetoes`
只有 `domain/curation/` 写（单一写入者测试检查）。要加、去掉、整组替换、搬关联，调 `link` / `linkEach` / `unlink` / `replaceCharacters` /
`moveCharacterLinks` / `carryLinks`，每条关联带来历（`provenance.ts`：`manual(at, 证据)` 或 `auto(规则@版本, at, 证据)`）；
它们负责写来历、记否决（用户去掉的）或清否决（用户手动加回的，D3）、记撤销、声明 `curation.charactersChanged`。
收藏、分级（含识别给的自动分级）、放下、原创（带来历，D8）在 `curation/marks.ts`；画师、手动来源、手动类型标记、手动指定的作品分别在 `artists.ts`、`source.ts`、`kinds.ts`、`works.ts`。

**证据模块**（P3b，第 2.1、2.3 节）：某个来源（`tagger` 识别模型、`pixiv` 投稿标签，以后的插件来源 `plugin:<id>`）对一张图给出的角色候选、作品候选、原创信号，
存在 `image_evidence` / `character_evidence` / `work_evidence`，只由 `domain/evidence/store.ts` 按「图片 × 来源」整体替换（`replaceEvidence`、来源失效时 `dropEvidence`），
替换时声明 `evidence.changed { provider }`。证据不改变图库：
- 识别写入（`evidence/tagger.ts`）把达到建议阈值或自动阈值的候选全部记成证据（包括会变成关联的），候选角色的主作品记成作品证据；
- Pixiv 补充（`services/pixiv/sync.ts` + `evidence/pixiv.ts`）只把投稿标签解释成候选和置信度（确认对上 1、只是候选 0）和原创信号；
- 建议是派生视图 `v_character_suggestions`：证据里还没关联、没被否决的候选。不要再写「建议」，关联上、否决了自然就不是建议；
- 图的作品（`v_image_works`）只来自关联的角色、手动指定的作品和原创标记，作品证据不算。

**唯一的自动决定规则 `decideAuto`**（P3b，第 4.2 节，`curation/auto.ts`）：纯函数，输入图片事实、各来源的证据（带「刚换过」）、当前决定、每个来源的阈值、编目解析，
输出要加的关联、要撤回的关联（D2）、要建档的角色、原创的自动决定（D8）。**只有反应 `reevaluateAuto`（`curation/reevaluate.ts`）调用它并写入结果**；
任何会影响自动决定的变化（证据、最终类型、放下 / 原创、否决、合集、漫画区、编目合并 / 绑定）都会触发它，所以首次识别、重新识别、补采纳、改类型、Pixiv 补充得到同样的结果。
- 写新的证据来源：在 `domain/evidence/` 里调 `replaceEvidence`，不要自己写关联；阈值在设置 `tagger.autoAcceptBySource` 里按来源配（没配就用 `autoAcceptThreshold`）。
- 要「按当前规则重新评估」这些图（例如补采纳），在命令里声明 `curation.autoRequested`，不要直接调 `decideAuto`。
- 撤回（D2）只在某个来源的证据刚换过时发生，记进 `change_log`（auto-retract），在「最近的自动改动」里可以撤回（加回来的记成手动）。
- 撤销重放时 `reevaluateAuto` 不做决定，只把涉及的图声明成「角色、原创变了」，派生数据按还原后的事实重算。

**编目模块**（P3b，附录 #37）：角色、作品、别名、重定向、Danbooru 绑定、名字索引只由 `domain/catalog/` 写。「标签 → 角色」只有 `CharacterCatalog.resolveCharacterId`；
规范化经 `CharacterCatalog.normalizeTag` / `normalizeWorkTag`（生产环境由 `createCatalog` 建）；建角色、建作品要可撤销时用 `insertDanbooruCharacter` / `insertWork`；
「原创」作品只用 `ensureOriginalWork`；绑定、解绑 Danbooru 经 `bindings.ts`。

**图库与文件模块**（P4a，[core-architecture.md](core-architecture.md) 第 2.4 节，附录 #11、#23）：图片行的新增和观测列（路径、文件名、尺寸、大小、格式、sha256、
入库 / 修改时间、丢失、回收站）、图库文件夹、漫画子文件夹、读不了的文件（`scan_errors`）、回收批次只在 `domain/library/` 里写。
- 扫描器（`services/scan/Scanner.ts`）只遍历、读文件、算 sha、读文件头；看到的经 `images.ts`（入库 `insertImage` + `declareAdded`、内容变化 `recordFileChanged`、
  丢失 / 找回）、`move.ts`（`recordMoved`）、`scan.ts`（导入 / 扫描时间、`scan_errors`、跟着改名的漫画子文件夹）写进库并声明变化。显式导入（`import.ts`）、
  替换文件（`replace.ts`）、移到回收站（`markTrashed` + `pendingTrash.ts`）、图库文件夹的增删改和合并接管（`roots.ts`）也在这里。
- **移动只有一条路径**（`move.ts`）：应用内「移动…」、整理到子文件夹（reason `move` / `organize`）共用 `moveImages`——改文件、改路径、声明 `image.moved`、
  记 `change_log`；撤回（toast 里的撤销、「最近的移动」里移回）共用 `revertMoveLog`。扫描发现的移动不动文件，经 `recordMoved` 写路径、声明同样的
  `image.moved`（reason `scan`）。之后来源、路径相关的分类、漫画区、排除规则、合集都由反应按新位置重算，几条路完全一样。
- **「扫描或识别进行中不能动文件」只有 `guard.ts` 的 `assertFilesIdle` 一处**：移动、整理、移回、替换、撤销替换、撤销导入都先过它
  （扫描正在跑一律不行；识别正在跑、要动的图里有它还会去读的也不行）。
- 回收站规则：用户移进回收站的行不当移动的来源；送进系统回收站后标成丢失（「丢弃的行」，`DISCARDED`），原位置再出现文件时旧行让出路径
  （挪到 `.emaki-discarded/<id>/…`，扫描永远不进以 . 开头的目录），文件作为新图入库，不复活旧 id 和旧关联。还在撤销窗口里的不动；
  系统回收站移不动（被占用）的没标丢失，文件还在原处，下次扫描照常回来。

**分析模块**（P4a，第 2.4、3.1 节，附录 #23）：派生数据——缩略图回写的 dHash、主色、生成时间、解码错误，帧数、相机，自动类型、主题、画质分——只由
`domain/analysis/` 写。唯一的入口是 `analyze(tx, ids, { probes, fileChanged })`：从现在的事实（路径、尺寸、格式、帧数、相机、识别标签、漫画区）重算类型、主题、
画质分，最终类型变了声明 `image.kindChanged`。
- 调用它的：反应 `analyze`（入库、文件内容变化、移动、漫画区变化）、识别写入（每批）、缩略图任务和识别任务读到的帧数 / 相机、手动改类型（`setManualKind`）、
  撤销切换导入方式（`restoreKinds`）、启动时版本过期的行（`classifyStale`）。别处不要调分类器。
- 读文件头才知道的帧数、相机由调用方交进来（变化里的 `probes`），分析模块先写上再判类型；入库的 INSERT 里不再顺手算类型。
- 缩略图文件本身还在 `ThumbnailService`（按 sha 缓存），它算出的主色、dHash 交给 `recordPixels` / `recordDecodeError` 按 sha 写，不传播（看图时生成缩略图不该让前端整页重拉），
  只有类型变了才传播。
- 缓存回收（`cacheGc.ts` + `library/replace.ts` 的 `collectReplacementBackups`，启动 10 分钟后后台做一次）：只进数据目录下的 `thumbs/v1`、`animations/v1`、
  `image-replacements`，只删名字符合格式、没有任何图片行引用的 sha 的普通文件，和撤销令牌已经过期的替换备份；缓存目录和任何图库文件夹重叠、
  图库还没扫完过时整个不做。

**文件内容变化（D1，附录 #10）**：同一个 id 的文件内容变了——扫描发现外部改了文件、用户替换成高清版——是**同一件事**，都只走 `recordFileChanged`：
改观测列，声明 `image.fileChanged { reason: 'scan' | 'replace', files: [新旧 sha], probes }`。`reason` 只记录在案，处理完全相同：
1. 证据（反应 `staleFileEvidence`，排在 `analyze` 前面）：这份文件版本还没有识别结果——识别时间、模型、画师识别时间清空，识别任务和画师任务会重新挑它；
   标签、角色候选这些旧证据先留着（过期）。
2. 分析（反应 `analyze`）：清掉旧文件的像素派生（缩略图任务按新 sha 重新生成），按新的尺寸、格式、帧数、相机重判类型；主题、画质分跟着「还没识别」清空。
3. 决定：手动的（角色、收藏、分级、原创、来源、手动类型……）都挂在 id 上，原样保留；自动关联先留着，过期的模型证据不再拿来**新加**关联（`decideAuto` 规则 5），
   新证据到了（重新识别写入）由 `reevaluateAuto` 按 D2 撤回不再被支持的。
4. 排队：查重标记（`markDedupeDirty`）、识别（`queueTagging`）、缩略图（`queueAnalysis`）、合集按目录重算，都是订阅这条变化的反应。
撤销替换也是一次文件内容变化，同样处理。缩略图、原图都按 sha 做 ETag，前端按 `modifiedAt` 带版本取，换了文件不会看到旧缩略图。

**派生数据的版本**（附录 #23，`propagation/versions.ts`，迁移 037）：来源解析（`source`）、类型判定（`classification`）、合集判定（`collections`）
上次整体重算用的版本统一记在 `derived_versions`。启动时对一遍：版本对不上就整体重算一次再记下（类型判定只重算 `content_kind_version` 过期的行）；
合集只有判定版本变了、或者有没做完的延后重算（`pending_work` 的 `collections`，后台任务 `defer` 时记、做完清）时才全量重判。
改了规则只要把对应的版本号加一。用户的暂停（识别、画师补跑、Pixiv 补充）也持久化在 `pending_work`（`pause:<任务>`），重启不丢。

**写一个新的反应**：放在主人模块（`domain/<模块>/reactions.ts`）或 `propagation/engine.ts`，在 `SqliteDataSource.registerReactions` 里注册（同一阶段按注册顺序执行）：

```ts
export const reevaluateExclusionsReaction: Reaction = {
  name: 'reevaluateExclusions',
  on: ['visibility.rulesChanged', 'curation.charactersChanged', …],  // 订阅
  phase: 'tx',                                                        // tx / queue / after
  emits: ['visibility.changed'],                                      // 会声明的变化（检查有没有环）
  run({ ctx, changes, emit, actor, undo }) { … },
};
```

- **事务内（tx）**：和写操作同一个事务，必须是幂等的重算（从事实算出结果，不做增量修补），按 `changes.ids()` 批量处理，不要逐行查询。
  自己声明的变化会继续交给后面的反应，最多 8 轮，超过就报错回滚（有环）。删掉了重算不出来的东西（过期的证据）时记在 `undo` 里。
- **排队（queue）**：提交后把工作交给后台任务；要做的事持久化在库里（识别、Pixiv 补充本来就在图片行和 `pixiv_character_checks` 里，查重在 `pending_work`）。
  只有用户和助手的操作在这里直接拉起任务，后台任务写库后由任务链接着排。
- **提交后（after）**：缓存、事件、监听者。出错只记日志。
- **actor**：HTTP 请求是 `user`；助手经 `app.inject` 调接口时带内部令牌，是 `assistant`；任务执行体在 `job:<种类>` 下；启动修补是 `system:startup`。
  用户和助手的操作强刷新缓存、马上推 `library-changed`（reason `mutation`）；后台任务和启动修补弱刷新（旧结果最多再用 10 秒），事件按任务种类节流，任务结束时推一次。
  后台任务里昂贵的全量重算（合集）用 `defer` 延后到任务结束（不论完成、让出还是取消）一次做完。
- 找慢的反应：`EMAKI_PROFILE_REACTIONS=1` 打印每个反应的耗时；写操作的测速脚本是 `apps/server/scripts/bench-mutations.ts`（合成数据）。

### 6. 后台任务 + SSE
扫描、缩略图、识别、Pixiv 补充、Danbooru 同步、查重都是 `JobQueue` 里的任务，分两条通道：识别角色和画师主要吃显卡，走 gpu 道；其余吃 CPU / 硬盘，走 io 道。每条道同一时间只跑一个，道内按优先级出队，两条道可以同时跑。进度通过 `EventBus` → `GET /api/events`（SSE）推给前端，侧边栏显示进度环。

### 7. 图片展示
- `Thumb`：主色占位（`dominantColor`）→ 缩略图淡入；敏感分级按偏好模糊。
- 缩略图三档宽度 240/480/960（webp），按 sha256 缓存，没人引用的由缓存回收删掉（见「分析模块」）。图片 id 稳定（文件内容变了 id 不变），所以 HTTP 用按内容 sha 的 ETag + `private, no-cache`，不用 `immutable`。
- `ImageGrid`：等高行布局（justify.ts）+ `@tanstack/react-virtual` 行虚拟化 + 无限滚动，10 万张也不卡。

### 8. 角色识别（真实实现）
WD14 tagger（ONNX，`onnxruntime-node`，Windows 上用 DirectML 走显卡）给每张图打 Danbooru 标签：
- character 标签都记成证据；分数 ≥ 自动采纳阈值的由 `decideAuto` 直接归类，介于建议阈值和自动阈值之间的作为建议进「未识别」等人确认。
- Danbooru API 把角色标签映射到作品（copyright），并提供日文名等别名；另有中文名字典（T12）。
- 用户也可以建「自建角色」（原创 / OC）。创建、编辑名称/别名/作品、启动、Pixiv 补充和 Danbooru 同步后，会用本地词库检查可关联的标签。
- 自动关联使用名称/别名的精确匹配，要求排除作品冲突、规范化服装变体后只有一个身份；仅昵称或标签简写匹配时还要求作品一致。投稿量和建议分差不用于自动选择。标签已有所属角色（含合并重定向）、多个自建角色争用同一标签、或已忽略的匹配均不自动绑定。
- 自动绑定保留角色编号、用户名称和已有图片关联；没有手动指定作品时补齐作品。创建/编辑时的自动绑定与本次操作一起撤销。其余建议由角色页「Danbooru 关联」弹窗列出具体名字、标签和所属作品，可确认关联或合并至已有角色；列表接口为 `GET /api/characters/danbooru-matches`。

## 配置（环境变量）

启动时会读取仓库根目录的 `.env`（可选，模板见 `.env.example`）；已经存在的环境变量优先。相对路径一律按仓库根目录解析。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EMAKI_DATA_SOURCE` | `sqlite` | `sqlite` 真实图库 / `demo` 演示数据（旧写法 `mock` 也认；也可以 `npm run dev:mock`，即命令行 `--mock`，优先级最高）。演示数据放在 `<数据目录>/demo`，每次启动重建 |
| `EMAKI_DATA_DIR` | `./data` | 数据库、缩略图缓存、模型文件 |
| `EMAKI_PORT` | `5174` | 后端端口（前端 dev server 固定 5173，代理 `/api`） |
| `EMAKI_HOST` | `127.0.0.1` | 只监听本机 |
| `EMAKI_LOG_LEVEL` | `info` | Fastify 日志级别 |
| `EMAKI_MODELS_DIR` | `<dataDir>/models` | 识别模型目录，多个库可共用一份 |
| `EMAKI_MODEL_SOURCES` | `huggingface,hf-mirror,modelscope` | 模型下载源，并行测速选最快的 |
| `HF_ENDPOINT` | `https://huggingface.co` | 兼容 huggingface_hub 的镜像约定 |
| `EMAKI_DML_DEVICE_ID` | 自动探测 | 强制 DirectML 显卡序号（探测结果缓存在 `<modelsDir>/dml-device.json`） |
| `EMAKI_HTTP_PROXY` | `HTTPS_PROXY` / `HTTP_PROXY` | 出网代理；都不设时读 Windows 系统代理（注册表里的 ProxyServer，或 PAC 里写的第一个地址），端口没在监听就直连 |
| `EMAKI_SCAN_CONCURRENCY` | `2` | 扫描时同时读几个文件（机械盘设 1） |
| `EMAKI_RESCAN_MINUTES` | `180` | 定时兜底全量扫描的间隔，0 = 关闭 |
| `EMAKI_NO_AUTOSCAN` | 未设置 | 设了之后启动时不自动扫描 |

### 识别速度（本机实测，2026-09-27）

`wd-eva02-large-tagger-v3`，RTX 3070 Laptop：

| 设备 | 速度 |
| --- | --- |
| DirectML（batch 8） | 约 4.7 张/秒（1 万张约 35 分钟） |
| CPU | 约 0.46 张/秒 |

## 隐私

- 后端只监听 127.0.0.1。
- 联网行为：下载 tagger 模型、（可选）同步 Danbooru 标签元数据、（可选）按 Pixiv 作品号读公开标签补角色、（可选，默认关）AI 助手。前三项都不上传图片。
- AI 助手开启后，对话、查询结果和助手查看的图片会发给用户选的模型服务；查出处时，经用户同意可能把去掉元数据的查询图上传到 Yandex、SauceNAO 等搜图网站。见 [ai-assistant.md](ai-assistant.md)。
- Pixiv 补充会把未识别图片文件名里的作品号发给 pixiv.net。识别后的自动补充由 `tagger.pixiv` 控制，默认关；「未识别」页的「补充 Pixiv 角色」按钮是用户手动点的，开关关着也会跑。
- 成功读取的投稿标签、译名、页数和原创标记按作品号保存在 `pixiv_artwork_cache`，跨重启复用。普通补跑使用缓存按当前词库和规则重新匹配；新增同投稿图片也共用缓存。获取失败不写成功缓存，明确的 404 继续由 `pixiv_unavailable_posts` 跳过。按钮旁的「重新获取 Pixiv 标签」只刷新当前待补投稿；API/MCP 可传 `refreshPixiv: true`。此缓存不保存角色匹配结论，也不按时间自动过期。
- `data/` 目录（数据库、缩略图、模型）在 `.gitignore` 里。
