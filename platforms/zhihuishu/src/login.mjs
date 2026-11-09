// 服务端模式下的登录与课程发现：都在无头 Chrome 里完成，不需要本机已登录的浏览器。
//  - qrLogin：打开智慧树登录中心的「扫码」页，把二维码转给宿主显示，用知到 App 扫码
//  - discoverCourses：带着 Cookie 打开学生端首页，从页面发出的接口响应里找课程
import { CDP, ensureChrome, newPage, sleep } from './cdp.mjs';
import { hasLoginCookies } from './cookies.mjs';
import { UA, VIEWPORT } from './page.mjs';

export const LOGIN_URL =
  'https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Flogin%2Fgologin';
export const STUDENT_HOME = 'https://onlineweb.zhihuishu.com/onlinestuh5';
export const STUDY_URL = (id) => `https://wisdom-mooc.zhihuishu.com/study/index?recruitAndCourseId=${encodeURIComponent(id)}`;

const SESSION_TTL_DAYS = 30;

async function openBrowser(chrome, logger, onChild) {
  const ws = await ensureChrome({ ...chrome, attached: true, onChild, logger });
  const cdp = new CDP(ws);
  await cdp.ready();
  await newPage(cdp, { userAgent: UA, viewport: VIEWPORT });
  return cdp;
}

/** CDP 的 Cookie 转成 Network.setCookies 能直接吃的格式；会话 Cookie 补一个过期时间 */
export function normalizeCookies(list) {
  const now = Math.floor(Date.now() / 1000);
  return list
    .filter((c) => c && c.name && String(c.domain || '').includes('zhihuishu'))
    .map((c) => ({
      name: c.name,
      value: String(c.value ?? ''),
      domain: c.domain,
      path: c.path || '/',
      expires: c.expires && c.expires > 0 && !c.session ? Math.floor(c.expires) : now + SESSION_TTL_DAYS * 86400,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
    }));
}

/** CASLOGC 里是 URL 编码的 JSON，带真实姓名和 uuid */
export function userFromCookies(cookies) {
  const c = cookies.find((x) => x.name === 'CASLOGC');
  if (!c) return null;
  try {
    const info = JSON.parse(decodeURIComponent(c.value));
    return {
      name: info.realName || info.username || '',
      id: String(info.uuid || info.userId || ''),
      username: info.username || '',
    };
  } catch {
    return null;
  }
}

async function zhsCookies(cdp) {
  const { cookies } = await cdp.send('Network.getAllCookies');
  return normalizeCookies(cookies || []);
}

const QR_EXPR = `(() => {
  const imgs = [...document.querySelectorAll('img')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 100 && r.width < 400 && Math.abs(r.width - r.height) < 8 && (e.src || '').startsWith('data:image');
  });
  const expired = [...document.querySelectorAll('div,span,p')].some((e) =>
    e.children.length === 0 && /已失效|已过期|点击刷新|刷新二维码/.test(e.innerText || '') && e.getBoundingClientRect().width > 0);
  return { host: location.host, src: imgs[0]?.src || '', expired };
})()`;

async function clickByText(cdp, selector, text) {
  const r = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`);
  if (!r) return false;
  await cdp.clickAt(r.x, r.y);
  return true;
}

/**
 * 扫码登录。onQr(dataUrl) 每当二维码变化时调用；isCancelled() 为真时提前结束。
 * 返回 { cookies, user }。
 */
export async function qrLogin({ chrome, logger, onQr, onChild, isCancelled = () => false, timeoutMs = 300_000 }) {
  const cdp = await openBrowser(chrome, logger, onChild);
  try {
    await cdp.send('Network.clearBrowserCookies').catch(() => {});
    await cdp.send('Page.navigate', { url: LOGIN_URL });

    let tabOk = false;
    for (let i = 0; i < 30 && !tabOk; i++) {
      await sleep(1000);
      tabOk = await clickByText(cdp, '.el-tabs__item', '扫码').catch(() => false);
    }
    if (!tabOk) throw new Error('登录页没有出现「扫码」选项，页面可能改版了');

    let lastSrc = '';
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (isCancelled()) throw new Error('已取消');
      await sleep(1500);
      const st = await cdp.eval(QR_EXPR).catch(() => null);
      if (!st) continue;
      if (!/login\.zhihuishu|passport\.zhihuishu/.test(st.host)) {
        logger.info(`扫码成功，已跳转到 ${st.host}`);
        break;
      }
      const cookies = await zhsCookies(cdp);
      if (hasLoginCookies(cookies) && cookies.some((c) => c.name === 'CASTGC')) break;
      if (st.expired) {
        logger.info('二维码已过期，刷新');
        await clickByText(cdp, '.el-tabs__item', '账号登录').catch(() => {});
        await sleep(800);
        await clickByText(cdp, '.el-tabs__item', '扫码').catch(() => {});
        continue;
      }
      if (st.src && st.src !== lastSrc) {
        lastSrc = st.src;
        onQr(st.src);
      }
    }
    if (Date.now() - t0 >= timeoutMs) throw new Error('扫码超时');

    // 跟完 CAS 跳转，让各子域都种上 Cookie
    await sleep(3000);
    await cdp.send('Page.navigate', { url: STUDENT_HOME }).catch(() => {});
    await sleep(6000);
    const cookies = await zhsCookies(cdp);
    if (!hasLoginCookies(cookies)) throw new Error('扫码后没有拿到登录 Cookie');
    return { cookies, user: userFromCookies(cookies) };
  } finally {
    cdp.close();
  }
}

function walk(node, out, depth = 0) {
  if (!node || depth > 12) return;
  if (Array.isArray(node)) {
    for (const x of node) walk(x, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const id = node.recruitAndCourseId;
  if (typeof id === 'string' && id.length > 8) {
    const name = node.courseName || node.name || node.title || node.courseTitle || '';
    const p = node.progress ?? node.schedule ?? node.studyProgress ?? node.learningProgress;
    let progress;
    if (typeof p === 'number') progress = p <= 1 ? Math.round(p * 100) : Math.round(p);
    else if (typeof p === 'string' && /^[\d.]+%?$/.test(p)) progress = Math.round(parseFloat(p));
    if (!out.has(id) || (name && !out.get(id).name)) out.set(id, { id, name: String(name), progress });
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, out, depth + 1);
}

/**
 * 带 Cookie 打开学生端首页，监听页面发出的 JSON 接口，凡是带 recruitAndCourseId 的对象都当作课程。
 * 智慧树接口经常改版，这里不绑定具体路径，失败时返回空数组，由用户手动填写学习页地址兜底。
 */
export async function discoverCourses({ chrome, cookies, logger, onChild, waitMs = 20_000 }) {
  const cdp = await openBrowser(chrome, logger, onChild);
  const found = new Map();
  const pending = new Set();
  try {
    cdp.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response;
        if (/json|text\/plain/.test(r.mimeType || '') && /zhihuishu/.test(r.url)) pending.add(m.params.requestId);
      }
      if (m.method === 'Network.loadingFinished' && pending.has(m.params.requestId)) {
        pending.delete(m.params.requestId);
        cdp.send('Network.getResponseBody', { requestId: m.params.requestId }, 10_000)
          .then((b) => {
            const text = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
            if (!text.includes('recruitAndCourseId')) return;
            try { walk(JSON.parse(text), found); } catch { /* not json */ }
          })
          .catch(() => {});
      }
    });
    await cdp.send('Network.setCookies', { cookies });
    await cdp.send('Page.navigate', { url: STUDENT_HOME });
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      await sleep(1000);
      const host = await cdp.eval('location.host').catch(() => '');
      if (/login\.zhihuishu|passport\.zhihuishu/.test(host)) {
        const err = new Error('智慧树登录态已失效，请重新扫码登录');
        err.code = 'LOGIN';
        throw err;
      }
      if (found.size > 0 && Date.now() - t0 > 8000) break;
    }
    // 页面里直接带链接的也收一下
    const links = await cdp.eval(`[...document.querySelectorAll('a[href*="recruitAndCourseId"]')].map((a) => [a.href, a.innerText.trim().slice(0, 60)])`).catch(() => []);
    for (const [href, text] of links || []) {
      const id = new URL(href).searchParams.get('recruitAndCourseId');
      if (id && !found.has(id)) found.set(id, { id, name: text });
    }
    return [...found.values()].map((c) => ({ ...c, url: STUDY_URL(c.id) }));
  } finally {
    cdp.close();
  }
}
