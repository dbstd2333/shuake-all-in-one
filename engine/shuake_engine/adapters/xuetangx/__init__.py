# SPDX-License-Identifier: AGPL-3.0-or-later
"""XuetangX (学堂在线) platform adapter.

Ported from dbstd2333/xuetangx-js (AGPL-3.0).
"""
from __future__ import annotations

from .auth import check, login
from .course import list_courses
from .runner import run

ACTIONS = {
    "login": login,
    "check": check,
    "list_courses": list_courses,
    "run": run,
}

__all__ = ["ACTIONS"]
