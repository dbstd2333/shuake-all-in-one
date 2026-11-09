#!/usr/bin/env node
// 智慧树驱动 CLI
//   shuake-zhihuishu cookies [--profile <dir>] [--out <file>]
//   shuake-zhihuishu probe   --url <学习页URL>
//   shuake-zhihuishu run     [--config <file>] [--url <url>] [--seek-test] [--max-sections N]
//   shuake-zhihuishu status  [--port N]
import fs from 'node:fs';
import path from 'node:path';
import { CDP, ensureChrome, expandHome, newPage, sleep } from '../src/cdp.mjs';
import { exportChromeCookies, hasLoginCookies, loadCookies, writeCookies } from '../src/cookies.mjs';
import { applyEnv, defaultConfig, loadConfig, validate } from '../src/config.mjs';
import { Logger } from '../src/log.mjs';
import { UA, VIEWPORT, ensureViewport, navigate, readState } from '../src/page.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { startStatusServer } from '../src/status-server.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const get = (k, d = null) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (k) => argv.includes('--' + k);

function usage() {
  console.log(`用法：
  shuake-zhihuishu cookies [--profile <Chrome配置目录>] [--out <输出文件>]
  shuake-zhihuishu probe   --url <学习页URL> [--port 9223]
  shuake-zhihuishu run     [--config <file>] [--url <URL>] [--seek-test] [--max-sections N] [--no-server]
  shuake-zhihuishu status  [--port 8790]`);
}

async function cmdCookies() {
  const cfg = applyEnv(defaultConfig());
  const profile = expandHome(get('profile') || cfg.cookies.chromeProfile);
  const out = expandHome(get('out') || cfg.cookies.file);
  console.log(`读取 Chrome 配置：${profile}`);
  const { cookies, failed, total } = exportChromeCookies({ profileDir: profile, domainSuffix: cfg.cookies.domainSuffix });
  if (!cookies.length) throw new Error('一条都没导出来，检查 profile 路径或域名后缀');
  const p = writeCookies(cookies, out);
  console.log(`已导出 ${cookies.length}/${total} 条（解密失败 ${failed}）→ ${p}`);
  if (!hasLoginCookies(cookies)) console.log('⚠ 未发现 CASTGC/CASLOGC/SESSION，登录态可能不完整');
}

async function cmdProbe() {
  const url = get('url');
  if (!url) throw new Error('缺少 --url');
  const cfg = applyEnv(defaultConfig());
  if (has('port')) cfg.chrome.port = Number(get('port'));
  const logger = new Logger({ dir: null, level: 'info' });

  const wsUrl = await ensureChrome({ ...cfg.chrome, logger });
  const cdp = new CDP(wsUrl);
  await cdp.ready();
  await newPage(cdp, { userAgent: UA, viewport: VIEWPORT });
  const cookies = loadCookies(cfg.cookies.file);
  await cdp.send('Network.setCookies', { cookies });
  logger.info(`注入 Cookie ${cookies.length} 条`);
  if (!(await navigate(cdp, url))) throw new Error('页面未挂载');

  await sleep(2000);
  const s = await readState(cdp);
  console.log(JSON.stringify({ ...s, viewport: await ensureViewport(cdp) }, null, 2));
  process.exit(0);
}

function buildConfig() {
  const file = get('config');
  const cfg = file ? loadConfig(file) : applyEnv(defaultConfig());
  applyEnv(cfg);
  if (get('url')) cfg.courses = [{ name: get('name') || '手动指定', url: get('url') }];
  if (has('seek-test')) cfg.behavior.seekTest = true;
  if (get('max-sections')) cfg.behavior.maxSectionsPerCourse = Number(get('max-sections'));
  if (has('no-server')) cfg.server.enabled = false;
  if (get('port')) cfg.server.port = Number(get('port'));
  if (has('chrome-port')) cfg.chrome.port = Number(get('chrome-port'));
  if (has('headed')) cfg.chrome.headless = false;
  validate(cfg);
  return cfg;
}

async function cmdRun() {
  const cfg = buildConfig();
  const sup = new Supervisor(cfg);

  let server = null;
  if (cfg.server.enabled) {
    server = startStatusServer(sup, { host: cfg.server.host, port: cfg.server.port, logger: sup.logger });
  }

  const stop = () => {
    sup.logger.info('收到退出信号，正在停止…');
    sup.stop();
    server?.close();
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  sup.logger.info(`配置：${cfg.courses.length} 门课程，headless=${cfg.chrome.headless}`);
  await sup.run();
  server?.close();
  process.exit(0);
}

async function cmdStatus() {
  const port = Number(get('port') || 8790);
  const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(3000) });
  console.log(JSON.stringify(await r.json(), null, 2));
}

const main = async () => {
  switch (cmd) {
    case 'cookies': return cmdCookies();
    case 'probe': return cmdProbe();
    case 'run': return cmdRun();
    case 'status': return cmdStatus();
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
};

main().catch((e) => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
