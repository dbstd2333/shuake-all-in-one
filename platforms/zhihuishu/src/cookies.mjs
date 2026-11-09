// Chrome Cookie 导出：SQLite 读取 + 系统钥匙串解密
// 支持 macOS（Chrome Safe Storage）与 Linux（peanuts / 环境变量）
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from './cdp.mjs';

export const DEFAULT_PROFILE = {
  darwin: '~/Library/Application Support/Google/Chrome/Default',
  linux: '~/.config/google-chrome/Default',
  win32: '~/AppData/Local/Google/Chrome/User Data/Default',
}[process.platform];

function safeStoragePassword(service = 'Chrome Safe Storage') {
  if (process.env.CHROME_SAFE_STORAGE) return process.env.CHROME_SAFE_STORAGE;
  if (process.platform === 'darwin') {
    return execFileSync('security', ['find-generic-password', '-w', '-s', service], {
      encoding: 'utf8',
    }).trim();
  }
  // Linux 下 Chrome 在无 keyring 时用固定口令；有 keyring 需自行导出到 CHROME_SAFE_STORAGE
  return 'peanuts';
}

function makeDecryptor(keychainService) {
  const pw = safeStoragePassword(keychainService);
  const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, ' ');

  return function decrypt(blob, hostKey) {
    const prefix = blob.subarray(0, 3).toString();
    if (prefix !== 'v10' && prefix !== 'v11') return null;
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    let plain;
    try {
      plain = Buffer.concat([d.update(blob.subarray(3)), d.final()]);
    } catch {
      return null;
    }
    // Chrome 130+ 会在明文前加 32 字节 sha256(host_key)
    if (plain.length > 32) {
      const h = crypto.createHash('sha256').update(hostKey).digest();
      if (plain.subarray(0, 32).equals(h)) plain = plain.subarray(32);
    }
    return plain.toString('utf8');
  };
}

const SAME_SITE = { '-1': 'Lax', 0: 'None', 1: 'Lax', 2: 'Strict' };

/**
 * 从 Chrome 的 Cookies 库导出指定域名后缀的 Cookie。
 * 注意事项：会话 Cookie（expires_utc=0）必须补一个未来时间戳，
 * 否则部分客户端（含 Lightpanda 的 --cookie）会直接丢弃，表现为“登录态丢失”。
 */
export function exportChromeCookies({
  profileDir = DEFAULT_PROFILE,
  domainSuffix = 'zhihuishu',
  sessionTtlDays = 30,
  keychainService = 'Chrome Safe Storage',
} = {}) {
  const dir = expandHome(profileDir);
  const db = path.join(dir, 'Cookies');
  if (!fs.existsSync(db)) throw new Error(`找不到 Cookie 数据库：${db}`);

  // 复制一份，避免与运行中的 Chrome 抢锁
  const tmp = path.join(os.tmpdir(), `shuake-cookies-${process.pid}.db`);
  fs.copyFileSync(db, tmp);

  const sql = `SELECT host_key,name,path,expires_utc,is_secure,is_httponly,samesite,hex(encrypted_value) AS ev,value
               FROM cookies WHERE host_key LIKE '%${domainSuffix}%' ORDER BY host_key;`;
  const rows = JSON.parse(
    execFileSync('sqlite3', ['-json', tmp, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) || '[]'
  );
  fs.unlinkSync(tmp);

  const decode = makeDecryptor(keychainService);

  const cookies = [];
  let failed = 0;
  for (const r of rows) {
    const blob = Buffer.from(r.ev || '', 'hex');
    let value = r.value;
    if (blob.length) {
      const dec = decode(blob, r.host_key);
      if (dec === null) {
        failed++;
        continue;
      }
      value = dec;
    }
    if (!value) continue;
    const exp = r.expires_utc > 0
      ? Math.floor(r.expires_utc / 1e6 - 11644473600)
      : Math.floor(Date.now() / 1000) + sessionTtlDays * 86400;
    cookies.push({
      name: r.name,
      value,
      domain: r.host_key,
      path: r.path || '/',
      expires: exp,
      secure: !!r.is_secure,
      httpOnly: !!r.is_httponly,
      sameSite: SAME_SITE[String(r.samesite)] || 'Lax',
    });
  }
  return { cookies, failed, total: rows.length };
}

export function writeCookies(cookies, file) {
  const p = expandHome(file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cookies, null, 2), { mode: 0o600 });
  return p;
}

export function loadCookies(file) {
  const p = expandHome(file);
  if (!fs.existsSync(p)) throw new Error(`Cookie 文件不存在：${p}`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('Cookie 文件应为数组');
  return raw;
}

/** 核心登录态是否齐全，用于启动前的快速自检 */
export function hasLoginCookies(cookies) {
  const names = new Set(cookies.map((c) => c.name));
  return names.has('CASTGC') || names.has('CASLOGC') || names.has('SESSION');
}
