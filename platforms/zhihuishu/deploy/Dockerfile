# 服务端离线运行：Chrome headless + Node，无需图形环境
FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive \
    SHUAKE_STATE_DIR=/data \
    SHUAKE_NO_SANDBOX=1 \
    NODE_ENV=production

# Chrome 官方 deb 源，保证能解 H.264/AAC（Chromium 的开源构建常缺这些编解码器）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg sqlite3 fonts-noto-cjk \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY config.example.json ./

VOLUME ["/data"]
EXPOSE 8790

# 首次启动前需要把导出的 cookies.json 放进 /data
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/cli.mjs", "run", "--config", "/data/config.json"]
