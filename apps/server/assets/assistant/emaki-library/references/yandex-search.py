"""Search one authorized local image; save the result page for source verification."""

import argparse
import json
import mimetypes
from pathlib import Path
import sys
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


ORIGIN = "https://yandex.ru"


class SearchError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


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
        mime = mimetypes.guess_type(image.name)[0]
        if mime not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
            raise SearchError("invalid_input", "Use a JPEG, PNG, WebP or GIF query image")
        payload = image.read_bytes()
        if not payload:
            raise SearchError("invalid_input", "The query image is empty")
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
            "status": "page_received", "stage": stage, "result_url": response.url,
            "html_path": str(html_path.resolve()), **summarize(page, response.url),
            "note": "Inspect candidates and verify the source image; page_received does not mean a match was found.",
        }
    except (SearchError, requests.RequestException, OSError, ValueError, TypeError, AttributeError) as error:
        result = {"status": getattr(error, "status", "error"), "stage": stage, "error": str(error)}
    (out / "summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="Authorized local query image")
    parser.add_argument("--out", required=True, type=Path, help="Separate output folder for this query")
    route = parser.add_mutually_exclusive_group()
    route.add_argument("--direct", action="store_true", help="Ignore environment proxies for this Yandex session")
    route.add_argument("--proxy", help="Explicit existing proxy URL; otherwise use the environment")
    parser.add_argument("--timeout", type=float, default=40, help="Read timeout in seconds per request (default: 40)")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
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
