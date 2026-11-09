// 常驻监督器：跑完一门课自动切下一门，出错自愈，为全天候运行设计
import fs from 'node:fs';
import path from 'node:path';
import { CDP, ensureChrome, newPage, sleep } from './cdp.mjs';
import { hasLoginCookies, loadCookies } from './cookies.mjs';
import { Logger } from './log.mjs';
import {
  HOST, UA, VIEWPORT,
  clickNextSection, ensurePlaying, ensureViewport, navigate, readState, waitMounted,
} from './page.mjs';

function inActiveHours(hours) {
  if (!hours || hours.length === 0) return true;
  const h = new Date().getHours();
  return hours.includes(h);
}

/** 登录态失效：任务模式下直接失败（宿主据此把账号标记为需重新登录） */
export class LoginExpired extends Error {
  constructor(msg) {
    super(msg);
    this.code = 'LOGIN';
  }
}

const LOGIN_HOSTS = /passport\.zhihuishu|login\.zhihuishu/;

export class Supervisor {
  constructor(cfg, { sink = null, quiet = false, emit = null, progress = null } = {}) {
    this.cfg = cfg;
    this.logger = new Logger({ ...cfg.log, sink, stdout: !quiet });
    this.emit = emit || (() => {});
    this.progress = progress || (() => {});
    this.chromeProc = null;
    this.paused = false;
    this.stopped = false;
    this.cdp = null;
    this.current = null;      // { name, url, idx, txt, t, d }
    this.counters = { sections: 0, courses: 0, kicks: 0, restarts: 0, startedAt: Date.now() };
    this.lastError = null;
    this.state = this.#loadState();
  }

  // ---------- 状态持久化（断电/重启后知道跑到哪了） ----------
  #loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.cfg.stateFile, 'utf8'));
    } catch {
      return { courses: {}, updatedAt: null };
    }
  }

  #saveState() {
    try {
      fs.mkdirSync(path.dirname(this.cfg.stateFile), { recursive: true });
      this.state.updatedAt = new Date().toISOString();
      fs.writeFileSync(this.cfg.stateFile, JSON.stringify(this.state, null, 2));
    } catch (e) {
      this.logger.warn('状态写入失败：' + e.message);
    }
  }

  status() {
    return {
      paused: this.paused,
      running: !!this.cdp && !this.cdp.closed,
      current: this.current,
      counters: this.counters,
      lastError: this.lastError,
      activeHours: this.cfg.behavior.activeHours,
      inWindow: inActiveHours(this.cfg.behavior.activeHours),
      updatedAt: new Date().toISOString(),
    };
  }

  pause() { this.paused = true; this.logger.info('已暂停'); }
  resume() { this.paused = false; this.logger.info('已恢复'); }
  stop() { this.stopped = true; }

  /** 关闭本监督器启动的 Chrome（只在 attached 模式下由我们负责） */
  close() {
    try { this.cdp?.close(); } catch { /* ignore */ }
    if (this.chromeProc && this.chromeProc.exitCode === null) {
      try { this.chromeProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }

  // ---------- 连接层 ----------
  async #connect() {
    const { port, profileDir, headless, executable, extraArgs, attached } = this.cfg.chrome;
    const wsUrl = await ensureChrome({
      port, profileDir, headless, executable, extraArgs, attached, logger: this.logger,
      onChild: (c) => { this.chromeProc = c; },
    });
    const cdp = new CDP(wsUrl);
    await cdp.ready();
    this.cdp = cdp;
    this.logger.debug('CDP 已连接');
    return cdp;
  }

  async #openPage(cdp, url) {
    const cookies = loadCookies(this.cfg.cookies.file);
    if (!hasLoginCookies(cookies)) {
      this.logger.warn('Cookie 里没有 CASTGC/CASLOGC/SESSION，可能已失效，需要重新导出');
    }
    await newPage(cdp, { userAgent: UA, viewport: VIEWPORT });
    await cdp.send('Network.setCookies', { cookies }).catch((e) => this.logger.warn('注入 Cookie 失败：' + e.message));
    this.logger.info(`注入 Cookie ${cookies.length} 条`);
    const ok = await navigate(cdp, url);
    if (!ok) {
      const host = await cdp.eval('location.host').catch(() => '');
      if (LOGIN_HOSTS.test(host)) throw new LoginExpired('智慧树登录态已失效，请重新扫码登录或更新 Cookie');
      throw new Error('页面未挂载（可能是登录态失效或网络问题）');
    }
    this.logger.info('页面就绪：' + (await cdp.eval('location.host')));
  }

  // ---------- 单门课 ----------
  async #runCourse(cdp, course) {
    const b = this.cfg.behavior;
    const key = course.url;
    const prev = this.state.courses[key] || {};
    this.state.courses[key] = { name: course.name || '', ...prev, lastSeenAt: new Date().toISOString() };
    this.#saveState();

    this.logger.info(`▶ 开始课程：${course.name || course.url.slice(0, 60)}`);
    this.emit('course_start', { name: course.name, url: course.url });
    await this.#openPage(cdp, course.url);

    let sections = 0;
    let lastProgressAt = Date.now();
    let lastT = -1;
    let idleRounds = 0;

    while (!this.stopped) {
      if (this.paused) { await sleep(3000); continue; }
      if (!inActiveHours(b.activeHours)) {
        this.logger.debug('不在活跃时段，等待');
        await sleep(60_000);
        continue;
      }

      const s = await readState(cdp).catch(() => null);
      if (!s) { await sleep(b.pollMs); continue; }

      this.current = { name: course.name, idx: s.idx, txt: s.txt, t: s.t, d: s.d, host: s.host };
      if (s.total > 0 && s.idx >= 0) this.progress('course', s.idx + 1, s.total, s.txt || '');
      if (s.d > 0 && s.t !== null) this.progress('item', Math.floor(s.t), Math.floor(s.d), s.txt || '', Math.max(0, Math.round(s.d - s.t)));

      // 被踢回门户 / 跳走
      if (s.host !== HOST) {
        this.counters.kicks++;
        this.logger.warn(`被重定向到 ${s.host}（第 ${this.counters.kicks} 次），重新进入`);
        this.emit('kicked', { host: s.host, count: this.counters.kicks });
        this.state.courses[key].kicks = (this.state.courses[key].kicks || 0) + 1;
        this.#saveState();
        if (LOGIN_HOSTS.test(s.host)) {
          throw new LoginExpired('智慧树登录态已失效，请重新扫码登录或更新 Cookie');
        }
        if (this.counters.kicks > b.maxKicksPerHour) {
          throw new LoginExpired(`一小时内被重定向 ${this.counters.kicks} 次，疑似登录态失效或风控，停止本课程`);
        }
        await this.#openPage(cdp, course.url);
        continue;
      }

      // 有弹窗（弹题/公告）就停手，等人处理
      if (s.dialogs?.length) {
        this.logger.warn(`检测到弹窗，暂停操作：${s.dialogs.join(' | ')}`);
        await sleep(10_000);
        continue;
      }

      if (s.total === 0 || s.idx < 0) {
        this.logger.debug('章节列表未就绪…');
        await sleep(b.pollMs);
        continue;
      }

      this.state.courses[key].lastSection = s.txt;
      this.state.courses[key].lastIndex = s.idx;

      // 未在播放则拉起
      if (s.paused && (s.t ?? 0) < (s.d ?? 0) - 1) {
        await ensurePlaying(cdp).catch(() => {});
      }

      // 测试模式：快进到片尾，用于快速验证链路
      if (b.seekTest && s.d && s.t !== null && s.d - s.t > 8) {
        await cdp.eval(`(() => { const v = document.querySelector('video'); if (v) v.currentTime = Math.max(0, v.duration - 4); return 1 })()`).catch(() => {});
        this.logger.debug('测试模式：快进到片尾');
      }

      const finished = s.d > 0 && s.t >= s.d - 0.6;

      if (finished) {
        this.logger.success(`本节完成：${s.txt}（${s.d}s）`);
        this.emit('item_done', { course: course.name, section: s.txt, index: s.idx, duration: s.d });
        const step = await clickNextSection(cdp, s.idx, {
          skip: b.skipKeywords,
          onLog: (m) => this.logger.debug(m),
        });

        if (!step.ok && step.finished) {
          this.logger.success(`课程已到最后一节：${course.name || ''}`);
          this.emit('course_done', { name: course.name, url: course.url, sections });
          this.state.courses[key].doneAt = new Date().toISOString();
          this.#saveState();
          return 'finished';
        }
        if (!step.ok) {
          this.logger.warn('切下一节失败：' + step.reason + '，重载页面重试');
          await this.#openPage(cdp, course.url);
          continue;
        }

        // 等切换生效
        let switched = false;
        for (let i = 0; i < 25; i++) {
          await sleep(1000);
          const n = await readState(cdp).catch(() => null);
          if (!n) continue;
          if (n.host !== HOST) break;
          if (n.idx === step.targetIdx && (n.src !== s.src || (n.d > 0 && n.t > 0))) { switched = true; break; }
        }
        if (!switched) {
          this.logger.warn('切换未确认，重新加载课程页');
          await this.#openPage(cdp, course.url);
          continue;
        }

        sections++;
        this.counters.sections++;
        this.state.courses[key].sectionsDone = (this.state.courses[key].sectionsDone || 0) + 1;
        this.#saveState();
        this.logger.info(`已推进 ${sections} 节 → ${step.targetText || ''}`);

        // 定期重载，释放长时间播放累积的内存
        if (b.reloadEverySections > 0 && sections % b.reloadEverySections === 0) {
          this.logger.debug(`已跑 ${sections} 节，重载页面`);
          await this.#openPage(cdp, course.url);
        }

        if (b.maxSectionsPerCourse > 0 && sections >= b.maxSectionsPerCourse) {
          this.logger.info(`达到单课上限 ${b.maxSectionsPerCourse} 节，退出本课程`);
          return 'capped';
        }

        lastProgressAt = Date.now();
        lastT = -1;
        await sleep(b.sectionGapMs);
        continue;
      }

      // 卡播检测：时间长时间不前进
      if (s.t !== null && s.t === lastT) {
        idleRounds++;
        if (Date.now() - lastProgressAt > b.emptySectionStallMs) {
          this.logger.warn(`播放卡住 ${Math.round(b.emptySectionStallMs / 1000)}s（t=${s.t}/${s.d}），重载页面`);
          await this.#openPage(cdp, course.url);
          lastProgressAt = Date.now();
          idleRounds = 0;
        }
      } else {
        lastT = s.t;
        lastProgressAt = Date.now();
        idleRounds = 0;
        this.logger.debug(`▶ ${s.txt} ${s.t}/${s.d}s`);
      }

      await sleep(b.pollMs);
    }
    return 'stopped';
  }

  // ---------- 主循环 ----------
  async run() {
    const b = this.cfg.behavior;
    if (!fs.existsSync(this.cfg.cookies.file)) {
      throw new Error(`缺少 Cookie 文件：${this.cfg.cookies.file}，先执行 cookies 子命令`);
    }
    let round = 0;

    while (!this.stopped) {
      round++;
      try {
        const cdp = await this.#connect();

        for (const [ci, course] of this.cfg.courses.entries()) {
          if (this.stopped) break;
          this.progress('overall', ci, this.cfg.courses.length, course.name || '');
          // 已经跑完的课跳过（除非配置了重跑）
          const st = this.state.courses[course.url];
          if (st?.doneAt && !course.force) {
            this.logger.info(`跳过已完成课程：${course.name || course.url.slice(0, 40)}`);
            continue;
          }
          const res = await this.#runCourse(cdp, course);
          if (res === 'finished') this.counters.courses++;
          if (this.stopped) break;
        }

        if (this.stopped) break;
        this.progress('overall', this.cfg.courses.length, this.cfg.courses.length, '');
        if (b.once) {
          this.logger.success('全部课程已处理完毕');
          break;
        }
        this.logger.info(`第 ${round} 轮全部课程结束，${Math.round(b.restartDelayMs / 60000)} 分钟后复查`);
        await sleep(b.restartDelayMs ?? 1800_000);
      } catch (e) {
        this.lastError = { at: new Date().toISOString(), msg: e.message };
        this.counters.restarts++;
        // 任务模式：登录失效直接结束；其他错误重试有限次数
        if (b.once && (e.code === 'LOGIN' || this.counters.restarts > (b.maxRestarts ?? 3))) {
          this.close();
          throw e;
        }
        const backoff = Math.min(30_000 * this.counters.restarts, 10 * 60_000);
        this.logger.error(`运行异常：${e.message}；${Math.round(backoff / 1000)}s 后重启`);
        this.close();
        this.cdp = null;
        this.chromeProc = null;
        await sleep(backoff);
      }
    }
    this.close();
    this.logger.info('监督器已停止');
  }
}
