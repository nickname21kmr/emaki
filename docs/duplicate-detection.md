# 图片查重

Emaki 保留 64 位 dHash + MIH 快速查找候选，使用 **Pixelmatch 8.0.0** 筛掉整体变化明显的候选，再用 **ssim.js 3.5.0** 核对局部结构。
原来的 256 位细哈希、8×8 颜色复核已移除，不再把哈希距离显示成相似百分比。

## 判定和显示

| 显示 | 条件 |
| --- | --- |
| 文件相同 | 原文件 SHA256 相同，包括动图 |
| 画面相同 | 静态图片统一 EXIF 方向、sRGB、RGBA 后，原尺寸和逐像素数据相同 |
| 疑似缩放 / 压缩副本 | 整体像素差异和局部 SSIM 均通过复核 |
| 疑似重复 | 升级前留下、尚未经过新比较器核对的候选 |

不同尺寸的图片允许缩放舍入造成的一像素比例误差，不做裁剪、拉伸、镜像或特征配准。
精细比较缩到较小图片的尺寸，最长边最多 1024；原尺寸像素相等检查最多处理 32 MiPixels，
更大的图片仍可作为疑似副本，但不会仅凭缩小结果标为画面相同。动图不比较首帧来判断重复。

Pixelmatch 使用颜色阈值 0.15，整体差异最多 0.5%，任一 16×16 窗口最多 28 个不同像素。
这两项颜色检查用于拦住整体改色及小面积明显改色；仅凭颜色容差会漏掉低对比嘴型、泪珠或浅色图案。
通过颜色检查后，以固定 sigma=1 的高斯低通抑制压缩振铃，再计算原始 Gaussian SSIM 地图（11×11、sigma=1.5）。
关闭 SSIM 库默认的自动降采样，分别计算 RGB，按位置平均；透明度变化单独核对。
对得分地图取 4×4 滑动区域的平均值，最差区域至少 0.6 才作为疑似副本；这个地图区域对应约 14×14 原图输入范围。
这里不使用整张图的平均 SSIM 来掩盖局部修改；早期的 16×16 地图区域平均会稀释细小泪珠，已缩小。
这些是 Emaki 的样本校准条件，不是图库识别置信度。`localStructure.ts` 仅负责库调用、通道处理及区域汇总，没有改写 SSIM 公式。

组内每一对都需要通过复核；A 像 B、B 像 C 不能自动推出 A 和 C 重复。
排序字段 `similarity` 仅为兼容 API 保留，表示组内最差一对的 `1 - differentFraction`，不显示为概率。
读取、解码失败的候选不通过复核，也不缓存失败。

## 运行与缓存

后台任务使用一个工作线程串行比较，避免阻塞 HTTP，并限制同时解码的原图数量。
正、负结果都按两份原文件的 SHA256 与比较器版本缓存到 `duplicate_comparisons`。
替换内容后 SHA 改变，旧结果不再命中。修改缩放规则或判定参数时必须更新 `COMPARISON_VERSION`，启动任务链会检查版本并重新核对。
从 v1 升级到当前版时，原尺寸像素相等及已被原有 Pixelmatch 条件排除的结果可复用；原有疑似副本必须重新核对局部结构。
这种复用仅限颜色阈值和预处理保持不变时；以后改动这些条件，必须一并移除或调整 `COMPATIBLE_PIXEL_VERSION`。
取消或让出任务时保留已完成的缓存，重复组只在整轮完成时对账。
已处理、已忽略记录继续保留。升级会清空上次运行时间，使正常启动的任务链重新核对。

## 验证依据

第一版只验证了一个实际表情差分、合成修改和压缩副本，覆盖不足。随后目视检查 25 对真实原图与局部放大，
确认其中 18 对是差分，发现 5 对被 v1 错当副本；6 对不确定样本未参与校准。

当前版固定条件后：

- 上述 18 对及随后确认的 2 对真实差分全部排除，包含嘴型、低对比局部描线、浅色地面标记和背景屏幕图案、细小泪珠。
- 另外 20 对来自不同投稿、在比较前选定并逐图核对的真实差分全部排除。
- 44 对带目视标注的原图回归全部通过（上述差分、保存副本、EXIF、高清/低清与原始睁眼/闭眼例子）。
- 校准用的 96 个缩小一半、JPEG quality 80/95 副本检出 89 个；漏检 7 个。这是识别细微差分的代价，不能把样本结果解释成全图库精度。
- 另抽 24 张新图片生成 48 个独立缩放/压缩副本，检出 44 个；24 个合成局部修改全部排除。

真实回归清单在 `apps/server/test/fixtures/dedupe/real-pairs.json`，只保存原文件 SHA256 和目视标签，不分发图库图片。

可复现命令（只读数据库和原图，测试文件写到指定输出目录）：

```sh
node --import tsx apps/server/scripts/verify-duplicate-comparison.ts <database> <output-directory> [id:id,id:id] [sample-offset]
```

`sample-offset` 为 0 到 1 之间的值，默认 0.5；例如 0.25 可选另一批样本。
真实差分回归命令（同样只读图库，通过 SHA256 查找原图；缺图会报告失败）：

```sh
node --import tsx apps/server/scripts/verify-duplicate-pairs.ts <database> apps/server/test/fixtures/dedupe/real-pairs.json <output-json>
```

自动测试另覆盖低对比条纹、颜色结构、透明度、EXIF、不同编码、局部小修改、裁剪、动图、工作线程、失败读取、缓存升级及分组传递问题。

参考：[Pixelmatch 8 发布说明](https://github.com/mapbox/pixelmatch/releases/tag/v8.0.0)、
[Pixelmatch 接口](https://github.com/mapbox/pixelmatch)、[SSIM 实现](https://github.com/obartra/ssim)、
[Hydrus 的 JPEG 噪声预处理参考](https://github.com/hydrusnetwork/hydrus/blob/db824d4f04970d7148a64e213e22e59cb8442e0d/hydrus/client/files/images/ClientVisualData.py)。
