# SPDX-License-Identifier: AGPL-3.0-or-later
"""安全微伴 (weiban.mycourse.cn) adapter.

Drives the vendored hangone/WeBan (GPL-3.0) client. Integration is done by
subclassing ``WeBanClient`` and monkeypatching, without editing upstream code:

* login captcha: CNN OCR first, then the image is shown in the GUI;
* exam questions missing from the bank: AI (shared config) → manual choice in
  the GUI (optional) → upstream random answer;
* stdin is a pipe, so upstream's non-interactive detection is forced off;
* ``WB_DATA_DIR`` points the answer bank at the app's writable data dir.
"""
from __future__ import annotations

import base64
import os
import re
import sys
import time
from typing import Any

from ... import ipc
from ...ai import AIClient
from ...context import Context

_loaded: dict[str, Any] = {}

COURSE_CATEGORY_FIELDS = (
    ("requiredNum", "requiredFinishedNum"),
    ("pushNum", "pushFinishedNum"),
    ("optionalNum", "optionalFinishedNum"),
)


# --------------------------------------------------------------------------- loading


def _load(ctx: Context) -> dict[str, Any]:
    """Import the upstream modules once, with the environment they expect."""
    if _loaded:
        return _loaded
    data_dir = ctx.platform_dir("weban")
    os.environ["WB_DATA_DIR"] = str(data_dir)
    os.environ.setdefault("WB_CAPTCHA_ROUNDS", str(ctx.options.get("captcha_rounds") or 2))
    vendor = str(ctx.vendor_dir / "weban")
    if vendor not in sys.path:
        sys.path.insert(0, vendor)
    # Upstream writes debug captcha images to a relative "logs" dir.
    os.chdir(data_dir)

    ipc.bridge_loguru()
    from loguru import logger

    def _captcha_notice(message) -> None:
        text = message.record["message"]
        if "请手动完成验证码" in text or "请在浏览器窗口中完成" in text:
            ipc.notify("notice", {
                "title": "需要手动完成验证",
                "message": "自动识别课程验证码失败，已打开一个浏览器窗口，请在其中完成图片点选验证，完成后任务会自动继续。",
            })

    logger.add(_captcha_notice, level="INFO", format="{message}")

    import captcha  # type: ignore
    import client  # type: ignore
    import api  # type: ignore

    # stdin is a pipe under the host; we *are* interactive through the GUI.
    captcha.is_non_interactive = lambda: False
    client.is_non_interactive = lambda: False

    _loaded.update(captcha=captcha, client=client, api=api, logger=logger)
    return _loaded


def _ai_config(ctx: Context) -> dict | None:
    if not ctx.ai.enabled:
        return None
    url = AIClient(ctx.ai)._url()
    base = url[: -len("/chat/completions")]
    return {
        "enable": True,
        "base_url": base,
        "api_key": ctx.ai.api_key,
        "model": ctx.ai.model,
        "timeout": int(ctx.ai.timeout),
        "max_retries": 2,
    }


def _make_client_class(mods: dict[str, Any]):
    WeBanClient = mods["client"].WeBanClient
    LoginCaptchaSolver = mods["captcha"].LoginCaptchaSolver

    class GuiWeBanClient(WeBanClient):  # type: ignore[misc, valid-type]
        manual_answer = False
        ocr_attempts = 5
        project_filter: set[str] | None = None

        # -- login: OCR, then ask the user in the GUI -----------------------
        def login(self):  # noqa: D401
            if self.api.user.get("userId"):
                return self.api.user
            manual_left = 5
            attempt = 0
            while True:
                ipc.check_cancel()
                attempt += 1
                verify_time = self.api.get_timestamp(13, 0)
                image = self.api.rand_letter_image(verify_time)
                if attempt <= self.ocr_attempts:
                    code = LoginCaptchaSolver.recognize(image, self.log)
                    if not code:
                        continue
                else:
                    if manual_left <= 0:
                        return None
                    manual_left -= 1
                    code = ipc.request("captcha_image", {
                        "title": "请输入登录验证码",
                        "hint": "自动识别失败，请手动输入图片中的 4 位字符",
                        "image": "data:image/png;base64," + base64.b64encode(image).decode(),
                    })
                    if code is None:
                        raise ipc.Cancelled()
                    code = str(code).strip()
                    if not code:
                        continue
                res = self.api.login(code, int(verify_time))
                if res.get("detailCode") == "67":
                    self.log.warning("验证码错误，重试")
                    continue
                if self.api.user.get("userId"):
                    return self.api.user
                msg = res.get("msg") or res.get("message") or str(res)
                raise ipc.LoginError(f"登录失败：{msg}")

        # -- exam: AI → manual (GUI) → upstream random ----------------------
        def _ai_search_question(self, question: dict) -> list:
            ids = super()._ai_search_question(question) if self.ai_config else []
            if ids or not self.manual_answer:
                return ids
            options = question.get("optionList") or []
            multiple = "多" in str(question.get("typeLabel", ""))
            picks = ipc.request("choice", {
                "title": "题库未收录，请手动作答",
                "question": question.get("title", ""),
                "kind": question.get("typeLabel", ""),
                "options": [o.get("content", "") for o in options],
                "multiple": multiple,
            })
            if not picks:
                return []
            return [options[i]["id"] for i in picks if isinstance(i, int) and 0 <= i < len(options)]

        # -- project filtering ---------------------------------------------
        def _get_project_list(self):
            projects = super()._get_project_list()
            if self.project_filter:
                projects = [p for p in projects if str(p.get("userProjectId")) in self.project_filter]
            return projects

        # -- progress reporting --------------------------------------------
        def get_progress(self, user_project_id, project_prefix, output=True):
            res = super().get_progress(user_project_id, project_prefix, output)
            try:
                d = res["data"]
                total = sum(int(d[n]) for n, _ in COURSE_CATEGORY_FIELDS) + int(d["examNum"])
                done = sum(int(d[f]) for _, f in COURSE_CATEGORY_FIELDS) + int(d["examFinishedNum"])
                ipc.progress("course", done, max(total, 1), str(project_prefix or "项目进度"), project_id=user_project_id)
                ipc.event("project_progress", project_id=user_project_id, data={k: d.get(k) for k in (
                    "requiredNum", "requiredFinishedNum", "pushNum", "pushFinishedNum",
                    "optionalNum", "optionalFinishedNum", "examNum", "examFinishedNum")})
            except Exception:  # noqa: BLE001
                pass
            return res

    return GuiWeBanClient


def _build_client(ctx: Context, require_login: bool = True):
    mods = _load(ctx)
    cls = _make_client_class(mods)
    tenant = str(ctx.account.get("tenant_name") or "").strip()
    username = str(ctx.account.get("username") or "").strip()
    password = str(ctx.credential.get("password") or "") or username
    token = str(ctx.credential.get("token") or "")
    user_id = str(ctx.credential.get("user_id") or ctx.account.get("user_id") or "")
    if not tenant and ctx.account.get("login_mode") != "browser":
        raise ipc.LoginError("请先选择学校")
    ipc.add_secret(token)
    ipc.add_secret(password)

    log = mods["logger"].bind(account=username or user_id)
    common = dict(
        log=log,
        browser_path=ctx.options.get("browser_path") or None,
        debug=ctx.debug,
        ai_config=_ai_config(ctx),
        video_speed=float(ctx.options.get("video_speed", 1) or 0),
        jupiter_fallback=bool(ctx.options.get("jupiter_fallback", False)),
    )
    client = None
    if token and user_id:
        client = cls(tenant, user={"userId": user_id, "token": token}, **common)
        try:
            info = client.api.my_get_info()
            if str(info.get("code")) != "0":
                raise PermissionError(str(info))
            client.api.user.update({k: v for k, v in (info.get("data") or {}).items() if k in ("realName", "userName", "batchCode")})
        except Exception as exc:  # noqa: BLE001
            ipc.log(f"保存的登录状态已失效，重新登录（{exc.__class__.__name__}）", "warn")
            client = None
    if client is None and (ctx.account.get("login_mode") == "browser" or (not username and ctx.action == "login")):
        if ctx.action != "login":
            raise ipc.LoginError("登录已失效，请点击“登录”在浏览器中重新登录")
        if ctx.options.get("server_mode"):
            raise ipc.LoginError("服务端部署无法弹出浏览器窗口：请把账号改为「学号密码」登录，或手动填写 Token 与 userId")
        client = _browser_client(ctx, mods, cls, common)
    if client is None:
        if not username:
            raise ipc.LoginError("登录已失效，请重新登录")
        client = cls(tenant, username, password, **common)
        client.ocr_attempts = int(ctx.options.get("ocr_attempts") or 5)
        if not client.login():
            raise ipc.LoginError("登录失败：验证码多次错误")
        user = client.api.user
        ipc.credential({"token": user.get("token"), "user_id": user.get("userId")})
        ipc.add_secret(str(user.get("token") or ""))
    client.manual_answer = bool(ctx.options.get("manual_answer", False))
    return client


def _browser_client(ctx: Context, mods: dict[str, Any], cls, common: dict):
    """Log in through a real browser window and build a client from the token."""
    from .browser_login import browser_login

    api_mod = mods["api"]

    def validate(user: dict) -> bool:
        try:
            a = api_mod.WeBanAPI(user={"userId": str(user["userId"]), "token": str(user["token"])})
            if user.get("tenantCode"):
                a.set_tenant_code(str(user["tenantCode"]))
            return str(a.my_get_info().get("code")) == "0"
        except Exception:  # noqa: BLE001
            return False

    user = browser_login(ctx, validate)
    token, user_id = str(user["token"]), str(user["userId"])
    ipc.add_secret(token)
    tenant = str(user.get("tenantName") or ctx.account.get("tenant_name") or "").strip()
    if not tenant and user.get("tenantCode"):
        res = api_mod.WeBanAPI().get_tenant_list_with_letter()
        for group in res.get("data", []) or []:
            for entry in group.get("list", []) or []:
                if str(entry.get("code")) == str(user["tenantCode"]):
                    tenant = str(entry.get("name", "")).strip()
    if not tenant:
        raise ipc.LoginError("已登录，但无法确定学校名称")
    client = cls(tenant, user={"userId": user_id, "token": token}, **common)
    client.api.user.update({k: user.get(k) for k in ("realName", "userName", "batchCode") if user.get(k)})
    ipc.credential({"token": token, "user_id": user_id})
    ipc.log(f"浏览器登录成功：{user.get('realName') or user.get('userName') or user_id}（{tenant}）", "success")
    # Let the host store the school name/user id for later runs.
    _account_fields.update({"tenant_name": tenant, "user_id": user_id, "login_mode": "browser"})
    return client


_account_fields: dict[str, Any] = {}


# --------------------------------------------------------------------------- actions


def list_tenants(ctx: Context) -> dict:
    mods = _load(ctx)
    res = mods["api"].WeBanAPI().get_tenant_list_with_letter()
    tenants = []
    for group in res.get("data", []) or []:
        for entry in group.get("list", []) or []:
            tenants.append({"code": entry.get("code"), "name": str(entry.get("name", "")).strip(), "letter": str(group.get("index") or "").upper()})
    if not tenants:
        raise RuntimeError(f"获取学校列表失败：{res.get('msg') or res}")
    return {"tenants": tenants}


def _user_info(client) -> dict:
    u = client.api.user
    return {"id": u.get("userId"), "name": u.get("realName") or u.get("userName") or u.get("nickName") or ""}


def login(ctx: Context) -> dict:
    client = _build_client(ctx)
    out: dict[str, Any] = {"user": _user_info(client)}
    if _account_fields:
        out["account_fields"] = dict(_account_fields)
    return out


def check(ctx: Context) -> dict:
    if not ctx.credential.get("token"):
        return {"valid": False}
    mods = _load(ctx)
    a = mods["api"].WeBanAPI(user={"userId": str(ctx.credential.get("user_id")), "token": str(ctx.credential.get("token"))})
    try:
        info = a.my_get_info()
        ok = str(info.get("code")) == "0"
        d = info.get("data") or {}
        return {"valid": ok, "user": {"id": ctx.credential.get("user_id"), "name": d.get("realName") or d.get("userName") or ""}}
    except Exception:  # noqa: BLE001
        return {"valid": False}


def list_courses(ctx: Context) -> dict:
    """WeBan works per *project* (安全教育项目); they are listed as courses."""
    client = _build_client(ctx)
    projects = client._get_project_list()
    courses = []
    for p in projects:
        pid = str(p.get("userProjectId") or "")
        progress = None
        try:
            d = client.api.show_progress(pid).get("data") or {}
            total = sum(int(d.get(n, 0)) for n, _ in COURSE_CATEGORY_FIELDS) + int(d.get("examNum", 0))
            done = sum(int(d.get(f, 0)) for _, f in COURSE_CATEGORY_FIELDS) + int(d.get("examFinishedNum", 0))
            progress = round(done * 100 / total) if total else 100
        except Exception:  # noqa: BLE001
            pass
        courses.append({
            "id": pid,
            "name": p.get("projectName") or "未命名项目",
            "progress": progress,
            "extra": {"end_time": p.get("endTime"), "category": p.get("projectCategory")},
        })
    return {"courses": courses, "user": _user_info(client)}


def run(ctx: Context) -> dict:
    o = ctx.options
    client = _build_client(ctx)
    ids = [str(i) for i in (o.get("course_ids") or []) if i]
    client.project_filter = set(ids) if ids else None
    study_mode = str(o.get("study_mode", "true")).lower()
    exam_mode = str(o.get("exam_mode", "true")).lower()
    study_time = str(o.get("study_time") or "20,10")
    if not re.fullmatch(r"\d+(,\d+)?", study_time):
        study_time = "20,10"

    started = time.time()
    ipc.log("模拟打开首页", "info")
    client.simulate_home_page()
    ipc.log("同步题库", "info")
    client.sync_answers()
    client.exam_mode = exam_mode
    client.run_project_cycle(
        study_time=study_time,
        study_mode=study_mode,
        exam_mode=exam_mode,
        random_answer=bool(o.get("random_answer", True)),
        exam_question_time=str(o.get("exam_question_time") or "3,3"),
        exam_submit_match_rate=int(o.get("exam_submit_match_rate") or 90),
    )
    client.sync_answers()
    return {"summary": {"projects": len(ids) or None, "elapsed": round(time.time() - started)}}


ACTIONS = {
    "list_tenants": list_tenants,
    "login": login,
    "check": check,
    "list_courses": list_courses,
    "run": run,
}
