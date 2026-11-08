# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tolerant JSON value helpers for the XuetangX API.

Ported from dbstd2333/xuetangx-js (AGPL-3.0).
"""
from __future__ import annotations

from typing import Any

_FALSE_VALUES = {"0", "false", "no", "off", "none", "null", ""}


def to_int(value: Any, default: int = 0) -> int:
    try:
        if isinstance(value, bool):
            return int(value)
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        if isinstance(value, bool):
            return float(value)
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def to_str(value: Any) -> str:
    return "" if value is None else str(value)


def as_number(value: Any, default: Any = 0) -> Any:
    """Return an int/float when possible, otherwise the original value."""
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else value
    text = str(value).strip()
    try:
        return int(text)
    except ValueError:
        try:
            number = float(text)
        except ValueError:
            return value
        return int(number) if number.is_integer() else number


def as_bool(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() not in _FALSE_VALUES


def as_list(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def percent(value: Any) -> float:
    """Normalize an API progress value to 0-100."""
    number = to_float(value, -1)
    if number < 0:
        return -1.0
    if number <= 1:
        number *= 100
    return round(number, 1)
