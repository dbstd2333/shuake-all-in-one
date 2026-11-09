# SPDX-License-Identifier: AGPL-3.0-or-later
import http.server
import threading
import unittest
import urllib.request

import requests

from shuake_engine import traffic

BODY = b"x" * 50_000


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(n)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


class TrafficTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        traffic.install(start_reporter=False)
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_requests_download_and_upload(self):
        rx0, tx0 = traffic.totals()
        with requests.Session() as s:
            self.assertEqual(len(s.get(self.url).content), len(BODY))
            r = s.get(self.url, stream=True)
            self.assertEqual(sum(len(c) for c in r.iter_content(4096)), len(BODY))
            s.post(self.url, data=b"y" * 20_000)
        rx, tx = traffic.totals()
        self.assertGreaterEqual(rx - rx0, 2 * len(BODY))
        self.assertLess(rx - rx0, 2 * len(BODY) + 2000)  # headers only on top
        self.assertGreaterEqual(tx - tx0, 20_000)

    def test_urllib(self):
        rx0, _ = traffic.totals()
        with urllib.request.urlopen(self.url) as r:
            self.assertEqual(len(r.read()), len(BODY))
        self.assertGreaterEqual(traffic.totals()[0] - rx0, len(BODY))


if __name__ == "__main__":
    unittest.main()
