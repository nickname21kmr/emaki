"""Offline protocol regression checks: python -B scripts/tests/test_yandex_search.py."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

import requests

HELPER = Path(__file__).resolve().parents[2] / "apps/server/assets/assistant/emaki-library/references/yandex-search.py"
spec = importlib.util.spec_from_file_location("yandex_search", HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def response(text, url="https://yandex.ru/images/", status=200):
    result = requests.Response()
    result.status_code = status
    result.url = url
    result._content = text.encode("utf-8")
    return result


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.image = self.root / "query.png"
        self.image.write_bytes(b"fixture image bytes")
        self.session = Mock()
        self.session.get.side_effect = [response("<title>Images</title>"), response(
            '<title>Results</title><a href="https://example.org/source">Source</a><script>hidden</script>',
            "https://yandex.ru/images/search?rpt=imageview",
        )]
        self.session.post.return_value = response(json.dumps({
            "image_shard": "fresh-shard", "image_id": "fresh-id",
            "sizes": {"orig": {"path": "https://example.org/query.png"}},
        }))

    def run_search(self):
        return helper.search(self.session, self.image, self.root / "out")

    def test_binary_upload_and_fresh_result_parameters(self):
        result = self.run_search()
        self.assertEqual(result["status"], "page_received")
        upload = self.session.post.call_args.kwargs
        self.assertEqual(upload["data"], self.image.read_bytes())
        self.assertNotIn("files", upload)
        self.assertEqual(upload["headers"]["Content-Type"], "image/png")
        self.assertEqual(self.session.get.call_args.kwargs["params"]["cbir_id"], "fresh-shard/fresh-id")
        self.assertEqual(result["links"], [{"title": "Source", "url": "https://example.org/source"}])
        self.assertNotIn("hidden", result["text"])
        self.assertIn("hidden", Path(result["html_path"]).read_text())
        self.assertEqual(json.loads((self.root / "out/summary.json").read_text(encoding="utf-8")), result)

    def test_captcha_home_stops_before_upload(self):
        self.session.get.side_effect = [response('<form action="/showcaptcha"></form>')]
        result = self.run_search()
        self.assertEqual((result["status"], result["stage"]), ("verification_required", "home"))
        self.session.post.assert_not_called()

    def test_upload_captcha_stops_before_results(self):
        self.session.post.return_value = response('{"type":"captcha"}')
        self.assertEqual(self.run_search()["status"], "verification_required")
        self.assertEqual(self.session.get.call_count, 1)

    def test_missing_upload_fields_is_not_success(self):
        self.session.post.return_value = response('{}')
        self.assertEqual(self.run_search()["status"], "protocol_changed")
        self.assertEqual(self.session.get.call_count, 1)

    def test_rate_limit_is_not_a_search_result(self):
        self.session.get.side_effect = [response("ok"), response("limited", status=429)]
        result = self.run_search()
        self.assertEqual((result["status"], result["stage"]), ("access_limited", "results"))

    def test_upload_timeout_reports_stage(self):
        self.session.post.side_effect = requests.Timeout("upload timeout")
        result = self.run_search()
        self.assertEqual((result["status"], result["stage"]), ("error", "upload"))
        self.assertEqual(self.session.post.call_count, 1)


if __name__ == "__main__":
    unittest.main()
