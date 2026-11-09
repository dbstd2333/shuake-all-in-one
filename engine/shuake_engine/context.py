# SPDX-License-Identifier: AGPL-3.0-or-later
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class AIConfig:
    """OpenAI-compatible chat completion endpoint shared by all platforms."""

    enabled: bool = False
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    timeout: float = 60.0
    # "deepseek" | "aliyun" | "custom" — decides how ``thinking`` is sent
    provider: str = "custom"
    # "" (provider default) | "off" | "low" | "medium" | "high" | "max"
    thinking: str = ""

    @classmethod
    def from_dict(cls, d: dict | None) -> "AIConfig":
        d = d or {}
        return cls(
            enabled=bool(d.get("enabled")) and bool(d.get("base_url")) and bool(d.get("model")),
            base_url=str(d.get("base_url") or "").rstrip("/"),
            api_key=str(d.get("api_key") or ""),
            model=str(d.get("model") or ""),
            timeout=float(d.get("timeout") or 60),
            provider=str(d.get("provider") or "custom").lower(),
            thinking=str(d.get("thinking") or "").lower(),
        )


@dataclass
class Context:
    """Everything an adapter action receives.

    ``account``    — non-secret account fields (e.g. tenant name, username).
    ``credential`` — secrets/session saved from a previous login (cookies, token,
                     password). Adapters report new ones via ``ipc.credential``.
    ``options``    — action/platform specific options chosen in the GUI
                     (e.g. ``course_ids``).
    """

    platform: str
    action: str
    account: dict[str, Any] = field(default_factory=dict)
    credential: dict[str, Any] = field(default_factory=dict)
    options: dict[str, Any] = field(default_factory=dict)
    ai: AIConfig = field(default_factory=AIConfig)
    data_dir: Path = field(default_factory=lambda: Path.cwd())
    resource_dir: Path = field(default_factory=lambda: Path(__file__).resolve().parent.parent)
    debug: bool = False

    @property
    def vendor_dir(self) -> Path:
        return self.resource_dir / "vendor"

    def platform_dir(self, name: str | None = None) -> Path:
        p = self.data_dir / (name or self.platform)
        p.mkdir(parents=True, exist_ok=True)
        return p

    @classmethod
    def from_start(cls, msg: dict) -> "Context":
        data_dir = Path(msg.get("data_dir") or os.getcwd())
        data_dir.mkdir(parents=True, exist_ok=True)
        return cls(
            platform=str(msg["platform"]),
            action=str(msg.get("action") or "run"),
            account=dict(msg.get("account") or {}),
            credential=dict(msg.get("credential") or {}),
            options=dict(msg.get("options") or {}),
            ai=AIConfig.from_dict(msg.get("ai")),
            data_dir=data_dir,
            debug=bool(msg.get("debug")),
        )
