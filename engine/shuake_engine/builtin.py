# SPDX-License-Identifier: AGPL-3.0-or-later
"""Engine-level actions: environment check and AI endpoint test."""
from __future__ import annotations

import importlib
import platform
import sys
import time

from . import __version__, ipc
from .ai import AIClient
from .context import Context

MODULES = [
    ("requests", "requests"),
    ("websockets", "websockets"),
    ("loguru", "loguru"),
    ("nodriver", "nodriver"),
    ("numpy", "numpy"),
    ("cv2", "opencv"),
    ("pyaes", "pyaes"),
    ("lxml.etree", "lxml"),
    ("Crypto.Cipher.AES", "pycryptodome"),
]


def env_check(ctx: Context) -> dict:
    mods = []
    for mod, label in MODULES:
        try:
            m = importlib.import_module(mod)
            top = importlib.import_module(mod.split(".")[0])
            mods.append({"name": label, "ok": True, "version": str(getattr(top, "__version__", getattr(m, "__version__", "")))})
        except Exception as exc:  # noqa: BLE001
            mods.append({"name": label, "ok": False, "error": str(exc)})
    browser = None
    try:
        sys.path.insert(0, str(ctx.vendor_dir / "weban"))
        from captcha import detect_browser  # type: ignore

        browser = detect_browser()
    except Exception as exc:  # noqa: BLE001
        ipc.log(f"浏览器检测失败: {exc}", "debug")
    return {
        "engine": __version__,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "platform": platform.platform(),
        "modules": mods,
        "browser": str(browser) if browser else None,
    }


def ai_test(ctx: Context) -> dict:
    if not ctx.ai.base_url or not ctx.ai.model:
        raise ValueError("请先填写 AI 接口地址和模型")
    client = AIClient(ctx.ai)
    started = time.monotonic()
    reply = client.chat([{"role": "user", "content": "只回复两个字：你好"}], max_tokens=20)
    return {"reply": reply, "seconds": round(time.monotonic() - started, 1), "thinking": ctx.ai.thinking or "default"}


ACTIONS = {"env_check": env_check, "ai_test": ai_test}
