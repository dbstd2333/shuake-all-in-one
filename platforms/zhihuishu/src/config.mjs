// 配置：默认值 + 文件 + 环境变量覆盖
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './cdp.mjs';
import { DEFAULT_PROFILE } from './cookies.mjs';
import { defaultStateDir } from './log.mjs';

export function defaultConfig() {
  const stateDir = defaultStateDir();
  return {
    chrome: {
      executable: null,
      port: 9223,
      profileDir: path.join(stateDir, 'chrome-profile'),
      headless: true,
      extraArgs: [],
    },
    cookies: {
      file: path.join(stateDir, 'cookies.json'),
      chromeProfile: DEFAULT_PROFILE,
      domainSuffix: 'zhihuishu',
      // 超过这个天数就提醒重新导出（登录态通常撑不了太久）
      warnAfterDays: 14,
    },
    courses: [],
    behavior: {
      pollMs: 5000,
      sectionGapMs: 4000,
      emptySectionStallMs: 90000,
      reloadEverySections: 20,
      maxSectionsPerCourse: 0,
      skipKeywords: ['测试', '考试', '作业', '讨论', '答疑'],
      maxKicksPerHour: 12,
      // 一轮跑完后多久复查（新章节通常按周放出）
      restartDelayMs: 1_800_000,
      // 全天候模式下只在这些小时干活；空数组表示不限
      activeHours: [],
      seekTest: false,
    },
    server: { enabled: true, host: '127.0.0.1', port: 8790 },
    log: { dir: path.join(stateDir, 'logs'), level: 'info', keepDays: 7 },
    stateFile: path.join(stateDir, 'state.json'),
  };
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function normalizePaths(cfg) {
  cfg.cookies.file = expandHome(cfg.cookies.file);
  cfg.cookies.chromeProfile = expandHome(cfg.cookies.chromeProfile);
  cfg.chrome.profileDir = expandHome(cfg.chrome.profileDir);
  cfg.log.dir = expandHome(cfg.log.dir);
  cfg.stateFile = expandHome(cfg.stateFile);
  return cfg;
}

export function loadConfig(file) {
  const cfg = defaultConfig();
  if (!file) return normalizePaths(cfg);
  const p = expandHome(file);
  if (!fs.existsSync(p)) throw new Error(`配置文件不存在：${p}`);
  const patch = JSON.parse(fs.readFileSync(p, 'utf8'));

  const merged = merge(cfg, patch);
  merged.configPath = p;
  // 相对路径按配置文件所在目录解析
  for (const [section, key] of [
    ['cookies', 'file'],
    ['cookies', 'chromeProfile'],
    ['chrome', 'profileDir'],
    ['log', 'dir'],
  ]) {
    const val = merged[section]?.[key];
    if (typeof val === 'string' && val.startsWith('.')) {
      merged[section][key] = path.resolve(path.dirname(p), val);
    }
  }
  if (merged.stateFile && merged.stateFile.startsWith('.')) {
    merged.stateFile = path.resolve(path.dirname(p), merged.stateFile);
  }
  return normalizePaths(merged);
}

export function applyEnv(cfg) {
  const env = process.env;
  if (env.SHUAKE_CHROME_PORT) cfg.chrome.port = Number(env.SHUAKE_CHROME_PORT);
  if (env.SHUAKE_CHROME) cfg.chrome.executable = env.SHUAKE_CHROME;
  if (env.SHUAKE_COOKIES) cfg.cookies.file = env.SHUAKE_COOKIES;
  if (env.SHUAKE_STATE_DIR) {
    cfg.chrome.profileDir = path.join(env.SHUAKE_STATE_DIR, 'chrome-profile');
    cfg.log.dir = path.join(env.SHUAKE_STATE_DIR, 'logs');
    cfg.stateFile = path.join(env.SHUAKE_STATE_DIR, 'state.json');
  }
  if (env.SHUAKE_HEADLESS === '0') cfg.chrome.headless = false;
  return normalizePaths(cfg);
}

export function validate(cfg) {
  const errs = [];
  if (!Array.isArray(cfg.courses) || cfg.courses.length === 0) errs.push('courses 为空，至少配置一门课');
  for (const [i, c] of (cfg.courses || []).entries()) {
    if (!c.url || !c.url.includes('recruitAndCourseId')) errs.push(`courses[${i}] 缺少有效的 url`);
  }
  if (!cfg.cookies?.file) errs.push('cookies.file 未配置');
  if (!(cfg.chrome?.port > 0)) errs.push('chrome.port 非法');
  if (errs.length) throw new Error('配置有误：\n  - ' + errs.join('\n  - '));
  return cfg;
}
