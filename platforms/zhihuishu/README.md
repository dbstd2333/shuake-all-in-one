# 智慧树（zhihuishu.com）学习页驱动

把「智慧树」纳入 All-in-One 的平台模块：用**真实浏览器播放**推进课程视频，播完自动切下一节，可本机常驻、也可作 JSON Lines 子进程被 Go 宿主调度。

- 运行时只需 **Node 20+** 和 **Chrome/Chromium**，无 npm 依赖
- 默认 headless，适合服务器 7×24 挂着跑
- 不做任何进度伪造：视频是实打实播完的，只省掉「盯着看 + 手动点下一节」

## 为什么不是 Lightpanda

Lightpanda 能挂载这个 Vue SPA（DOM、课程数据都正常），但它没有媒体管线：

| 能力 | Lightpanda 1.0 nightly | Chrome headless |
|---|---|---|
| `MediaSource` / `AudioContext` | `undefined` | 可用 |
| `video.play()` | 返回成功、`paused=false` | 正常 |
| `currentTime` 推进 | **永远 0** | 5s 推进 4.96s |

`currentTime` 不走，就不会触发 `ended`，也就无所谓「下一节」。所以播放这一环只能交给真浏览器。
（如果只是抓课程结构/做接口调试，Lightpanda 仍可用，但要 `--http-timeout 0`——主 bundle 有 4.3MB、源站要 ~37s 才吐完。）

## 两个必须知道的坑

1. **不能用 `element.click()`**
   合成事件的 `isTrusted=false`，智慧树会直接把页面重定向到 `www.zhihuishu.com`（看起来像"掉登录"，其实是风控）。必须走 CDP `Input.dispatchMouseEvent` 派发真实鼠标事件。

2. **headless 默认视口只有 ~756px**
   侧栏章节项 `getBoundingClientRect()` 全为 0，点击坐标退化成 (0,0)。必须先 `Emulation.setDeviceMetricsOverride` 到 1600×1000，且**页面加载后要再打一次**（override 有时不跨导航保留）。

另外：页面在视频播完后**什么都不做**，没有自动跳转，所以「下一节」本来就得自己点。

## 快速开始

```bash
cd platforms/zhihuishu

# 1. 从已登录的 Chrome 导出 Cookie（会读系统钥匙串解密）
node bin/cli.mjs cookies
node bin/cli.mjs cookies --profile "~/Library/Application Support/Google/Chrome/Default" --out ./cookies.json

# 2. 自检：页面能不能挂载、播放器状态是否正常
node bin/cli.mjs probe --url "https://wisdom-mooc.zhihuishu.com/study/index?recruitAndCourseId=xxxx"

# 3. 正式跑
cp config.example.json config.json   # 填 courses
node bin/cli.mjs run --config config.json

# 4. 看状态
node bin/cli.mjs status
curl localhost:8790/status
```

单门课临时跑一下：

```bash
node bin/cli.mjs run --url "https://wisdom-mooc.zhihuishu.com/study/index?recruitAndCourseId=xxxx"
# 快速验证链路（会拖动进度条，别用来真刷）
node bin/cli.mjs run --url "..." --seek-test --max-sections 2
```

## 配置

见 `config.example.json`。要点：

| 字段 | 说明 |
|---|---|
| `courses[].url` | 学习页地址，必须带 `recruitAndCourseId`；`force: true` 可重跑已完成的课 |
| `behavior.activeHours` | 只在指定小时运行，`[]` 表示不限。用于「白天刷、夜里歇」 |
| `behavior.skipKeywords` | 章节名命中这些词就跳过（测试/考试/作业…） |
| `behavior.playbackRate` | 播放倍速，默认 `2`。点播放器自带的倍速按钮；课程没开放这一档时降到可选的最高档（多数课程最高 1.5） |
| `behavior.quality` | 清晰度，默认 `"480p"`（流畅线路），可选 `"720p"`；空字符串表示不调整 |
| `behavior.maxSectionsPerCourse` | 单课上限，0 不限，测试时很有用 |
| `behavior.reloadEverySections` | 每跑 N 节重载页面，释放 Chrome 长跑累积的内存 |
| `behavior.emptySectionStallMs` | 播放时间多久不前进判定为卡死并重载 |
| `behavior.maxKicksPerHour` | 一小时内被重定向多少次判定为登录态失效并中止 |
| `server` | 状态接口，默认只监听 127.0.0.1 |

环境变量覆盖：`SHUAKE_STATE_DIR`、`SHUAKE_CHROME_PORT`、`SHUAKE_CHROME`、`SHUAKE_COOKIES`、`SHUAKE_HEADLESS=0`、`SHUAKE_NO_SANDBOX=1`。

## 状态接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 探活 |
| GET | `/status` | 当前课程、章节、播放进度、计数、最近错误 |
| POST | `/pause` `/resume` `/stop` | 控制 |

`/status` 返回示例：

```json
{
  "paused": false,
  "running": true,
  "current": { "name": "运动安全与健康", "idx": 3, "txt": "1.4 健康第一的教育理念", "t": 128.4, "d": 605.2 },
  "counters": { "sections": 12, "courses": 0, "kicks": 0, "restarts": 0 },
  "inWindow": true
}
```

## 作为引擎子进程（主程序调度）

协议与 `docs/ENGINE.md` 完全一致。Go 宿主对智慧树平台启动的是 `node bin/engine.mjs`，而不是 Python：

```json
{"type":"start","platform":"zhihuishu","action":"run","account_id":"<账号 id>",
 "account":{"course_urls":"课程名 | https://wisdom-mooc.zhihuishu.com/study/index?recruitAndCourseId=..."},
 "credential":{"cookies":[...]},
 "options":{"course_ids":["<recruitAndCourseId>"],"skip_keywords":["测试","考试"],"max_sections":0,"force":false,"playback_rate":2,"quality":"480p"},
 "data_dir":"/data","debug":false}
```

| 动作 | 说明 |
|---|---|
| `login` | 已有 Cookie 且有效就直接返回；否则在无头 Chrome 里打开登录中心的「扫码」页，把二维码以 `qrcode` 请求发给宿主显示。扫码成功后回传 `credential {cookies}` |
| `check` | 只检查 Cookie 里是否有登录字段 |
| `list_courses` | 带 Cookie 打开学生端首页，从页面接口响应里找含 `recruitAndCourseId` 的课程（实验性，智慧树改版可能失效），再合并账号里手填的学习页地址 |
| `run` | 按 `course_ids` 依次播放；只跑一轮。登录态失效时以退出码 2 结束，其他错误最多自愈重试 3 次 |

每个账号的数据放在 `<data_dir>/zhihuishu/accounts/<账号 id>/`，包括 Chrome 配置、`state.json`（已完成的课程）和本次运行注入的 `cookies.json`。Chrome 调试端口每次随机分配，所以多个账号可以同时跑。

输出的消息包括：`log`、`progress`（`overall` 课程 / `course` 章节 / `item` 当前视频秒数）、`event`（`ready`、`course_start`、`item_done`、`course_done`、`kicked`）、`request`、`credential`、`result`、`error`。

## 独立部署（不经过主程序）

常驻（systemd）：

```bash
sudo useradd -r -m -d /var/lib/shuake-aio shuake
sudo mkdir -p /opt/shuake-all-in-one /etc/shuake-aio
# 把仓库放到 /opt/shuake-all-in-one，然后
sudo cp platforms/zhihuishu/deploy/systemd/shuake-zhihuishu.service /etc/systemd/system/
sudo cp platforms/zhihuishu/config.example.json /etc/shuake-aio/zhihuishu.json
sudo systemctl daemon-reload && sudo systemctl enable --now shuake-zhihuishu
journalctl -u shuake-zhihuishu -f
```

容器：

```bash
cd platforms/zhihuishu/deploy
mkdir -p data && cp ../config.example.json data/config.json
# 把本机导出的 cookies.json 拷进去
cp ../../../cookies.json data/cookies.json
docker compose up -d --build
```

Dockerfile 用的是 Chrome 官方 deb 源而不是发行版 Chromium——后者常缺 H.264/AAC，智慧树的 MP4 会直接播不动。

## 已知边界

- **播完一整节才算数**：不拖进度、不伪造心跳。`--seek-test` 只用于验证链路，正式跑别开。
- **登录态会过期**：Cookie 有效期通常几天到两周。`maxKicksPerHour` 触发就是提醒你重新 `cookies`。建议配个定时任务定期重导。
- **弹题/公告会停手**：检测到可见弹窗只记录并等待，不自动作答（答题属于另一类风险，不在本模块范围）。
- **需要真实 GPU/解码**：容器里没有 GPU 也能跑，Chrome 走软件解码，CPU 占用会高一些。
- **同一账号别双端同时学**：会互相踢下线，表现为频繁重定向。
