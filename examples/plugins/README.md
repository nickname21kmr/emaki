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
- `page@1`：自己画的一页（`{ "id": "main", "view": "index.html", "title": "…" }`），地址是 `/p/<插件 id>/<页面 id>`。

服务端代码（`server`）、改内部（`permissions.unsafe`）要等以后的版本，清单里用到的话会写明「这个版本的 Emaki 还不支持」，装不上。

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
- 样式用宿主给的 CSS 变量（`--color-background-primary`、`--color-text-primary`、`--font-sans` 这些 MCP Apps 的标准变量），浅色深色都跟着变。
- 同一页在 Claude 这类 MCP Apps 客户端里也能打开（Emaki 的 MCP 里有 `open_view_…` 工具）；那里没有 `open`、`storage`，调用不报错，图片经 `read_media` 取。
- 也可以让 AI 助手做：说「做一个统计页，看……」，它写好以后对话里出一张保存卡片。
