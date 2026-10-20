"""Reverse-search one local image the user agreed to upload; send a cleaned query copy, never the original bytes."""

import argparse
import io
import json
from pathlib import Path
import re
import sys
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


ORIGIN = "https://yandex.ru"
QUERY_SIDE = 1280  # 查询图最长边，够搜图用
# PNG 只留画面需要的块；tEXt/iTXt/zTXt/eXIf/tIME、iCCP 等一律不传
PNG_KEEP = {b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"sBIT", b"pHYs", b"acTL", b"fcTL", b"fdAT"}
# WebP 同样只留画面块；"VP8 " 末尾的空格不能少
WEBP_KEEP = {b"VP8 ", b"VP8L", b"VP8X", b"ALPH", b"ANIM", b"ANMF"}
# 扫描数据里 FF00 是转义、FFD0-FFD7 是 RST，其余 FFxx 才是下一个标记
JPEG_NEXT_MARKER = re.compile(rb"\xff[^\x00\xd0-\xd7]")


class SearchError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def strip_jpeg(data):
    """Keep JFIF/Adobe headers, tables and scans; drop APP1-APP13/APP15 (EXIF, GPS, XMP, IPTC, MPF, ICC) and comments."""
    out, i = bytearray(b"\xff\xd8"), 2
    while i + 1 < len(data):
        if data[i] != 0xFF:  # 段之间多出的字节（pixiv 图常见）跳过不传，和解码器一样找下一个标记
            i = data.find(b"\xff", i)
            if i < 0:
                break
            continue
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if marker == 0xD9:  # 结束标记之后的附加数据（多图、动态照片）不上传
            break
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            out += data[i:i + 2]
            i += 2
            continue
        end = i + 2 + int.from_bytes(data[i + 2:i + 4], "big")
        if end > len(data) or end < i + 4:
            raise SearchError("invalid_input", "Malformed JPEG")
        if marker == 0xDA:
            found = JPEG_NEXT_MARKER.search(data, end)
            end = found.start() if found else len(data)
        # APP0 只留 JFIF 头，JFXX 等扩展段可能带缩略图
        if not (0xE1 <= marker <= 0xED or marker in (0xEF, 0xFE) or (marker == 0xE0 and data[i + 4:i + 9] != b"JFIF\0")):
            out += data[i:end]
        i = end
    return bytes(out + b"\xff\xd9")


def strip_png(data):
    out, i = bytearray(data[:8]), 8
    while i + 12 <= len(data):
        kind = data[i + 4:i + 8]
        end = i + 12 + int.from_bytes(data[i:i + 4], "big")
        if kind in PNG_KEEP:
            out += data[i:end]
        i = end
        if kind == b"IEND":
            break
    return bytes(out)


def strip_webp(data):
    # 只走到 RIFF 头声明的长度，后面附加的字节不上传
    chunks, i, stop = [], 12, min(len(data), 8 + int.from_bytes(data[4:8], "little"))
    while i + 8 <= stop:
        kind, size = data[i:i + 4], int.from_bytes(data[i + 4:i + 8], "little")
        end = i + 8 + size + (size & 1)
        if kind in WEBP_KEEP:
            chunk = bytearray(data[i:end])
            if kind == b"VP8X" and len(chunk) > 8:
                chunk[8] &= 0xD3  # 清掉 ICC、EXIF、XMP 标志
            chunks.append(bytes(chunk))
        i = end
    body = b"WEBP" + b"".join(chunks)
    return b"RIFF" + len(body).to_bytes(4, "little") + body


def strip_metadata(data):
    """Drop metadata blocks losslessly; pixels stay as they are."""
    if data.startswith(b"\xff\xd8"):
        return strip_jpeg(data), "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return strip_png(data), "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return strip_webp(data), "image/webp"
    raise SearchError("invalid_input", "Without Pillow only JPEG, PNG or WebP can be cleaned; make a JPEG or PNG copy first")


def query_copy(image):
    """Return (bytes, mime, note) to upload. With Pillow: a downscaled JPEG re-encode. Without: metadata stripped only."""
    data = image.read_bytes()
    if not data:
        raise SearchError("invalid_input", "The query image is empty")
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return (*strip_metadata(data), "metadata stripped; not downscaled (Pillow not installed)")
    with Image.open(io.BytesIO(data)) as source:
        picture = ImageOps.exif_transpose(source)  # 第一帧，按 EXIF 方向摆正
    picture.thumbnail((QUERY_SIDE, QUERY_SIDE))
    if picture.mode != "RGB":
        rgba = picture.convert("RGBA")
        picture = Image.new("RGB", rgba.size, "white")
        picture.paste(rgba, mask=rgba.getchannel("A"))
    picture.info.clear()  # 不把原图的 EXIF、ICC、注释带进新文件
    out = io.BytesIO()
    picture.save(out, "JPEG", quality=90)
    # 重新编码的结果也再过一遍，保证上传的字节里没有元数据段
    return (*strip_metadata(out.getvalue()), f"re-encoded JPEG, longest side <= {QUERY_SIDE}px, no metadata")


def check_response(response):
    """A verification page can have HTTP 200; do not treat it as search results."""
    if response.status_code in (401, 403, 429):
        raise SearchError("access_limited", f"HTTP {response.status_code}; try another search service")
    response.raise_for_status()
    # JSON upload replies are checked by the caller; avoid interpreting them as HTML.
    page = BeautifulSoup(b"" if response.content.lstrip().startswith((b"{", b"[")) else response.content, "html.parser")
    title = page.title.get_text(" ", strip=True).lower() if page.title else ""
    if ("showcaptcha" in response.url.lower()
            or page.select_one('form[action*="showcaptcha"], form[action*="checkcaptcha"]')
            or any(word in title for word in ("captcha", "are you not a robot", "ой!", "ой,"))):
        raise SearchError("verification_required", "Yandex requests verification; try another search service")
    return page


def summarize(page, base_url):
    """Return navigation clues, not a claim that any link is the original source."""
    links, seen = [], set()
    for anchor in page.select("a[href]"):
        url = urljoin(base_url, anchor["href"])
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or url in seen:
            continue
        seen.add(url)
        # Keep full HTML too: dynamic result data may not appear in anchor tags.
        if len(links) < 80:
            links.append({"title": anchor.get_text(" ", strip=True)[:300], "url": url})
    for element in page.select("script, style, noscript"):
        element.decompose()
    return {"text": page.get_text(" ", strip=True)[:12000], "links": links}


def search(session, image, out, timeout=40):
    out.mkdir(parents=True, exist_ok=True)
    stage = "input"
    result = {"status": "error", "stage": stage}
    try:
        payload, mime, query_note = query_copy(image)
        stage = "home"
        check_response(session.get(ORIGIN + "/images/", timeout=(10, timeout)))
        stage = "upload"
        response = session.post(
            ORIGIN + "/images-apphost/image-download",
            params={"images_avatars_size": "preview", "images_avatars_namespace": "images-cbir"},
            data=payload,
            headers={"Content-Type": mime, "Referer": ORIGIN + "/images/"},
            timeout=(10, timeout),
        )
        check_response(response)
        info = response.json()
        if not isinstance(info, dict):
            raise SearchError("protocol_changed", "Upload response is not an object")
        if info.get("type") == "captcha":
            raise SearchError("verification_required", "Yandex requests verification; try another search service")
        cbir_id = info.get("cbir_id")
        if not cbir_id and "image_shard" in info and "image_id" in info:
            cbir_id = f"{info['image_shard']}/{info['image_id']}"
        original = info.get("sizes", {}).get("orig", {}).get("path")
        if not cbir_id or not original:
            raise SearchError("protocol_changed", "Upload returned no image ID or original image URL")
        stage = "results"
        response = session.get(
            ORIGIN + "/images/search",
            params={"rpt": "imageview", "cbir_id": cbir_id, "url": original, "tabInt": "1"},
            timeout=(10, timeout),
        )
        html_path = out / "results.html"
        html_path.write_bytes(response.content)
        page = check_response(response)
        result = {
            "status": "page_received", "stage": stage, "result_url": response.url, "uploaded": query_note,
            "html_path": str(html_path.resolve()), **summarize(page, response.url),
            "note": "Inspect candidates and verify the source image; page_received does not mean a match was found.",
        }
    except (SearchError, requests.RequestException, OSError, ValueError, TypeError, AttributeError) as error:
        result = {"status": getattr(error, "status", "error"), "stage": stage, "error": str(error)}
    (out / "summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="Local image the user agreed to upload; only a cleaned copy is sent")
    parser.add_argument("--out", required=True, type=Path, help="Separate output folder for this query")
    route = parser.add_mutually_exclusive_group()
    route.add_argument("--direct", action="store_true", help="Ignore environment proxies for this Yandex session")
    route.add_argument("--proxy", help="Explicit existing proxy URL; otherwise use the environment")
    parser.add_argument("--timeout", type=float, default=40, help="Read timeout in seconds per request (default: 40)")
    parser.add_argument("--query-only", action="store_true", help="Only write the cleaned query copy into --out (e.g. for other search sites); no network")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if args.query_only:
        try:
            payload, mime, note = query_copy(args.image)
        except (SearchError, OSError, ValueError) as error:
            print(json.dumps({"status": getattr(error, "status", "error"), "error": str(error)}, ensure_ascii=False))
            return 1
        args.out.mkdir(parents=True, exist_ok=True)
        saved = args.out / ("query" + {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[mime])
        saved.write_bytes(payload)
        print(json.dumps({"status": "query_saved", "path": str(saved.resolve()), "mime": mime, "note": note}, ensure_ascii=False))
        return 0
    with requests.Session() as session:
        session.trust_env = not (args.direct or args.proxy)
        if args.proxy:
            session.proxies.update({"http": args.proxy, "https": args.proxy})
        # Only retry page reads once. Uploads, verification, auth and rate limits are not retried.
        session.mount("https://", HTTPAdapter(max_retries=Retry(
            total=1, connect=0, read=0, status=1, other=0,
            allowed_methods={"GET"}, status_forcelist=[502, 503, 504],
            respect_retry_after_header=False, backoff_factor=0.5,
        )))
        result = search(session, args.image, args.out, args.timeout)
    print(json.dumps({key: value for key, value in result.items() if key not in ("text", "links")}, ensure_ascii=False))
    print(f"Read details: {(args.out / 'summary.json').resolve()}")
    return 0 if result["status"] == "page_received" else 1


if __name__ == "__main__":
    sys.exit(main())
