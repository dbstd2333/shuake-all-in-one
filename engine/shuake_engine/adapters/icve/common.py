# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared helpers for the ICVE adapters: vendor path, logger bridge, payload parsing."""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any

from ... import ipc

_VENDOR_INSERTED: str | None = None


def default_vendor_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "vendor" / "mooc_work_answer"


def ensure_vendor(vendor_dir: str | Path | None = None) -> Path:
    """Put ``vendor/mooc_work_answer`` first on sys.path (upstream uses top-level imports)."""
    global _VENDOR_INSERTED
    path = Path(vendor_dir) if vendor_dir else default_vendor_dir()
    value = str(path)
    if _VENDOR_INSERTED != value:
        while value in sys.path:
            sys.path.remove(value)
        sys.path.insert(0, value)
        _VENDOR_INSERTED = value
    return path


def _ipc_logger_class(debug: bool):
    class IpcLogger:
        """Replacement for ``MoocMain.log.Logger``: stdlib logger only, no files/handlers."""

        def __init__(self, name: str):
            self.logger = logging.getLogger(name)
            self.logger.setLevel(logging.DEBUG if debug else logging.INFO)
            self.logger.propagate = True
            for handler in list(self.logger.handlers):
                self.logger.removeHandler(handler)

        def get_log(self):
            return self.logger

    return IpcLogger


def install_logger(debug: bool = False) -> None:
    """Monkeypatch ``MoocMain.log.Logger`` before any vendor module imports it."""
    import MoocMain.log as log_module  # noqa: PLC0415 - must run after ensure_vendor

    log_module.Logger = _ipc_logger_class(debug)  # type: ignore[assignment]
    # Upstream passes stray arguments to logging calls; never spew tracebacks to stderr.
    logging.raiseExceptions = False


def prepare(vendor_dir: str | Path | None = None, debug: bool = False) -> Path:
    path = ensure_vendor(vendor_dir)
    install_logger(debug)
    return path


def unwrap_payload(data: Any) -> Any:
    """Mirror upstream ``parse_response``: unwrap ``{code:200,data:...}`` envelopes."""
    if isinstance(data, dict) and "code" in data:
        if data.get("code") == 200:
            return data.get("data", data)
        return None
    return data


def parse_percent(value: Any) -> int | None:
    """Parse ``"12%"`` / ``12.3`` into an int 0-100; return None when not a percentage."""
    if value is None or value == "":
        return None
    try:
        number = float(str(value).strip().rstrip("%"))
    except (TypeError, ValueError):
        return None
    if 0 <= number <= 100:
        return int(number)
    return None


def user_summary(info: dict | None) -> dict:
    info = info or {}
    return {
        "id": str(info.get("id") or info.get("userId") or info.get("userName") or ""),
        "name": str(info.get("displayName") or info.get("userName") or info.get("nickName") or ""),
    }


def check_cancel() -> None:
    ipc.check_cancel()
