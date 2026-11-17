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
│  │  └─ sqlite/                唯一的实现
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

### 6. 后台任务 + SSE
扫描、缩略图、识别、Pixiv 补充、Danbooru 同步、查重都是 `JobQueue` 里的任务，分两条通道：识别角色和画师主要吃显卡，走 gpu 道；其余吃 CPU / 硬盘，走 io 道。每条道同一时间只跑一个，道内按优先级出队，两条道可以同时跑。进度通过 `EventBus` → `GET /api/events`（SSE）推给前端，侧边栏显示进度环。

### 7. 图片展示
- `Thumb`：主色占位（`dominantColor`）→ 缩略图淡入；敏感分级按偏好模糊。
- 缩略图三档宽度 240/480/960（webp），按 sha256 缓存。图片 id 稳定（文件内容变了 id 不变），所以 HTTP 用按内容 sha 的 ETag + `private, no-cache`，不用 `immutable`。
- `ImageGrid`：等高行布局（justify.ts）+ `@tanstack/react-virtual` 行虚拟化 + 无限滚动，10 万张也不卡。

### 8. 角色识别（真实实现）
WD14 tagger（ONNX，`onnxruntime-node`，Windows 上用 DirectML 走显卡）给每张图打 Danbooru 标签：
- character 标签分数 ≥ 自动采纳阈值 → 直接归类；介于建议阈值和自动阈值之间 → 进「未识别」等人确认。
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
