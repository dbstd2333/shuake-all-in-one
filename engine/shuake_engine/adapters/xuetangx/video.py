# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fake playback heartbeats for video/audio leaves.

Ported from dbstd2333/xuetangx-js (AGPL-3.0).
"""
from __future__ import annotations

import math
import time
from typing import Any

from ... import ipc
from .api import ApiClient, media_duration
from .utils import as_number, to_float

HEARTBEAT_INTERVAL = 30
HEARTBEAT_SPEED = 2
STEP_SECONDS = HEARTBEAT_INTERVAL * HEARTBEAT_SPEED
CDN_HOST = "qn1-next.xuetangonline.com"

__all__ = ["HEARTBEAT_INTERVAL", "STEP_SECONDS", "make_heartbeat_entry", "media_duration", "simulate_playback"]


def make_heartbeat_entry(
    *,
    et: str,
    cp: float,
    ts: int,
    seq: int,
    user_id: Any,
    course_id: Any,
    leaf_id: Any,
    classroom_id: Any,
    duration: float,
    video_type: str,
    sku_id: Any,
    page_group: str,
) -> dict:
    return {
        "i": HEARTBEAT_INTERVAL,
        "et": et,
        "p": "web",
        "cp": as_number(cp),
        "fp": 0,
        "tp": 0,
        "sp": HEARTBEAT_SPEED,
        "ts": ts,
        "u": as_number(user_id),
        "c": as_number(course_id),
        "v": as_number(leaf_id),
        "classroomid": as_number(classroom_id),
        "cc": "",
        "d": as_number(duration),
        "pg": page_group,
        "sq": seq,
        "t": video_type,
        "lob": "plat2",
        "n": CDN_HOST,
        "skuid": as_number(sku_id),
    }


def simulate_playback(
    client: ApiClient,
    *,
    user_id: Any,
    course_id: Any,
    leaf_id: Any,
    classroom_id: Any,
    duration: float,
    video_type: str,
    sku_id: Any,
    leaf_name: str = "",
    heartbeat_interval: float = 5,
) -> int:
    """Send play -> heartbeats -> videoend. Returns the number of events sent."""
    duration = to_float(duration)
    if duration <= 0:
        return 0

    now_ms = int(time.time() * 1000)
    page_group = f"{leaf_id}_{now_ms}"
    seq = 1
    common = {
        "user_id": user_id,
        "course_id": course_id,
        "leaf_id": leaf_id,
        "classroom_id": classroom_id,
        "duration": duration,
        "video_type": video_type,
        "sku_id": sku_id,
        "page_group": page_group,
    }

    client.send_heartbeat([make_heartbeat_entry(et="play", cp=0, ts=now_ms, seq=seq, **common)])

    cp = 0.0
    while cp < duration:
        cp = min(cp + STEP_SECONDS, duration)
        seq += 1
        client.send_heartbeat(
            [make_heartbeat_entry(et="heartbeat", cp=cp, ts=int(time.time() * 1000), seq=seq, **common)]
        )
        remaining = max(0, math.ceil((duration - cp) / STEP_SECONDS))
        ipc.progress("item", as_number(cp), as_number(duration), leaf_name, eta=remaining * heartbeat_interval)
        ipc.sleep(heartbeat_interval)

    seq += 1
    client.send_heartbeat(
        [make_heartbeat_entry(et="videoend", cp=duration, ts=int(time.time() * 1000), seq=seq, **common)]
    )
    return seq
