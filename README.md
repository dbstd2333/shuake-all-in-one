# 刷课 All-in-One

一个带图形界面的桌面刷课工具，整合了 **学堂在线**、**智慧职教**（AI优课/常规MOOC、MOOC学院）和 **安全微伴**。安装包自带 Python 运行环境，Windows 和 macOS 上都能开箱即用。

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

其他特性：

- 多账号、多任务并发，并发数可设
- 实时显示进度条、预计剩余时间和日志
- 需要人工处理时（验证码、扫码、手动答题）弹窗提示
- 引擎报错和界面崩溃都会显示完整堆栈，方便排查
- AI 答题使用 OpenAI 兼容接口（DeepSeek、通义、Kimi、Ollama 等），所有平台共用一份配置

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
main.go                  Wails 入口
internal/pyenv           查找内置 Python
internal/runner          子进程、JSON Lines、终止整个进程树（Unix 进程组 / Windows Job Object）
internal/core            任务调度、事件分发、请求与回复
internal/store           SQLite 与凭证加密
internal/services        供前端调用的服务（AccountService / TaskService / AppService）
engine/                  Python 引擎（ipc、AI 客户端、各平台适配器、vendor 中的上游代码）
frontend/                React 界面
scripts/                 准备运行时、打包运行时
```

## 免责声明

本项目仅供学习研究。自动刷课和自动答题可能违反相关平台的用户协议，导致账号受限，使用后果由使用者自行承担。
