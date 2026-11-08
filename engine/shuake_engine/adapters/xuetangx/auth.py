# SPDX-License-Identifier: AGPL-3.0-or-later
"""QR-code login and session checks for XuetangX.

Ported from dbstd2333/xuetangx-js (AGPL-3.0).
"""
from __future__ import annotations

import base64
import json
import time
from typing import Any

import requests

from ... import ipc
from ...context import Context
from .api import BASE_URL, USER_AGENT, WS_URL, ApiClient, profile_user
from .utils import as_bool, to_float, to_str

LOGIN_TIMEOUT = 5 * 60
QR_REFRESH_SECONDS = 120
REQUEST_LOGIN = {
    "op": "requestlogin",
    "role": "web",
    "version": "1.4",
    "purpose": "login",
    "xtbz": "xt",
    "x-client": "web",
}


def login(ctx: Context) -> dict:
    return qr_login()


def check(ctx: Context) -> dict:
    credential = ctx.credential or {}
    sessionid = to_str(credential.get("sessionid"))
    csrftoken = to_str(credential.get("csrftoken"))
    if not sessionid:
        return {"valid": False, "user": {}}
    client = ApiClient(sessionid, csrftoken)
    try:
        if not client.check_is_l():
            return {"valid": False, "user": {}}
        return {"valid": True, "user": profile_user(client.basic_profile())}
    except Exception as exc:  # noqa: BLE001
        ipc.log(f"登录状态检查失败: {exc}", "warn")
        return {"valid": False, "user": {}}


def qr_login() -> dict:
    try:
        from websockets.sync.client import connect
    except ImportError as exc:  # pragma: no cover - runtime bundles websockets
        raise ipc.LoginError("缺少 websockets 依赖，无法扫码登录") from exc

    ws = None
    qr_id: str | None = None
    success: dict | None = None
    try:
        try:
            ws = _open_socket(connect)
        except Exception as exc:  # noqa: BLE001
            raise ipc.LoginError(f"无法连接登录服务器: {exc}") from exc

        _send_or_fail(ws)
        deadline = time.monotonic() + LOGIN_TIMEOUT
        qr_deadline: float | None = None

        while success is None:
            ipc.check_cancel()
            now = time.monotonic()
            if now >= deadline:
                raise ipc.LoginError("登录超时（5 分钟），请重试")
            if qr_deadline is not None and now >= qr_deadline:
                if qr_id:
                    ipc.dismiss(qr_id)
                    qr_id = None
                qr_deadline = None
                ipc.log("二维码已过期，正在重新获取", "info")
                _send_or_fail(ws)

            try:
                raw = ws.recv(timeout=1.0)
            except TimeoutError:
                continue
            except Exception as exc:  # noqa: BLE001
                raise ipc.LoginError(f"登录连接中断: {exc}") from exc

            try:
                msg = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if not isinstance(msg, dict):
                continue

            op = msg.get("op")
            if op == "requestlogin":
                ticket = to_str(msg.get("ticket")).strip()
                if not ticket:
                    continue
                if qr_id:
                    ipc.dismiss(qr_id)
                qr_id = ipc.notify("qrcode", _qr_payload(ticket))
                seconds = to_float(msg.get("expire_seconds"), QR_REFRESH_SECONDS)
                qr_deadline = time.monotonic() + (seconds if seconds > 0 else QR_REFRESH_SECONDS)
                ipc.log(
                    f"请使用微信扫描二维码登录（有效期 {int(seconds or QR_REFRESH_SECONDS)} 秒）",
                    "info",
                )
            elif op == "loginsuccess":
                success = msg
    finally:
        if qr_id:
            try:
                ipc.dismiss(qr_id)
            except Exception:  # noqa: BLE001
                pass
        if ws is not None:
            try:
                ws.close()
            except Exception:  # noqa: BLE001
                pass

    assert success is not None
    return _finish_login(success)


def _open_socket(connect: Any) -> Any:
    headers = {"Origin": BASE_URL}
    try:
        return connect(
            WS_URL,
            open_timeout=15,
            close_timeout=5,
            additional_headers=headers,
            user_agent_header=USER_AGENT,
        )
    except TypeError:
        # websockets < 14 uses extra_headers
        return connect(
            WS_URL,
            open_timeout=15,
            close_timeout=5,
            extra_headers=headers,
            user_agent_header=USER_AGENT,
        )


def _send_or_fail(ws: Any) -> None:
    try:
        _send_request_login(ws)
    except Exception as exc:  # noqa: BLE001
        raise ipc.LoginError(f"登录连接中断: {exc}") from exc


def _send_request_login(ws: Any) -> None:
    ws.send(json.dumps(REQUEST_LOGIN, ensure_ascii=False))


def _qr_payload(ticket: str) -> dict:
    payload: dict[str, Any] = {"title": "微信扫码登录", "hint": "请使用微信扫描二维码完成登录"}
    if ticket.startswith(("http://", "https://")):
        payload["url"] = ticket
        try:
            payload["image"] = _download_data_url(ticket)
        except Exception as exc:  # noqa: BLE001
            ipc.log(f"二维码图片下载失败，改用链接渲染: {exc}", "warn")
    else:
        payload["url"] = ticket
    return payload


def _download_data_url(url: str) -> str:
    response = requests.get(url, timeout=20, headers={"User-Agent": USER_AGENT})
    response.raise_for_status()
    data = response.content
    if not data:
        raise ValueError("empty image")
    mime = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if not mime.startswith("image/"):
        mime = _guess_mime(data) or ""
    if not mime:
        raise ValueError("响应不是图片")
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


def _guess_mime(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data.startswith(b"GIF8"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _finish_login(msg: dict) -> dict:
    token = to_str(msg.get("s_s") if msg.get("is_new") else msg.get("token"))
    if not token:
        token = to_str(msg.get("s_s"))
    if not token:
        raise ipc.LoginError("扫码成功但未获取到登录凭证")
    ipc.add_secret(token)

    client = ApiClient()
    try:
        response = client.post("/api/v1/u/login/wx/", {"s_s": token})
    except Exception as exc:  # noqa: BLE001
        raise ipc.LoginError(f"微信登录失败: {exc}") from exc
    if isinstance(response, dict) and "success" in response and not as_bool(response.get("success"), False):
        reason = response.get("msg") or response.get("message") or "接口返回失败"
        raise ipc.LoginError(f"微信登录失败: {reason}")

    sessionid, csrftoken = _read_cookies(client)
    if not sessionid or not csrftoken:
        try:
            client.get("/api/v1/u/login/check_is_l/")
        except Exception:  # noqa: BLE001
            pass
        sessionid = sessionid or _cookie(client, "sessionid")
        csrftoken = csrftoken or _cookie(client, "csrftoken")
    if not csrftoken:
        try:
            client.session.get(BASE_URL + "/", timeout=20)
        except Exception:  # noqa: BLE001
            pass
        csrftoken = _cookie(client, "csrftoken")

    if not sessionid:
        raise ipc.LoginError("登录成功但未获取到 sessionid")
    if not csrftoken:
        raise ipc.LoginError("登录成功但未获取到 csrftoken，请重试")

    ipc.add_secret(sessionid)
    ipc.add_secret(csrftoken)
    ipc.credential({"sessionid": sessionid, "csrftoken": csrftoken})

    authed = ApiClient(sessionid, csrftoken)
    try:
        user = profile_user(authed.basic_profile())
    except Exception as exc:  # noqa: BLE001
        ipc.log(f"获取用户信息失败: {exc}", "warn")
        user = {"id": "", "name": ""}
    return {"user": user}


def _cookie(client: ApiClient, name: str) -> str:
    try:
        return to_str(client.session.cookies.get(name))
    except Exception:  # noqa: BLE001 - CookieConflictError
        for cookie in client.session.cookies:
            if cookie.name == name:
                return to_str(cookie.value)
        return ""


def _read_cookies(client: ApiClient) -> tuple[str, str]:
    return _cookie(client, "sessionid"), _cookie(client, "csrftoken")
