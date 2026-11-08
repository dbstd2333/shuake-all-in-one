# SPDX-License-Identifier: AGPL-3.0-or-later
"""icve_ai: 智慧职教 AI 优课 / 常规 MOOC (ai.icve.com.cn)."""
from __future__ import annotations

import logging
from typing import Any

import requests

from ... import ipc
from ...context import Context
from . import common, sso

BASE_URL = "https://ai.icve.com.cn/prod-api"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
)
SKIP_TYPES = {"作业", "考试", "测验", "子节点", "文件夹"}

_api_classes: tuple[type, type] | None = None
_handler_class: type | None = None


def _prepare(ctx: Context) -> None:
    global _api_classes, _handler_class
    common.prepare(ctx.vendor_dir / "mooc_work_answer", ctx.debug)
    if _api_classes is None:
        from AIMoocMain.api import AIMoocApi
        from base.api_client import BaseAPIClient

        _api_classes = (AIMoocApi, BaseAPIClient)
    if _handler_class is None:
        from AIMoocMain.main import AIMoocHandler

        _handler_class = AIMoocHandler


def _new_api(access_token: str):
    assert _api_classes is not None
    api_cls, base_cls = _api_classes
    api = api_cls.__new__(api_cls)
    base_cls.__init__(api, BASE_URL)
    api.token = None
    api.access_token = access_token
    api.username = None
    api.password = None
    api.set_auth_token(access_token)
    return api


def _exchange_access_token(sso_token: str) -> str | None:
    """GET /auth/passLogin?token=... and return the access token."""
    try:
        resp = requests.get(
            f"{BASE_URL}/auth/passLogin",
            params={"token": sso_token},
            headers={"User-Agent": USER_AGENT},
            timeout=30,
        )
        data = common.unwrap_payload(resp.json())
    except (requests.RequestException, ValueError) as exc:
        ipc.log(f"换取 AI 优课访问令牌失败: {exc}", "warn")
        return None
    if isinstance(data, str):
        return data or None
    if isinstance(data, dict):
        return str(data.get("access_token") or data.get("accessToken") or "") or None
    return None


def _user_info(api) -> dict | None:
    info = api.get("/system/baseUser/info")
    if isinstance(info, dict) and (info.get("id") or info.get("userName")):
        return info
    return None


def _api_with_credential(ctx: Context):
    access = str(ctx.credential.get("access_token") or "")
    if not access:
        raise ipc.LoginError("未登录或登录凭证已失效，请先登录")
    ipc.add_secret(access)
    _prepare(ctx)
    api = _new_api(access)
    info = _user_info(api)
    if info is None:
        raise ipc.LoginError("登录凭证已失效，请重新登录")
    return api, info


def login(ctx: Context) -> dict:
    _prepare(ctx)
    sso_token = sso.login(ctx)
    ipc.add_secret(sso_token)
    access = _exchange_access_token(sso_token)
    if not access:
        raise ipc.LoginError("登录成功，但未换取到 AI 优课访问令牌")
    ipc.add_secret(access)
    api = _new_api(access)
    info = _user_info(api)
    if info is None:
        raise ipc.LoginError("登录成功，但获取用户信息失败")
    ipc.credential({"sso_token": sso_token, "access_token": access})
    return {"user": common.user_summary(info)}


def check(ctx: Context) -> dict:
    try:
        _api, info = _api_with_credential(ctx)
    except ipc.LoginError as exc:
        ipc.log(str(exc), "debug")
        return {"valid": False}
    except Exception as exc:  # noqa: BLE001
        ipc.log(f"检查登录状态失败: {exc}", "warn")
        return {"valid": False}
    return {"valid": True, "user": common.user_summary(info)}


def list_courses(ctx: Context) -> dict:
    access = str(ctx.credential.get("access_token") or "")
    if not access:
        raise ipc.LoginError("未登录或登录凭证已失效，请先登录")
    ipc.add_secret(access)
    _prepare(ctx)
    api = _new_api(access)
    if _user_info(api) is None:
        raise ipc.LoginError("登录凭证已失效，请重新登录")
    data = api.my_course_list(page_size=9999)
    if not isinstance(data, dict):
        raise RuntimeError("获取课程列表失败，请稍后重试")
    courses = []
    for row in data.get("rows") or []:
        cid = str(row.get("id") or "")
        if not cid:
            continue
        courses.append(
            {
                "id": cid,
                "name": str(row.get("courseName") or row.get("courseInfoName") or "未命名课程"),
                "progress": common.parse_percent(row.get("studySpeed")),
                "extra": {
                    "courseId": row.get("courseId"),
                    "courseInfoName": row.get("courseInfoName"),
                    "teacher": row.get("displayName"),
                    "finalScore": row.get("finalScore"),
                },
            }
        )
    return {"courses": courses}


def _selected_courses(rows: list[dict], course_ids: Any) -> list[dict]:
    wanted = {str(x) for x in (course_ids or []) if str(x)}
    if not wanted:
        return rows
    return [row for row in rows if str(row.get("id")) in wanted or str(row.get("courseId")) in wanted]


def _walk_resources(nodes: list[dict], parent_id: str, out: list[tuple[dict, str]]) -> None:
    for node in nodes or []:
        children = node.get("children") or []
        if children:
            _walk_resources(children, parent_id, out)
        else:
            out.append((node, parent_id))


def _collect_resources(api, course_info_id: str, course_id: str) -> list[tuple[dict, str]]:
    resources: list[tuple[dict, str]] = []
    design = api.study_design_list(course_info_id, course_id) or []
    for node in design:
        parent_id = str(node.get("id") or "")
        cells = api.get_cell_list(course_info_id, course_id, parent_id) or []
        _walk_resources(cells, parent_id, resources)
    return resources


def run(ctx: Context) -> dict:
    api, _info = _api_with_credential(ctx)
    data = api.my_course_list(page_size=9999)
    if not isinstance(data, dict):
        raise RuntimeError("获取课程列表失败，请稍后重试")
    courses = _selected_courses(list(data.get("rows") or []), ctx.options.get("course_ids"))
    if not courses:
        ipc.log("没有找到匹配的课程", "warn")
        return {"summary": {"courses": 0, "resources": 0, "attempted": 0, "skipped": 0}}

    assert _handler_class is not None
    runner = _handler_class.__new__(_handler_class)  # 不调用 __init__，避免直接跑完全程
    runner.client = api
    runner.jump_list = []
    runner.study_record_list = []
    runner.logging = logging.getLogger("icve_ai")
    runner.logging.setLevel(logging.DEBUG if ctx.debug else logging.INFO)

    attempted = skipped = total_resources = 0
    for index, course in enumerate(courses, 1):
        ipc.check_cancel()
        course_info_id = str(course.get("id") or "")
        course_id = str(course.get("courseId") or "")
        name = str(course.get("courseName") or course.get("courseInfoName") or course_info_id)
        if not course_info_id or not course_id:
            ipc.log(f"课程 {name} 缺少 id，跳过", "warn")
            continue
        ipc.event("course_start", id=course_info_id, name=name)
        ipc.progress("overall", index - 1, len(courses), name)
        try:
            runner.study_record_list = api.study_record_list(course_info_id, course_id) or []
            resources = _collect_resources(api, course_info_id, course_id)
            total_resources += len(resources)
            for item_index, (node, parent_id) in enumerate(resources, 1):
                ipc.check_cancel()
                resource_name = str(node.get("name") or "未命名资源")
                file_type = str(node.get("fileType") or "")
                ipc.progress("course", item_index, len(resources), resource_name)
                if file_type in SKIP_TYPES:
                    skipped += 1
                    ipc.log(f"跳过{file_type}: {resource_name}", "debug")
                    continue
                if node.get("id") in runner.study_record_list:
                    skipped += 1
                    ipc.log(f"已完成，跳过: {resource_name}", "debug")
                    continue
                attempted += 1
                try:
                    runner.handle_resource(node, parent_id)
                except ipc.Cancelled:
                    raise
                except Exception as exc:  # noqa: BLE001 - one resource must not abort the course
                    ipc.log(f"处理资源失败: {resource_name}: {exc}", "warn")
            if resources:
                ipc.progress("course", len(resources), len(resources), name)
        except ipc.Cancelled:
            raise
        except Exception as exc:  # noqa: BLE001 - one course must not abort the task
            ipc.log(f"课程处理失败: {name}: {exc}", "warn")
        finally:
            ipc.event("course_done", id=course_info_id, name=name)
            ipc.progress("overall", index, len(courses), name)

    return {
        "summary": {
            "courses": len(courses),
            "resources": total_resources,
            "attempted": attempted,
            "skipped": skipped,
        }
    }


ACTIONS = {"login": login, "check": check, "list_courses": list_courses, "run": run}
