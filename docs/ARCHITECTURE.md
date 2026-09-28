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
│  DataSource 接口 (datasource/DataSource.ts)  ◀── 架构的核心接缝                                 │
│      ├── MockDataSource   内存假数据 + SVG 占位图（已完成，默认）                                  │
│      └── SqliteDataSource SQLite + 文件系统（待实现，见 TASKS.md）                               │
│              │                                                                               │
│              ├── core/  JobQueue（串行后台任务） UndoStack（撤销） EventBus（→ SSE）              │
│              └── services/  scanner · thumbnails · tagger(WD14/ONNX) · danbooru · dedupe       │
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
│  ├─ index.ts         启动：选数据源 → buildApp → listen
│  ├─ app.ts           Fastify 实例、错误处理、生产模式托管前端
│  ├─ config.ts        环境变量
│  ├─ routes/          HTTP 路由（zod 校验）
│  ├─ http/            错误类型（NotImplementedError 带任务编号）、校验工具
│  ├─ core/            JobQueue / UndoStack / EventBus（mock 与真实实现共用）
│  ├─ datasource/
│  │  ├─ DataSource.ts          接口
│  │  ├─ mock/                  参考实现（行为基准）
│  │  └─ sqlite/                真实实现（桩，按 TASKS.md 填）
│  └─ db/schema.sql    完整表结构（v1）
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

### 2. DataSource 接口 = 前后端解耦点
路由层只认 `DataSource` 接口。`MockDataSource` 完整实现了所有行为（过滤、排序、分页、撤销、后台任务进度、SSE），所以**前端可以完全独立开发**；后端逐个方法把 `SqliteDataSource` 填完，行为对齐 mock，然后 `EMAKI_DATA_SOURCE=sqlite` 一切换，前端零改动。T24 会写一套契约测试同时跑两个实现。

### 3. 契约放在 packages/shared
类型只写一遍。改接口的顺序：`shared/api.ts` → 后端 `routes/` → 前端 `lib/api.ts`。TypeScript 会把漏改的地方全部标红。

### 4. 服务端数据走 TanStack Query，UI 状态走 zustand
- 服务端数据只存在 Query 缓存里，失效策略极简：**任何修改成功 / 收到 SSE `library-changed` → 全部 invalidate**。本地后端请求很快，不值得做精细失效。
- zustand 只放纯 UI 状态：偏好（持久化）、看图器、多选、撤销栈、浮层开关。
- 页面筛选条件放 URL 查询参数，刷新 / 前进后退都保留。

### 5. 撤销
所有修改接口返回 `MutationResult { message, undoToken }`。服务端 `UndoStack` 保存反向操作（最近 50 条，内存）。前端 toast 上有「撤销」按钮，顶栏撤销按钮 / Ctrl+Z 撤销最近一次。这让「排除」「归类」「移到回收站」这类批量操作可以放心大胆地做。

### 6. 后台任务 + SSE
扫描、缩略图、打标签、Danbooru 同步、查重都是 `JobQueue` 里的串行任务（同时只跑一个，避免 IO/GPU 争抢）。进度通过 `EventBus` → `GET /api/events`（SSE）推给前端，侧边栏显示进度环。

### 7. 图片展示
- `Thumb`：主色占位（`dominantColor`）→ 缩略图淡入；敏感分级按偏好模糊。
- 缩略图三档宽度 240/480/960（webp），按 sha256 缓存，HTTP `immutable` 永久缓存。
- `ImageGrid`：等高行布局（justify.ts）+ `@tanstack/react-virtual` 行虚拟化 + 无限滚动，10 万张也不卡。

### 8. 角色识别（真实实现）
WD14 tagger（ONNX，`onnxruntime-node`，Windows 上用 DirectML 走显卡）给每张图打 Danbooru 标签：
- character 标签分数 ≥ 自动采纳阈值 → 直接归类；介于建议阈值和自动阈值之间 → 进「未识别」等人确认。
- Danbooru API 把角色标签映射到作品（copyright），并提供日文名等别名；另有中文名字典（T12）。
- 用户也可以建「自建角色」（原创 / OC），以后 Danbooru 有了对应标签时提示「能对上 Danbooru」。

## 配置（环境变量）

启动时会读取仓库根目录的 `.env`（可选，模板见 `.env.example`）；已经存在的环境变量优先。相对路径一律按仓库根目录解析。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EMAKI_DATA_SOURCE` | `sqlite` | `sqlite` 真实数据 / `mock` 演示数据（也可以 `npm run dev:mock`，即命令行 `--mock`，优先级最高） |
| `EMAKI_DATA_DIR` | `./data` | 数据库、缩略图缓存、模型文件 |
| `EMAKI_PORT` | `5174` | 后端端口（前端 dev server 固定 5173，代理 `/api`） |
| `EMAKI_HOST` | `127.0.0.1` | 只监听本机 |
| `EMAKI_LOG_LEVEL` | `info` | Fastify 日志级别 |
| `EMAKI_MODELS_DIR` | `<dataDir>/models` | 识别模型目录，多个库可共用一份 |
| `EMAKI_MODEL_SOURCES` | `huggingface,hf-mirror,modelscope` | 模型下载源，并行测速选最快的 |
| `HF_ENDPOINT` | `https://huggingface.co` | 兼容 huggingface_hub 的镜像约定 |
| `EMAKI_DML_DEVICE_ID` | 自动探测 | 强制 DirectML 显卡序号（探测结果缓存在 `<modelsDir>/dml-device.json`） |
| `EMAKI_HTTP_PROXY` | `HTTPS_PROXY` / `HTTP_PROXY` | 出网代理（Clash 等系统代理 Node 不会自动走） |
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
- 唯一的联网行为：下载 tagger 模型、（可选）同步 Danbooru 标签元数据。图片本身永远不上传。
- `data/` 目录（数据库、缩略图、模型）在 `.gitignore` 里。
