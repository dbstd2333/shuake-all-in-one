# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exercise/exam answering for XuetangX.

Ported from dbstd2333/xuetangx-js (AGPL-3.0).
"""
from __future__ import annotations

import random
from typing import Any

from ... import ipc
from ...ai import AIClient
from .api import ApiClient
from .utils import as_bool, to_str


def option_key(option: Any) -> str:
    if isinstance(option, dict):
        value = option.get("key")
        return "" if value is None else to_str(value)
    return to_str(option)


def indexes_to_keys(options: list, indexes: list[int]) -> list[str]:
    """Map 0-based option indexes returned by the AI to API answer keys."""
    keys: list[str] = []
    for index in indexes:
        if not isinstance(index, int) or not 0 <= index < len(options):
            continue
        key = option_key(options[index])
        if key and key not in keys:
            keys.append(key)
    return keys


def is_multiple(content: dict) -> bool:
    type_value = to_str(content.get("Type")).strip()
    type_text = to_str(content.get("TypeText")).strip()
    return type_value == "MultipleChoice" or "多选" in type_text


def build_question(content: dict) -> str:
    return to_str(content.get("Body") or content.get("body") or content.get("title") or "")


def build_option_texts(options: list) -> list[str]:
    texts = []
    for option in options:
        if isinstance(option, dict):
            texts.append(to_str(option.get("value") or option.get("text") or option.get("content")))
        else:
            texts.append(to_str(option))
    return texts


def process_exercise(
    client: ApiClient,
    ai: AIClient,
    *,
    leaf_id: Any,
    classroom_id: Any,
    sign: str,
    leaf_info: dict,
) -> dict:
    content_info = (leaf_info or {}).get("content_info")
    if not isinstance(content_info, dict):
        content_info = {}
    exercise_id = content_info.get("leaf_type_id") or content_info.get("exercise_id")
    sku_id = (leaf_info or {}).get("sku_id") or content_info.get("sku_id") or 0
    if not exercise_id:
        ipc.log("  未找到 exercise_id，跳过答题", "warn")
        return {"total": 0, "submitted": 0, "skipped": 0, "correct": 0, "ai": 0}

    data = client.get_exercise_list(exercise_id, sku_id)
    problems = data.get("problems") or data.get("problem_list") or []
    if not isinstance(problems, list) or not problems:
        ipc.log("  没有题目数据", "warn")
        return {"total": 0, "submitted": 0, "skipped": 0, "correct": 0, "ai": 0}

    submitted = skipped = correct = ai_used = 0
    for problem in problems:
        if not isinstance(problem, dict):
            skipped += 1
            continue
        content = problem.get("content") or {}
        if not isinstance(content, dict):
            content = {}
        options = content.get("Options") or content.get("options") or []
        if not isinstance(options, list):
            options = []
        user = problem.get("user") if isinstance(problem.get("user"), dict) else {}
        label = to_str(problem.get("index") or problem.get("problem_id"))
        type_text = to_str(content.get("TypeText") or content.get("Type")) or "未知"

        if as_bool(user.get("is_show_answer"), False):
            skipped += 1
            continue
        valid_keys = {option_key(option) for option in options if option_key(option)}
        if not valid_keys:
            skipped += 1
            ipc.log(f"  题目{label} 无选项，跳过", "debug")
            continue

        keys: list[str] = []
        if ai is not None:
            picks = ai.answer_choice(
                build_question(content),
                build_option_texts(options),
                multiple=is_multiple(content),
                kind=type_text,
            )
            keys = [key for key in indexes_to_keys(options, picks) if key in valid_keys]
        source = "AI" if keys else "随机"
        if keys:
            ai_used += 1
        else:
            keys = [random.choice(sorted(valid_keys))]

        try:
            result = client.submit_answer(
                leaf_id=leaf_id,
                classroom_id=classroom_id,
                exercise_id=exercise_id,
                problem_id=problem.get("problem_id"),
                sign=sign,
                answer=keys,
            )
        except Exception as exc:  # noqa: BLE001
            ipc.log(f"  题目{label} 提交失败: {exc}", "warn")
            continue

        submitted += 1
        right = as_bool(result.get("is_right"), False) or as_bool(result.get("is_correct"), False)
        if right:
            correct += 1
            ipc.log(f"  题目{label} [{type_text}] {source}选 {','.join(keys)} 正确", "success")
        else:
            answer = result.get("answer") or result.get("correct_answer") or []
            answer_text = (
                ",".join(to_str(item) for item in answer) if isinstance(answer, list) else to_str(answer)
            )
            ipc.log(
                f"  题目{label} [{type_text}] {source}选 {','.join(keys)} 错误，正确答案: {answer_text}",
                "warn",
            )

    ipc.log(
        f"  习题统计：共 {len(problems)} 题，提交 {submitted}，正确 {correct}，AI {ai_used}，跳过 {skipped}",
        "info",
    )
    return {"total": len(problems), "submitted": submitted, "skipped": skipped, "correct": correct, "ai": ai_used}
