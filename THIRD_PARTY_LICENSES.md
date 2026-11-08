# 第三方组件与许可

刷课 All-in-One 本身以 **GNU AGPL-3.0-or-later** 发布（见 `LICENSE`）。项目中包含或分发了下列第三方组件，它们各自的许可证仍然有效。

## 整合的上游项目

| 组件 | 位置 | 许可 | 说明 |
|---|---|---|---|
| [hangone/WeBan](https://github.com/hangone/WeBan) @036dc72 | `engine/vendor/weban/` | GPL-3.0（见该目录下 `LICENSE`） | 安全微伴。GPL-3.0 第 13 条允许与 AGPL-3.0 代码组合，组合后的作品整体按 AGPL-3.0 分发 |
| [11273/mooc-work-answer](https://github.com/11273/mooc-work-answer) @aa87320 | `engine/vendor/mooc_work_answer/` | 上游未附许可证，**经作者授权**再分发 | 智慧职教，见 `docs/AUTHORIZATION.md` |
| [dbstd2333/xuetangx-js](https://github.com/dbstd2333/xuetangx-js) | `engine/shuake_engine/adapters/xuetangx/`（移植为 Python） | AGPL-3.0 | 学堂在线 |

## 运行时与依赖

| 组件 | 许可 |
|---|---|
| CPython 3.12（[python-build-standalone](https://github.com/astral-sh/python-build-standalone)） | PSF License，以及其中各组件自带的许可 |
| requests、urllib3、certifi、idna、charset-normalizer | Apache-2.0 / MIT / MPL-2.0 |
| websockets、wrapt、deprecated | BSD-3-Clause / BSD-2-Clause / MIT |
| loguru、pyaes、PySocks、mss | MIT / MIT / BSD-3-Clause / MIT |
| nodriver | AGPL-3.0 |
| numpy | BSD-3-Clause |
| opencv-python-headless | Apache-2.0（另含 FFmpeg LGPL 等组件） |
| lxml | BSD-3-Clause |
| pycryptodome | BSD-2-Clause / Public Domain |
| Wails v3 | MIT |
| React、Ant Design、Zustand | MIT |
| [阿里巴巴普惠体 3.0](https://www.alibabafonts.com/) | 阿里巴巴普惠体免费商用授权（字体不适用本项目的 AGPL 许可）。文件位于 `frontend/public/fonts/` |

Python 依赖的准确版本见 `engine/requirements.lock`。分发安装包时，每个依赖包自带的许可证文件位于 `runtime/python/.../site-packages/*.dist-info/`。
