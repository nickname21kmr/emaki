# 插件样例

格式见 [docs/plugins.md](../../docs/plugins.md) 第 8 节。一个插件就是一个文件夹，最外层放 `emaki-plugin.json`。

| 样例 | 内容 |
| --- | --- |
| [random-browse](random-browse/) | 只有配置：侧栏加一个「随便看看」（`nav.item@1`），图片默认按修改时间排（`override@1`）。不要任何权限 |

## 怎么装

「插件」页 →「安装…」，三种来源任选一种：

- **文件**：把插件文件夹压成 zip（直接压缩文件夹也行），选这个 zip；
- **文件夹**：填这台电脑上插件文件夹的完整路径。不复制，改了清单以后在插件详情里点「重新读取」，适合写插件的时候用；
- **git 地址**：`https://…`、`ssh://…` 或 `git@主机:路径`，可以指定分支或标签。要这台电脑上装了 git。

装之前会出一张授权单，列出这个插件会做的所有事；点「允许并启用」以后，用的时候不再问。

## 这个版本的 Emaki 能装什么

装的插件现在只能贡献不跑代码的东西：

- `nav.item@1`：侧栏里的一项，只能指向 Emaki 里的地址（可以带筛选参数，比如 `/gallery?sort=random`）；图标从 `house`、`images`、`clock`、`star`、`bookmark`、`folder`、`chart`、`compass`、`download`、`heart`、`puzzle` 这些里选；
- `override@1`：设置注册表里登记过的值，现在只有 `images.defaultSort`（`addedAt`、`modifiedAt`、`fileName`、`bytes`、`random`）。

自己画界面的视图（`page@1` 的 `view`）、服务端代码（`server`）、改内部（`permissions.unsafe`）要等以后的版本，清单里用到的话会写明「这个版本的 Emaki 还不支持」，装不上。
