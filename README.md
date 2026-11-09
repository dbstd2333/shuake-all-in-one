# 刷课 All-in-One

一个刷课工具，整合了 **学堂在线**、**智慧职教**（AI优课/常规MOOC、MOOC学院）、**安全微伴** 和 **智慧树**。两种用法：

- **桌面版**：安装包自带 Python 运行环境，Windows 和 macOS 上开箱即用。
- **服务端版（Docker）**：部署到服务器上，用浏览器管理多个账号，批量建任务、7×24 挂着跑。见[服务端部署](#服务端部署docker)。

- **界面**：Wails v3 + React 19 + TypeScript + Vite + Ant Design + Zustand
- **后端**：Go；每个任务启动一个独立的 Python 子进程，通过 JSON Lines 与 Go 通信（协议见 [docs/ENGINE.md](docs/ENGINE.md)）
- **存储**：SQLite；账号凭证和 AI Key 用 AES-GCM 加密，主密钥保存在系统钥匙串
- **许可**：AGPL-3.0-or-later（第三方组件见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)）

## 功能

| 平台 | 登录方式 | 能做什么 |
|---|---|---|
| 学堂在线 | 微信扫码（应用内显示二维码） | 视频/音频心跳、图文、习题（AI 或随机）、讨论 |
| 智慧职教 · AI优课/常规MOOC | 统一认证（系统浏览器登录后自动回调） | 视频、文档、音频、图文进度 |
| 智慧职教 · MOOC学院 | 统一认证 | 视频分段上报、讨论回复、AI 答题（可选自动交卷） |
| 安全微伴 | **浏览器登录，自动读取 Token** / 学号密码（验证码自动识别，失败时在应用内手动输入）/ 手动填 Token | 课程学习、考试（题库 → AI → 手动或随机） |
| 智慧树 | 知到 App 扫码（服务器上的无头 Chrome 显示二维码）/ 粘贴 Cookie | 真实播放视频、播完自动切下一节（见 [platforms/zhihuishu](platforms/zhihuishu/README.md)） |

其他特性：

- 多账号、多任务并发，总并发数和单平台上限都可设
- 批量导入账号、批量登录、批量建任务（按「未完成 / 全部 / 关键词」自动选课）、批量停止 / 重跑
- 实时显示进度条、预计剩余时间和日志
- 流量统计：侧栏实时网速；「流量」页有最近 10 分钟的网速曲线、近 30 天每日用量、各平台和各任务的用量
- 需要人工处理时（验证码、扫码、手动答题）弹窗提示
- 引擎报错和界面崩溃都会显示完整堆栈，方便排查
- AI 答题使用 OpenAI 兼容接口（DeepSeek、通义、Kimi、Ollama 等），所有平台共用一份配置

## 服务端部署（Docker）

镜像里包含 Go 服务、Python 引擎、智慧树的 Node 引擎和无头 Chrome，一个容器就能跑全部平台。

```bash
cp .env.example .env
```

编辑 `.env`，至少把 `SHUAKE_ADMIN_PASSWORD` 改掉，然后启动：

```bash
docker compose up -d --build
```

浏览器打开 `http://<服务器 IP>:8080`，输入管理员密码。没设密码时，首次启动会自动生成一个，写在 `data/.admin-password`，也会打印在日志里：

```bash
docker compose logs shuake | grep 管理员密码
```

### 多账号批量刷课的流程

1. **账号 → 批量导入**：每行一个账号。安全微伴写「学校,学号,密码」；智慧树、学堂在线、智慧职教只写备注名（智慧树也可以在后面附上 Cookie）。
2. 勾选「导入后立即批量登录」。需要扫码或输入验证码的账号会在网页里**依次弹窗**，每个弹窗都标明了是哪个账号。安全微伴的验证码会先自动识别。
3. **账号**页勾选同一平台的账号，点 **批量建任务**，或者直接进入「批量任务」页。选好选课方式（未完成 / 全部 / 名称关键词）和平台选项，点开始。系统会逐个账号获取课程，并各建一个任务排队。
4. 在「总览」看实时进度。「任务记录」里可以批量停止、重跑失败的任务。

### 各平台在服务端的登录方式

| 平台 | 服务端登录 |
|---|---|
| 学堂在线 | 网页里显示微信二维码，手机扫码 |
| 智慧职教 | 网页给出统一认证链接，在自己的浏览器里登录。登录后会跳到一个打不开的 `localhost` 地址，把地址栏里的完整地址粘贴回来即可 |
| 安全微伴 | 学号密码（验证码自动识别，失败时在网页输入）或手动填 Token。服务端没有「浏览器登录」 |
| 智慧树 | 网页显示服务器上无头 Chrome 里的二维码，用知到 App 扫码；也可以粘贴 Cookie（Cookie-Editor 导出的 JSON 或 `a=b; c=d` 格式） |

### 配置项（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SHUAKE_ADMIN_PASSWORD` | 自动生成 | 网页登录密码 |
| `SHUAKE_PORT` | `8080` | compose 对外映射的端口 |
| `SHUAKE_MASTER_KEY` | 自动生成 `data/.master.key` | 凭证加密主密钥（32 字节 base64）。设置后，仅拿到数据卷也解不开账号密码；设置后不能再更换 |
| `SHUAKE_AUTH` | — | 设为 `off` 时关闭登录，只建议在完全可信的内网使用 |
| `TZ` | `Asia/Shanghai` | 时区，影响日志时间和智慧树的活跃时段 |

所有数据都在 `./data`（SQLite、加密密钥、任务日志、智慧树各账号的浏览器配置），请定期备份。

### 资源与安全

- **并发**：「设置 → 单平台上限」里的智慧树默认是 2。每个智慧树任务都会开一个 Chrome，大约占 300~500 MB 内存，请按服务器内存调整。
- **带宽**：只有智慧树会真实播放视频，默认 480P、2 倍速，按经验估算每个任务约 1~2 Mbps（每小时几百 MB）；其他平台只发进度心跳，流量很小。实际用量以「流量」页为准：在 Docker 里它统计的是整个容器的网卡流量（含 Chrome、引擎和打开网页的流量），各平台、各任务的数字来自引擎上报，不含 TLS/TCP 开销，会比网卡读数略低。网页静态资源会 gzip 压缩，首次打开约 0.4 MB，之后走浏览器缓存。
- **反向代理**：实时进度走 SSE（`/api/events`）。nginx 需要关闭缓冲，并调大超时：

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_buffering off;
      proxy_read_timeout 600s;
      proxy_set_header X-Forwarded-Proto $scheme;
  }
  ```

- **公网访问**：请放在 HTTPS 反向代理后面。登录接口有失败次数限制，会话 Cookie 是 HttpOnly 的；放在 HTTPS 后面时还会带上 Secure 标记。
- **构建慢或 pip 下载失败**：可以换 PyPI 镜像源，例如 `docker build --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple -t shuake-aio .`（也可以写在 compose 的 `build.args` 里）。
- **arm64**：Google 没有提供 Linux arm64 版 Chrome，arm64 镜像用的是 Debian 的 Chromium。智慧树的 MP4 能否播放取决于它带的解码器，建议优先用 amd64 服务器。

不用 Docker、直接运行服务端：

```bash
cd frontend && pnpm build && cd ..
```

```bash
go build -o shuake-server ./cmd/server
```

```bash
SHUAKE_ADMIN_PASSWORD=xxx ./shuake-server
```

在仓库目录里运行时，会自动找到 `build/runtime` 下的 Python 和 `platforms/zhihuishu`。也可以用 `SHUAKE_PYTHON`、`SHUAKE_ENGINE`、`SHUAKE_NODE`、`SHUAKE_ZHS_ENGINE` 分别指定。

## 开发

需要准备：Go ≥ 1.27.3、Node 20+ 和 pnpm、[uv](https://docs.astral.sh/uv/)、Wails CLI。

```bash
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0
```

```bash
python3 scripts/prepare_runtime.py
```

`prepare_runtime.py` 会下载 CPython 3.12，并把依赖装到 `build/runtime/<os>-<arch>/`。

```bash
wails3 dev
```

### 测试

```bash
go test ./internal/...
```

```bash
cd engine && ../build/runtime/darwin-arm64/python/bin/python3 -m unittest discover -s tests -v
```

```bash
cd frontend && pnpm typecheck
```

开发网页版界面时，先启动 `shuake-server`，再运行下面的命令，把 `/api` 代理到它：

```bash
cd frontend && VITE_SHUAKE_SERVER=1 pnpm dev
```

想在不访问任何网站的情况下检查界面和引擎能否正常通信，可以在应用里添加一个「诊断」平台账号。

### 打包

```bash
wails3 package
```

- **macOS**：生成 `bin/shuake-all-in-one.app`，Python 运行时放在 `Contents/Resources/runtime`。所有 Mach-O 文件默认做 ad-hoc 签名；传入 `SIGN_IDENTITY="Developer ID Application: …"` 则使用正式签名。
- **Windows**：生成 NSIS 安装包，运行时放在安装目录的 `runtime\`。可以在 macOS 上用 `python3 scripts/prepare_runtime.py --target windows-amd64` 准备 Windows 运行时，但安装包要在 Windows 上构建（见 CI）。

推送 `v*` 标签后，CI（`.github/workflows/release.yml`）会构建 macOS arm64、macOS x64 和 Windows x64 三个版本，并发布到 GitHub Release。

Windows 构建单独放在 `.github/workflows/windows.yml`：推送到 main、提 PR 或在 Actions 页手动触发时都会运行，产出 NSIS 安装包 `shuake-all-in-one-amd64-installer.exe` 和免安装版 `shuake-all-in-one-windows-amd64-portable.zip`（在 Actions 运行页的 Artifacts 里下载）。它会在 Windows 上跑引擎和 Go 测试，并检查打包后的 Python 能导入 OpenCV 等依赖、VC++ 运行库 DLL 已随附。

## 目录结构

```
main.go                  Wails 入口（桌面版）
cmd/server               服务端入口（网页版 / Docker）
internal/server          HTTP API、SSE 事件推送、管理员登录
internal/pyenv           查找内置 Python
internal/runner          子进程、JSON Lines、终止整个进程树（Unix 进程组 / Windows Job Object）
internal/core            任务调度（总并发 + 单平台上限）、事件分发、请求与回复、批量登录 / 批量任务
internal/store           SQLite 与凭证加密
internal/services        供前端调用的服务（AccountService / TaskService / AppService）
engine/                  Python 引擎（ipc、AI 客户端、各平台适配器、vendor 中的上游代码）
platforms/zhihuishu/     智慧树驱动（Node + CDP 真实浏览器播放，可常驻/作子进程）
frontend/                React 界面
scripts/                 准备运行时、打包运行时
```

## 智慧树（独立常驻模式）

智慧树的视频必须真正解码播放，所以这一平台没有走 Python 的 HTTP 引擎，而是用 **Node + Chrome DevTools Protocol** 驱动一个 headless Chrome：真实点击、真实播放、播完自动切下一节。它已经接入主程序，在桌面版和服务端里和其他平台用法一样，作为 JSON Lines 子进程被调度：每个账号有独立的 Chrome 配置目录，调试端口随机分配，任务结束时 Chrome 随之退出。下面是不依赖主程序、单独常驻运行的方式：

```bash
cd platforms/zhihuishu
node bin/cli.mjs cookies                # 从已登录的 Chrome 导出登录态
node bin/cli.mjs run --config config.json
```

细节、配置项和踩坑记录见 [platforms/zhihuishu/README.md](platforms/zhihuishu/README.md)。

## 免责声明

本项目仅供学习研究。自动刷课和自动答题可能违反相关平台的用户协议，导致账号受限，使用后果由使用者自行承担。
