# SPDX-License-Identifier: AGPL-3.0-or-later
"""HTTP client for the XuetangX web API.

Ported from dbstd2333/xuetangx-js (AGPL-3.0).
"""
from __future__ import annotations

import math
import re
from typing import Any, Callable
from urllib.parse import quote, urlencode

import requests

from ... import ipc
from .utils import as_number, to_float, to_str

BASE_URL = "https://www.xuetangx.com"
WS_URL = "wss://www.xuetangx.com/wsapp/"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
DEFAULT_HEADERS = {
    "content-type": "application/json",
    "x-client": "web",
    "xtbz": "xt",
    "app-name": "xtzx",
    "accept": "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "user-agent": USER_AGENT,
    "referer": f"{BASE_URL}/",
}
TIMEOUT = 30
MAX_ATTEMPTS = 3

_RETRY_AFTER_RE = re.compile(r"Expected available in\s+(\d+(?:\.\d+)?)\s*seconds?", re.I)


class ApiError(Exception):
    def __init__(self, status: int, text: str, retry_after: float | None = None) -> None:
        super().__init__(f"HTTP {status}: {to_str(text)[:200]}")
        self.status = status
        self.text = to_str(text)
        self.retry_after = retry_after


def parse_retry_after(text: str) -> float | None:
    match = _RETRY_AFTER_RE.search(to_str(text))
    if not match:
        return None
    try:
        seconds = float(match.group(1))
    except ValueError:
        return None
    return seconds if seconds >= 0 else None


def with_retry(fn: Callable[[], Any], max_attempts: int = MAX_ATTEMPTS, label: str = "") -> Any:
    last: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        ipc.check_cancel()
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt >= max_attempts:
                break
            if isinstance(exc, ApiError) and exc.retry_after is not None:
                wait = math.ceil(exc.retry_after + 2)
            else:
                wait = 5 * attempt
            ipc.log(f"{label or '请求'}失败（{exc}），{wait}s 后重试 ({attempt}/{max_attempts})", "warn")
            ipc.sleep(wait)
    assert last is not None
    raise last


def data_of(response: Any) -> Any:
    """Unwrap the ``{"data": ...}`` envelope used by the API."""
    if isinstance(response, dict):
        data = response.get("data")
        if isinstance(data, (dict, list)):
            return data
    return response


def profile_user(data: Any) -> dict:
    if not isinstance(data, dict):
        return {"id": "", "name": ""}
    user_id = data.get("user_id") or data.get("id") or data.get("uid") or ""
    name = data.get("nickname") or data.get("name") or data.get("username") or ""
    return {"id": to_str(user_id), "name": to_str(name)}


class ApiClient:
    def __init__(self, sessionid: str = "", csrftoken: str = "", session: requests.Session | None = None) -> None:
        self.session = session or requests.Session()
        headers = dict(DEFAULT_HEADERS)
        if csrftoken:
            headers["x-csrftoken"] = csrftoken
        self.session.headers.update(headers)
        if sessionid:
            self.session.cookies.set("sessionid", sessionid)
        if csrftoken:
            self.session.cookies.set("csrftoken", csrftoken)

    def _request_once(self, method: str, path: str, body: Any = None) -> Any:
        url = path if path.startswith("http") else BASE_URL + path
        response = self.session.request(method, url, json=body, timeout=TIMEOUT)
        if not 200 <= response.status_code < 300:
            retry_after = parse_retry_after(response.text) if response.status_code == 429 else None
            raise ApiError(response.status_code, response.text, retry_after)
        text = response.text or ""
        if not text.strip():
            return {}
        try:
            return response.json()
        except ValueError:
            return text

    def request(self, method: str, path: str, body: Any = None) -> Any:
        return with_retry(lambda: self._request_once(method, path, body), label=path)

    def get(self, path: str) -> Any:
        return self.request("GET", path)

    def post(self, path: str, body: Any = None) -> Any:
        return self.request("POST", path, body)

    # ------------------------------------------------------------------ auth
    def check_is_l(self) -> bool:
        data = data_of(self.get("/api/v1/u/login/check_is_l/"))
        return bool(data.get("is_login")) if isinstance(data, dict) else False

    def basic_profile(self) -> Any:
        return data_of(self.get("/api/v1/u/user/basic_profile/"))

    # ------------------------------------------------------------------ course
    def get_user_last(self) -> Any:
        return data_of(self.get("/api/v1/lms/learn/get_user_last/"))

    def get_chapters(self, sign: str, classroom_id: Any) -> list:
        path = f"/api/v1/lms/learn/course/chapter?cid={quote(to_str(classroom_id))}&sign={quote(sign)}"
        data = data_of(self.get(path))
        if isinstance(data, dict):
            for key in ("course_chapter", "course_chapters", "chapters"):
                value = data.get(key)
                if isinstance(value, list):
                    return value
            return []
        return data if isinstance(data, list) else []

    def get_schedule(self, sign: str, classroom_id: Any) -> Any:
        path = f"/api/v1/lms/learn/course/schedule?cid={quote(to_str(classroom_id))}&sign={quote(sign)}"
        data = data_of(self.get(path))
        if isinstance(data, dict):
            return data.get("leaf_schedules") or data.get("schedule") or {}
        return data

    def get_leaf_info(self, sign: str, classroom_id: Any, leaf_id: Any) -> Any:
        path = (
            f"/api/v1/lms/learn/leaf_info/{quote(to_str(classroom_id))}/{quote(to_str(leaf_id))}/"
            f"?sign={quote(sign)}"
        )
        data = data_of(self.get(path))
        return data if isinstance(data, dict) else {}

    def update_schedule(self, leaf_id: Any, classroom_id: Any, sku_id: Any) -> Any:
        body = {
            "leaf_id": as_number(leaf_id),
            "classroom_id": as_number(classroom_id),
            "sku_id": as_number(sku_id),
        }
        return data_of(self.post("/api/v1/lms/learn/chapter/schedule", body))

    def product_info(self, sign: str, classroom_id: Any) -> Any:
        path = f"/api/v1/lms/learn/product/info?cid={quote(to_str(classroom_id))}&sign={quote(sign)}"
        return data_of(self.get(path))

    # ------------------------------------------------------------------ video
    def send_heartbeat(self, entries: list[dict]) -> Any:
        return self.post("/video-log/heartbeat/", {"heart_data": entries})

    # ------------------------------------------------------------------ exercise
    def get_exercise_list(self, exercise_id: Any, sku_id: Any) -> Any:
        path = f"/api/v1/lms/exercise/get_exercise_list/{as_number(exercise_id)}/{as_number(sku_id)}/"
        data = data_of(self.get(path))
        return data if isinstance(data, dict) else {}

    def submit_answer(
        self,
        *,
        leaf_id: Any,
        classroom_id: Any,
        exercise_id: Any,
        problem_id: Any,
        sign: str,
        answer: list[str],
    ) -> Any:
        body = {
            "leaf_id": as_number(leaf_id),
            "classroom_id": as_number(classroom_id),
            "exercise_id": as_number(exercise_id),
            "problem_id": as_number(problem_id),
            "sign": sign,
            "answers": {},
            "answer": answer,
        }
        data = data_of(self.post("/api/v1/lms/exercise/problem_apply/", body))
        return data if isinstance(data, dict) else {}

    # ------------------------------------------------------------------ discussion
    def get_discussion_unit(self, sign: str, leaf_id: Any, classroom_id: Any) -> Any:
        query = urlencode(
            {
                "product_sign": sign,
                "leaf_id": to_str(leaf_id),
                "classroom_id": to_str(classroom_id),
                "topic_type": 4,
                "channel": "xt",
            }
        )
        data = data_of(self.get(f"/api/v1/lms/forum/unit/discussion/?{query}"))
        return data if isinstance(data, dict) else {}

    def post_comment(self, classroom_id: Any, leaf_id: Any, body: dict) -> Any:
        path = (
            f"/api/v1/lms/forum/comment/?classroom_id={quote(to_str(classroom_id))}"
            f"&leaf_id={quote(to_str(leaf_id))}"
        )
        response = self.post(path, body)
        return response if isinstance(response, dict) else {}

    # ------------------------------------------------------------------ article
    def mark_article_finished(self, leaf_id: Any, classroom_id: Any, sku_id: Any) -> Any:
        path = (
            f"/api/v1/lms/learn/user_article_finish/{quote(to_str(leaf_id))}/"
            f"?cid={quote(to_str(classroom_id))}&sid={quote(to_str(sku_id))}"
        )
        return self.get(path)


def media_duration(leaf_info: Any) -> float:
    """Duration in seconds; falls back to a ~1MB/s estimate from file size."""
    if not isinstance(leaf_info, dict):
        return 0.0
    content = leaf_info.get("content_info") or {}
    media = content.get("media") or {} if isinstance(content, dict) else {}
    if not isinstance(media, dict):
        return 0.0
    duration = to_float(media.get("duration"))
    if duration <= 0:
        size = to_float(media.get("size"))
        if size > 0:
            duration = float(round(size / (1024 * 1024)))
    return duration
