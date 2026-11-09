// 智慧树学习页操作原语。所有选择器与经验参数都来自实测，改动前请先跑 probe。
import { sleep } from './cdp.mjs';

export const HOST = 'wisdom-mooc.zhihuishu.com';
export const HOME_HOST = 'www.zhihuishu.com';
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
export const VIEWPORT = { width: 1600, height: 1000 };

export const DEFAULT_SKIP = ['测试', '考试', '作业', '讨论', '答疑'];

export const STATE_EXPR = `(() => {
  const items = [...document.querySelectorAll('.chapter-item')];
  const cur  = document.querySelector('.chapter-item.current');
  const v    = document.querySelector('video');
  const dialogs = [...document.querySelectorAll('.el-dialog,.el-overlay-message-box,.el-message-box')]
    .filter(e => { const s = getComputedStyle(e); return s.display !== 'none' && e.getBoundingClientRect().height > 0; })
    .map(e => e.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60))
    .filter(Boolean);
  return {
    host: location.host,
    total: items.length,
    idx: items.indexOf(cur),
    txt: cur ? cur.innerText.replace(/\\s+/g, ' ').trim().slice(0, 40) : null,
    src: v ? (v.src || '').slice(-20) : null,
    t: v ? +(+v.currentTime).toFixed(1) : null,
    d: v ? +(+v.duration || 0).toFixed(1) : null,
    paused: v ? v.paused : null,
    rs: v ? v.readyState : null,
    dialogs: dialogs.slice(0, 3),
  };
})()`;

export async function readState(cdp) {
  return cdp.eval(STATE_EXPR);
}

export async function waitMounted(cdp, timeout = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (cdp.closed) throw new Error('CDP 连接已关闭');
    const ok = await cdp.eval(`document.querySelector('#app')?.innerHTML.length > 1000`).catch(() => false);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

/**
 * headless 默认视口只有 ~756px，侧栏章节项 rect 全为 0，点击坐标会变成 (0,0)。
 * 而且 override 在部分情况下不会跨导航保留，所以每次关键操作前都检查一次。
 */
export async function ensureViewport(cdp) {
  const w = await cdp.eval('innerWidth').catch(() => 0);
  if (w < 1200) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    await sleep(400);
  }
  return cdp.eval('innerWidth').catch(() => 0);
}

export async function ensurePlaying(cdp) {
  return cdp.eval(`(() => {
    const v = document.querySelector('video');
    if (!v) return 'no-video';
    v.muted = true;
    if (v.paused) { v.play().catch(() => {}); return 'resumed'; }
    return 'playing';
  })()`);
}

/**
 * 切到当前节之后的第一个视频节。跳过「测试/考试」类，跨章节自动展开折叠组。
 * 必须用真实鼠标事件，否则会被风控踢回首页。
 */
export async function clickNextSection(cdp, idx, { skip = DEFAULT_SKIP, tries = 6, onLog } = {}) {
  await ensureViewport(cdp);
  const skipRe = skip.join('|');

  for (let attempt = 1; attempt <= tries; attempt++) {
    const rect = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('.chapter-item')];
      const curIdx = ${Number(idx)};
      let ti = -1;
      const skip = new RegExp(${JSON.stringify(skipRe)});
      for (let i = curIdx + 1; i < items.length; i++) {
        const t = items[i].innerText.replace(/\\s+/g, ' ').trim();
        if (skip.test(t)) continue;
        ti = i;
        break;
      }
      if (ti < 0) return { missing: true };
      const nx = items[ti];
      const wrap = nx.closest('.el-collapse-item');
      if (wrap && !String(wrap.className).includes('is-active')) {
        wrap.querySelector('.el-collapse-item__header')?.click();
      }
      const box = nx.querySelector('.item-box') || nx;
      box.scrollIntoView({ block: 'center' });
      const r = box.getBoundingClientRect();
      return {
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        w: Math.round(r.width), h: Math.round(r.height),
        targetIdx: ti,
        skipped: ti - curIdx - 1,
        targetText: nx.innerText.replace(/\\s+/g, ' ').trim().slice(0, 40),
      };
    })()`);

    if (rect?.missing) return { ok: false, reason: 'no-next', finished: true };
    if (rect && rect.w > 0) {
      if (rect.skipped > 0) onLog?.(`跳过 ${rect.skipped} 个非视频小节`);
      await cdp.clickAt(rect.x, rect.y);
      return { ok: true, targetIdx: rect.targetIdx, targetText: rect.targetText, attempt };
    }
    onLog?.(`下一节 rect 为 0（第 ${attempt}/${tries} 次），重测…`);
    await sleep(1500);
  }
  return { ok: false, reason: 'zero-rect' };
}

export async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  const ok = await waitMounted(cdp);
  await sleep(1200);
  await ensureViewport(cdp);
  return ok;
}

// ---------- 倍速与清晰度 ----------
// 学习页用的是智慧树自家的 ableVideoPlayerAiv2 播放器（lc.zhihuishu.com/ableVideoPlayerAiv2）：
//   倍速：.speedBox .speedTab[rate="2.0"]，点击后调用 player.playbackRate(rate) 并上报 changeRate；
//         课程未开启 isIncreaseRate 时列表里最高只有 1.5。
//   清晰度：.definiBox b.line1bq = 480P（流畅线路）、b.line1gq = 720P，选中项带 active；切换会重建播放器。
// 都走播放器自己的按钮，而不是直接改 <video>：播放器会把 playbackRate() 写进学习行为日志一起上报，
// 页面没有提供的倍速硬塞进去容易被判为异常学时。
export const QUALITY_CLASS = { '480p': 'line1bq', '720p': 'line1gq' };

/**
 * 把倍速设为 rate；页面没有这一档时用不超过它的最高一档。
 * 返回 { ok, rate, via, available }，via 为 'tab'（点了播放器按钮）/ 'kept'（已经是目标值）/ 'video'（无倍速按钮，直接设置）。
 */
export async function applyRate(cdp, rate) {
  return cdp.eval(`(() => {
    const want = ${Number(rate)};
    const v = document.querySelector('video');
    if (!v) return { ok: false, reason: 'no-video' };
    const tabs = [...document.querySelectorAll('.speedBox [rate], .speedList [rate]')]
      .map(el => ({ el, r: parseFloat(el.getAttribute('rate')) }))
      .filter(t => t.r > 0);
    const available = [...new Set(tabs.map(t => t.r))].sort((a, b) => a - b);
    if (!tabs.length) {
      if (Math.abs(v.playbackRate - want) <= 0.01) return { ok: true, rate: v.playbackRate, via: 'kept', available };
      v.playbackRate = want;
      return { ok: true, rate: v.playbackRate, via: 'video', available };
    }
    const fit = tabs.filter(t => t.r <= want + 0.001).sort((a, b) => b.r - a.r)[0] || tabs.sort((a, b) => a.r - b.r)[0];
    if (Math.abs(v.playbackRate - fit.r) <= 0.01) return { ok: true, rate: v.playbackRate, via: 'kept', available };
    fit.el.click();
    return { ok: true, rate: fit.r, via: 'tab', available };
  })()`);
}

/**
 * 切换清晰度（'480p' / '720p'）。返回 { ok, changed, reason, available }。
 */
export async function applyQuality(cdp, quality) {
  const cls = QUALITY_CLASS[String(quality || '').toLowerCase()];
  if (!cls) return { ok: true, changed: false, reason: 'keep' };
  return cdp.eval(`(() => {
    const lines = [...document.querySelectorAll('.definiLines b, .definiLines [class^="line1"]')];
    const available = lines.map(b => (b.innerText || b.className).trim()).filter(Boolean);
    // 旧版清晰度面板（.definiArea）选中后把 class 换成 line1bq_1
    if (document.querySelector('.${cls}_1')) return { ok: true, changed: false, reason: 'already', available };
    const el = document.querySelector('.definiLines .${cls}, .${cls}');
    if (!el) return { ok: false, changed: false, reason: 'missing', available };
    if (/(^|\\s)(active|${cls}_1)(\\s|$)/.test(el.className)) return { ok: true, changed: false, reason: 'already', available };
    el.click();
    return { ok: true, changed: true, available };
  })()`);
}
