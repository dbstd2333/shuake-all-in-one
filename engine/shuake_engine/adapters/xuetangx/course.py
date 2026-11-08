# SPDX-License-Identifier: AGPL-3.0-or-later
"""Course URL parsing, chapter flattening and course listing.

Ported from dbstd2333/xuetangx-js (AGPL-3.0).
"""
from __future__ import annotations

import re
from typing import Any

from ... import ipc
from ...context import Context
from .api import ApiClient, ApiError, data_of
from .utils import as_list, percent, to_float, to_int, to_str

COURSE_URL_RE = re.compile(r"/learn/(?:space/)?([^/]+)/([^/]+)/(\d+)")

LEAF_VIDEO = 0
LEAF_AUDIO = 1
LEAF_IMAGE_TEXT = 3
LEAF_DISCUSSION = 4
LEAF_EXAM = 5
LEAF_EXERCISE = 6

_LEAF_TYPE_NAMES = {
    LEAF_VIDEO: "视频",
    LEAF_AUDIO: "音频",
    LEAF_IMAGE_TEXT: "图文",
    LEAF_DISCUSSION: "讨论",
    LEAF_EXAM: "考试",
    LEAF_EXERCISE: "习题",
}


def parse_course_url(url: Any) -> dict | None:
    match = COURSE_URL_RE.search(to_str(url))
    if not match:
        return None
    return {"sign": match.group(1), "classroom_id": match.group(3)}


def parse_course_id(value: Any) -> dict | None:
    text = to_str(value).strip()
    sign, sep, classroom_id = text.partition("|")
    if not sep or not sign.strip() or not classroom_id.strip():
        return None
    return {"sign": sign.strip(), "classroom_id": classroom_id.strip()}


def leaf_type(leaf: dict) -> int:
    return to_int((leaf or {}).get("leaf_type"), -1)


def leaf_id(leaf: dict) -> Any:
    return (leaf or {}).get("id") or (leaf or {}).get("leaf_id") or 0


def leaf_name(leaf: dict) -> str:
    return to_str((leaf or {}).get("name")).strip() or "未命名"


def leaf_type_name(value: int) -> str:
    return _LEAF_TYPE_NAMES.get(value, "其他")


def flatten_leaves(chapters: Any) -> list[dict]:
    if not isinstance(chapters, list):
        return []
    leaves: list[dict] = []
    for chapter in chapters:
        if not isinstance(chapter, dict):
            continue
        chapter_name = chapter.get("chapter_name") or chapter.get("name") or ""
        sections = chapter.get("section_leaf_list") or chapter.get("section_list") or []
        for section in sections if isinstance(sections, list) else []:
            if not isinstance(section, dict):
                continue
            section_name = section.get("section_name") or section.get("name") or ""
            section_leaves = section.get("leaf_list")
            if isinstance(section_leaves, list) and section_leaves:
                for leaf in section_leaves:
                    if isinstance(leaf, dict):
                        leaves.append(_with_names(leaf, chapter_name, section_name))
            elif _looks_like_leaf(section):
                leaves.append(_with_names(section, chapter_name, section_name))
    return leaves


def _looks_like_leaf(item: dict) -> bool:
    if "leaf_type" in item or "leaf_id" in item:
        return True
    return "id" in item and "name" in item


def _with_names(leaf: dict, chapter_name: str, section_name: str) -> dict:
    merged = dict(leaf)
    merged["chapter_name"] = to_str(chapter_name)
    merged["section_name"] = to_str(section_name)
    return merged


def normalize_schedule(raw: Any) -> dict:
    if isinstance(raw, dict):
        schedules = raw.get("leaf_schedules")
        return schedules if isinstance(schedules, dict) else raw
    if isinstance(raw, list):
        result: dict[str, Any] = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            lid = item.get("leaf_id") or item.get("id")
            if lid is None:
                continue
            value = item.get("schedule", item.get("leaf_schedule", item.get("status")))
            result[to_str(lid)] = value
        return result
    return {}


def is_done(schedule: dict, lid: Any) -> bool:
    value = schedule.get(to_str(lid))
    if value is None:
        value = schedule.get(lid)  # type: ignore[arg-type]
    return to_float(value) >= 1


def extract_progress(item: Any) -> float | None:
    if not isinstance(item, dict):
        return None
    for key in ("progress", "learn_progress", "course_progress", "progress_rate", "rate", "schedule"):
        if key not in item:
            continue
        value = item[key]
        if isinstance(value, dict):
            nested = extract_progress(value)
            if nested is not None:
                return nested
            continue
        number = percent(value)
        if number >= 0:
            return number
    return None


def normalize_course_list(data: Any) -> list[dict]:
    if isinstance(data, dict):
        raw = data.get("course_list") or data.get("classroom_list") or data.get("list")
        if not isinstance(raw, list):
            raw = next((value for value in data.values() if isinstance(value, list)), [])
    elif isinstance(data, list):
        raw = data
    else:
        raw = []

    courses = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = item.get("course_name") or item.get("classroom_name") or item.get("name") or item.get("product_name")
        sign = item.get("product_sign") or item.get("sign") or item.get("products_sign")
        classroom_id = item.get("classroom_id") or item.get("cid") or item.get("id")
        if not sign or classroom_id in (None, ""):
            continue
        courses.append(
            {
                "name": to_str(name) or "未知课程",
                "sign": to_str(sign),
                "classroom_id": to_str(classroom_id),
                "progress": extract_progress(item),
            }
        )
    return courses


def list_courses(ctx: Context) -> dict:
    sessionid = to_str((ctx.credential or {}).get("sessionid"))
    csrftoken = to_str((ctx.credential or {}).get("csrftoken"))
    if not sessionid:
        raise ipc.LoginError("登录已失效，请重新扫码")

    client = ApiClient(sessionid, csrftoken)
    try:
        valid = client.check_is_l()
    except ApiError as exc:
        if exc.status in (401, 403):
            raise ipc.LoginError("登录已失效，请重新扫码") from exc
        raise
    if not valid:
        raise ipc.LoginError("登录已失效，请重新扫码")

    courses = collect_courses(client, as_list((ctx.options or {}).get("course_urls")))
    if not courses:
        ipc.log(
            "未获取到课程列表，可以粘贴课程链接（形如 https://www.xuetangx.com/learn/...）后重试",
            "warn",
        )
    return {"courses": courses}


def collect_courses(client: ApiClient, urls: list) -> list[dict]:
    found: list[dict] = []
    seen: set[str] = set()

    def add(name: Any, sign: Any, classroom_id: Any, progress: float | None = None) -> None:
        sign_text = to_str(sign).strip()
        cid_text = to_str(classroom_id).strip()
        if not sign_text or not cid_text:
            return
        course_id = f"{sign_text}|{cid_text}"
        if course_id in seen:
            return
        seen.add(course_id)
        entry: dict[str, Any] = {
            "id": course_id,
            "name": to_str(name).strip() or "未知课程",
            "extra": {"sign": sign_text, "classroom_id": cid_text},
        }
        if progress is not None and progress >= 0:
            entry["progress"] = progress
        found.append(entry)

    try:
        last = client.get_user_last()
    except Exception as exc:  # noqa: BLE001
        ipc.log(f"获取最近学习课程失败: {exc}", "debug")
        last = None
    if isinstance(last, dict):
        add(
            last.get("product_name") or last.get("course_name") or last.get("name"),
            last.get("product_sign") or last.get("sign"),
            last.get("classroom_id") or last.get("cid"),
            extract_progress(last),
        )

    for path in (
        "/api/v1/lms/learn/course_list/",
        "/api/v1/lms/classroom/list/",
        "/api/v1/lms/learn/list/",
    ):
        try:
            response = client.get(path)
        except Exception as exc:  # noqa: BLE001
            ipc.log(f"{path} 获取失败: {exc}", "debug")
            continue
        for course in normalize_course_list(data_of(response)):
            add(course["name"], course["sign"], course["classroom_id"], course.get("progress"))

    for url in urls:
        parsed = parse_course_url(url)
        if not parsed:
            ipc.log(f"无法解析课程链接：{url}", "warn")
            continue
        name = ""
        progress: float | None = None
        try:
            info = client.product_info(parsed["sign"], parsed["classroom_id"])
            if isinstance(info, dict):
                name = to_str(
                    info.get("name")
                    or info.get("course_name")
                    or info.get("product_name")
                    or info.get("classroom_name")
                )
                progress = extract_progress(info)
        except Exception as exc:  # noqa: BLE001
            ipc.log(f"获取课程信息失败：{exc}", "debug")
        add(name or parsed["sign"], parsed["sign"], parsed["classroom_id"], progress)

    return found
