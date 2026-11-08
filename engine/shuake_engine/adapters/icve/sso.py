# SPDX-License-Identifier: AGPL-3.0-or-later
"""ICVE SSO login: local callback server bound to 127.0.0.1 only."""
from __future__ import annotations

import random
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from ... import ipc

AUTH_URL = "https://sso.icve.com.cn/sso/auth?mode=simple&source=2&redirect={redirect}"
TIMEOUT = 300

_SUCCESS_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>登录成功</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f7fa;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#fff;border-radius:16px;padding:40px 56px;text-align:center;
box-shadow:0 12px 40px rgba(0,0,0,.08)}h1{color:#18a058;font-size:24px;margin:0 0 12px}
p{color:#666;margin:0}</style></head>
<body><div class="box"><h1>登录成功</h1><p>可以关闭此页面，返回应用继续操作。</p></div></body></html>"""

_WAITING_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>等待登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,'PingFang SC',sans-serif;padding:40px;color:#333">
<h3>智慧职教登录服务</h3><p>请回到应用，在浏览器中完成登录。</p></body></html>"""

# 浏览器不会把 URL fragment 发给服务器；用 JS 把它转成 query 后重新请求 /login。
_RELAY_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>正在确认登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,'PingFang SC',sans-serif;padding:40px;color:#333">
<h3 id="title">正在确认登录信息…</h3><p id="msg">如果长时间没有反应，请返回登录页面重试。</p>
<script>
(function () {
  var query = new URLSearchParams(window.location.search);
  if (query.get('token')) { return; }
  var hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  var token = hash.get('token') || hash.get('access_token');
  if (token) {
    window.location.replace('/login?token=' + encodeURIComponent(token));
  } else {
    document.getElementById('title').textContent = '未获取到登录凭证';
    document.getElementById('msg').textContent = '请返回登录页面重新登录。';
  }
})();
</script></body></html>"""

_NOT_FOUND_HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>页面不存在</title></head><body style="font-family:sans-serif;padding:40px">
<h3>页面不存在</h3></body></html>"""


class _CallbackHandler(BaseHTTPRequestHandler):
    owner: "SsoCallbackServer"

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        parsed = urlparse(self.path)
        if parsed.path in ("", "/"):
            self._send(200, _WAITING_HTML)
        elif parsed.path == "/login":
            token = (parse_qs(parsed.query).get("token") or [""])[0]
            if token:
                self.owner.set_token(token)
                self._send(200, _SUCCESS_HTML)
            else:
                self._send(200, _RELAY_HTML)
        else:
            self._send(404, _NOT_FOUND_HTML)

    def _send(self, code: int, body: str) -> None:
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:  # silence default stderr logging
        pass


class SsoCallbackServer:
    """Tiny HTTP server that receives ``/login?token=...`` on 127.0.0.1."""

    def __init__(self) -> None:
        self.token: str | None = None
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._token_event = threading.Event()

    @property
    def port(self) -> int:
        if not self._server:
            raise RuntimeError("server not started")
        return int(self._server.server_address[1])

    @property
    def host(self) -> str:
        if not self._server:
            raise RuntimeError("server not started")
        return str(self._server.server_address[0])

    @property
    def auth_url(self) -> str:
        return AUTH_URL.format(redirect=f"http://localhost:{self.port}/login")

    def set_token(self, token: str) -> None:
        if not self.token:
            self.token = token
            self._token_event.set()

    def start(self) -> str:
        handler = type("Handler", (_CallbackHandler,), {"owner": self})
        last_error: Exception | None = None
        seen: set[int] = set()
        for _ in range(200):
            port = random.randint(30000, 65535)
            if port in seen:
                continue
            seen.add(port)
            try:
                server = ThreadingHTTPServer(("127.0.0.1", port), handler)
            except OSError as exc:
                last_error = exc
                continue
            server.daemon_threads = True
            self._server = server
            self._thread = threading.Thread(
                target=server.serve_forever, kwargs={"poll_interval": 0.1}, name="icve-sso", daemon=True
            )
            self._thread.start()
            return self.auth_url
        raise ipc.LoginError(f"无法启动本地登录回调服务: {last_error}")

    def wait(self, timeout: float = TIMEOUT) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            ipc.check_cancel()
            if self._token_event.wait(0.5):
                return self.token or ""
        raise ipc.LoginError("智慧职教登录超时，请重试")

    def close(self) -> None:
        server, self._server = self._server, None
        if server is not None:
            server.shutdown()
            server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None


def login(ctx=None, timeout: float = TIMEOUT) -> str:
    """Open the SSO page, wait for the browser callback and return the token."""
    server = SsoCallbackServer()
    notice_id: str | None = None
    try:
        url = server.start()
        notice_id = ipc.notify(
            "notice",
            {
                "title": "请在浏览器中登录智慧职教",
                "message": "登录完成后应用会自动继续；若浏览器没有打开，请手动访问下面的地址。",
                "url": url,
            },
        )
        try:
            webbrowser.open(url)
        except Exception as exc:  # noqa: BLE001
            ipc.log(f"无法自动打开浏览器: {exc}", "warn")
        ipc.log("已打开智慧职教登录页面，等待浏览器回调…", "info")
        token = server.wait(timeout)
        if not token:
            raise ipc.LoginError("未获取到智慧职教登录凭证")
        ipc.add_secret(token)
        return token
    finally:
        if notice_id:
            ipc.dismiss(notice_id)
        server.close()
