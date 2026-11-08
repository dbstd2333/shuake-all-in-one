# Python 引擎开发约定

Go 宿主每执行一个动作（登录、列课程、运行任务等），就启动一个独立的 Python 子进程：

```
<内置python> -I -X utf8 -u engine/bootstrap.py
```

双方通过 stdin/stdout 交换 **JSON Lines**（每行一个 JSON 对象）。下面依次说明运行方式、协议格式和编写适配器的规则。

## 1. 运行与调试

```bash
python3 scripts/prepare_runtime.py          # 准备内置运行时，生成 build/runtime/<os>-<arch>/python
PY=build/runtime/darwin-arm64/python/bin/python3
(echo '{"type":"start","platform":"diagnostic","action":"run","options":{"steps":3}}'; sleep 5) \
  | $PY -I -X utf8 -u engine/bootstrap.py
$PY -I -m pytest engine/tests     # 测试；需要在 engine/ 目录下执行，或者把 engine/ 加进 sys.path
```

注意：**stdin 一旦关闭，引擎就认为宿主已经退出，会按"已取消"处理**。所以手动调试时，要在管道里用 `sleep` 让 stdin 保持打开。

## 2. 启动消息（宿主 → 引擎的第一行）

```json
{"type":"start","platform":"weban","action":"run",
 "account":{"username":"..."},            // 非敏感的账号字段
 "credential":{"token":"..."},            // 上次保存的凭证或密码；可能为空
 "options":{"course_ids":["..."]},        // GUI 中选择的选项
 "ai":{"enabled":true,"base_url":"https://api.deepseek.com","api_key":"...","model":"deepseek-chat"},
 "data_dir":"/Users/x/Library/Application Support/ShuakeAIO",
 "debug":false}
```

启动消息之后，宿主还可能发送两种消息：

- `{"type":"reply","id":"r3","value":...}`：回复引擎发出的请求
- `{"type":"cancel"}`：取消任务

## 3. 引擎 → 宿主的消息

所有输出都要通过 `shuake_engine.ipc` 提供的函数发出。

| 函数 | 生成的消息 | 用途 |
|---|---|---|
| `ipc.log(msg, level)` | `{"type":"log","level","msg","ts"}` | 日志。level 取值：debug / info / success / warn / error |
| `ipc.progress(scope, cur, total, label, eta=None)` | `progress` | 进度。scope 取值：`overall`（课程级）、`course`（课程内条目）、`item`（单个条目内部，如视频心跳） |
| `ipc.event(name, **data)` | `event` | 关键节点。例如 `course_start` / `course_done` / `item_done` / `exam_score` / `notice` |
| `ipc.request(kind, payload)` | `request` + `request_done` | **阻塞**等待用户回复，返回回复的 value |
| `ipc.notify(kind, payload)` / `ipc.dismiss(id)` | 非阻塞的 `request` | 例如显示二维码，同时继续轮询 |
| `ipc.credential(dict)` | `credential` | 登录成功后回传凭证，宿主会合并后加密保存，下次放在 `ctx.credential` 里传回来 |
| 动作函数的返回值 | `result` | 例如 `{"courses":[...]}`、`{"summary":{...}}` |
| 抛出 `ipc.LoginError` | `error` + 退出码 2 | 登录失败 |
| 抛出其他异常 | `error` + 退出码 1 | 其他错误 |
| `{"type":"open_url","url"}` | | 由 `webbrowser.open` 的补丁自动发出，宿主收到后用系统浏览器打开 |

### `request` 的 kind 和 payload

| kind | payload | 回复的 value |
|---|---|---|
| `captcha_image` | `{title, image: "data:image/png;base64,..." , hint?}` | 字符串；`null` 表示用户取消 |
| `qrcode` | `{title, image?: dataURL, url?: "要编码成二维码的内容", hint?}` | 一般用 `notify` 非阻塞显示，扫码成功后 `dismiss` |
| `text` | `{prompt, title?, default?, multiline?}` | 字符串 |
| `choice` | `{title, question, options:[str], multiple}` | 0 基的序号数组 |
| `confirm` | `{title, message}` | bool |
| `image` / `notice` | `{title, message?, image?}` | 只用 `notify` 发出，不需要回复 |

## 4. 适配器规范

每个平台对应一个模块，模块里导出 `ACTIONS: dict[str, Callable[[Context], Any]]`，在 `shuake_engine/main.py` 的 `PLATFORMS` 里登记。

| 动作 | 是否必须 | 说明 |
|---|---|---|
| `login` | 必须 | 交互式登录，成功后调用 `ipc.credential`，返回 `{"user":{"name":..., "id":...}}` |
| `check` | 可选 | 用 `ctx.credential` 校验登录状态，返回 `{"valid":bool,"user":{...}}` |
| `list_courses` | 必须 | 返回 `{"courses":[{"id","name","progress"?(0-100),"extra"?:{...}}]}`。凭证失效时可以在这里重新登录 |
| `run` | 必须 | 按 `ctx.options["course_ids"]` 执行，返回 `{"summary":{...}}` |

`ipc.install_patches()` 在适配器加载**之前**就已经生效，它替换了以下调用：

- `time.sleep`：改成可取消的版本，取消时抛出 `ipc.Cancelled`。它继承自 `BaseException`，所以不会被 `except Exception` 吞掉
- `input()`：改成 `request("text")`，由 GUI 输入
- `exit()` / `sys.exit()`：改成抛出 `ipc.EngineExit`
- `webbrowser.open`：网页链接发 `open_url`；本地图片会被当作验证码图片显示在 GUI 里
- `print` / stdout / stderr：转成 `log` 消息，不会破坏 JSON 流
- 标准库 `logging`：同样转成 `log` 消息；loguru 需要调用 `ipc.bridge_loguru()` 才会转

编写适配器时要遵守以下规则：

- 长循环里要调用 `ipc.check_cancel()`。等待一律用 `ipc.sleep()`，或者直接用 `time.sleep()`（已经被替换成可取消版本）。
- 不要把密码、token 打进日志。`ipc.add_secret()` 注册过的字符串会被自动打码。
- 需要持久化的文件（题库、缓存）写到 `ctx.platform_dir()` 下面。
- AI 答题统一使用 `shuake_engine.ai.AIClient(ctx.ai)`，调用 `.answer_choice(question, options, multiple)`，返回 0 基序号；未启用 AI 时返回空列表。
- 上游代码放在 `engine/vendor/<name>`。对上游的修改尽量用 monkeypatch 实现；确实需要改源码时，改完要在 `engine/patches/<name>/` 里留一份 diff 说明。
