# SPDX-License-Identifier: AGPL-3.0-or-later
"""icve_mooc: 智慧职教新版 MOOC 学院 (mooc.icve.com.cn)."""
from __future__ import annotations

from typing import Any

import requests

from ... import ipc
from ...context import Context
from . import common, sso

DEFAULT_REPLIES = ["好", "加油", "积极响应"]
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
)
_module = None


def _prepare(ctx: Context):
    global _module
    common.prepare(ctx.vendor_dir / "mooc_work_answer", ctx.debug)
    if _module is None:
        import NewMoocMain.init_mooc as init_mooc

        _module = init_mooc
    return _module


def _token(ctx: Context) -> str:
    token = str(ctx.credential.get("token") or ctx.credential.get("sso_token") or "")
    if not token:
        raise ipc.LoginError("未登录或登录凭证已失效，请先登录")
    ipc.add_secret(token)
    return token


def _new_session(init_mooc, token: str) -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    session.cookies.set("token", token)
    init_mooc.session = session  # openLearnResItem 等函数使用模块级 session
    return session


def _verify(init_mooc, session: requests.Session, token: str) -> None:
    init_mooc.load_mooc(session, token)
    try:
        text = init_mooc.is_login(session)
    except Exception as exc:  # noqa: BLE001
        raise ipc.LoginError(f"智慧职教 MOOC 登录校验失败: {exc}") from exc
    if not text or "token" not in str(text):
        raise ipc.LoginError("智慧职教 MOOC 登录凭证已失效，请重新登录")


def _user_info(init_mooc, session: requests.Session) -> dict:
    raw = init_mooc.get_user_info(session)
    if isinstance(raw, dict) and raw.get("errorCode") == "A0000":
        data = raw.get("data")
        if isinstance(data, dict):
            return common.user_summary(data)
    return {"id": "", "name": ""}


def login(ctx: Context) -> dict:
    init_mooc = _prepare(ctx)
    token = sso.login(ctx)
    ipc.add_secret(token)
    session = _new_session(init_mooc, token)
    _verify(init_mooc, session, token)
    user = _user_info(init_mooc, session)
    ipc.credential({"token": token})
    return {"user": user}


def check(ctx: Context) -> dict:
    token = str(ctx.credential.get("token") or ctx.credential.get("sso_token") or "")
    if not token:
        return {"valid": False}
    ipc.add_secret(token)
    try:
        init_mooc = _prepare(ctx)
        session = _new_session(init_mooc, token)
        _verify(init_mooc, session, token)
        return {"valid": True, "user": _user_info(init_mooc, session)}
    except ipc.LoginError as exc:
        ipc.log(str(exc), "debug")
        return {"valid": False}
    except Exception as exc:  # noqa: BLE001
        ipc.log(f"检查登录状态失败: {exc}", "warn")
        return {"valid": False}


def list_courses(ctx: Context) -> dict:
    token = _token(ctx)
    init_mooc = _prepare(ctx)
    session = _new_session(init_mooc, token)
    _verify(init_mooc, session, token)
    result = init_mooc.student_mooc_select_mooc_course(session, token, 0) or {}
    courses = []
    for row in result.get("data") or []:
        if not isinstance(row, (list, tuple)) or len(row) < 7:
            continue
        cid = str(row[6] or "")
        if not cid:
            continue
        raw_progress = str(row[15]) if len(row) > 15 else ""
        course = {
            "id": cid,
            "name": str(row[0] or "未命名课程"),
            "extra": {
                "courseName2": row[1],
                "teacher": row[2],
                "raw": raw_progress,
            },
        }
        progress = common.parse_percent(raw_progress)
        if progress is not None:
            course["progress"] = progress
        courses.append(course)
    return {"courses": courses}


def _replies(ctx: Context) -> list[str]:
    raw: Any = ctx.options.get("topic_replies", DEFAULT_REPLIES)
    if isinstance(raw, str):
        raw = [raw]
    return [str(item).strip() for item in (raw or []) if str(item).strip()]


def run(ctx: Context) -> dict:
    token = _token(ctx)
    init_mooc = _prepare(ctx)
    session = _new_session(init_mooc, token)
    _verify(init_mooc, session, token)

    replies = _replies(ctx)
    topic = "#" + "#".join(replies) if replies else None
    ai_enabled = bool(ctx.options.get("ai_answer")) and ctx.ai.enabled
    auto_submit = bool(ctx.options.get("auto_submit"))
    if ai_enabled:
        try:
            from ai.ai_exam_handler import set_ai_config

            set_ai_config(ctx.ai, debug=ctx.debug)
        except Exception as exc:  # noqa: BLE001
            ipc.log(f"AI 答题初始化失败，已关闭: {exc}", "warn")
            ai_enabled = False

    stats = {"courses": 0, "completed": 0}

    def progress_cb(scope: str, current: float, total: float, label: str) -> None:
        ipc.progress(scope, current, total, label)

    def event_cb(name: str, **data: Any) -> None:
        if name == "course_start":
            stats["courses"] += 1
        elif name == "course_done":
            stats["completed"] += 1
        ipc.event(name, **data)

    try:
        init_mooc.run(
            username="",
            password="",
            topic_content=topic,
            jump_content=None,
            type_value=0,
            is_ai_answer=ai_enabled,
            is_auto_submit=auto_submit,
            token=token,
            course_ids=ctx.options.get("course_ids"),
            progress_cb=progress_cb,
            event_cb=event_cb,
        )
    except RuntimeError as exc:
        message = str(exc)
        if "未查询到" in message or "未匹配到" in message:
            ipc.log(message, "warn")
        else:
            raise
    return {"summary": stats}


ACTIONS = {"login": login, "check": check, "list_courses": list_courses, "run": run}
