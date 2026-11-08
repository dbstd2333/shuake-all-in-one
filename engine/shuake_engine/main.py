# SPDX-License-Identifier: AGPL-3.0-or-later
"""Engine entry point. Reads the start message and dispatches to an adapter."""
from __future__ import annotations

import importlib
import json
import sys
import traceback
from typing import Any, Callable

from . import __version__, ipc
from .context import Context

# platform id -> module exposing ``ACTIONS: dict[str, Callable[[Context], Any]]``
PLATFORMS: dict[str, str] = {
    "engine": "shuake_engine.builtin",
    "diagnostic": "shuake_engine.adapters.diagnostic",
    "weban": "shuake_engine.adapters.weban",
    "xuetangx": "shuake_engine.adapters.xuetangx",
    "icve_ai": "shuake_engine.adapters.icve.ai_mooc",
    "icve_mooc": "shuake_engine.adapters.icve.new_mooc",
}


def _read_start() -> dict:
    line = sys.stdin.readline()
    if not line:
        raise ipc.EngineExit(ipc.EXIT_ERROR, "no start message")
    msg = json.loads(line)
    if msg.get("type") != "start":
        raise ipc.EngineExit(ipc.EXIT_ERROR, "first message must be type=start")
    return msg


def run() -> int:
    try:
        start = _read_start()
    except Exception as exc:  # noqa: BLE001
        ipc.error("bad_start", str(exc))
        return ipc.EXIT_ERROR

    ipc.start_reader(sys.stdin)
    ipc.install_patches()
    ctx = Context.from_start(start)
    ipc.set_debug(ctx.debug)
    for key in ("password", "token", "sessionid", "csrftoken", "api_key"):
        ipc.add_secret(str(ctx.credential.get(key) or ""))
    ipc.add_secret(ctx.ai.api_key)

    module_name = PLATFORMS.get(ctx.platform)
    if not module_name:
        ipc.error("unknown_platform", ctx.platform)
        return ipc.EXIT_ERROR
    try:
        module = importlib.import_module(module_name)
        actions: dict[str, Callable[[Context], Any]] = module.ACTIONS
        fn = actions.get(ctx.action)
        if fn is None:
            ipc.error("unknown_action", f"{ctx.platform}.{ctx.action}")
            return ipc.EXIT_ERROR
        ipc.log(f"engine {__version__} · {ctx.platform}.{ctx.action}", "debug")
        data = fn(ctx)
        if data is not None:
            ipc.result(data)
        return ipc.EXIT_OK
    except ipc.Cancelled:
        ipc.log("任务已取消", "warn")
        return ipc.EXIT_CANCELLED
    except ipc.LoginError as exc:
        ipc.error("login_failed", str(exc) or "登录失败")
        return ipc.EXIT_LOGIN
    except ipc.EngineExit as exc:
        if exc.code:
            ipc.error("exit", str(exc))
        return exc.code
    except KeyboardInterrupt:
        return ipc.EXIT_CANCELLED
    except Exception as exc:  # noqa: BLE001
        if ipc.cancel_event.is_set():
            return ipc.EXIT_CANCELLED
        trace = ipc.redact(traceback.format_exc())
        ipc.log(trace, "error")
        ipc.send({"type": "error", "code": type(exc).__name__, "msg": ipc.redact(f"{type(exc).__name__}: {exc}"), "trace": trace})
        return ipc.EXIT_ERROR


def main() -> None:
    code = run()
    try:
        sys.stdout.flush()
    except Exception:  # noqa: BLE001
        pass
    import os

    # Hard exit: upstream code may leave non-daemon threads behind.
    os._exit(code)


if __name__ == "__main__":
    main()
