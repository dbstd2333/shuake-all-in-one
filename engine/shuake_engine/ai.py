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


THINKING_LEVELS = ("off", "low", "medium", "high", "max")

# extra output tokens allowed for reasoning, on top of what the caller asks for
_REASONING_TOKENS = {"low": 4096, "medium": 8192, "high": 16384, "max": 32768}
# 阿里云 thinking_budget per level ("max" = no budget, model default)
_QWEN_BUDGET = {"low": 1024, "medium": 4096, "high": 16384}
# DeepSeek accepts low/high/max (medium is mapped to high by the API itself)
_DEEPSEEK_EFFORT = {"low": "low", "medium": "high", "high": "high", "max": "max"}
# minimum read timeout per level: reasoning makes replies much slower
_TIMEOUT = {"low": 90.0, "medium": 120.0, "high": 240.0, "max": 360.0}

# optional fields we drop one by one when a provider rejects the request (400)
_OPTIONAL = ("response_format", "thinking_budget", "reasoning_effort")


def thinking_params(provider: str, level: str) -> dict:
    """Provider specific request fields for a thinking level ("" = send nothing)."""
    level = (level or "").lower()
    if level not in THINKING_LEVELS:
        return {}
    if provider == "deepseek":
        if level == "off":
            return {"thinking": {"type": "disabled"}}
        return {"thinking": {"type": "enabled"}, "reasoning_effort": _DEEPSEEK_EFFORT[level]}
    if provider == "aliyun":
        if level == "off":
            return {"enable_thinking": False}
        out: dict = {"enable_thinking": True}
        if level in _QWEN_BUDGET:
            out["thinking_budget"] = _QWEN_BUDGET[level]
        return out
    # generic OpenAI-style reasoning models
    return {"reasoning_effort": "none" if level == "off" else level}


def thinking_enabled(cfg: AIConfig) -> bool:
    """Whether the model is expected to reason before answering."""
    if cfg.thinking in ("low", "medium", "high", "max"):
        return True
    # both providers think by default when nothing is sent
    return cfg.thinking == "" and cfg.provider in ("deepseek", "aliyun")


class AIClient:
    def __init__(self, cfg: AIConfig, max_retries: int = 2) -> None:
        self.cfg = cfg
        self.max_retries = max_retries
        self.session = requests.Session()
        self._rejected: set[str] = set()  # optional fields this endpoint refused

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

    def _body(self, messages: list[dict], max_tokens: int, json_mode: bool, temperature: float) -> dict:
        body: dict = {
            "model": self.cfg.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        body.update(thinking_params(self.cfg.provider, self.cfg.thinking))
        if thinking_enabled(self.cfg):
            level = self.cfg.thinking if self.cfg.thinking in _REASONING_TOKENS else "high"
            body["max_tokens"] = max_tokens + _REASONING_TOKENS[level]
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        for k in self._rejected:
            body.pop(k, None)
        return body

    def _timeout(self) -> float:
        if not thinking_enabled(self.cfg):
            return self.cfg.timeout
        return max(self.cfg.timeout, _TIMEOUT.get(self.cfg.thinking, _TIMEOUT["high"]))

    def chat(self, messages: list[dict], max_tokens: int = 512, json_mode: bool = False, temperature: float = 0.1) -> str:
        headers = {"Content-Type": "application/json"}
        if self.cfg.api_key:
            headers["Authorization"] = f"Bearer {self.cfg.api_key}"
        last: Exception | None = None
        attempt = 0
        while attempt <= self.max_retries:
            ipc.check_cancel()
            body = self._body(messages, max_tokens, json_mode, temperature)
            try:
                resp = self.session.post(self._url(), json=body, headers=headers, timeout=self._timeout())
                if resp.status_code == 400:
                    # Some providers/models reject response_format (e.g. JSON mode
                    # while thinking) or the thinking knobs: drop one and retry.
                    drop = next((k for k in _OPTIONAL if k in body), None)
                    if drop:
                        ipc.log(f"AI 接口不接受 {drop}，去掉后重试：{resp.text[:200]}", "debug")
                        self._rejected.add(drop)
                        continue
                resp.raise_for_status()
                data = resp.json()
                msg = data["choices"][0]["message"]
                usage = data.get("usage") or {}
                if usage:
                    ipc.log(f"AI 用量：输入 {usage.get('prompt_tokens', '?')}，输出 {usage.get('completion_tokens', '?')} tokens", "debug")
                return strip_think(str(msg.get("content") or ""))
            except Exception as exc:  # noqa: BLE001
                last = exc
                if isinstance(exc, requests.HTTPError) and exc.response is not None:
                    last = RuntimeError(f"HTTP {exc.response.status_code}: {exc.response.text[:300]}")
                    if exc.response.status_code in (401, 403, 404):
                        break  # bad key / model: retrying will not help
                attempt += 1
                if attempt <= self.max_retries:
                    ipc.sleep(min(2 * attempt, 6))
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


def strip_think(s: str) -> str:
    """Remove ``<think>…</think>`` blocks some models put into the content."""
    s = re.sub(r"<think>.*?</think>", "", s, flags=re.S)
    if "</think>" in s:  # opening tag cut off
        s = s.split("</think>", 1)[1]
    return s.strip()


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
