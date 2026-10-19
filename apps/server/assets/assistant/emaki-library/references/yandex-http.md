# Yandex HTTP 搜图参考

适合 harness 有终端或 HTTP 能力时使用。2026-10-19 使用 Python requests 直连 `yandex.ru`，已完成公开测试图的二进制上传与结果页读取；测试图为 OpenCV 的 `samples/data/fruits.jpg`，结果包含水果识别词、不同尺寸及使用该图的 OpenCV 教程网页。此结果验证调用流程，不代表所有插画都能找到出处。

## 调用方法

下面是当日网页脚本使用的流程，属于可能变化的网页接口，不是稳定的官方 API。仅上传本次任务已获授权的图片；不需要登录 Cookie 或 API key。先取得当前页面，再在同一个 Session 中上传图片、读取结果。图片可在本地纠正 EXIF 方向并缩放到最长边不超过 1680 像素，编码为 JPEG；保留原图以便后续核验。

```python
from pathlib import Path
import requests
from bs4 import BeautifulSoup

image_path = Path("authorized-query.jpg")  # 本次授权的 JPEG 查询图
s = requests.Session()
# 仅在已确认该站适合直连、且环境允许时启用。只影响此 Session。
s.trust_env = False
origin = "https://yandex.ru"
home = s.get(origin + "/images/", timeout=(10, 30))
home.raise_for_status()

uploaded = s.post(
    origin + "/images-apphost/image-download",
    params={"images_avatars_size": "preview", "images_avatars_namespace": "images-cbir"},
    data=image_path.read_bytes(),  # 原始二进制，不是 multipart
    headers={"Content-Type": "image/jpeg", "Referer": origin + "/images/"},
    timeout=(10, 40),
)
uploaded.raise_for_status()
info = uploaded.json()
if info.get("type") == "captcha":
    raise RuntimeError("Yandex requires verification; stop this HTTP attempt")
cbir_id = info.get("cbir_id")
if not cbir_id and "image_shard" in info and "image_id" in info:
    cbir_id = f"{info['image_shard']}/{info['image_id']}"
original_url = info.get("sizes", {}).get("orig", {}).get("path")
if not cbir_id or not original_url:
    raise RuntimeError("Unexpected upload response; inspect current page protocol")

result = s.get(
    origin + "/images/search",
    params={"rpt": "imageview", "cbir_id": cbir_id, "url": original_url, "tabInt": "1"},
    timeout=(10, 40),
)
result.raise_for_status()
page = BeautifulSoup(result.content, "html.parser")
print(result.url)
print(page.get_text(" ", strip=True))
```

上传成功应包含新的图片 ID 和图片地址；搜索成功还需要实际读取到候选图片、网站或明确的无结果状态。HTTP 200 也可能是验证页或错误页，不能仅凭状态码宣布搜图成功。解析网页链接时保留标题与目标地址，区分“相似”与“网站中的同图”，继续核验原发布页。

## 网络与接口变化

当日这台机器的 `.ru` 直连成功；其他环境应按当前响应判断。`trust_env=False` 会忽略该 Session 的环境代理配置，下载候选原图或访问其他网站时应分别选择合适路径，不把 Yandex 的直连选择推广到所有域名。超时或临时服务错误可有限重试；验证、认证和限流不要靠循环请求解决。

若上传响应结构或入口变化，可读取当前 `/images/` 与 `/images/search?rpt=imageview` 的公开 HTML 和所引用脚本，查找 `CbirCore` 的上传逻辑；本次入口来自其中的 `image-download` 请求。不要保存并复用旧 Cookie、图片 ID、脚本哈希或验证参数。无法继续时记录卡在首页、上传还是结果读取，换合适的搜图服务。
