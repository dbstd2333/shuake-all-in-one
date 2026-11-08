# SPDX-License-Identifier: AGPL-3.0-or-later
"""JSON-Lines IPC between the Go host and the Python engine.

Protocol (one JSON object per line, UTF-8):

Host -> engine (stdin)
    {"type": "start", ...}                 first line, see main.py
    {"type": "reply", "id": "...", "value": ...}
    {"type": "cancel"}

Engine -> host (stdout)
    {"type": "log", "level": "info", "msg": "...", "ts": 1700000000.0}
    {"type": "progress", "scope": "overall|course|item", "current": 1, "total": 9, "label": "...", "eta": 120}
    {"type": "event", "name": "...", "data": {...}}
    {"type": "request", "id": "...", "kind": "captcha_image|qrcode|open_url|text|choice|confirm|notice", "payload": {...}}
    {"type": "credential", "data": {...}}
    {"type": "result", "data": {...}}
    {"type": "error", "code": "...", "msg": "..."}

Everything that blocks or talks to the terminal in upstream code is routed through
this module (see ``install_patches``) so that it becomes cancellable and visible
in the GUI.
"""
from __future__ import annotations

import builtins
import itertools
import json
import os
import sys
import threading
import time
from typing import Any, Callable

# --------------------------------------------------------------------------- errors


class Cancelled(BaseException):
    """Raised inside the engine when the host asked to cancel.

    Derives from BaseException so that upstream ``except Exception`` blocks do
    not swallow it.
    """


class EngineExit(Exception):
    """Raised instead of ``sys.exit``/``exit`` from upstream code."""

    def __init__(self, code: int = 0, msg: str = ""):
        super().__init__(msg or f"exit({code})")
        self.code = code


class LoginError(Exception):
    """Login failed; reported to the host with exit code 2."""


EXIT_OK = 0
EXIT_ERROR = 1
EXIT_LOGIN = 2
EXIT_CANCELLED = 3

# --------------------------------------------------------------------------- state

_out_lock = threading.Lock()
_stdout = sys.stdout  # captured before any redirection
cancel_event = threading.Event()
_pending: dict[str, "_Pending"] = {}
_pending_lock = threading.Lock()
_ids = itertools.count(1)
_real_sleep = time.sleep
_reader_started = False


class _Pending:
    __slots__ = ("event", "value")

    def __init__(self) -> None:
        self.event = threading.Event()
        self.value: Any = None


# --------------------------------------------------------------------------- output


def send(obj: dict) -> None:
    line = json.dumps(obj, ensure_ascii=False, default=str)
    with _out_lock:
        _stdout.write(line + "\n")
        _stdout.flush()


def log(msg: str, level: str = "info", **extra: Any) -> None:
    obj = {"type": "log", "level": level, "msg": str(msg), "ts": time.time()}
    if extra:
        obj.update(extra)
    send(obj)


def progress(scope: str, current: int | float, total: int | float, label: str = "", eta: float | None = None, **extra: Any) -> None:
    obj: dict[str, Any] = {"type": "progress", "scope": scope, "current": current, "total": total, "label": label}
    if eta is not None:
        obj["eta"] = eta
    if extra:
        obj.update(extra)
    send(obj)


def event(_name: str, /, **data: Any) -> None:
    send({"type": "event", "name": _name, "data": data})


def credential(data: dict) -> None:
    send({"type": "credential", "data": data})


def result(data: Any) -> None:
    send({"type": "result", "data": data})


def error(code: str, msg: str) -> None:
    send({"type": "error", "code": code, "msg": msg})


# --------------------------------------------------------------------------- input


def _reader_loop(stream) -> None:
    for raw in stream:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        kind = msg.get("type")
        if kind == "cancel":
            cancel_event.set()
            with _pending_lock:
                for p in _pending.values():
                    p.event.set()
        elif kind == "reply":
            with _pending_lock:
                p = _pending.get(str(msg.get("id")))
            if p is not None:
                p.value = msg.get("value")
                p.event.set()
    # stdin closed: the host went away, behave as cancelled.
    cancel_event.set()
    with _pending_lock:
        for p in _pending.values():
            p.event.set()


def start_reader(stream=None) -> None:
    global _reader_started
    if _reader_started:
        return
    _reader_started = True
    t = threading.Thread(target=_reader_loop, args=(stream or sys.stdin,), name="ipc-reader", daemon=True)
    t.start()


def request(kind: str, payload: dict | None = None, timeout: float | None = None) -> Any:
    """Ask the host (i.e. the user) for something and block until it replies.

    Returns the reply value. Raises ``Cancelled`` if the task is cancelled and
    ``TimeoutError`` if ``timeout`` elapses. A reply value of ``None`` means the
    user dismissed the dialog.
    """
    check_cancel()
    rid = f"r{next(_ids)}"
    pending = _Pending()
    with _pending_lock:
        _pending[rid] = pending
    try:
        send({"type": "request", "id": rid, "kind": kind, "payload": payload or {}})
        deadline = None if timeout is None else time.monotonic() + timeout
        while not pending.event.is_set():
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                raise TimeoutError(f"request {kind} timed out")
            pending.event.wait(0.5 if remaining is None else min(0.5, remaining))
        check_cancel()
        return pending.value
    finally:
        with _pending_lock:
            _pending.pop(rid, None)
        send({"type": "request_done", "id": rid})


def notify(kind: str, payload: dict | None = None) -> str:
    """Show a non-blocking request (e.g. a QR code) and return its id.

    Call ``dismiss(id)`` when it is no longer relevant.
    """
    rid = f"n{next(_ids)}"
    send({"type": "request", "id": rid, "kind": kind, "payload": payload or {}, "blocking": False})
    return rid


def dismiss(rid: str) -> None:
    send({"type": "request_done", "id": rid})


# --------------------------------------------------------------------------- cancel


def check_cancel() -> None:
    if cancel_event.is_set():
        raise Cancelled()


def sleep(seconds: float) -> None:
    """Cancellable replacement for ``time.sleep``."""
    if seconds is None or seconds <= 0:
        check_cancel()
        _real_sleep(0)
        return
    if cancel_event.wait(seconds):
        raise Cancelled()


# --------------------------------------------------------------------------- patches


def _patched_input(prompt: str = "") -> str:
    value = request("text", {"prompt": str(prompt).strip() or "请输入"})
    if value is None:
        raise Cancelled()
    return str(value)


def _patched_exit(code: Any = 0) -> None:
    if isinstance(code, int):
        raise EngineExit(code)
    raise EngineExit(1, str(code))


def _image_mime(path: str) -> str | None:
    lower = path.lower()
    for ext, mime in ((".png", "image/png"), (".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".gif", "image/gif"), (".bmp", "image/bmp")):
        if lower.endswith(ext):
            return mime
    return None


def _patched_webbrowser_open(url: str, new: int = 0, autoraise: bool = True) -> bool:
    """Route ``webbrowser.open`` to the host.

    Local images are shown inside the app (they are captcha images in upstream
    code); everything else is opened in the system browser by the host.
    """
    import base64
    from urllib.parse import unquote, urlparse

    path = url
    if url.startswith("file://"):
        path = unquote(urlparse(url).path)
        if os.name == "nt" and path.startswith("/") and len(path) > 2 and path[2] == ":":
            path = path[1:]
    mime = _image_mime(path)
    if mime and os.path.isfile(path):
        with open(path, "rb") as fh:
            data = base64.b64encode(fh.read()).decode()
        notify("image", {"title": "图片", "image": f"data:{mime};base64,{data}"})
        return True
    send({"type": "open_url", "url": url})
    return True


def install_patches() -> None:
    """Make upstream code safe to run headless under the host."""
    import webbrowser

    time.sleep = sleep  # type: ignore[assignment]
    builtins.input = _patched_input  # type: ignore[assignment]
    builtins.exit = _patched_exit  # type: ignore[assignment]
    builtins.quit = _patched_exit  # type: ignore[assignment]
    sys.exit = _patched_exit  # type: ignore[assignment]
    webbrowser.open = _patched_webbrowser_open  # type: ignore[assignment]
    webbrowser.open_new = _patched_webbrowser_open  # type: ignore[assignment]
    webbrowser.open_new_tab = _patched_webbrowser_open  # type: ignore[assignment]
    _install_stdlib_logging()

    # Anything printed by upstream code becomes a log line instead of corrupting
    # the JSON stream.
    sys.stdout = _PrintToLog("info")  # type: ignore[assignment]
    sys.stderr = _PrintToLog("warn")  # type: ignore[assignment]


class _PrintToLog:
    encoding = "utf-8"
    errors = "replace"

    def __init__(self, level: str) -> None:
        self.level = level
        self._buf = ""
        self._lock = threading.Lock()

    def write(self, s: str) -> int:
        with self._lock:
            self._buf += s
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                line = line.rstrip("\r")
                if line.strip():
                    log(_strip_ansi(line), self.level)
        return len(s)

    def flush(self) -> None:
        with self._lock:
            if self._buf.strip():
                log(_strip_ansi(self._buf), self.level)
            self._buf = ""

    def isatty(self) -> bool:
        return False

    def fileno(self) -> int:
        raise OSError("not a real file")


def _strip_ansi(s: str) -> str:
    import re

    return re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", s)


# --------------------------------------------------------------------------- logging bridge

_LEVELS = {"DEBUG": "debug", "INFO": "info", "SUCCESS": "success", "WARNING": "warn", "ERROR": "error", "CRITICAL": "error"}

_redactors: list[Callable[[str], str]] = []


def add_secret(secret: str | None) -> None:
    """Never let ``secret`` appear in log output."""
    if secret and len(secret) >= 6:
        _redactors.append(lambda s, x=secret: s.replace(x, x[:3] + "***"))


def redact(s: str) -> str:
    for r in _redactors:
        s = r(s)
    return s


_debug_enabled = False


def set_debug(enabled: bool) -> None:
    global _debug_enabled
    _debug_enabled = enabled


def emit_log_record(levelname: str, message: str, **extra: Any) -> None:
    level = _LEVELS.get(levelname.upper(), "info")
    if level == "debug" and not _debug_enabled:
        return
    log(redact(_strip_ansi(message)), level, **extra)


def _install_stdlib_logging() -> None:
    import logging

    class Handler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            try:
                emit_log_record(record.levelname, record.getMessage())
            except Exception:  # pragma: no cover
                pass

    root = logging.getLogger()
    root.handlers = [Handler()]
    root.setLevel(logging.DEBUG)


def bridge_loguru() -> None:
    """Replace loguru sinks (used by WeBan) with the IPC sink."""
    try:
        from loguru import logger
    except ImportError:  # pragma: no cover
        return

    def sink(message) -> None:
        rec = message.record
        account = rec["extra"].get("account")
        extra = {"account": account} if account else {}
        emit_log_record(rec["level"].name, rec["message"], **extra)

    logger.remove()
    logger.add(sink, level="DEBUG", format="{message}", enqueue=False, colorize=False)
