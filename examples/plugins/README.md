# 插件样例

格式见 [docs/plugins.md](../../docs/plugins.md) 第 8 节。一个插件就是一个文件夹，最外层放 `emaki-plugin.json`。

| 样例 | 内容 |
| --- | --- |
| [sort-by-modified](sort-by-modified/) | 只有配置：图片的默认排序改成按修改时间（`override@1`）。图库、别册、角色和作品页，还有手机和 AI 助手拿到的图片列表都跟着变；页面上的排序照旧能换。不要任何权限 |
| [works-chart](works-chart/) | 自己画的一页（`page@1` 视图）：统计、各作品张数，点一行进作品页，排序存在插件存储里。要「读图库」。写视图看它（`index.html`） |
| [random-browse](random-browse/) | 只有配置：侧栏加一个「随便看看」，点进去是按随机排的图库（`nav.item@1`）。不要任何权限 |

两个可以一起装，各管各的。停用或卸载「按修改时间排」，默认排序回到「最近添加」。
几个插件改同一个值时，插件页上会让你选用哪个。

## 怎么装

「插件」页 →「安装…」，三种来源任选一种：

- **文件**：把插件文件夹压成 zip（直接压缩文件夹也行），选这个 zip；
- **文件夹**：填这台电脑上插件文件夹的完整路径。不复制，改了清单以后在插件详情里点「重新读取」，适合写插件的时候用；
- **git 地址**：`https://…`、`ssh://…` 或 `git@主机:路径`，可以指定分支或标签。要这台电脑上装了 git。

装之前会出一张授权单，列出这个插件会做的所有事；点「允许并启用」以后，用的时候不再问。

## 这个版本的 Emaki 能装什么

装的插件现在能贡献：

- `nav.item@1`：侧栏里的一项，指向 Emaki 里的地址（`"to"`，可以带筛选参数，比如 `/gallery?sort=random`），或者自己的一页（`"page": "main"`）；图标从 `house`、`images`、`clock`、`star`、`bookmark`、`folder`、`chart`、`compass`、`download`、`heart`、`puzzle` 这些里选；
- `override@1`：设置注册表里登记过的值，现在只有 `images.defaultSort`（`addedAt`、`modifiedAt`、`fileName`、`bytes`、`random`）；
- `page@1`：自己画的一页（`{ "id": "main", "view": "index.html", "title": "…" }`），地址是 `/p/<插件 id>/<页面 id>`；
- `site@1`：给一个外部网站用的脚本（`{ "id", "title", "url", "matches", "script" }`），在安卓 App 里打开那个网站本身时加载，往网站上加按钮；脚本经 `window.__emakiSite.call(命令, 输入)` 调这个插件自己的命令。`page@1` 写 `"site"` 指向它，在 App 里打开这一页就是打开网站。例子见 Pixiv 浏览的 `site/pixiv.js`；
- 服务端逻辑（清单写 `"server": "server/index.mjs"`）和它的 `command@1`（命令）、`job.kind@1`（后台任务）、`setting@1`（设置、登录凭证），见下面「写服务端逻辑」。

改内部（`permissions.unsafe`）要等以后的版本，清单里用到的话会写明「这个版本的 Emaki 还不支持」，装不上。

Emaki 自己附带一个完整的例子：[plugins/pixiv-browser](../../plugins/pixiv-browser/)（Pixiv 浏览，默认没装，在「插件」页的「附带的」里启用）。

## 写一页视图

视图是 MCP Apps 格式的 HTML，在隔离的框里显示：不能联网、不能直接请求 `/api`，图库的数据经 Emaki 调工具拿（和 AI 助手的工具同一份，按授权过滤）。
最简单的写法见 [works-chart/index.html](works-chart/index.html)：

```html
<script src="/plugin-sdk/app.js"></script>
<script type="module">
  const view = await Emaki.connect({ name: 'my-view', version: '0.1.0' });
  const stats = await view.read('/api/stats');      // read_library：Emaki 的地址
  img.src = await view.thumb(imageId);               // 图片地址
  view.open('/works/1');                             // 跳到 Emaki 的一页
  await view.storage.set('key', value);              // 这个插件自己的存储
  view.onChanged(() => render());                    // 图库变了
</script>
```

- 要读图库就在清单里要 `"permissions": { "scopes": ["read"] }`；要改什么再加对应的范围（授权单上会写出来）。
- 隔离的框里不能提交表单（`<form>` 的提交被浏览器拦下）：搜索框这类用按钮的 `click` 和回车键（`keydown`）。
- 样式用宿主给的 CSS 变量（`--color-background-primary`、`--color-text-primary`、`--font-sans` 这些 MCP Apps 的标准变量），浅色深色都跟着变。
- 同一页在 Claude 这类 MCP Apps 客户端里也能打开（Emaki 的 MCP 里有 `open_view_…` 工具）；那里没有 `open`、`storage`，调用不报错，图片经 `read_media` 取。
- 也可以让 AI 助手做：说「做一个统计页，看……」，它写好以后对话里出一张保存卡片。

## 写服务端逻辑

要联网、下载、在后台跑的，写一段在电脑上运行的程序。清单里写入口（包里的 `.js`、`.mjs` 或 `.cjs`），Emaki 给每个插件起一个单独的 Node 进程：
只能读插件自己的包、只能读写它自己的数据文件夹（`emaki.files.dir`），不能再起别的程序；崩了会记一次错误、自动重启，短时间崩很多次就自动停用，Emaki 照常。

```js
// server/index.mjs
export async function activate(emaki) {
  // 清单 command@1 里登记的命令（名字是 <插件 id>.<名字>），视图、AI 助手、HTTP 都能调
  emaki.commands.handle('search', async ({ word }) => {
    const r = await emaki.fetch(`https://example.com/api?q=${encodeURIComponent(word)}`); // 只能连授权里的域名
    return { items: r.body.items };
  });
  // 后台任务（清单 job.kind@1，要 "background": true）：进 Emaki 的任务列表，进度、取消都一样
  emaki.jobs.register('download', async ({ urls }, job) => {
    job.setTotal(urls.length);
    for (const url of urls) {
      if (job.signal.aborted) throw new Error('取消了');
      const r = await emaki.fetch(url, { saveAs: 'dl/a.jpg' });   // 存进自己的文件夹
      await emaki.library.import({ files: [{ path: r.path }] });  // 放进授权单上选的文件夹（相同的图不再放一份）
      job.advance(1);
    }
    return '下载完了';
  });
  emaki.commands.handle('download', (input) => emaki.jobs.start('download', input));
}
```

- `emaki.call(命令或查询, 输入)`：调 Emaki 的命令和查询，受授权限制，记成这个插件做的（能撤销的照样能撤销）；
- `emaki.fetch(地址, { method, headers, body, json, as, saveAs })`：走 Emaki 的代理设置；`as` 是 `json`、`text`、`bytes`（不写按返回的类型猜）；`saveAs` 直接存成文件；
- `emaki.storage`：键值，和插件的视图共用；`emaki.settings.get(id)`：你在插件详情里填的设置（`setting@1`）；`emaki.secrets`：登录凭证这类，视图读不到；
- `emaki.login.browser({ url, cookieUrl, cookie, pattern })`：要登录的网站，在电脑上开一个浏览器窗口让你在网站自己的登录页登录，返回 `{ done }`，`done` 给登录以后的 Cookie（`cookieUrl` 要在授权的域名里），自己存进 `emaki.secrets`；
- `emaki.files`：自己的文件夹（`dir`、`path(...)`）；`emaki.on('changed', fn)`：图库变了以后旁观（要 `"background": true`）；`emaki.log(...)`：写进 Emaki 的日志。

视图里调自己的命令直接写命令名：`await view.call('my-plugin.search', { word })`。视图不能连外站，外站的图由服务端取到自己的文件夹，
视图用 `view.file('thumbs/a.jpg')` 得到能显示的地址。
