# SPDX-License-Identifier: AGPL-3.0-or-later
"""Discussion comment posting for XuetangX.

Ported from dbstd2333/xuetangx-js (AGPL-3.0).
"""
from __future__ import annotations

from typing import Any

from ... import ipc
from .api import ApiClient
from .utils import as_bool, as_number, to_int, to_str

DEFAULT_DISCUSSION_TEXT = "很有启发性的讨论，让我对这个问题有了更深入的思考。"


def _content_info(leaf_info: dict) -> dict:
    content = (leaf_info or {}).get("content_info")
    return content if isinstance(content, dict) else {}


def process_discussion(
    client: ApiClient,
    *,
    leaf_id: Any,
    classroom_id: Any,
    sign: str,
    leaf_info: dict,
    text: str = DEFAULT_DISCUSSION_TEXT,
) -> bool:
    content = _content_info(leaf_info)
    topic_id: Any = None
    to_user: Any = 0

    try:
        unit = client.get_discussion_unit(sign, leaf_id, classroom_id)
        topic_id = unit.get("id") or unit.get("topic_id")
        to_user = unit.get("user_id") or unit.get("to_user") or 0
    except Exception as exc:  # noqa: BLE001
        ipc.log(f"  获取讨论信息失败: {exc}", "warn")

    discussion = content.get("discussion") if isinstance(content.get("discussion"), dict) else {}
    if not topic_id:
        topic_id = (
            content.get("topic_id")
            or discussion.get("topic_id")
            or content.get("discussion_topic_id")
        )
    if not to_user:
        to_user = content.get("to_user") or discussion.get("user_id") or content.get("creator_id") or 0

    if not topic_id:
        ipc.log("  未找到讨论 topic_id，跳过评论", "warn")
        return False

    body = {
        "to_user": as_number(to_user),
        "topic_id": as_number(topic_id),
        "content": {"text": to_str(text) or DEFAULT_DISCUSSION_TEXT, "upload_images": []},
    }
    try:
        result = client.post_comment(classroom_id, leaf_id, body)
    except Exception as exc:  # noqa: BLE001
        ipc.log(f"  发表评论失败: {exc}", "warn")
        return False

    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    status = data.get("status", result.get("status"))
    succeeded = (
        as_bool(result.get("success"), False)
        or as_bool(data.get("success"), False)
        or (status is not None and to_int(status, -1) == 0)
    )
    if succeeded:
        ipc.log("  评论发布成功", "success")
        return True
    reason = result.get("message") or result.get("msg") or ""
    ipc.log(f"  评论响应异常: {reason}", "warn")
    return False
