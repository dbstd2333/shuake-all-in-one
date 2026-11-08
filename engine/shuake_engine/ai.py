# SPDX-License-Identifier: AGPL-3.0-or-later
"""Minimal OpenAI-compatible chat client shared by all platform adapters."""
from __future__ import annotations

import json
import re
from typing import Sequence

import requests

from . import ipc
from .context import AIConfig

SYSTEM_PROMPT = (
    "你是一个答题助手。根据题目和选项选出正确答案。"
    "只输出 JSON，格式为 {\"answers\": [选项序号...]}，序号从 1 开始。"
)


class AIClient:
    def __init__(self, cfg: AIConfig, max_retries: int = 2) -> None:
        self.cfg = cfg
        self.max_retries = max_retries
        self.session = requests.Session()

    @property
    def enabled(self) -> bool:
        return self.cfg.enabled

    def _url(self) -> str:
        base = self.cfg.base_url.rstrip("/")
        if base.endswith("/chat/completions"):
            return base
        if not re.search(r"/v\d+[a-z]*$", base):
            base += "/v1"
        return base + "/chat/completions"

    def chat(self, messages: list[dict], max_tokens: int = 512, json_mode: bool = False, temperature: float = 0.1) -> str:
        body: dict = {
            "model": self.cfg.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        headers = {"Content-Type": "application/json"}
        if self.cfg.api_key:
            headers["Authorization"] = f"Bearer {self.cfg.api_key}"
        last: Exception | None = None
        for attempt in range(self.max_retries + 1):
            ipc.check_cancel()
            try:
                resp = self.session.post(self._url(), json=body, headers=headers, timeout=self.cfg.timeout)
                if resp.status_code == 400 and json_mode:
                    # Some providers do not support response_format.
                    body.pop("response_format", None)
                    json_mode = False
                    continue
                resp.raise_for_status()
                data = resp.json()
                return str(data["choices"][0]["message"]["content"] or "").strip()
            except Exception as exc:  # noqa: BLE001
                last = exc
                ipc.sleep(min(2 * (attempt + 1), 6))
        raise RuntimeError(f"AI 请求失败: {last}")

    def answer_choice(self, question: str, options: Sequence[str], multiple: bool = False, kind: str = "") -> list[int]:
        """Return 0-based indexes of the chosen options (empty on failure)."""
        if not self.enabled or not options:
            return []
        type_hint = kind or ("多选题" if multiple else "单选题")
        opts = "\n".join(f"{i + 1}. {strip_html(o)}" for i, o in enumerate(options))
        prompt = f"题型：{type_hint}\n题目：{strip_html(question)}\n选项：\n{opts}"
        try:
            text = self.chat(
                [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}],
                max_tokens=200,
                json_mode=True,
            )
        except Exception as exc:  # noqa: BLE001
            ipc.log(f"AI 作答失败: {exc}", "warn")
            return []
        picks = parse_answer_indexes(text, len(options))
        if not multiple and len(picks) > 1:
            picks = picks[:1]
        return picks


def strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", str(s or ""))
    return re.sub(r"\s+", " ", s.replace("&nbsp;", " ")).strip()


def parse_answer_indexes(text: str, n: int) -> list[int]:
    """Parse ``{"answers":[1,3]}`` / ``"AC"`` / ``"1,3"`` into 0-based indexes."""
    picks: list[int] = []
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            raw = json.loads(m.group(0)).get("answers", [])
            for a in raw if isinstance(raw, list) else [raw]:
                if isinstance(a, int) or (isinstance(a, str) and a.strip().isdigit()):
                    picks.append(int(a) - 1)
                elif isinstance(a, str) and len(a.strip()) == 1 and a.strip().isalpha():
                    picks.append(ord(a.strip().upper()) - 65)
        except (ValueError, AttributeError):
            picks = []
    if not picks:
        letters = re.findall(r"\b([A-H])\b", text.upper())
        if letters:
            picks = [ord(c) - 65 for c in letters]
        else:
            picks = [int(d) - 1 for d in re.findall(r"\d+", text)]
    seen: list[int] = []
    for p in picks:
        if 0 <= p < n and p not in seen:
            seen.append(p)
    return seen
