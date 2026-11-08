# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for the XuetangX adapter.

Ported from dbstd2333/xuetangx-js (AGPL-3.0); only exercised against mocks.
"""
from __future__ import annotations

import unittest
from unittest import mock

from shuake_engine.adapters.xuetangx import api as api_module
from shuake_engine.adapters.xuetangx import video
from shuake_engine.adapters.xuetangx.api import ApiClient, ApiError, parse_retry_after, with_retry
from shuake_engine.adapters.xuetangx.course import (
    flatten_leaves,
    normalize_course_list,
    normalize_schedule,
    parse_course_url,
)
from shuake_engine.adapters.xuetangx.exercise import indexes_to_keys


class TestCourseUrl(unittest.TestCase):
    def test_standard_url(self):
        parsed = parse_course_url("https://www.xuetangx.com/learn/THU12345/THU12345/1234567/video/1")
        self.assertEqual(parsed, {"sign": "THU12345", "classroom_id": "1234567"})

    def test_space_url(self):
        parsed = parse_course_url("https://www.xuetangx.com/learn/space/PKU001/PKU001/7654321")
        self.assertEqual(parsed, {"sign": "PKU001", "classroom_id": "7654321"})

    def test_invalid_url(self):
        self.assertIsNone(parse_course_url("https://www.xuetangx.com/course/abc"))
        self.assertIsNone(parse_course_url(""))


class TestFlattenLeaves(unittest.TestCase):
    def test_nested_and_section_leaf(self):
        chapters = [
            {
                "chapter_name": "第一章",
                "section_leaf_list": [
                    {
                        "section_name": "1.1",
                        "leaf_list": [
                            {"id": 11, "name": "视频一", "leaf_type": 0},
                            {"id": 12, "name": "习题一", "leaf_type": 6},
                        ],
                    },
                    {"section_name": "1.2", "id": 13, "name": "图文一", "leaf_type": 3},
                    {"section_name": "空小节", "leaf_list": []},
                ],
            },
            {
                "chapter_name": "第二章",
                "section_leaf_list": [
                    {"section_name": "2.1", "leaf_list": [{"id": 21, "name": "讨论", "leaf_type": 4}]}
                ],
            },
        ]
        leaves = flatten_leaves(chapters)
        self.assertEqual([leaf["id"] for leaf in leaves], [11, 12, 13, 21])
        self.assertEqual(leaves[0]["chapter_name"], "第一章")
        self.assertEqual(leaves[0]["section_name"], "1.1")
        self.assertEqual(leaves[2]["section_name"], "1.2")

    def test_tolerates_bad_shapes(self):
        self.assertEqual(flatten_leaves(None), [])
        self.assertEqual(flatten_leaves([{"section_leaf_list": "oops"}]), [])
        self.assertEqual(flatten_leaves(["bad", 3]), [])


class TestSchedule(unittest.TestCase):
    def test_normalize_variants(self):
        self.assertEqual(normalize_schedule({"10": 1, "11": "0"}), {"10": 1, "11": "0"})
        self.assertEqual(
            normalize_schedule([{"leaf_id": 10, "schedule": 1}, {"id": 11, "status": "0.5"}]),
            {"10": 1, "11": "0.5"},
        )
        self.assertEqual(normalize_schedule("bad"), {})

    def test_course_list_normalization(self):
        courses = normalize_course_list(
            {
                "course_list": [
                    {"course_name": "课程A", "product_sign": "S1", "classroom_id": 11},
                    {"name": "课程B", "sign": "S2", "cid": "22", "learn_progress": 0.5},
                    {"course_name": "缺字段"},
                ]
            }
        )
        self.assertEqual([course["name"] for course in courses], ["课程A", "课程B"])
        self.assertEqual(courses[1]["classroom_id"], "22")
        self.assertEqual(courses[1]["progress"], 50.0)


class TestHeartbeat(unittest.TestCase):
    class _RecordingClient:
        def __init__(self):
            self.batches = []

        def send_heartbeat(self, entries):
            self.batches.append(entries)

    def _run(self, duration=150):
        client = self._RecordingClient()
        with mock.patch.object(video.ipc, "sleep", lambda seconds: None), mock.patch.object(
            video.ipc, "progress"
        ) as progress:
            count = video.simulate_playback(
                client,
                user_id=7,
                course_id=8,
                leaf_id=9,
                classroom_id=10,
                duration=duration,
                video_type="video",
                sku_id=11,
                leaf_name="测试视频",
            )
        entries = [entry for batch in client.batches for entry in batch]
        return count, entries, progress

    def test_sequence(self):
        count, entries, progress = self._run(150)
        self.assertEqual(count, 5)
        self.assertEqual(
            [entry["et"] for entry in entries],
            ["play", "heartbeat", "heartbeat", "heartbeat", "videoend"],
        )
        self.assertEqual([entry["cp"] for entry in entries], [0, 60, 120, 150, 150])
        self.assertEqual([entry["sq"] for entry in entries], [1, 2, 3, 4, 5])
        self.assertEqual(entries[0]["i"], 30)
        self.assertEqual(entries[0]["sp"], 2)
        self.assertEqual(entries[0]["p"], "web")
        self.assertEqual(entries[0]["t"], "video")
        self.assertEqual(entries[0]["n"], "qn1-next.xuetangonline.com")
        self.assertIsInstance(entries[0]["ts"], int)
        self.assertTrue(entries[0]["pg"].startswith("9_"))
        self.assertEqual(progress.call_count, 3)

    def test_cp_never_exceeds_duration(self):
        _, entries, _ = self._run(130)
        self.assertTrue(all(entry["cp"] <= 130 for entry in entries))
        self.assertEqual(entries[-1]["et"], "videoend")
        self.assertEqual(entries[-1]["cp"], 130)

    def test_zero_duration_sends_nothing(self):
        count, entries, _ = self._run(0)
        self.assertEqual(count, 0)
        self.assertEqual(entries, [])

    def test_duration_from_size(self):
        info = {"content_info": {"media": {"duration": 0, "size": 10 * 1024 * 1024}}}
        self.assertEqual(video.media_duration(info), 10.0)
        self.assertEqual(video.media_duration({"content_info": {"media": {"duration": "42"}}}), 42.0)
        self.assertEqual(video.media_duration({}), 0.0)


class TestRetry(unittest.TestCase):
    class _Response:
        def __init__(self, status_code=200, text="", body=None):
            self.status_code = status_code
            self.text = text
            self._body = body if body is not None else {}

        def json(self):
            return self._body

    class _Session:
        def __init__(self, responses):
            self.responses = list(responses)
            self.headers = {}

        def request(self, *args, **kwargs):
            return self.responses.pop(0)

    def test_parse_retry_after(self):
        self.assertEqual(parse_retry_after("Expected available in 12.5 seconds"), 12.5)
        self.assertEqual(parse_retry_after("expected available in 3 second"), 3.0)
        self.assertIsNone(parse_retry_after("rate limited"))

    def test_429_waits_ceil_seconds_plus_two(self):
        session = self._Session(
            [
                self._Response(429, "Expected available in 3 seconds"),
                self._Response(200, '{"data": {"ok": true}}', {"data": {"ok": True}}),
            ]
        )
        sleeps = []
        client = ApiClient(session=session)
        with mock.patch.object(api_module.ipc, "sleep", side_effect=sleeps.append), mock.patch.object(
            api_module.ipc, "log"
        ):
            result = client.get("/api/v1/test")
        self.assertEqual(result, {"data": {"ok": True}})
        self.assertEqual(sleeps, [5])

    def test_other_errors_backoff_five_times_attempt(self):
        session = self._Session(
            [
                self._Response(500, "boom"),
                self._Response(502, "boom"),
                self._Response(200, "{}", {}),
            ]
        )
        sleeps = []
        client = ApiClient(session=session)
        with mock.patch.object(api_module.ipc, "sleep", side_effect=sleeps.append), mock.patch.object(
            api_module.ipc, "log"
        ):
            client.get("/api/v1/test")
        self.assertEqual(sleeps, [5, 10])

    def test_gives_up_after_three_attempts(self):
        calls = []

        def fail():
            calls.append(1)
            raise ApiError(503, "nope")

        with mock.patch.object(api_module.ipc, "sleep", lambda seconds: None), mock.patch.object(api_module.ipc, "log"):
            with self.assertRaises(ApiError):
                with_retry(fail)
        self.assertEqual(len(calls), 3)


class TestAnswerKey(unittest.TestCase):
    def test_indexes_map_to_letter_keys(self):
        options = [{"key": "A", "value": "1"}, {"key": "B", "value": "2"}, {"key": 3, "value": "3"}]
        self.assertEqual(indexes_to_keys(options, [0, 2]), ["A", "3"])
        self.assertEqual(indexes_to_keys(options, [2, 0, 0, 9, -1]), ["3", "A"])

    def test_invalid_indexes_are_dropped(self):
        self.assertEqual(indexes_to_keys([{"key": "A"}], []), [])
        self.assertEqual(indexes_to_keys([{"key": "A"}], [5]), [])
        self.assertEqual(indexes_to_keys([], [0]), [])


if __name__ == "__main__":
    unittest.main()
