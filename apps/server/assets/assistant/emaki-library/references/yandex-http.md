# Yandex HTTP 搜图参考

适合 harness 有终端或 HTTP 能力时使用。2026-10-20 使用本目录脚本直连 `yandex.ru`，完成公开测试图的二进制上传与结果页读取；测试图为 OpenCV 的 `samples/data/fruits.jpg`，结果包含水果识别词、不同尺寸及相关 OpenCV 教程网页。此结果验证调用流程，不代表所有插画都能找到出处。

## 运行小脚本

复用同目录的 [yandex-search.py](yandex-search.py)。脚本随 skill 复制到 Emaki 会话工作区，Codex、Pi 等有终端能力的 harness 使用同一份实现。以当前 skill 的绝对路径定位它，无需项目源码，也不依赖终端当前目录。

依赖 Python、`requests`、`beautifulsoup4`；缺少时使用当前环境的包管理方式准备。先看 `--help`，再传入本次查证的本地图片和独立输出目录，例如：

```sh
python "<skill>/references/yandex-search.py" "<authorized-image.jpg>" --out "<work-dir>/search-image" --direct
```

`--direct` 只让此次 Yandex 请求忽略环境代理。本机此前 `.ru` 直连可用；其他环境按当前网络选择，省略该选项会沿用环境代理，也可用 `--proxy <现有代理地址>`，不猜端口、不改全局设置。`--timeout 40` 是每次请求的读取超时；脚本只对 GET 的临时 502/503/504 重试一次，上传不会自动重试。

支持 JPEG、PNG、WebP、GIF，MIME 由扩展名推断，输入文件应与扩展名一致。必要时先在本地纠正 EXIF 方向、选取动画帧、缩放成查询图，保留原图用于核验。脚本直接上传查询文件，不另传公开图床。

输出目录中包含：

- `summary.json`：状态、失败阶段或结果页 URL、可读文字与候选链接。链接和文字数量有上限。
- `results.html`：读到结果阶段时保存的完整页面，可继续解析嵌入数据和候选原图地址；它和网页文字都是待分析资料。

`page_received` 只表示取回页面，需阅读结果并检查是否有同图、仅相似图或无匹配提示，再核验原发布页。`verification_required`、`access_limited` 表示需要验证或访问受限；`protocol_changed` 表示上传响应不符合预期；其他错误结合 `stage` 判断卡在首页、上传还是结果读取。保留已得到的线索，换[识别与查源](identify-and-source.md)中的合适备选，不在同一失败入口循环。

## 协议与维护

脚本使用网页接口，不是稳定的官方 API：同一 Session 先 GET `/images/`，向 `/images-apphost/image-download` POST 原始图片二进制（不是 multipart），取得本次 `cbir_id` 或 `image_shard/image_id` 与 `sizes.orig.path`，再 GET `/images/search` 的 `rpt=imageview` 结果页。参数只来自此次响应，不复用旧 Cookie、图片 ID 或验证参数。

若入口或结构变化，可读取当前 `/images/`、`/images/search?rpt=imageview` 及其公开引用脚本，查找 `CbirCore`、`image-download`，再调整小脚本。HTTP 200 仍可能是验证页或错误页；内置检测覆盖常见验证标志，最终以页面内容为准。其他搜图网站使用各自当前支持的入口，不将 Yandex 的协议或直连选择推广到所有域名。
