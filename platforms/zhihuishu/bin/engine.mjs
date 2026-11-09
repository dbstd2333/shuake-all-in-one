#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// JSON Lines 子进程模式：协议与 engine/bootstrap.py 完全一致（见 docs/ENGINE.md），供 Go 宿主直接 spawn。
//
// 宿主 → 引擎（第一行）：
//   {"type":"start","platform":"zhihuishu","action":"login|check|list_courses|run",
//    "account_id":"...","account":{"course_urls":"..."},"credential":{"cookies":[...]},
//    "options":{"course_ids":[...],"courses":[...],"skip_keywords":"测试,考试","max_sections":0,"playback_rate":2,"quality":"480p"},
//    "data_dir":"...","debug":false}
// 之后：{"type":"cancel"} / {"type":"reply","id","value"}
//
// 引擎 → 宿主：log / progress / event / request / request_done / credential / result / error
// 退出码：0 成功，1 出错，2 登录失效，3 已取消
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { freePort, traffic } from '../src/cdp.mjs';
import { applyEnv, defaultConfig, validate } from '../src/config.mjs';
import { hasLoginCookies } from '../src/cookies.mjs';
import { STUDY_URL, discoverCourses, normalizeCookies, qrLogin, userFromCookies } from '../src/login.mjs';
import { Logger } from '../src/log.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const EXIT = { OK: 0, ERROR: 1, LOGIN: 2, CANCELLED: 3 };

let started = false;
let cancelled = false;
let supervisor = null;
const children = new Set();

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
const now = () => Date.now() / 1000;
const log = (msg, level = 'info') => out({ type: 'log', level, msg, ts: now() });
const progress = (scope, current, total, label = '', eta) =>
  out({ type: 'progress', scope, current, total, label, ...(eta !== undefined ? { eta } : {}) });

// ---------------------------------------------------------------- 流量上报
// 与 Python 引擎一致：每 5 秒发一次累计字节数（有变化才发），退出前再发一次
let reported = '';
function reportTraffic() {
  const key = `${traffic.rx}/${traffic.tx}`;
  if (key === reported) return;
  reported = key;
  out({ type: 'stats', rx: Math.round(traffic.rx), tx: Math.round(traffic.tx) });
}
setInterval(reportTraffic, 5000).unref();

function killChildren() {
  for (const c of children) {
    if (c.exitCode === null) {
      try { c.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
}

function exit(code) {
  reportTraffic();
  killChildren();
  // 给 stdout 一点时间刷出去
  setTimeout(() => process.exit(code), 100);
}

function fail(msg, code = EXIT.ERROR, kind = 'error') {
  out({ type: 'error', code: kind, msg });
  exit(code);
}

class Cancelled extends Error {}

// ---------------------------------------------------------------- 输入解析

/** 支持：CDP/Puppeteer 数组、Cookie-Editor 导出（expirationDate）、"a=b; c=d" 请求头 */
export function parseCookies(raw) {
  if (!raw) return [];
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith('[') || s.startsWith('{')) {
      v = JSON.parse(s);
    } else {
      v = s.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
        const i = p.indexOf('=');
        return { name: p.slice(0, i), value: p.slice(i + 1), domain: '.zhihuishu.com', path: '/' };
      });
    }
  }
  if (!Array.isArray(v)) v = v.cookies || [];
  return normalizeCookies(v.map((c) => ({ ...c, expires: c.expires ?? c.expirationDate, session: c.session ?? false })));
}

/** 账号里手填的学习页地址：每行一个，可写成「课程名 | 地址」或只写地址 */
export function parseCourseLines(text) {
  const outList = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/https?:\/\/\S*recruitAndCourseId=[^\s&#]+\S*/);
    if (!m) continue;
    const url = m[0];
    const id = new URL(url).searchParams.get('recruitAndCourseId');
    const name = line.replace(url, '').replace(/[|｜,，\s]+$/g, '').replace(/^[|｜,，\s]+/g, '').trim();
    outList.push({ id, name: name || `课程 ${id.slice(-6)}`, url });
  }
  return outList;
}

function accountDir(start) {
  const base = start.data_dir || path.join(process.cwd(), '.zhihuishu');
  const id = String(start.account_id || 'default').replace(/[^\w.-]/g, '_');
  return path.join(base, 'zhihuishu', 'accounts', id);
}

async function buildConfig(start) {
  const cfg = applyEnv(defaultConfig());
  const dir = accountDir(start);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  cfg.chrome.profileDir = path.join(dir, 'chrome-profile');
  cfg.chrome.attached = true;
  cfg.chrome.headless = start.options?.headless !== false;
  // 多账号并发：每个任务自己的 Chrome，调试端口随机
  cfg.chrome.port = start.options?.chromePort || (await freePort());
  cfg.stateFile = path.join(dir, 'state.json');
  cfg.cookies.file = path.join(dir, 'cookies.json');
  cfg.log.dir = null; // 日志由宿主统一保存
  cfg.log.level = start.debug ? 'debug' : 'info';
  cfg.server.enabled = false;
  cfg.behavior.once = true;
  cfg.behavior.restartDelayMs = 0;

  const o = start.options || {};
  if (o.skip_keywords) {
    cfg.behavior.skipKeywords = Array.isArray(o.skip_keywords)
      ? o.skip_keywords
      : String(o.skip_keywords).split(/[,，\s]+/).filter(Boolean);
  }
  if (Number(o.max_sections) > 0) cfg.behavior.maxSectionsPerCourse = Number(o.max_sections);
  if (o.seek_test) cfg.behavior.seekTest = true;
  if (o.playback_rate !== undefined && o.playback_rate !== '') {
    const r = Number(o.playback_rate);
    cfg.behavior.playbackRate = r > 0 && r <= 4 ? r : 0;
  }
  if (o.quality !== undefined) cfg.behavior.quality = ['480p', '720p'].includes(String(o.quality).toLowerCase()) ? String(o.quality).toLowerCase() : '';
  if (Array.isArray(o.active_hours)) cfg.behavior.activeHours = o.active_hours;

  // 课程：优先用宿主传来的完整对象，其次 id 列表，最后账号里手填的地址
  const known = new Map(parseCourseLines(start.account?.course_urls).map((c) => [c.id, c]));
  for (const c of o.courses || []) {
    const url = c.extra?.url || c.url || STUDY_URL(c.id);
    known.set(String(c.id), { id: String(c.id), name: c.name || '', url });
  }
  const ids = (o.course_ids || []).map(String);
  const picked = ids.length ? ids.map((id) => known.get(id) || { id, name: '', url: STUDY_URL(id) }) : [...known.values()];
  cfg.courses = picked.map((c) => ({ name: c.name, url: c.url, force: !!o.force }));
  return cfg;
}

function loadCookies(start) {
  return parseCookies(start.credential?.cookies);
}

const chromeOpts = (cfg) => ({ ...cfg.chrome });
const trackChild = (c) => children.add(c);

// ---------------------------------------------------------------- 动作

async function actionLogin(start, logger) {
  const cfg = await buildConfig(start);
  const existing = loadCookies(start);
  if (existing.length && hasLoginCookies(existing) && !start.options?.force_qr) {
    logger.info('检查已保存的 Cookie 是否有效…');
    try {
      await discoverCourses({ chrome: chromeOpts(cfg), cookies: existing, logger, onChild: trackChild, waitMs: 8000 });
      const user = userFromCookies(existing) || { name: '', id: '' };
      logger.success(`登录态有效${user.name ? '：' + user.name : ''}`);
      return { user };
    } catch (e) {
      if (e.code !== 'LOGIN') throw e;
      logger.warn('已保存的 Cookie 已失效，改用扫码登录');
    }
    killChildren();
    cfg.chrome.port = await freePort();
  }

  logger.info('正在打开智慧树登录页…');
  const qrId = 'qr';
  let shown = false;
  const { cookies, user } = await qrLogin({
    chrome: chromeOpts(cfg),
    logger,
    onChild: trackChild,
    isCancelled: () => cancelled,
    onQr: (image) => {
      out({
        type: 'request', id: qrId, kind: 'qrcode', blocking: false,
        payload: { title: '用「知到」App 扫码登录智慧树', image, hint: '打开「知到」App 扫一扫；二维码过期会自动刷新' },
      });
      if (!shown) logger.info('二维码已显示，请用知到 App 扫码');
      shown = true;
    },
  }).finally(() => {
    if (shown) out({ type: 'request_done', id: qrId });
  });
  out({ type: 'credential', data: { cookies } });
  logger.success(`扫码登录成功${user?.name ? '：' + user.name : ''}，已保存 ${cookies.length} 条 Cookie`);
  return { user: user || { name: '', id: '' } };
}

async function actionCheck(start) {
  const cookies = loadCookies(start);
  return { valid: hasLoginCookies(cookies), user: userFromCookies(cookies) };
}

async function actionListCourses(start, logger) {
  const cfg = await buildConfig(start);
  const manual = parseCourseLines(start.account?.course_urls);
  const cookies = loadCookies(start);
  let found = [];
  if (cookies.length) {
    logger.info('正在从学生端首页读取课程（约 10~20 秒）…');
    try {
      found = await discoverCourses({ chrome: chromeOpts(cfg), cookies, logger, onChild: trackChild });
      logger.info(`自动发现 ${found.length} 门课程`);
    } catch (e) {
      if (e.code === 'LOGIN') throw e;
      logger.warn('自动发现课程失败：' + e.message);
    }
  } else {
    logger.warn('账号还没有登录，只能列出手动填写的学习页地址');
  }
  const map = new Map();
  for (const c of [...found, ...manual]) {
    const prev = map.get(c.id);
    map.set(c.id, { ...prev, ...c, name: c.name || prev?.name || '' });
  }
  // 本账号已经跑完的课程标成 100%
  let state = {};
  try { state = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')).courses || {}; } catch { /* none */ }
  const courses = [...map.values()].map((c) => ({
    id: c.id,
    name: c.name,
    progress: state[c.url]?.doneAt ? 100 : c.progress,
    extra: { url: c.url },
  }));
  if (!courses.length) {
    logger.warn('没有找到课程。可以在账号设置里填写课程学习页地址（每行一个，需包含 recruitAndCourseId）');
  }
  return { courses, user: userFromCookies(cookies) || undefined };
}

async function actionRun(start, logger) {
  const cfg = await buildConfig(start);
  const cookies = loadCookies(start);
  if (!cookies.length) {
    const e = new Error('账号还没有登录：请先扫码登录或粘贴 Cookie');
    e.code = 'LOGIN';
    throw e;
  }
  fs.writeFileSync(cfg.cookies.file, JSON.stringify(cookies), { mode: 0o600 });
  validate(cfg);

  supervisor = new Supervisor(cfg, {
    quiet: true,
    sink: (rec) => out({ type: 'log', level: rec.level, msg: rec.msg, ts: Date.parse(rec.ts) / 1000 }),
    emit: (name, data = {}) => out({ type: 'event', name, data }),
    progress,
  });
  if (cancelled) supervisor.stop();
  out({ type: 'event', name: 'ready', data: { courses: cfg.courses.length } });
  await supervisor.run();
  if (cancelled) throw new Cancelled();
  const { startedAt, ...summary } = supervisor.counters;
  return { summary: { ...summary, minutes: Math.round((Date.now() - startedAt) / 60000) } };
}

const ACTIONS = { login: actionLogin, check: actionCheck, list_courses: actionListCourses, run: actionRun };

async function handleStart(msg) {
  const action = msg.action || 'run';
  const fn = ACTIONS[action];
  if (!fn) return fail(`未知动作：zhihuishu.${action}`, EXIT.ERROR, 'unknown_action');
  const logger = new Logger({
    level: msg.debug ? 'debug' : 'info',
    stdout: false,
    sink: (rec) => out({ type: 'log', level: rec.level, msg: rec.msg, ts: Date.parse(rec.ts) / 1000 }),
  });
  try {
    const data = await fn(msg, logger);
    if (data !== undefined) out({ type: 'result', data });
    exit(EXIT.OK);
  } catch (e) {
    if (cancelled || e instanceof Cancelled) {
      log('任务已取消', 'warn');
      return exit(EXIT.CANCELLED);
    }
    if (e.code === 'LOGIN') return fail(e.message, EXIT.LOGIN, 'login_failed');
    log(e.stack || e.message, 'error');
    return fail(`${e.name}: ${e.message}`);
  }
}

function cancel() {
  if (cancelled) return;
  cancelled = true;
  reportTraffic();
  supervisor?.stop();
  killChildren();
  // supervisor 可能卡在长 sleep 里，兜底强退
  setTimeout(() => process.exit(EXIT.CANCELLED), 3000).unref();
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.type === 'start') {
    if (started) return;
    started = true;
    if (msg.platform && msg.platform !== 'zhihuishu') {
      return fail(`本引擎只处理 zhihuishu，收到 ${msg.platform}`, EXIT.ERROR, 'unknown_platform');
    }
    handleStart(msg);
  } else if (msg.type === 'cancel') {
    log('收到取消指令', 'warn');
    cancel();
  }
});

// 宿主关闭 stdin 视为取消（与 Python 引擎一致）
rl.on('close', cancel);
process.on('SIGTERM', () => {
  cancel();
  setTimeout(() => process.exit(EXIT.CANCELLED), 500).unref();
});
