/* 首帧校验（模拟真实扩展）：
   mock 模式走的是同步 localStorage，验不出"刷新弹一下"——真扩展里 chrome.storage 是异步 IPC，
   等它回来时首帧已经画过了。这里注入一个 chrome 桩，storage 故意延迟 40ms、bookmarks 延迟 30ms，
   然后用逐帧记录器看首帧的侧边栏宽度是不是已经是"上次的值"。
   用法：python3 -m http.server 5199 --directory dist & 然后 node test/sidebar-firstpaint-check.mjs [宽] [高] */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const W = Number(process.argv[2] || 1440);
const H = Number(process.argv[3] || 940);
const CDP_HTTP = 'http://127.0.0.1:9237';
const PAGE_URL = 'http://localhost:5199/';
const STORAGE_DELAY = 40; // 模拟 chrome.storage 的异步往返
const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const EDGE_BIN = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE_BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');

const profile = mkdtempSync(join(tmpdir(), 'cardtree-firstpaint-'));
const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  `--remote-debugging-port=9237`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

async function waitHttp(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await (await fetch(url)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('CDP 未就绪');
}

// chrome 桩：storage 异步且慢；书签树给一棵最小可用的
const CHROME_STUB = `
(() => {
  const bookmarks = [
    { id: 'bar', title: '书签栏', children: [
      { id: 'f1', title: '常用工具', children: [
        { id: 'b1', title: 'GitHub', url: 'https://github.com' },
        { id: 'b2', title: 'Gmail', url: 'https://mail.google.com' },
      ]},
      { id: 'b3', title: 'YouTube', url: 'https://www.youtube.com' },
      { id: 'b4', title: 'Notion', url: 'https://www.notion.so' },
    ]},
    { id: 'other', title: '其他书签', children: [] },
  ];
  const noopEvent = { addListener() {}, removeListener() {} };
  const store = Object.create(null);
  store.sidebarWidth = 400;   // 模拟"上次把侧边栏拉到 400"
  store.theme = 'dark';       // 模拟"上次用的是深色"
  window.__storageState = store;
  try { localStorage.setItem('cardtree:sync:theme', '"dark"') } catch (e) {}
  window.chrome = {
    runtime: { id: 'stub-extension', lastError: null },
    bookmarks: {
      getTree: (cb) => setTimeout(() => cb([{ id: '0', title: '', children: bookmarks }]), 30),
      create: (o, cb) => setTimeout(() => cb({ id: 'new-' + Math.random().toString(36).slice(2, 6), ...o }), 5),
      update: (id, c, cb) => setTimeout(() => cb({ id, ...c }), 5),
      removeTree: (id, cb) => setTimeout(() => cb(), 5),
      move: (id, d, cb) => setTimeout(() => cb({ id, ...d }), 5),
      onCreated: noopEvent, onRemoved: noopEvent, onChanged: noopEvent,
      onMoved: noopEvent, onChildrenReordered: noopEvent, onImportEnded: noopEvent,
    },
    storage: { local: {
      // 关键：异步返回，模拟 IPC 延迟
      get: (key, cb) => setTimeout(() => cb({ [key]: store[key] }), ${STORAGE_DELAY}),
      set: (obj) => Object.assign(store, obj),
    } },
  };
  // 逐帧记录器（在文档创建时就装好）
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
      theme: (document.body && document.body.dataset.theme) || null,
    });
    if (performance.now() - t0 < 2500) requestAnimationFrame(rec);
  };
  requestAnimationFrame(rec);
})()
`;

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
      await sleep(200);
      const ok = await ev(`document.querySelectorAll('.bookmark-item').length > 0 && !document.querySelector('.loading')`).catch(() => false);
      if (ok) return;
    }
    throw new Error('页面未就绪');
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_STUB });

  // 第 1 次：冷启动（镜像还是空的）→ 预期会"弹一下"
  await send('Page.navigate', { url: PAGE_URL });
  await waitReady();
  await sleep(700);
  const bootCold = await ev(`window.__boot || []`);
  const mirrorAfterCold = await ev(`localStorage.getItem('cardtree:sync:sidebarWidth')`);

  // 第 2 次：带着镜像刷新 → 首帧就应是上次的值，宽度不应再变化
  await send('Page.reload');
  await waitReady();
  await sleep(700);
  const bootWarm = await ev(`window.__boot || []`);

  // 第 3 次：手动清掉镜像（等价于修复前的行为）→ "弹一下"应重现，证明是镜像在起作用
  await ev(`localStorage.removeItem('cardtree:sync:sidebarWidth')`);
  await send('Page.reload');
  await waitReady();
  await sleep(700);
  const bootNoMirror = await ev(`window.__boot || []`);

  const summarize = (frames) => ({
    首帧宽度: frames.length ? frames[0].sbW : null,
    出现过的宽度: [...new Set(frames.map((f) => f.sbW))],
    发生过跳变: new Set(frames.map((f) => f.sbW)).size > 1,
    首帧主题: frames.length ? frames[0].theme : null,
    出现过的主题: [...new Set(frames.map((f) => f.theme))],
    前5帧: frames.slice(0, 5).map((f) => `${f.t}ms 宽${f.sbW} 主题${f.theme}`),
  });

  console.log(JSON.stringify({
    窗口: [W, H],
    storage延迟ms: STORAGE_DELAY,
    预置的上次宽度: 400,
    冷启动_无镜像: { ...summarize(bootCold), 冷启动后写下的镜像: mirrorAfterCold },
    带镜像刷新: summarize(bootWarm),
    清掉镜像刷新_对照: summarize(bootNoMirror),
  }, null, 2));
} finally {
  try { ws && ws.close(); } catch {}
  try { edge.kill('SIGTERM'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
