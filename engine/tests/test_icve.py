# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for the ICVE adapters. No network access is performed."""
from __future__ import annotations

import http.client
import json
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path

from shuake_engine import ipc
from shuake_engine.adapters.icve import ai_mooc, common, new_mooc, sso
from shuake_engine.context import AIConfig, Context

VENDOR_DIR = Path(__file__).resolve().parents[1] / "vendor" / "mooc_work_answer"


def setUpModule() -> None:
    common.prepare(VENDOR_DIR, debug=False)


class TestOnclickParsing(unittest.TestCase):
    def test_parses_standard_call(self) -> None:
        from NewMoocMain.init_mooc import parse_open_learn_res_item

        self.assertEqual(
            parse_open_learn_res_item("openLearnResItem('abc-123','video');"),
            ("abc-123", "video"),
        )

    def test_parses_quotes_and_extra_args(self) -> None:
        from NewMoocMain.init_mooc import parse_open_learn_res_item

        self.assertEqual(
            parse_open_learn_res_item('openLearnResItem( "x1" , "topic", 1, 2 )'),
            ("x1", "topic"),
        )

    def test_rejects_arbitrary_javascript(self) -> None:
        from NewMoocMain.init_mooc import parse_open_learn_res_item

        self.assertIsNone(parse_open_learn_res_item("alert(document.cookie)"))
        self.assertIsNone(parse_open_learn_res_item("__import__('os').system('id')"))


class TestSsoCallbackServer(unittest.TestCase):
    def setUp(self) -> None:
        ipc.cancel_event.clear()

    def test_binds_localhost_and_receives_token(self) -> None:
        server = sso.SsoCallbackServer()
        try:
            auth_url = server.start()
            self.assertIn("sso.icve.com.cn/sso/auth", auth_url)
            self.assertEqual(server.host, "127.0.0.1")
            self.assertGreaterEqual(server.port, 30000)
            self.assertLessEqual(server.port, 65535)

            # fragment 中转页：没有 token 时返回 JS relay 页面
            conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
            conn.request("GET", "/login")
            relay = conn.getresponse()
            body = relay.read().decode("utf-8")
            self.assertEqual(relay.status, 200)
            self.assertIn("location.hash", body)

            conn.request("GET", "/login?token=abc")
            response = conn.getresponse()
            page = response.read().decode("utf-8")
            conn.close()
            self.assertEqual(response.status, 200)
            self.assertIn("登录成功", page)
            self.assertEqual(server.wait(1), "abc")
        finally:
            server.close()


class _FakeAI:
    enabled = True

    def answer_choice(self, question, options, multiple=False, kind=""):
        if kind == "多选题":
            return [0, 2]
        if kind == "判断题":
            return [0]
        return [1]

    def chat(self, messages, max_tokens=512, json_mode=False, temperature=0.1):
        return '{"answers": ["foo", "bar"]}'


class TestAIExamHandler(unittest.TestCase):
    def test_disabled_returns_empty(self) -> None:
        from ai.ai_exam_handler import AIExamHandler, set_ai_config

        set_ai_config(AIConfig(enabled=False))
        handler = AIExamHandler("token", verbose=False, auto_delete_chat=True)
        self.assertFalse(handler.load_agents())
        self.assertEqual(handler.process_exam([{"id": "q", "type": "单选题"}], False), [])
        handler.ai_handler.cleanup_all_chats()  # 必须存在且不抛异常

    def test_answer_mapping_with_fake_client(self) -> None:
        from ai.ai_exam_handler import AIExamHandler

        questions = [
            {
                "id": "q1",
                "type": "单选题",
                "answer_type": "singlechoice",
                "text": "1+1=?",
                "options": [
                    {"value": "A", "label": "A", "text": "1"},
                    {"value": "B", "label": "B", "text": "2"},
                ],
            },
            {
                "id": "q2",
                "type": "多选题",
                "answer_type": "multichoice",
                "text": "选出偶数",
                "options": [
                    {"value": "A", "label": "A", "text": "2"},
                    {"value": "B", "label": "B", "text": "3"},
                    {"value": "C", "label": "C", "text": "4"},
                ],
            },
            {
                "id": "q3",
                "type": "判断题",
                "answer_type": "bijudgement",
                "text": "地球是圆的",
                "options": [
                    {"value": "1", "label": "正确", "text": "正确"},
                    {"value": "0", "label": "错误", "text": "错误"},
                ],
            },
            {
                "id": "q4",
                "type": "填空题",
                "answer_type": "fillblank",
                "text": "____ 和 ____",
                "blank_count": 2,
            },
        ]
        handler = AIExamHandler("token", client=_FakeAI())
        self.assertTrue(handler.load_agents())
        answers = handler.process_exam(questions, False)
        self.assertEqual(
            answers,
            [
                {"questionId": "q1", "questionType": "singlechoice", "answer": "B"},
                {"questionId": "q2", "questionType": "multichoice", "answer": "A,C"},
                {"questionId": "q3", "questionType": "bijudgement", "answer": "1"},
                {
                    "questionId": "q4",
                    "questionType": "fillblank",
                    "answer": json.dumps(["foo", "bar"], ensure_ascii=False, separators=(",", ":")),
                },
            ],
        )


class TestLogger(unittest.TestCase):
    def test_logger_does_not_create_file_or_handlers(self) -> None:
        from MoocMain.log import Logger

        old_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            try:
                log = Logger("icve-test").get_log()
                log.info("hello from test")
                for handler in log.handlers:
                    handler.flush()
                self.assertEqual(log.handlers, [])
                self.assertTrue(log.propagate)
                self.assertEqual(log.getEffectiveLevel(), logging.INFO)
                self.assertEqual(list(Path(tmp).glob("mooc-work-answer-log_*.log")), [])
            finally:
                os.chdir(old_cwd)


class TestVendorPreparation(unittest.TestCase):
    def test_adapters_insert_vendor_subdir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ctx = Context(platform="icve_ai", action="run", data_dir=Path(tmp))
            ai_mooc._prepare(ctx)
            new_mooc._prepare(ctx)
        self.assertIn(str(VENDOR_DIR.resolve()), [str(Path(p).resolve()) for p in sys.path])


class TestMissingCredential(unittest.TestCase):
    def test_ai_list_courses_raises_login_error(self) -> None:
        ctx = Context(platform="icve_ai", action="list_courses")
        with self.assertRaises(ipc.LoginError):
            ai_mooc.list_courses(ctx)

    def test_mooc_list_courses_raises_login_error(self) -> None:
        ctx = Context(platform="icve_mooc", action="list_courses")
        with self.assertRaises(ipc.LoginError):
            new_mooc.list_courses(ctx)


if __name__ == "__main__":
    unittest.main()
