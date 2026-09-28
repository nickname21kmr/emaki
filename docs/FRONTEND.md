# 前端设计说明

> 给实现者（人或模型）的页面级规格。整体架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 设计语言：私人画集（M5 定稿）

**概念：一本「私人画集」—— 纸、墨、一方朱印，插画是唯一的主角。** 角色总览的信息结构对齐参考图（Illustash），再加上「按类型陈列」「空间连续」「印与纸」几类微交互。规格来源见 `docs/design/m5/`，有冲突时以本节为准（`02-aesthetic.md`「Token 改动·九」里「删掉 +N 前的小绿点」「+N 白文印」两处作废）。

### 六条原则

1. **内容是印刷品，控件是器物。**
   - 封面类统一 `--radius-plate`（12px）：Top 卡、扇形卡、plate 图版、首页扇形小样；扇形卡保留 3px 白边（`ring-raised`）。网格缩略图 `--radius-plate-sm`（6px），头像是圆形，控件是胶囊。合集的书用 `--radius-book`（书脊直、切口圆），是唯一的例外。
   - 「印刷品」的感觉靠图注、标题排版和纸色，不靠方角。
   - 书架卡片（plate）不在图上压白字，名字写在图版下方；Top 卡（overlay）和看图器例外。
2. **层级靠字体和线。**
   - 页头 = kicker（徽记 + 册号 + 小题）+ 衬线大标题 + 双线（`rule-double`）。
   - 章节 = `SectionTitle`：「01 小标题 ——— 注释」。编号由 CSS 计数器自动生成（滚动容器上有 `chapter-scope`，标题前是 `chapter-no`），**不要传编号**；不参与编号的传 `numbered={false}`。某一段不渲染时，后面的编号自动前移。
   - 中文衬线（`font-serif-cjk`、`display-title`、`kicker`）只用于页面大标题、kicker、章节标题（D8）；卡片上的名字一律无衬线 `font-semibold tracking-tight`。
3. **朱色只用来做「印」**，每屏朱色面积 < 1%：当前导航、焦点、引信、章节编号、类型印。`Seal` 只用于类型印、卷号、选中和「新」「自」、合集书名印，**不用于 +N**。+N 全站只有两种写法，见下。
4. **插画与别册。** 截图、漫画、文字、照片、表情、动图自动分开放进「别册」。分类要能说出原因（看图器「类型」里有依据），手动修改优先，可以撤销，**不移动文件**。
5. **动效像纸与印。** 参数全部来自 `lib/motion.ts`；全站包在 `<MotionConfig reducedMotion="user">` 里（`main.tsx`）。克制，不来回弹跳。
6. **按 10 万张图定性能预算。** 网格里不做逐格的 filter、tilt、backdrop-filter；吸顶头部用不透明的纸，不用背景模糊；新网格一律虚拟化。

**禁止**：emoji 图标、紫色渐变、到处都是卡片阴影、居中大标题 hero、为了「好看」而加的无意义装饰、在组件里写死色值（叠在图片上的白字除外）。

### +N 的两种写法

| 位置 | 写法 | 例子 |
| --- | --- | --- |
| 叠在图上（圆头像、plate 图版） | `<Badge tone="ink" dot="var(--c-ok)">+N</Badge>` | `AvatarTile` 的 `badge`、`CharacterCover variant="plate"` 右上角 |
| 写在文字行里 | `<span className="font-semibold text-ok">+N</span>` | 扇形卡「17 位 · 2,316 张 · +231」 |

数字的含义：角色卡上是 `newCount`（上次打开扉页之后的新图）；「最近 30 天在收」头像和作品卡上是 30 天内的张数（`recentCount` / `recentImageCount`）。Top 卡（overlay）不显示 +N，也不显示排名数字。

### Token（`styles/index.css`）

颜色是 `@theme inline`，工具类直接引用 `var(--c-*)`：组件里只写 `bg-sheet`、`text-fg-muted`、`border-line` 这类语义类，暗色和底色自动成立；任何子树写 `data-theme` / `data-palette` 都能局部换肤（设置页的底色预览就是这样做的）。

| 类别 | Token（工具类后缀） | 用途 |
| --- | --- | --- |
| 纸面 | `canvas` `sheet` `raised` `sunken` `hover` | 桌面 / 主内容区的纸 / 卡片和弹层 / 输入框 / 悬停底 |
| 线 | `line` `line-strong` `rule` | 分隔线 / 强分隔 / 章节细线和双线 |
| 文字 | `fg` `fg-muted` `fg-subtle` `fg-inverse` | 正文 / 次要 / 更弱 / 墨底上的字 |
| 墨 | `ink` `ink-hover` | 主按钮、选中的 chip、toast 胶囊、+N 徽章 |
| 朱 | `shu` `shu-soft` `shu-fg` `seal` | 印：焦点、引信、章节编号、类型印；`seal` 是白文印底 |
| 品牌 | `brand` | 徽记、kicker 的册号、标签页图标 |
| 状态 | `ok` `warn` `danger`（各有 `-soft`） | `ok` 兼作 +N 的「新鲜」色 |
| 其他 | `scrim` `stage` | 遮罩 / 看图器暗房（不随主题变） |
| 圆角 | `--radius-xs/sm/md/lg/xl` = 6/8/12/16/22；`--radius-sheet` 20；`--radius-plate` 12；`--radius-plate-sm` 6；`--radius-book` `3px 8px 8px 3px` | 见原则 1 |
| 阴影 | `shadow-card` `shadow-lift` `shadow-pop` `shadow-fan` `shadow-fan-hover` `shadow-plate` `shadow-sheet`；圆头像卡纸框 `--c-shadow-avatar(-hover)` | `shadow-plate` 和卡纸框按主题 / 底色取值 |
| 缓动 | `--ease-out-soft` `--ease-fan` `--ease-spring` | 与 `lib/motion.ts` 前两个一一对应；`--ease-spring` 只给徽记转环、开关滑块这类小动作 |
| 动画 | `animate-rise` `animate-fade-in` `animate-unroll`（双线、今日一枚）`animate-brush`（竖排大名）`skeleton`；关键帧 `fuse` `draw` `check-in` `ripple` | 引信、对勾、勾选涟漪 |
| 字体 | `font-sans`（Inter + 系统中文）`font-display`（Instrument Serif）`font-serif-cjk`（Noto Serif SC）`font-mono` | |
| 工具类 | `numeral`（斜体衬线大数字）`tabular` `display-title` `kicker` `tategaki`（竖排）`rule-double` `paper`（纸纹，`background-attachment: local`）`chapter-scope` / `chapter-no` `fade-x` `scrollbar-thin` `scrollbar-none` `scrim-bottom` | |
| 运行时变量 | `--focus-halo` `--paper-grain` `--page-head-h`（`PageHeader` 写入，给 `SectionBar` 吸顶定位） | |

**底色**（设置 → 外观 → 底色，T29c）：`<html data-palette>` 选底色、`<html data-theme>` 选明暗，两者正交。底色存在本机偏好 `usePrefs.palette`（localStorage `emaki.prefs`），明暗来自设置 `ui.theme`（`ThemeSync`，system 时跟随系统）；`index.html` 的内联脚本在首屏前先读这两项，避免闪色。底色只换纸面、线、文字、投影和品牌色；薄荷 / 天青 / 雾紫连朱色（`shu`、`seal`、`--focus-halo`）也换成同色系，米纸和黑白保留朱色；`ok` / `warn` / `danger` 和看图器暗房都不变。

| 底色 | 浅色 canvas / sheet / brand / shu | 深色 canvas / sheet / brand / shu | 说明 |
| --- | --- | --- | --- |
| `washi` 米纸（默认） | `#ece8e0` / `#faf8f4` / `#c73a27` / `#d9442a` | `#0d0c0b` / `#161412` / `#ee6242` / `#ee6242` | 暖色画册纸，有纸纹 |
| `mono` 黑白 | `#eceef1` / `#ffffff` / `#15171b` / 朱不变 | `#000000` / `#060606` / `#ededed` / 朱不变 | 纯白 / 纯黑，无纸纹 |
| `mint` 薄荷 | `#dcebe4` / `#f3faf6` / `#2e7d5b` / `#2e8a62` | `#08110e` / `#0e1814` / `#7fd1a8` / `#5fc796` | |
| `sky` 天青 | `#dbe6f0` / `#f2f7fc` / `#2f6fa8` / `#2f76b8` | `#080d14` / `#0e151f` / `#8cc1ee` / `#6fb0ea` | |
| `lilac` 雾紫 | `#e6e1ef` / `#f8f6fc` / `#6b54a8` / `#7058b8` | `#0e0c13` / `#15121c` / `#b9a6ef` / `#a893ea` | |

新增底色时：在 `index.css` 各加一段 `[data-palette='x']:not([data-theme='dark'])` 和 `[data-palette='x'][data-theme='dark']`（`--c-shadow-avatar` 引用 `--c-raised`，必须在每段里重新写），再在 `lib/stores.ts` 的 `Palette` 和 `PalettePicker` 里加一项。

### 动效：`lib/motion.ts`

| 导出 | 值 | 用在哪 |
| --- | --- | --- |
| `EASE_OUT` | `[0.22, 1, 0.36, 1]`（= `--ease-out-soft`） | 默认缓出：入场、淡入、滚动定位 |
| `EASE_FAN` | `[0.3, 1.25, 0.5, 1]`（= `--ease-fan`） | 扇形叠卡展开，约 3% 过冲 |
| `DURATION` | `fast 0.18` / `base 0.35` / `slow 0.55`（秒） | 常用时长 |
| `SPRING` | `{ type: 'spring', stiffness: 420, damping: 32 }` | 印章落下、选中下划线（`layoutId`）、chip 这类小元素 |

```tsx
import { DURATION, EASE_OUT, SPRING } from '@/lib/motion';

<motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: DURATION.base, ease: EASE_OUT }} />
<motion.span layoutId="kind-index-underline" transition={SPRING} />
```

- 组件里**不要写缓动数组字面量**，从这里取；CSS 里用 `var(--ease-out-soft)` / `var(--ease-fan)`。
- 减少动效：motion 由 `MotionConfig reducedMotion="user"` 直接跳到终态；CSS 由 `index.css` 末尾的 `prefers-reduced-motion` 把动画和过渡压到 0.01ms（`.fuse` 引信除外，它是计时器）。悬停几何变化写成 `motion-safe:` 前缀（`CoverFan`），减少动效时只加深阴影。
- 图片悬停轻微放大（1.03–1.045，700–900ms 缓出）；模糊中的图不放大（会盖掉模糊用的 scale）。缓存命中的图不重播淡入（SEL-13）。

### 画册的零件

- **徽记 `Emblem`**（`components/ui/Emblem.tsx`）「相角徽环」：圆环 + 四向相角刻度 + 三张照片扇形叠放，线条用 `currentColor`，默认 `text-brand`，跟着底色和明暗变。`size ≤ 16` 自动换简化版；`spin` 让外环在悬停时转 45°（侧栏 Logo）。
- **动态标签页图标**：`faviconSvg(color)` 生成简化版徽记；`ThemeSync` 读当前 `--c-brand`，监听 `<html>` 的 `data-theme` / `data-palette` 变化后更新 `<link rel="icon">`（data URL）。
- **卷首的相簿说法**（`components/layout/chapters.ts` 的 `getChapter`，SEL-3）：整个应用是一套私人相簿，页头 kicker 按路由自动生成——首页「扉页 · 中文日期」、图库「第一册 · 插画」、角色「第二册 · 人物」、作品「第三册 · 作品」、合集「合集 · 本子与画集」、别册「别册 · 类型」、未识别 / 重复 / 已排除「整理 · 其一 / 其二 / 其三」、设置「附录 · 设置」。详情页用 `chapter={false}` 的面包屑头。
- **页头 `PageHeader`**：`sticky` 时是不透明的纸加一道细线；吸住后收起 kicker、双线和副标题，标题缩到 20px 并垫回高度（内容不跳），高度写进 `--page-head-h`。双线只在首次进入时展开。
- **结果 toast**（`components/ui/Toast.tsx`，SEL-11）：`useMutate` 成功后调用 `showResultToast(message, undoToken, client)`。墨色胶囊，对勾描出来，底部一条朱色引信（末端一颗 3px 朱点）：可撤销的 6 秒、不可撤销的 3.2 秒烧完消失；悬停、键盘聚焦、切到后台时停烧；减少动效时照常烧。Ctrl+Z、顶栏撤销、命令面板撤销都先调 `undoViaToast(token)`：对应的 toast 还在就原地变成「已撤销 · …」，否则走普通撤销；撤销失败时胶囊轻抖并显示原因。
- **机械计数 `RollingNumber`**（`components/ui`，SEL-18）：数字变化时只有变了的那几位像翻页计数器一样滚动，方向跟增减一致；首次出现或大跨度（差值 > 10 且超过 5%）改成连续补间，减少动效时直接替换。参数：`size`（`xl` / `md` / `xs`）、`mode`（`auto` / `roll`）、`digits`、`format`（如 `formatCompact`）、`id`（记住上次显示的值，重新挂载时从旧值滚过去）、`appear={false}`（首次直接显示）。用在首页统计、侧栏计数、别册目次、多选栏。
- **封面长成扉页**（`lib/viewTransition.ts`，SEL-14）：列表里的角色封面调用 `useCoverMorph(id)`，把 `ref` 挂在图版上、`viewTransition` 给 react-router 的 `Link`、`onClick` / `onPointerEnter` / `onPointerLeave` 给链接。只有被点的那张在点击时才挂上 `view-transition-name: emaki-cover`（同名元素会让浏览器取消整个过渡）；悬停 120ms 预取角色详情，扉页同帧就有图；后退时由同一个角色的封面接住，反向缩回并恢复滚动。CSS 在 `index.css` 末尾：封面组 460ms 变形，其余页面 180ms 淡出、280ms 淡入。减少动效或浏览器不支持时普通跳转。入口：书架 plate、Top 卡、圆头像。
- **放映**（`components/media/lightbox/slideshow.ts`，SEL-16）：`useSlideshow().start(() => collectImages(queries, max))` 分页拉图、去重，然后用 `useLightbox.show(ids, 0, …, { autoplay: SLIDE_MS })` 打开看图器。`slideFilter()` 只放插画，开着模糊时只放分级可信的全年龄图。看图器放映时每张停 6 秒、交叉淡化，底部朱色引信烧完换下一张（到最后绕回开头），Space 暂停，鼠标 2 秒不动时顶栏和面板淡出。入口：角色扉页「放映」、首页今日一枚「放映今天的 20 张」。
- **焦点**（SEL-15）：控件平时有一圈透明的 5px 外框，聚焦时变朱色并收到 2px。图版用「印框焦点」：宿主加 `focus-frame`（宿主不能 `overflow-hidden`），或者在可聚焦的祖先（Link / button）里包一层 `focus-frame-target`；键盘聚焦时四角朱框从外往里收紧落下。
- **印章 `Seal`**：朱文（描边，`variant="zhu"`）标类型、作品；白文（实底、微歪，`variant="bai"`）只用于「新」「自」和合集书名印；`animateIn` 像盖章一样落下。

## 可用积木（先用这些，不够再加）

- `components/ui`：`Button` `IconButton`（必须有 label，自带 tooltip）`Chip` `ChipAvatar` `Badge` `CountBubble` `Segmented` `Input` `SearchInput` `Kbd` `Tooltip` `Dialog` `DialogFooter` `Menu*` `Switch` `Slider` `Progress` `Field` `Skeleton` `EmptyState` `ErrorState` `SectionTitle` `Seal` `RollingNumber`；另有 `Emblem.tsx`、`Toast.tsx`（不从 index 导出）
- `components/layout`：`PageHeader`（右侧自带全局操作：跳到角色 ⌘K / 模糊开关 / 撤销 / 帮助）`PageBody` `useScrollContainer` `ThemeSync` `chapters.ts`
- `components/media`：`Thumb`（所有插画都用它：主色占位、淡入、按分级 / 类型模糊，`blurBadge` 按尺寸自动选、`revealOnHover` 默认关）`ImageGrid`（虚拟化等高行网格 + 无限滚动 + 多选 + 点开看图器）`CharacterCover`（`variant="overlay"` Top 卡 / `"plate"` 书架图版）`CoverFan`（全站唯一的扇形叠放，1 / 2 / 3 / 5 张）`AvatarTile` + `RecentStrip`（圆头像「卡纸框」+ 图注）`BookPlate`（合集的书）`CollectionsStrip`（「收录于」）`KindBadge` `KindMenu` `CardGrid`
- `lib/queries.ts`：全部数据 hook；修改一律用 `useMutate(fn)`，自动结果 toast + 撤销 + 刷新
- `lib/stores.ts`：`usePrefs`（模糊开关与范围、照片 / 文字模糊、悬停显示、底色、书架 / 列表、行高、图库类型、阅读器单双页与翻页方向）`useLightbox`（`show(ids, index)` 打开看图器）`useSelection`（多选）`useOverlays` `useUndoStore`
- `lib/motion.ts`、`lib/viewTransition.ts`、`lib/kinds.ts`（类型名、印章字、图标）、`lib/blur.ts`（模糊判断）、`lib/format.ts`（`formatCount` `formatCompact` `formatBytes` `formatRelative` `formatDate` `RATING_LABEL`）、`lib/hotkeys.ts`（`useHotkey('mod+k', fn)`）、`lib/events.ts`（SSE：`library-changed` 让 query 失效；识别进行中排名类列表最多一分钟重拉一次，未识别列表只标记过期）

页面的筛选状态放在 URL 查询参数（`useSearchParams`），刷新后保留。

---

## 1. 首页 `/`（`features/home`）

目的：打开应用第一眼看到「最近收了什么、有什么待处理」。页头 kicker 是「扉页 · 中文日期」，副标题「晚上好 · 本周新收 312 张 · 上次扫描 2 小时前」（刚导入时改写成「刚导入 N 张，正在识别角色」）。

从上到下（T31）：
- **首次导入面板** `ImportPanel`：7 天内有文件夹首次导入时显示，扫描、缩略图、识别、查重四步分别判断。
- **统计条** `StatsStrip`：插画数（只数插画，旁边是 7 天柱状图，今天那根用朱色，下面写「另有 N 张在别册」）、角色数（识别中写「已看过 X%」）、作品数（「收得最多的是『…』」）、总体积；数字用 `RollingNumber`。
- **今日一枚** `DailyPlate`（SEL-9）：按日期种子每天抽一张大图版，右侧竖排角色名和图注；开着模糊时只抽已识别的全年龄图；R 换一张；「放映今天的 20 张」。
- **待处理** `TriageCards`：未识别（另写「另有 N 本待整理」）、重复、能对上 Danbooru 的自建角色，按实际情况自适应，清空的显示「已清空」而不是隐藏。
- **最近 30 天在收**：圆头像行（`AvatarTile`）；30 天内没有新图时换成「收得最多」（`CharacterCover` overlay）。
- **最新入库** `LatestImages`，**别册** `AnnexIndex`（各类型入口）。
- 有后台任务时顶部一条 `JobBanner`；空库（`stats.imageCount === 0`）显示首次使用引导 `Onboarding`。

## 2. 图库 `/gallery`（`features/gallery`）

目的：浏览全部插画，批量整理。

- **头部**（sticky）：kicker「第一册 · 插画」，标题「图库」，副标题「6,147 张插画 · 另有 2,806 张在别册 →」。下面是类型目次 `KindIndex`（和别册共用）：「全部 N」· 插画 · 别册各类（类型印 + 斜体数字），默认只显示插画，选「全部」写进 `usePrefs.galleryKinds`（D2）；分类第一次生效后有一条可关闭的提示。再下面一行工具条：
  - 左：`SearchInput`（搜文件名 / 标签，防抖 250ms，写入 `?q=`）
  - 中：筛选 chip——分级（全年龄 / 轻微 / 较敏感 / 限制级，可多选）、方向（竖 / 横 / 方）、画面（腿·足 / 胸 / 泳装 / 兽耳 / 女仆·和服 / 多人，T34e）、只看收藏
  - 右：排序 `Menu`（最近添加 / 修改时间 / 文件名 / 体积 / 随机）、升降序、行高 `Slider`（120–400，存 `usePrefs.gridRowHeight`）
- **网格**：`ImageGrid`，`selectionScope="gallery"`，`useImagesInfinite(query)`。
- **多选操作栏**：有选中时，底部居中浮起一条墨色胶囊工具栏（`fixed bottom-6`，`animate-rise`）：「已选 N 张」· 归到角色…（弹出角色搜索）· 收藏 · 设分级 · 排除 · 移到回收站 · 取消选择（Esc）。全选当前已加载（Ctrl+A）。调用 `api.bulkImages`。
- 快捷键：Esc 取消选择，Ctrl+A 全选，E 排除选中，F 收藏选中。

### 看图器（`components/media/Lightbox.tsx`，归这个页面的实现者）

全局组件，已有最小版本，需要做完整：

- 全屏深色 scrim，图片居中 `object-contain`；先显示 960 宽缩略图（`imageUrl.thumb(id, 960)`）再换原图，避免白屏。
- 右侧可折叠信息面板（320px，按 `I` 切换）：文件名、尺寸、体积、格式、入库时间、来源（pixiv 链接等）、分级（可改）、角色（chip 列表，可移除，可添加——带搜索的弹出框，调用 `api.updateImage`）、tagger 建议（`characterSuggestions`，一键采纳）、标签（按 category 分组，score 用细进度条表示）、操作：收藏（F）、在资源管理器中显示、排除（E）、移到回收站。
- 顶部：`index / total`、关闭。左右方向键切换，滚轮 / 双击放大（简单的 transform scale + 拖动即可）。
- 敏感图片默认模糊，中间一个「显示」按钮（只对当前这张生效）。
- 切换图片时预加载下一张。

## 3. 角色 `/characters`（`features/characters/CharactersPage.tsx`）★ 核心页面

信息结构对齐参考图（Illustash 的角色页）：**Top / 最近在收（或「更多常看的」）/ 作品** 三段。组件都在 `features/characters/overview/`。

- **头部**（`PageHeader sticky`）：kicker「第二册 · 人物」，标题「角色」，副标题「88 位角色 · 23 部作品」（`stats.characterCount` / `workCount`，都只数有插画的）。右侧 `CustomMatchPill`「N 个自建角色能对上 Danbooru」（点了只看自建）。下面两行：
  - `SearchBar`：大号圆角搜索框（写入 `?q=`，Ctrl/⌘+F 聚焦），右侧 `Segmented`「书架 / 列表」（`usePrefs.charactersView`，V 切换）。
  - `WorkChips`：「总览」（选中时墨色）、「最近在收 N」（30 天内有新图的角色数）、按张数排的前 16 部作品（`ChipAvatar` + 张数），行尾「全部作品 N ⌄」弹出带搜索的全部作品；选中写入 `?work=`，`[` `]` 在相邻作用域间切换。
  - 吸顶后收起 kicker、双线、副标题，标题缩到 20px，1440×900 下总高不超过 150px。
- **总览**（没选作品、没搜索、书架视图），从上到下三段，编号由 CSS 计数器自动生成，某段不显示时后面的前移：
  1. **01 你最常看的** — `TopBento`，`useTopCharacters({ limit: 9 })`。「一大多小」Bento：第 1 名占左侧 2×2，2–5 名占右侧 2×2（行高 204px），6–9 名在底行四等分（260px）；不足 9 位时按实际数量重新铺满，不留空洞；窄屏退成两列。卡片是 `CharacterCover`（overlay，`showNew={false}`），不显示排名数字和 +N。
  2. **02 最近 30 天在收** — `OverviewRecent` → `RecentStrip`：`useTopCharacters({ workId: 'recent', limit: 24 })` 里 `recentCount > 0` 的角色，圆头像「卡纸框」+ 名字 / 细线 / 作品名，右下角 +recentCount；hint「N 位角色有新图」，「全部 →」切到「最近在收」作用域。**30 天内没有新图时不隐藏**，同一位置换成「**更多常看的**」：`useTopCharacters({ limit: 34 })` 去掉前 9 位（Top 里已经有了），hint「按张数」，不显示 +N、没有「全部」、不写名次。有了新图会自动换回来。
  3. **03 作品** — `WorksShelf`：只列有插画的作品。3 张以上的画成 `WorkFanCard` 扇形卡（`CoverFan`，作品的 `covers` 三张；盒子取列宽的 96%、上限 400px），下面是作品名、一道细线、「N 位 · N 张 · +N」（+N 是 30 天内张数，`text-ok`）；点卡片切到这部作品。网格 <1024 两列、1024–1279 三列、**≥1280 一律四列**；每批渲染 24 张，滚到底再加。一两张的长尾作品收成 chip 云「还有 N 部作品只有一两张」。末尾「共 N 部作品」和「按角色浏览全部 N 位 →」（切到列表视图）。标题右侧「新建角色 N」。
- **选中作品 / 最近在收 / 搜索 / 只看自建 / 列表视图**：上面仍是 `TopBento`（hint「作品名 · 按收藏张数」+「作品页 ↗」；选中作品的角色少于 5 位、或总览的列表视图时不显示），下面是 `FlatCharacters`：
  - 书架 = `ShelfGrid`，`CharacterCover variant="plate"`：名字写在图版下方，+N 用 ink 徽章；列表 = `CharacterRows`（小封面、名字 + 别名、作品、张数、最近添加、Danbooru 标签 / 「自建」）。
  - 标题行是 `SectionBar`，吸在页头下面（用 `--page-head-h` 定位），带排序 `Menu`：按张数 / 最近添加 / 名字 / 新图数。无限滚动。
  - 列表末尾：「另有 N 位角色只出现在漫画、截图等里 · 显示」（`?other=1`，`includeOther`）。
  - 空搜索结果：`EmptyState`「没有找到『xxx』」+「新建自建角色」（N 键，Dialog：名字、所属作品、别名、Danbooru 标签）。
- 切作用域时内容整块淡入（`EASE_OUT`）；回到某个作用域时按「作用域 + 视图」恢复滚动位置（`sessionStorage`，读写包 try/catch）。
- 识别进行中：作品网格、Top、最近在收这类排名列表最多一分钟重拉一次，免得鼠标下的卡片不停换位（`lib/events.ts`）。

## 4. 角色扉页 `/characters/:id`（`features/characters/CharacterDetail.tsx`）

- 进入时调用 `api.markCharacterSeen(id)`（清掉 +N）。页头是面包屑（角色 › 作品 › 名字），右侧全局操作。
- **扉页**（`CharacterHero`，SEL-8）：左侧 plate 图版（封面长成扉页的落点），旁边竖排大名（`tategaki display-title`，`animate-brush` 像一笔写下来）和读音；右侧大号张数（`numeral`）+「另有 N 张漫画等」+「放映」，下面一张细线表：作品、最近添加、最常一起出现、上次查看后（「新」白文印 + 新增 N 张）、Danbooru 标签（可复制）、别名。右上角：置顶、编辑、更多（合并、排除这个角色、恢复自动封面）。
- **01 常一起出现**（`RelatedCharacters`）：`AvatarTile` 头像行，图注「同框 N 张」，有新图的带 +N 徽章。
- **02 收录于**（`CollectionsStrip`）：这个角色出现的本子 / 画集（门槛见 TASKS「数据口径 → 角色出现在合集」），没有时整章不渲染。
- **全部插画**：`ImageGrid`（`characterId` 筛选），工具条：插画 / 全部、排序、分级、画面筛选；多选后可「从该角色移除」「设为封面」（选中 1 张时）等。

## 5. 作品 `/works/:id`（`features/works/components/WorkDetail.tsx`）

- **Hero**（`WorkHero`）：作品色的浅底卡片，左边作品印、Danbooru copyright 标签、作品名、别名，统计「N 位角色 · N 张插画（另有 N 张漫画等）· +N 最近 30 天」；右边是作品的 `CoverFan` 扇形封面。
- **01 角色**（`WorkCharacters`）：最常看的 4 位用 `CharacterCover`（overlay），其余角色是 `AvatarTile` 头像网格（默认两整行，可展开，+N 用 ink 徽章）。
- 「收录于」和「全部插画」（`ImageGrid`，`workId` 筛选）。

## 6. 未识别 `/unrecognized`（`features/unrecognized`）

目的：**快速**给没识别出角色的图归类。这是整理效率最关键的页面，要能全程键盘操作。

- 头部：标题「未识别」，副标题「702 张待确认 · 其中 N 张 tagger 有建议」。右侧：「运行识别」按钮（`api.startJob('tag')`，运行中显示进度）。
- **布局：左右分栏**。左边是队列（窄的缩略图竖列表，当前项高亮，显示最高建议的分数）；右边是当前图片的大预览 + 决策面板：
  - 建议列表：每条是一行大按钮——角色名、作品、置信度条（朱色进度条 + 百分比），编号 1/2/3，按数字键直接采纳（`api.acceptSuggestion`）。
  - 「搜索其他角色」输入框（按 `/` 聚焦），下拉结果回车归入（`api.bulkImages assign`）。
  - 次要操作：跳过（→ 或 J）、排除（E）、上一张（← 或 K）。
- 采纳后自动前进到下一张，列表里那项用动画移出。
- 支持在左侧队列多选后批量归到同一个角色。
- 清空时：`EmptyState` glyph「清」「全部识别完了」。

## 7. 重复 `/duplicates`（`features/duplicates`）

- 头部：标题「重复」，副标题「36 组 · 可释放 1.2 GB」（除推荐保留外其余图片体积之和）。`Segmented`：待处理 / 已处理。右侧「重新查找」（`startJob('dedupe')`）。
- 每组一张卡：顶部一行「完全相同」或「相似 96%」Badge + 组内张数；下面横排该组全部图片（等高，按比例），每张图下方是对比信息：尺寸、体积、格式、文件夹路径（截断）、入库时间；**最好的值用朱色高亮**（分辨率最高、体积最大）。推荐保留的那张有「建议保留」角标并默认勾选。点击图片切换保留 / 删除（删除的变灰 + 删除线）。
- 卡片底部操作：「保留选中，其余移到回收站」（主按钮）、「不是重复」（ghost）。
- 键盘：J/K 在组间移动，Enter 按推荐处理当前组。
- 一键「全部按推荐处理」（二次确认 Dialog，说明会移到回收站、可撤销）。

## 8. 已排除 `/excluded`（`features/excluded`）

- 头部：标题「已排除」，副标题「176 张 · 12 条规则」。右侧「添加规则」按钮（Dialog：类型 Segmented 标签 / 文件夹 / 角色，输入目标）。
- 规则列表：每条一行卡片——类型图标（Tag / Folder / User / Image）、label、创建时间、影响张数、4 张预览缩略图叠放（稍微错开旋转，像一叠照片）、「恢复」按钮（`api.deleteExclusion`，带撤销）。按类型分组：规则（标签 / 文件夹 / 角色）在上，单张图片在下（单张的可以用小网格展示 + 多选恢复）。
- 解释文案：「排除的图片不会出现在图库和统计里，文件本身不会被删除。」

## 9. 设置 `/settings`（`features/settings`）

左侧小目录（sticky）+ 右侧分组卡片，分组：

1. **图库文件夹**：列表（路径、张数、上次扫描、启用 `Switch`、移除），「添加文件夹」（输入绝对路径的 Dialog），「立即扫描」按钮。
2. **识别**：模型（只读文本 + 说明）、运行设备（`Segmented` CPU / GPU(DirectML)）、角色阈值 / 通用标签阈值 / 自动采纳阈值（`Slider` + 数值）、批大小。「对全部未识别图片运行识别」。
3. **Danbooru**：启用联网同步 `Switch`、用户名、API Key（password 输入，只写不读，显示「已设置」）、上次同步时间、「立即同步」。
4. **查重**：相似度阈值 `Slider`（汉明距离 0–16，旁边解释「越小越严格」）、「重新查找」。
5. **外观**：主题（跟随系统 / 浅色 / 深色，三张小预览卡片可选）、默认模糊敏感图片、网格密度。
6. **后台任务**：最近任务列表（`useJobs` + `useLiveJobs`）：类型、状态 Badge、进度条、开始时间、取消按钮。
7. **关于**：版本、数据目录、快捷键入口。

设置修改即时保存（`api.updateSettings`，toast「已保存」），滑块松手时才保存。

## 10. 全局浮层（`components/overlays`）

### 命令面板 ⌘K（`CommandPalette.tsx`）

- 用 `cmdk`。宽 600px，顶部 18vh，大输入框（「跳到角色、作品、标签…」），结果分组：角色（`ChipAvatar` 封面 + 名字 + 作品 + 张数）、作品、标签、命令（前往各页面、切换模糊、切换主题、运行识别、查找重复）。
- `useSearch(q)`，输入为空时显示「最近访问的角色」（localStorage 记录最近 8 个）和常用命令。
- 选中角色 → 导航 `/characters/:id`；作品 → `/works/:id`；标签 → `/gallery?q=tag`。
- 底部一行快捷键提示：↑↓ 选择 · ↵ 打开 · Esc 关闭。

### 帮助面板（`HelpDialog.tsx`）

两列快捷键表（全局 / 看图器 / 未识别 / 重复），用 `Kbd`；下方一句「Emaki 是本地应用，图片不会上传到任何地方」。

---

## 实现备注与已知待办

### Tailwind v4 的坑（已踩过）

- `scale-*` / `translate-*` / `rotate-*` 设置的是**独立的** CSS 属性 `scale` / `translate` / `rotate`，不是 `transform`。写过渡要用 `transition-[scale,...]`；写 `transition-[transform]` 不会有动画。
- `cn()` 只拼接、不做 tailwind-merge。给组件传覆盖类（比如给 `Skeleton` 传 `rounded-full`）时，谁生效取决于 CSS 生成顺序。需要覆盖时用 `!` 后缀（`rounded-full!`），或给组件加显式 prop。
- 颜色 token 是 `@theme inline`，工具类直接引用 `var(--c-*)`，所以任何子树写 `data-theme="light|dark"` 都能局部换肤（设置页的主题预览就是这样做的）。

### 需要后端配合的改进（T21 已逐条处置）

| 页面 | 现状 | 建议 | 处置（T21） |
| --- | --- | --- | --- |
| 角色 / 首页 | 「能对上 Danbooru」只有一个数字，不知道是哪几个角色 | `Character` 加 `matchableDanbooruTag: string \| null`，或 `GET /api/characters?matchable=true` | 暂不做：点击仍跳 `/characters?source=custom` |
| 角色 | 「最近在收」的角色数要多发一个请求 | `LibraryStats` 加 `recentCharacterCount` | 暂不做（本地请求很便宜） |
| 未识别 | 「其中 N 张有建议」只能从已加载的数据里数 | `ListUnrecognizedResponse` 加 `suggestedCount` | **已做**：副标题读 `suggestedCount` |
| 未识别 | 需要新建角色的建议不能批量采纳 | 批量 accept 接口 | 暂不做（前端逐张调用） |
| 重复 | 「全部按推荐处理」是逐组调用，撤销也是逐个 | `POST /api/duplicates/resolve-all`，返回单个 undoToken | 暂不做：真实数据的 resolve 本来就不可撤销，文案已改 |
| 重复 | 已处理的组不知道当时保留了哪张 | `DuplicateGroup` 加 `keptIds`、`resolvedAt` | 暂不做 |
| 已排除 | 预览图只有 id，每张都要单独请求详情拿分级和主色 | `Exclusion.previewImages: { id, rating, dominantColor }[]` | 暂不做；T22 若发现请求过多再加 |
| 设置 | 版本号、数据目录写死在前端 | `GET /api/about` | **已做**：用 `/api/health` 的 `version` / `dataDir`（`useHealth`） |
| 设置 | 添加文件夹只能手输路径 | 后端校验路径存在；可选的原生文件夹选择接口 | **已做**：`POST /api/system/pick-folder`，「浏览…」按钮 |
| 设置 | 选 GPU 时不知道 DirectML 是否可用 | 设置里带上 `tagger.availableDevices` | 暂不做：DirectML 不可用时自动回退 CPU，任务消息里说明 |
| 首页 / 设置 | `startJob` 返回 `Job` 而不是 `MutationResult`，页面里各自包了一层 | 在 `lib/queries.ts` 加统一的 `useStartJob` | **已做** |

### 纯前端的小待办

- 看图器：缩略图胶片条（合集阅读器已有，看图器还没有）。
- 「设为封面」之后可以拖动选择焦点（`coverFocus`）。
- 设置里的 `ui.blurSensitive` / `ui.density` 只在修改时写进 `usePrefs`，新浏览器首次打开不会读服务端默认值（可以加一个 PrefsSync）。
- 「最近访问 / 最近使用」的角色存的是 localStorage 快照，角色被合并或删除后不会自动清掉。
- 网格缩略图很多时会占满浏览器对同一域名的 6 个 HTTP/1.1 连接，看图器的原图要排队（真实后端可以考虑 HTTP/2，或给原图加 `fetchpriority="high"`）。

