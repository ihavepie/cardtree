/* 侧边栏诊断：① 刷新时的首帧宽度时间线（是否先 230 再跳到存储值）② 拉伸前后的几何间距
   用法：python3 -m http.server 5199 --directory dist & 然后 node test/sidebar-diag.mjs [宽] [高] */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const W = Number(process.argv[2] || 1440);
const H = Number(process.argv[3] || 940);
const CDP_HTTP = 'http://127.0.0.1:9236';
const PAGE_URL = 'http://localhost:5199/';
const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const EDGE_BIN = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE_BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');

const profile = mkdtempSync(join(tmpdir(), 'cardtree-sidebar-'));
const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  `--remote-debugging-port=9236`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

async function waitHttp(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await (await fetch(url)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('CDP 未就绪');
}

const GEO = `(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; };
  const sb = r('.sidebar'), rs = r('.sidebar-resizer'), main = r('.main'), inner = r('.main-inner'), card = r('.root-card');
  return {
    window: window.innerWidth,
    sidebar: sb, resizer: rs, main, mainInner: inner, rootCard: card,
    gap_sidebar_to_card: card && sb ? card.l - sb.r : null,
    gap_sidebar_to_main: main && sb ? main.l - sb.r : null,
    card_left_inset_in_main: card && main ? card.l - main.l : null,
    card_right_inset_in_main: card && main ? main.r - card.r : null,
    mainInnerWidth: inner ? inner.w : null,
  };
})()`;

let ws;
try {
  const list = await waitHttp(CDP_HTTP + '/json');
  const target = list.find((t) => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitReady = async () => {
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      if (await ev(`!!(window.__store && !window.__store.loading)`).catch(() => false)) return;
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });

  // 首帧记录器：从文档创建就开始逐帧记录侧边栏宽度与 app 类名
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__boot = [];
      const t0 = performance.now();
      const rec = () => {
        const app = document.querySelector('.app');
        const s = document.querySelector('.sidebar');
        const b = s ? s.getBoundingClientRect() : null;
        window.__boot.push({
          t: Math.round(performance.now() - t0),
          app: app ? app.className : null,
          sbW: b ? Math.round(b.width) : null,
          sbL: b ? Math.round(b.left) : null,
          rows: document.querySelectorAll('.sf-row').length,
        });
        if (performance.now() - t0 < 2500) requestAnimationFrame(rec);
      };
      requestAnimationFrame(rec);
    })()`,
  });

  // 第一次加载：设一个非默认宽度（持久化到 storage）
  await send('Page.navigate', { url: PAGE_URL });
  await waitReady();
  await sleep(800);
  await ev(`(async () => { window.__store.sidebarWidth = 400; await new Promise(r => setTimeout(r, 500)); return localStorage.getItem('cardtree:sidebarWidth') })()`);
  const storedW = await ev(`localStorage.getItem('cardtree:sidebarWidth')`);

  // 第二次加载：观察首帧时间线
  await send('Page.reload');
  await waitReady();
  await sleep(600);
  const boot = await ev(`window.__boot || []`);
  const widthSeq = [];
  for (const f of boot) {
    const last = widthSeq[widthSeq.length - 1];
    if (!last || last.sbW !== f.sbW || last.app !== f.app || last.rows !== f.rows) widthSeq.push(f);
  }

  // 第三次加载：删掉异步存储里的宽度键（模拟"chrome.storage 还没回来"），
  // 首帧应当仍取到上次的宽度（来自同步镜像），不再从 230 跳一下
  await ev(`localStorage.removeItem('cardtree:sidebarWidth')`);
  const syncMirror = await ev(`localStorage.getItem('cardtree:sync:sidebarWidth')`);
  await send('Page.reload');
  await waitReady();
  await sleep(600);
  const boot2 = await ev(`window.__boot || []`);
  const firstFrameW = boot2.length ? boot2[0].sbW : null;
  const widthsSeen = [...new Set(boot2.map((f) => f.sbW))];

  const geoDefault = await ev(GEO);
  await ev(`(async () => { window.__store.sidebarWidth = 520; await new Promise(r => setTimeout(r, 600)); return true })()`);
  await sleep(500);
  const geoWide = await ev(GEO);
  await ev(`(async () => { window.__store.sidebarWidth = 150; await new Promise(r => setTimeout(r, 600)); return true })()`);
  await sleep(500);
  const geoNarrow = await ev(GEO);

  console.log(JSON.stringify({
    窗口: [W, H],
    存储的侧边栏宽度: storedW,
    首帧宽度序列: widthSeq.slice(0, 14),
    首帧总帧数: boot.length,
    无异步存储时的首帧: { 同步镜像值: syncMirror, 首帧宽度: firstFrameW, 出现过的宽度: widthsSeen },
    几何_默认400: geoDefault,
    几何_拉伸520: geoWide,
    几何_收窄150: geoNarrow,
  }, null, 2));
} finally {
  try { ws && ws.close(); } catch {}
  try { edge.kill('SIGTERM'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
