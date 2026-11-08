<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# mooc_work_answer vendor patch notes

- Upstream: https://github.com/11273/mooc-work-answer
- Commit: `aa87320f6cda73a8ed363dd1e4e3cb6fe4b9c61b`
- Modified files:
  - `NewMoocMain/init_mooc.py` — diff: [`init_mooc.patch`](./init_mooc.patch)
  - `AIMoocMain/main.py` — diff: [`ai_mooc_main.patch`](./ai_mooc_main.patch)

All changes are deliberately small and keep the upstream function names/semantics so
`StartWork.py` continues to work unchanged. The adapter never imports `StartWork.py`
(because it imports tkinter via `update.py`).

## 1. Replace `eval(onclick)` with a strict parser

Upstream executed arbitrary JavaScript taken from the course page:

```python
eval(get_xpath_text(s_point[k], "./@onclick").replace(";", ""))
```

This is remote code execution: a compromised/changed page could run anything in the
engine process. It is replaced by `parse_open_learn_res_item()` which only accepts

```python
openLearnResItem('item-id', 'video')
```

and then calls `openLearnResItem(id, type)` directly. Anything else is logged and
skipped. (Both chapter layouts — with and without `s_pointwrap` — were changed.)

## 2. Bound recursive retries

The following functions retried forever by calling themselves. Each now takes a
private `_retry` counter and raises `RuntimeError` after 5 attempts:

- `is_login`
- `student_mooc_select_mooc_course`
- `sign_learn`
- `learning_time_save_video_learn_time_long_record`
- `learning_time_save_learning_time`
- `video_learn_record_detail`
- `course_topic_action` (both the inner discussion-page fetch and the reply POST)

The retry sleeps are unchanged (1s/10s/60s/160s).

## 3. `exit(...)` → `raise`

- `auth()` failure: `input('程序退出'); exit(0)` → `raise RuntimeError(...)`
- `run()` with no courses: `exit(0)` → `raise RuntimeError("未查询到需要学习的课程！")`
- The adapter catches the two "no course" messages and reports an empty summary.

## 4. Clearer `alicfw` prompt

The `input()` call stays (the engine patches `input()` into a GUI text dialog), but the
prompt now explains how to obtain the cookie value:

> 请在浏览器打开课程学习页，控制台执行 `(await cookieStore.get('alicfw')).value`
> 并粘贴结果（24 小时有效，获取方法见 README_ALICFW.md）

## 5. Only process selected courses

`run()` gained a keyword-only-compatible `course_ids=None` parameter. When it is not
empty, courses are filtered by `course[6]` (the course id returned by
`student_mooc_select_mooc_course`). `StartWork.py` does not pass it, so the interactive
behaviour is unchanged.

## 6. Fix `load_mooc` token URL

Upstream used `?token=${token}`, which sends a literal `$` before the token. The
adapter needs the real token, so it now uses `params={"token": token}` (same URL,
proper URL encoding).

## 7. Host progress/event callbacks and per-course isolation

`run()` accepts optional `progress_cb` / `event_cb`. They are module-level globals
(`progress_callback`, `event_callback`) so vendor code keeps no hard dependency on
`shuake_engine`:

- chapter loop → `progress("course", chapter_index, chapter_count, title)`
- video segment loop → `progress("item", end_seconds, total_seconds, title)`
- audio → one `progress("item", ...)`
- each course → `event("course_start"/"course_done")` + `progress("overall", ...)`
- exam auto-submit → `event("exam_score", score=..., examId=..., name=...)`

The course body was moved into `_process_course()` so a failure in one course is
logged and the remaining courses still run. A single resource was already isolated by
`openLearnResItem`'s own `try/except` in upstream.

## 8. Initialise `url_short` in `AIMoocMain/main.py`

`AIMoocHandler.handle_resource()` used `url_short` before assignment when a resource
had an empty `fileUrl` (e.g. a video node with missing metadata), raising
`UnboundLocalError` and losing the whole resource. Added `url_short = None`; this is a
one-line robustness fix only.

## 9. New `ai/` package (not a modification of upstream files)

Upstream `NewMoocMain/init_mooc.py` imports `ai.ai_exam_handler.AIExamHandler`, but the
module is absent from the redistributed tree. Added:

- `ai/__init__.py`
- `ai/ai_exam_handler.py`

Inferred interface from all call sites:

```python
handler = AIExamHandler(token, verbose=False, auto_delete_chat=True)
handler.ai_handler.cleanup_all_chats()
handler.load_agents() -> bool
handler.process_exam(questions, use_auto_submit) -> list[dict]
```

`questions` is the output of `icve_exam_parser.parse_exam_questions` (fields:
`id`, `number`, `type`, `answer_type`, `text`, `score`, `options[].value/label/text`,
`blank_count`). The returned list is passed to `save_exam_answers()`, which does
`json.dumps(answers)` into the `studentAnswers` form field. Each answer is therefore:

```json
{"questionId": "<id>", "questionType": "<answer_type>", "answer": "<serialized answer>"}
```

- single choice → option `value` (fallback `label`)
- multiple choice → option `value`s joined with `,`
- judgement → option `value` (fallback `label`)
- fill blank → one blank: plain text; multiple: compact JSON array string
- short answer/essay → AI text
- matching/other → skipped

The handler uses `shuake_engine.ai.AIClient`; the adapter injects the config with
`set_ai_config(ctx.ai)`. With AI disabled, `load_agents()` returns `False` and
`process_exam()` returns `[]` without raising.

### Uncertainty

The exact server-side schema of `spoc-exam.icve.com.cn/exam/examflow_sendManyAnswer`
could not be verified from public sources, and the site is not resolvable from the dev
environment. `questionId/questionType/answer` is the minimal shape consistent with the
parser and with `init_mooc.run()`'s `json.dumps(ai_answers)`; the upstream project does
not contain a reference implementation either. If the platform rejects the payload,
only `AIExamHandler.process_exam()` needs adjusting — no adapter change.
