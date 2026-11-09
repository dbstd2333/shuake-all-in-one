// 结构化日志：控制台 + 按天 JSONL 文件，自动清理过期
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from './cdp.mjs';

const LEVEL_ORDER = { debug: 10, info: 20, success: 20, warn: 30, error: 40 };

export class Logger {
  constructor({ dir = null, level = 'info', keepDays = 7, stdout = true, sink = null } = {}) {
    this.level = level;
    this.stdout = stdout;
    this.dir = dir ? expandHome(dir) : null;
    this.keepDays = keepDays;
    this.sink = sink; // 子进程模式：把日志转成 JSONL 发给宿主
    this.tag = 'zhs';
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.prune();
    }
  }

  prune() {
    if (!this.dir) return;
    const cutoff = Date.now() - this.keepDays * 86400_000;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(this.dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }

  file() {
    if (!this.dir) return null;
    const d = new Date();
    const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
    return path.join(this.dir, name);
  }

  log(level, msg, extra = null) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const ts = new Date().toISOString();
    const rec = { ts, level, msg, ...(extra ? { extra } : {}) };

    if (this.stdout) {
      const time = new Date().toTimeString().slice(0, 8);
      const mark = { debug: '·', info: '»', success: '✓', warn: '!', error: '✗' }[level] || '·';
      console.log(`[${time}] ${mark} ${msg}`);
    }
    if (this.sink) this.sink(rec);
    const f = this.file();
    if (f) {
      try {
        fs.appendFileSync(f, JSON.stringify(rec) + '\n');
      } catch {
        /* ignore */
      }
    }
  }

  debug(m, e) { this.log('debug', m, e); }
  info(m, e) { this.log('info', m, e); }
  success(m, e) { this.log('success', m, e); }
  warn(m, e) { this.log('warn', m, e); }
  error(m, e) { this.log('error', m, e); }
}

export function defaultStateDir() {
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'ShuakeAIO')
      : process.env.XDG_STATE_HOME
        ? path.join(process.env.XDG_STATE_HOME, 'shuake-aio')
        : path.join(os.homedir(), '.local', 'state', 'shuake-aio');
  return base;
}
