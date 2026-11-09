// 极简 CDP 客户端 + Chrome 启动/复用
// 不依赖任何 npm 包，Node 20+ 内置 WebSocket / fetch 足够。
import { execFile, execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

export function findChrome(explicit) {
  if (explicit) return expandHome(explicit);
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      const out = execFileSync('which', [name], { encoding: 'utf8' }).trim();
      if (out) return out;
    } catch {
      /* ignore */
    }
  }
  throw new Error('找不到 Chrome/Chromium，可用 --chrome 或 CHROME_PATH 指定');
}

/** 向系统要一个空闲端口（多账号并发时每个 Chrome 一个调试端口） */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function cdpEndpoint(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? (await r.json()).webSocketDebuggerUrl : null;
  } catch {
    return null;
  }
}

/**
 * 确保有一个带调试端口的 Chrome 在跑；已有则复用。
 * 服务端部署时 headless=true，Docker 里会自动补 --no-sandbox 等参数。
 */
export async function ensureChrome(opts) {
  const { port, profileDir, headless = true, executable, extraArgs = [], logger, attached = false, onChild } = opts;
  const existing = await cdpEndpoint(port);
  if (existing) {
    logger?.debug(`复用已运行的 Chrome（端口 ${port}）`);
    return existing;
  }

  const bin = findChrome(executable);
  const dir = expandHome(profileDir);
  fs.mkdirSync(dir, { recursive: true });

  const args = [
    headless ? '--headless=new' : '--new-window',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-dev-shm-usage',
    '--window-size=1600,1000',
    ...(process.env.SHUAKE_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ...extraArgs,
    'about:blank',
  ];

  logger?.info(`启动 Chrome: ${bin}`);
  let child;
  if (attached) {
    // 子进程模式：Chrome 留在宿主的进程组里，任务结束/被取消时随引擎一起退出
    child = spawn(bin, args, { stdio: 'ignore' });
    onChild?.(child);
  } else {
    child = execFile(bin, args, { detached: true, stdio: 'ignore' });
    child.unref();
  }

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const ws = await cdpEndpoint(port);
    if (ws) return ws;
  }
  throw new Error('Chrome 启动超时（60s）');
}

export class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.sessionId = null;
    this.pending = new Map();
    this.closed = false;
    this.ws.addEventListener('message', (e) => this.#onMessage(e));
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const { rej } of this.pending.values()) rej(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  #onMessage(e) {
    const m = JSON.parse(e.data);
    if (m.id && this.pending.has(m.id)) {
      const { res, rej } = this.pending.get(m.id);
      this.pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
      return;
    }
    if (m.method === 'Target.attachedToTarget') this.sessionId = m.params.sessionId;
  }

  ready() {
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
  }

  send(method, params = {}, timeout = 60000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(this.sessionId ? { sessionId: this.sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 超时: ${method}`));
        }
      }, timeout);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description?.split('\n')[0] || d.text || '页面脚本执行异常');
    }
    return r.result?.value;
  }

  /** 必须走真实鼠标事件：element.click() 的 isTrusted=false 会被风控直接踢回首页 */
  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await sleep(120);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(80);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** 开一个新标签页并把常用域打开，返回已 attach 的 CDP */
export async function newPage(cdp, { url = 'about:blank', userAgent, viewport } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  for (let i = 0; i < 100 && !cdp.sessionId; i++) await sleep(50);
  if (!cdp.sessionId) throw new Error('CDP attach 失败');

  for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable']) {
    await cdp.send(m).catch(() => {});
  }
  if (userAgent) {
    await cdp.send('Network.setUserAgentOverride', {
      userAgent,
      acceptLanguage: 'zh-CN,zh;q=0.9',
      platform: 'MacIntel',
    }).catch(() => {});
  }
  if (viewport) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    }).catch(() => {});
  }
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  if (url && url !== 'about:blank') {
    await cdp.send('Page.navigate', { url });
  }
  return { targetId };
}
