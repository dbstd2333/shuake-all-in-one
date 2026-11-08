# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run action: walk every selected course and complete its pending leaves.

Ported from dbstd2333/xuetangx-js (AGPL-3.0).
"""
from __future__ import annotations

from typing import Any

from ... import ipc
from ...ai import AIClient
from ...context import Context
from .api import ApiClient, media_duration, profile_user
from .course import (
    LEAF_AUDIO,
    LEAF_DISCUSSION,
    LEAF_EXAM,
    LEAF_EXERCISE,
    LEAF_IMAGE_TEXT,
    LEAF_VIDEO,
    flatten_leaves,
    is_done,
    leaf_id,
    leaf_name,
    leaf_type,
    leaf_type_name,
    normalize_schedule,
    parse_course_id,
    parse_course_url,
)
from .discussion import DEFAULT_DISCUSSION_TEXT, process_discussion
from .exercise import process_exercise
from .utils import as_bool, as_list, to_float, to_int, to_str
from .video import simulate_playback


def run(ctx: Context) -> dict:
    credential = ctx.credential or {}
    sessionid = to_str(credential.get("sessionid"))
    csrftoken = to_str(credential.get("csrftoken"))
    if not sessionid:
        raise ipc.LoginError("登录已失效，请重新扫码")

    client = ApiClient(sessionid, csrftoken)
    if not client.check_is_l():
        raise ipc.LoginError("登录已失效，请重新扫码")

    try:
        user = profile_user(client.basic_profile())
    except Exception as exc:  # noqa: BLE001
        ipc.log(f"获取用户信息失败: {exc}", "warn")
        user = {"id": "0", "name": ""}
    user_id = to_int(user.get("id"))
    if user.get("name"):
        ipc.log(f"当前用户: {user['name']}", "info")

    options = ctx.options or {}
    settings = {
        "skip_audio": as_bool(options.get("skip_audio"), False),
        "do_exercise": as_bool(options.get("do_exercise"), True),
        "do_discussion": as_bool(options.get("do_discussion"), True),
        "discussion_text": to_str(options.get("discussion_text")).strip() or DEFAULT_DISCUSSION_TEXT,
        "heartbeat_interval": max(0.0, to_float(options.get("heartbeat_interval"), 5.0)),
        "replay_incomplete": max(0, to_int(options.get("replay_incomplete"), 1)),
    }

    courses = _course_pairs(options)
    if not courses:
        ipc.log("没有可运行的课程，请选择课程或粘贴课程链接", "warn")
        return {"summary": {"courses": 0, "done": 0, "total": 0, "failed": 0}}

    ai = AIClient(ctx.ai)
    total = done_total = failed = 0
    for index, (sign, classroom_id) in enumerate(courses, 1):
        course_key = f"{sign}|{classroom_id}"
        label = f"{sign} / {classroom_id}"
        ipc.event("course_start", id=course_key, name=label)
        ipc.progress("overall", index - 1, len(courses), label)

        try:
            leaves = flatten_leaves(client.get_chapters(sign, classroom_id))
            schedule = normalize_schedule(client.get_schedule(sign, classroom_id))
        except Exception as exc:  # noqa: BLE001
            failed += 1
            ipc.log(f"课程 {label} 加载失败: {exc}", "error")
            ipc.event("course_done", id=course_key, name=label, error=to_str(exc))
            ipc.progress("overall", index, len(courses), label)
            continue

        total += len(leaves)
        done_before = sum(1 for leaf in leaves if is_done(schedule, leaf_id(leaf)))
        pending = [
            leaf
            for leaf in leaves
            if not is_done(schedule, leaf_id(leaf))
            and not (settings["skip_audio"] and leaf_type(leaf) == LEAF_AUDIO)
        ]
        ipc.log(f"课程 {label}: 共 {len(leaves)} 个章节，已完成 {done_before}，待处理 {len(pending)}")

        for item_index, leaf in enumerate(pending, 1):
            ipc.check_cancel()
            name = leaf_name(leaf)
            type_name = leaf_type_name(leaf_type(leaf))
            ipc.event(
                "item_start",
                id=to_str(leaf_id(leaf)),
                name=name,
                type=type_name,
                index=item_index,
                total=len(pending),
            )
            ipc.progress("course", item_index - 1, len(pending), name)
            ok = True
            try:
                _process_leaf(client, ai, sign, classroom_id, leaf, user_id, settings)
            except Exception as exc:  # noqa: BLE001
                ok = False
                failed += 1
                ipc.log(f"[{type_name}] {name} 处理失败: {exc}", "error")
            ipc.event("item_done", id=to_str(leaf_id(leaf)), name=name, ok=ok)
            ipc.progress("course", item_index, len(pending), name)

        try:
            final_schedule = normalize_schedule(client.get_schedule(sign, classroom_id))
            done = sum(1 for leaf in leaves if is_done(final_schedule, leaf_id(leaf)))
        except Exception as exc:  # noqa: BLE001
            ipc.log(f"课程 {label} 最终进度获取失败: {exc}", "warn")
            done = done_before
        done_total += done
        ipc.event("course_done", id=course_key, name=label, done=done, total=len(leaves))
        ipc.progress("overall", index, len(courses), label)

    summary = {"courses": len(courses), "done": done_total, "total": total, "failed": failed}
    ipc.log(
        f"全部完成：{summary['done']}/{summary['total']} 个章节，失败 {summary['failed']} 个",
        "success",
    )
    return {"summary": summary}


def _course_pairs(options: dict) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for raw in as_list(options.get("course_ids")):
        parsed = parse_course_id(raw)
        if not parsed:
            ipc.log(f"忽略无法识别的课程 ID：{raw}", "warn")
            continue
        pairs.append((parsed["sign"], parsed["classroom_id"]))
    for raw in as_list(options.get("course_urls")):
        parsed = parse_course_url(raw)
        if not parsed:
            ipc.log(f"忽略无法解析的课程链接：{raw}", "warn")
            continue
        pairs.append((parsed["sign"], parsed["classroom_id"]))

    unique: list[tuple[str, str]] = []
    seen: set[str] = set()
    for sign, classroom_id in pairs:
        key = f"{sign}|{classroom_id}"
        if key in seen:
            continue
        seen.add(key)
        unique.append((sign, classroom_id))
    return unique


def _sku_of(leaf_info: dict) -> Any:
    content = leaf_info.get("content_info") if isinstance(leaf_info.get("content_info"), dict) else {}
    media = content.get("media") if isinstance(content.get("media"), dict) else {}
    return leaf_info.get("sku_id") or content.get("sku_id") or media.get("sku_id") or 0


def _course_id_of(leaf_info: dict) -> Any:
    content = leaf_info.get("content_info") if isinstance(leaf_info.get("content_info"), dict) else {}
    media = content.get("media") if isinstance(content.get("media"), dict) else {}
    return leaf_info.get("course_id") or content.get("course_id") or media.get("course_id") or 0


def _leaf_schedule(result: Any) -> float:
    if not isinstance(result, dict):
        return -1.0
    return to_float(result.get("leaf_schedule"), -1.0)


def _fmt_progress(value: float) -> str:
    return "未知" if value < 0 else f"{value * 100:.0f}%"


def _mark_done(client: ApiClient, leaf_id_value: Any, classroom_id: Any, sku_id: Any) -> float:
    progress = _leaf_schedule(client.update_schedule(leaf_id_value, classroom_id, sku_id))
    if progress >= 1:
        ipc.log("  已标记完成", "success")
    else:
        ipc.log(f"  标记后进度 {_fmt_progress(progress)}", "info")
    return progress


def _process_leaf(
    client: ApiClient,
    ai: AIClient,
    sign: str,
    classroom_id: str,
    leaf: dict,
    user_id: int,
    settings: dict,
) -> None:
    kind = leaf_type(leaf)
    lid = leaf_id(leaf)

    if kind in (LEAF_VIDEO, LEAF_AUDIO):
        _process_media(client, sign, classroom_id, leaf, user_id, settings)
    elif kind == LEAF_IMAGE_TEXT:
        leaf_info = client.get_leaf_info(sign, classroom_id, lid)
        client.mark_article_finished(lid, classroom_id, _sku_of(leaf_info))
        ipc.log("  图文已标记完成", "success")
    elif kind in (LEAF_EXAM, LEAF_EXERCISE):
        leaf_info = client.get_leaf_info(sign, classroom_id, lid)
        if settings["do_exercise"]:
            process_exercise(
                client,
                ai,
                leaf_id=lid,
                classroom_id=classroom_id,
                sign=sign,
                leaf_info=leaf_info,
            )
        else:
            ipc.log("  已跳过习题作答", "info")
        _mark_done(client, lid, classroom_id, _sku_of(leaf_info))
    elif kind == LEAF_DISCUSSION:
        leaf_info = client.get_leaf_info(sign, classroom_id, lid)
        if settings["do_discussion"]:
            process_discussion(
                client,
                leaf_id=lid,
                classroom_id=classroom_id,
                sign=sign,
                leaf_info=leaf_info,
                text=settings["discussion_text"],
            )
        else:
            ipc.log("  已跳过讨论", "info")
        _mark_done(client, lid, classroom_id, _sku_of(leaf_info))
    else:
        leaf_info = client.get_leaf_info(sign, classroom_id, lid)
        ipc.log(f"  未支持的章节类型 {kind}，尝试直接标记", "debug")
        _mark_done(client, lid, classroom_id, _sku_of(leaf_info))


def _process_media(
    client: ApiClient,
    sign: str,
    classroom_id: str,
    leaf: dict,
    user_id: int,
    settings: dict,
) -> None:
    lid = leaf_id(leaf)
    name = leaf_name(leaf)
    leaf_info = client.get_leaf_info(sign, classroom_id, lid)
    duration = media_duration(leaf_info)
    sku_id = _sku_of(leaf_info)

    if duration <= 0:
        ipc.log("  无法获取时长，尝试直接标记完成", "warn")
        _mark_done(client, lid, classroom_id, sku_id)
        return

    video_type = "video_audio" if leaf_type(leaf) == LEAF_AUDIO else "video"
    replays = 0
    while True:
        simulate_playback(
            client,
            user_id=user_id,
            course_id=_course_id_of(leaf_info),
            leaf_id=lid,
            classroom_id=classroom_id,
            duration=duration,
            video_type=video_type,
            sku_id=sku_id,
            leaf_name=name,
            heartbeat_interval=settings["heartbeat_interval"],
        )
        progress = _leaf_schedule(client.update_schedule(lid, classroom_id, sku_id))
        if progress >= 1:
            ipc.log(f"  {name} 已完成", "success")
            return
        if replays >= settings["replay_incomplete"]:
            ipc.log(f"  {name} 进度 {_fmt_progress(progress)}，未能完成", "warn")
            return
        replays += 1
        ipc.log(f"  {name} 进度 {_fmt_progress(progress)}，开始第 {replays} 次重播", "info")
