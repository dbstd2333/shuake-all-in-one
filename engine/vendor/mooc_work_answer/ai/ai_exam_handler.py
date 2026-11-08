# SPDX-License-Identifier: AGPL-3.0-or-later
"""智慧职教考试 AI 答题处理器（补齐上游缺失的 ``ai.ai_exam_handler``）。

上游 ``NewMoocMain/init_mooc.py`` 只依赖以下接口：
    handler = AIExamHandler(token, verbose=False, auto_delete_chat=True)
    handler.ai_handler.cleanup_all_chats()
    handler.load_agents()
    handler.process_exam(questions, use_auto_submit) -> list[dict]
其中 ``questions`` 来自 ``icve_exam_parser.parse_exam_questions``。
"""
from __future__ import annotations

import json
import re
from typing import Any, Sequence

from shuake_engine import ipc
from shuake_engine.ai import AIClient
from shuake_engine.context import AIConfig

_client: AIClient | None = None
_debug = False


def set_ai_config(cfg: AIConfig, debug: bool = False, client: AIClient | None = None) -> None:
    """由适配器注入宿主配置；未注入时 AI 功能视为关闭。"""
    global _client, _debug
    _debug = debug
    _client = client if client is not None else AIClient(cfg)


class _ChatShim:
    """兼容上游对 ``handler.ai_handler.cleanup_all_chats()`` 的调用。"""

    def cleanup_all_chats(self) -> None:
        return None


class AIExamHandler:
    def __init__(
        self,
        token: str | None = None,
        verbose: bool = False,
        auto_delete_chat: bool = True,
        ai_config: AIConfig | None = None,
        client: Any | None = None,
    ) -> None:
        self.token = token
        self.verbose = verbose
        self.auto_delete_chat = auto_delete_chat
        if client is not None:
            self.client = client
        elif ai_config is not None:
            self.client = AIClient(ai_config)
        else:
            self.client = _client or AIClient(AIConfig())
        self.ai_handler = _ChatShim()

    @property
    def enabled(self) -> bool:
        return bool(getattr(self.client, "enabled", False))

    def load_agents(self) -> bool:
        """上游用返回值决定是否继续启用 AI；未配置 AI 时安静返回 False。"""
        return self.enabled

    def process_exam(self, questions: Sequence[dict], auto_submit: bool = False) -> list[dict]:
        """返回可直接 json.dumps 进 ``studentAnswers`` 的答案列表。"""
        if not self.enabled or not questions:
            return []
        answers: list[dict] = []
        for question in questions:
            ipc.check_cancel()
            try:
                answer = self._answer_question(question)
            except ipc.Cancelled:
                raise
            except Exception as exc:  # noqa: BLE001 - 单题失败不影响其它题
                if self.verbose:
                    ipc.log(f"AI 答题失败: {exc}", "warn")
                answer = None
            if answer is None or answer == "":
                continue
            answers.append(
                {
                    "questionId": str(question.get("id") or ""),
                    "questionType": str(question.get("answer_type") or question.get("type") or ""),
                    "answer": answer,
                }
            )
        if self.verbose:
            ipc.log(f"AI 生成 {len(answers)}/{len(questions)} 个答案", "debug")
        return answers

    # ------------------------------------------------------------------ internals

    def _answer_question(self, question: dict) -> str | None:
        answer_type = str(question.get("answer_type") or "")
        type_name = str(question.get("type") or "")
        if answer_type in ("singlechoice", "multichoice", "bijudgement") or type_name in (
            "单选题",
            "多选题",
            "判断题",
        ):
            return self._answer_choice(question, answer_type or type_name)
        if answer_type == "fillblank" or type_name == "填空题":
            return self._answer_fill(question)
        if type_name in ("简答题", "问答题") or answer_type in ("shortanswer", "essay"):
            return self._answer_text(question)
        return None  # 匹配题/阅读理解等结构不明确，跳过

    def _answer_choice(self, question: dict, kind: str) -> str | None:
        options = question.get("options") or []
        if not options:
            return None
        texts = [str(opt.get("text") or opt.get("label") or "") for opt in options]
        multiple = kind in ("multichoice", "多选题")
        if multiple:
            answer_kind = "多选题"
        elif kind in ("bijudgement", "判断题"):
            answer_kind = "判断题"
        else:
            answer_kind = "单选题"
        picks = self.client.answer_choice(
            str(question.get("text") or ""), texts, multiple=multiple, kind=answer_kind
        )
        if not picks:
            return None
        values = [self._option_value(options[i]) for i in picks if 0 <= i < len(options)]
        values = [value for value in values if value]
        if not values:
            return None
        return ",".join(values) if multiple else values[0]

    def _answer_fill(self, question: dict) -> str | None:
        count = int(question.get("blank_count") or 1)
        prompt = (
            f"题目：{question.get('text') or ''}\n"
            f"共有 {count} 个空。请按顺序给出每个空的答案，只输出 JSON："
            '{"answers": ["第1空答案", "第2空答案"]}'
        )
        text = self.client.chat(
            [
                {"role": "system", "content": "你是答题助手，只输出 JSON。"},
                {"role": "user", "content": prompt},
            ],
            max_tokens=400,
            json_mode=True,
        )
        parts = self._parse_answers(text)
        if not parts:
            return None
        if len(parts) < count:
            parts = parts + [""] * (count - len(parts))
        parts = parts[:count]
        if count == 1:
            return parts[0]
        return json.dumps(parts, ensure_ascii=False, separators=(",", ":"))

    def _answer_text(self, question: dict) -> str | None:
        text = self.client.chat(
            [
                {"role": "system", "content": "你是答题助手，请直接给出简洁答案，不要解释。"},
                {"role": "user", "content": f"题目：{question.get('text') or ''}"},
            ],
            max_tokens=500,
        )
        return text.strip() or None

    @staticmethod
    def _option_value(option: dict) -> str:
        return str(option.get("value") or option.get("label") or option.get("text") or "")

    @staticmethod
    def _parse_answers(text: str) -> list[str]:
        text = (text or "").strip()
        match = re.search(r"\{.*\}", text, re.S)
        if match:
            try:
                raw = json.loads(match.group(0)).get("answers", [])
                if isinstance(raw, list):
                    return [str(item) for item in raw]
                if raw:
                    return [str(raw)]
            except (ValueError, AttributeError):
                pass
        parts = [line.strip(" -•\t") for line in text.splitlines() if line.strip()]
        if len(parts) <= 1:
            parts = [part.strip() for part in re.split(r"[；;]", text) if part.strip()]
        return parts
