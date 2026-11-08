# SPDX-License-Identifier: AGPL-3.0-or-later
"""A fake platform that exercises every IPC message type. Used for testing the
host <-> engine round trip without touching any real website."""
from __future__ import annotations

import base64
import time

from ... import ipc
from ...context import Context

# 1x1 transparent PNG, scaled up by the UI
_PNG = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)).decode()


def login(ctx: Context) -> dict:
    code = ipc.request("captcha_image", {"title": "诊断：输入任意验证码", "image": f"data:image/png;base64,{_PNG}"})
    if not code:
        raise ipc.LoginError("未输入验证码")
    ipc.credential({"token": f"diag-{code}", "saved_at": time.time()})
    return {"user": {"name": ctx.account.get("username") or "诊断用户"}}


def list_courses(ctx: Context) -> dict:
    return {"courses": [{"id": str(i), "name": f"诊断课程 {i}", "progress": i * 10} for i in range(1, 6)]}


def run(ctx: Context) -> dict:
    ids = ctx.options.get("course_ids") or ["1", "2"]
    steps = int(ctx.options.get("steps") or 5)
    for ci, cid in enumerate(ids, 1):
        ipc.event("course_start", id=cid, name=f"诊断课程 {cid}")
        ipc.progress("overall", ci - 1, len(ids), f"课程 {ci}/{len(ids)}")
        for s in range(1, steps + 1):
            ipc.progress("item", s, steps, f"条目 {s}/{steps}", eta=(steps - s) * 0.5)
            ipc.log(f"课程 {cid} 条目 {s} 完成", "info")
            time.sleep(0.5)  # patched: cancellable
        if ctx.options.get("ask") and ci == 1:
            pick = ipc.request("choice", {"title": "诊断：手动答题", "question": "1+1=?", "options": ["1", "2", "3"], "multiple": False})
            ipc.log(f"选择了 {pick}", "success")
        ipc.event("course_done", id=cid)
    ipc.progress("overall", len(ids), len(ids), "完成")
    return {"summary": {"done": len(ids)}}


ACTIONS = {"login": login, "list_courses": list_courses, "run": run}
