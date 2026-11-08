# SPDX-License-Identifier: AGPL-3.0-or-later
"""安全微伴 browser login: the user signs in on the official site in a real
browser window (any method the site offers — password, WeChat, SSO); the
token/userId the site keeps in ``localStorage['user']`` is then read
automatically. No copying from developer tools needed.
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Callable

from ... import ipc
from ...context import Context

LOGIN_URL = "https://weiban.mycourse.cn/#/login"
ORIGIN = "https://weiban.mycourse.cn"
TIMEOUT = 600

READ_USER_JS = "(() => { try { return localStorage.getItem('user') || ''; } catch (e) { return ''; } })()"


def _parse_user(raw: Any) -> dict | None:
    if not raw or not isinstance(raw, str):
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if isinstance(data, dict) and data.get("token") and data.get("userId"):
        return data
    return None


async def _login_async(ctx: Context, validate: Callable[[dict], bool]) -> dict:
    import nodriver  # type: ignore
    from captcha import detect_browser  # type: ignore  (vendor/weban)

    browser_path = ctx.options.get("browser_path") or detect_browser()
    if not browser_path:
        raise ipc.LoginError("未找到 Chrome / Edge 浏览器，无法使用浏览器登录。请安装 Chrome，或在设置中填写浏览器路径。")
    profile = ctx.platform_dir("weban") / "browser-profile"
    profile.mkdir(parents=True, exist_ok=True)

    browser = await nodriver.start(
        headless=False,
        browser_executable_path=browser_path,
        user_data_dir=str(profile),
        browser_args=["--window-size=480,860", "--no-first-run", "--disable-default-apps", "--disable-extensions"],
    )
    notice = ipc.notify("notice", {
        "title": "请在弹出的浏览器中登录安全微伴",
        "message": "已打开安全微伴官网。请像平时一样登录（账号密码或扫码均可），登录成功后程序会自动读取登录信息并关闭该窗口。\n\n不要关闭本对话框以外的窗口；如需放弃请点“取消”。",
    })
    try:
        tab = await browser.get(LOGIN_URL)
        deadline = time.monotonic() + TIMEOUT
        rejected: set[str] = set()
        while True:
            ipc.check_cancel()
            if time.monotonic() > deadline:
                raise ipc.LoginError("等待浏览器登录超时（10 分钟）")
            try:
                raw = await tab.evaluate(READ_USER_JS, return_by_value=True)
            except Exception:  # noqa: BLE001 - page navigating / window closed
                raw = None
                if not browser.tabs:
                    raise ipc.LoginError("浏览器窗口已关闭，登录取消")
            user = _parse_user(raw)
            if user and user["token"] not in rejected:
                if validate(user):
                    return user
                # Stale session from an earlier run: drop it and wait for a fresh login.
                rejected.add(user["token"])
                ipc.log("浏览器中保存的登录已失效，请重新登录", "warn")
                try:
                    await tab.evaluate("localStorage.removeItem('user')")
                    await tab.get(LOGIN_URL)
                except Exception:  # noqa: BLE001
                    pass
            await asyncio.sleep(1)
    finally:
        ipc.dismiss(notice)
        try:
            browser.stop()
        except Exception:  # noqa: BLE001
            pass


def browser_login(ctx: Context, validate: Callable[[dict], bool]) -> dict:
    """Blocks until the user has logged in; returns the site's ``user`` object."""
    return asyncio.run(_login_async(ctx, validate))
