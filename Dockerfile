# syntax=docker/dockerfile:1
# 刷课 All-in-One 服务端镜像：Go 服务 + Python 引擎 + 智慧树 Node 引擎 + Chrome（无头）
#
#   docker compose up -d --build
#   浏览器打开 http://<服务器>:8080 ，用 SHUAKE_ADMIN_PASSWORD 登录

# ---------------------------------------------------------------- web UI
FROM node:22-bookworm-slim AS web
WORKDIR /src/frontend
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# ---------------------------------------------------------------- server
FROM golang:1.27-bookworm AS server
ENV GOTOOLCHAIN=auto CGO_ENABLED=0
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
COPY --from=web /src/frontend/dist ./frontend/dist
ARG VERSION=0.1.0
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags "-s -w -X main.Version=${VERSION}" -o /out/shuake-server ./cmd/server

# ---------------------------------------------------------------- runtime
FROM python:3.12-slim-bookworm
ARG TARGETARCH

# Chrome：智慧树需要真实播放视频，安全微伴的课程验证码也要用浏览器。
# amd64 用 Google Chrome（自带 H.264/AAC 解码）；arm64 没有官方 Chrome，退回 Debian 的 Chromium。
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg tini tzdata fonts-noto-cjk libstdc++6; \
    if [ "${TARGETARCH:-amd64}" = "amd64" ]; then \
      install -d -m 0755 /etc/apt/keyrings; \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg; \
      echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends google-chrome-stable; \
      ln -sf /usr/bin/google-chrome-stable /usr/local/bin/chrome; \
    else \
      apt-get install -y --no-install-recommends chromium; \
      ln -sf /usr/bin/chromium /usr/local/bin/chrome; \
    fi; \
    apt-get purge -y gnupg; apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY engine/requirements.lock ./engine/requirements.lock
# 国内网络可构建时传 --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir --prefer-binary --retries 10 --timeout 60 \
      --index-url "$PIP_INDEX_URL" -r engine/requirements.lock

COPY engine/ ./engine/
COPY platforms/zhihuishu/package.json ./zhihuishu/package.json
COPY platforms/zhihuishu/bin ./zhihuishu/bin
COPY platforms/zhihuishu/src ./zhihuishu/src
COPY --from=server /out/shuake-server /app/shuake-server
COPY LICENSE NOTICE THIRD_PARTY_LICENSES.md ./

ENV SHUAKE_DATA_DIR=/data \
    SHUAKE_LISTEN=:8080 \
    SHUAKE_PYTHON=/usr/local/bin/python3 \
    SHUAKE_ENGINE=/app/engine \
    SHUAKE_NODE=/usr/local/bin/node \
    SHUAKE_ZHS_ENGINE=/app/zhihuishu/bin/engine.mjs \
    CHROME_PATH=/usr/local/bin/chrome \
    SHUAKE_NO_SANDBOX=1 \
    ENVIRONMENT=docker \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Shanghai

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4)" || exit 1

# tini 负责回收 Chrome 等孙进程，避免僵尸进程堆积
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/shuake-server"]
