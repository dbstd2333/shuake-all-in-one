# SPDX-License-Identifier: AGPL-3.0-or-later
import unittest

from shuake_engine.ai import AIClient, strip_think, thinking_params
from shuake_engine.context import AIConfig


class FakeResp:
    def __init__(self, status: int, data: dict | None = None, text: str = "") -> None:
        self.status_code = status
        self._data = data or {}
        self.text = text

    def json(self) -> dict:
        return self._data

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            import requests

            raise requests.HTTPError(response=self)  # type: ignore[arg-type]


class FakeSession:
    def __init__(self, responses: list[FakeResp]) -> None:
        self.responses = responses
        self.bodies: list[dict] = []
        self.timeouts: list[float] = []

    def post(self, url, json=None, headers=None, timeout=None):  # noqa: A002
        self.bodies.append(dict(json))
        self.timeouts.append(timeout)
        return self.responses.pop(0)


def ok(content: str) -> FakeResp:
    return FakeResp(200, {"choices": [{"message": {"content": content}}]})


def client(provider: str, thinking: str, responses: list[FakeResp]) -> tuple[AIClient, FakeSession]:
    cfg = AIConfig(enabled=True, base_url="https://x", model="m", provider=provider, thinking=thinking)
    c = AIClient(cfg, max_retries=0)
    s = FakeSession(responses)
    c.session = s  # type: ignore[assignment]
    return c, s


class ThinkingParamsTest(unittest.TestCase):
    def test_deepseek(self) -> None:
        self.assertEqual(thinking_params("deepseek", "off"), {"thinking": {"type": "disabled"}})
        self.assertEqual(thinking_params("deepseek", "low"), {"thinking": {"type": "enabled"}, "reasoning_effort": "low"})
        self.assertEqual(thinking_params("deepseek", "medium")["reasoning_effort"], "high")
        self.assertEqual(thinking_params("deepseek", "max")["reasoning_effort"], "max")

    def test_aliyun(self) -> None:
        self.assertEqual(thinking_params("aliyun", "off"), {"enable_thinking": False})
        self.assertEqual(thinking_params("aliyun", "low"), {"enable_thinking": True, "thinking_budget": 1024})
        self.assertEqual(thinking_params("aliyun", "max"), {"enable_thinking": True})

    def test_custom_and_default(self) -> None:
        self.assertEqual(thinking_params("custom", ""), {})
        self.assertEqual(thinking_params("custom", "high"), {"reasoning_effort": "high"})
        self.assertEqual(thinking_params("deepseek", "bogus"), {})


class ChatTest(unittest.TestCase):
    def test_thinking_raises_max_tokens_and_timeout(self) -> None:
        c, s = client("aliyun", "low", [ok("{\"answers\": [2]}")])
        self.assertEqual(c.answer_choice("q", ["a", "b"]), [1])
        body = s.bodies[0]
        self.assertTrue(body["enable_thinking"])
        self.assertEqual(body["max_tokens"], 200 + 4096)
        self.assertGreaterEqual(s.timeouts[0], 90)

    def test_off_keeps_small_budget(self) -> None:
        c, s = client("deepseek", "off", [ok("A")])
        self.assertEqual(c.answer_choice("q", ["a", "b"]), [0])
        self.assertEqual(s.bodies[0]["max_tokens"], 200)
        self.assertEqual(s.bodies[0]["thinking"], {"type": "disabled"})

    def test_400_drops_optional_fields(self) -> None:
        c, s = client("aliyun", "low", [FakeResp(400, text="json mode"), FakeResp(400, text="budget"), ok("1")])
        self.assertEqual(c.chat([{"role": "user", "content": "x"}], json_mode=True), "1")
        self.assertIn("response_format", s.bodies[0])
        self.assertNotIn("response_format", s.bodies[1])
        self.assertIn("thinking_budget", s.bodies[1])
        self.assertNotIn("thinking_budget", s.bodies[2])
        self.assertTrue(s.bodies[2]["enable_thinking"])
        # remembered for the next call
        s.responses.append(ok("2"))
        c.chat([{"role": "user", "content": "y"}], json_mode=True)
        self.assertNotIn("response_format", s.bodies[3])

    def test_401_fails_fast(self) -> None:
        cfg = AIConfig(enabled=True, base_url="https://x", model="m", provider="deepseek", thinking="off")
        c = AIClient(cfg, max_retries=3)
        s = FakeSession([FakeResp(401, text="bad key")])
        c.session = s  # type: ignore[assignment]
        with self.assertRaises(RuntimeError) as cm:
            c.chat([{"role": "user", "content": "x"}])
        self.assertIn("401", str(cm.exception))
        self.assertEqual(len(s.bodies), 1)

    def test_strip_think(self) -> None:
        self.assertEqual(strip_think("<think>hmm</think>\n{\"answers\":[1]}"), "{\"answers\":[1]}")
        self.assertEqual(strip_think("reasoning...</think>B"), "B")


if __name__ == "__main__":
    unittest.main()
