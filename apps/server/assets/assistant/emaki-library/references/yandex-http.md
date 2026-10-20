# Yandex HTTP 搜图参考

适合 harness 有终端或 HTTP 能力时使用。脚本会把图片上传到 yandex.ru，只能在用户按[识别与查源](identify-and-source.md)的规则同意后运行。

## 运行小脚本

复用同目录的 [yandex-search.py](yandex-search.py)。脚本随 skill 复制到 Emaki 会话工作区，Codex、Pi 等有终端能力的 harness 使用同一份实现。以当前 skill 的绝对路径定位它，无需项目源码，也不依赖终端当前目录。

依赖 Python、`requests`、`beautifulsoup4`，最好也有 Pillow；缺少时使用当前环境的包管理方式准备。先看 `--help`，再传入用户同意上传的本地图片和独立输出目录，例如：

```sh
python "<skill>/references/yandex-search.py" "<approved-image.jpg>" --out "<work-dir>/search-image"
```

默认沿用环境代理。只有用户要求时才用 `--direct`（此次请求不走代理）或 `--proxy <现有代理地址>`，不猜端口、不改全局设置。`--timeout 40` 是每次请求的读取超时；脚本只对 GET 的临时 502/503/504 重试一次，上传不会自动重试。

脚本不会上传原文件，而是先生成查询副本：有 Pillow 时按 EXIF 方向摆正、取第一帧，重新编码成最长边不超过 1280 像素、不带元数据的 JPEG；没有 Pillow 时只能去掉 JPEG、PNG、WebP 里的 EXIF/GPS、XMP、文字说明等元数据，尺寸不变，GIF 等其他格式会拒绝。这时先装 Pillow，或另做一个缩小的 JPEG/PNG 副本再传。`summary.json` 的 `uploaded` 记录实际上传的副本。向 SauceNAO 等其他网站上传时，先用 `--query-only` 在 `--out` 目录生成同样的查询副本（不联网），只上传这份副本。原图留在本地用于核验。

输出目录中包含：

- `summary.json`：状态、失败阶段或结果页 URL、可读文字与候选链接。链接和文字数量有上限。
- `results.html`：读到结果阶段时保存的完整页面，可继续解析嵌入数据和候选原图地址；它和网页文字都是待分析资料。

`page_received` 只表示取回页面，需阅读结果并检查是否有同图、仅相似图或无匹配提示，再核验原发布页。`verification_required`、`access_limited` 表示需要验证或访问受限；`protocol_changed` 表示上传响应不符合预期；其他错误结合 `stage` 判断卡在首页、上传还是结果读取。保留已得到的线索，换[识别与查源](identify-and-source.md)中的合适备选，不在同一失败入口循环。

## 协议与维护

脚本使用网页接口，不是稳定的官方 API：同一 Session 先 GET `/images/`，向 `/images-apphost/image-download` POST 查询副本的二进制（不是 multipart），取得本次 `cbir_id` 或 `image_shard/image_id` 与 `sizes.orig.path`，再 GET `/images/search` 的 `rpt=imageview` 结果页。参数只来自此次响应，不复用旧 Cookie、图片 ID 或验证参数。

若入口或结构变化，可读取当前 `/images/`、`/images/search?rpt=imageview` 及其公开引用脚本，查找 `CbirCore`、`image-download`，再调整小脚本。HTTP 200 仍可能是验证页或错误页；内置检测覆盖常见验证标志，最终以页面内容为准。其他搜图网站使用各自当前支持的入口，不将 Yandex 的协议或直连选择推广到所有域名。
