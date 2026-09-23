/* 「前 N 个 + 展开全部」校验：默认只显示 8 个、展开/收起、状态持久化、拖拽不受影响
   用法：需先有静态服务器 python3 -m http.server 5199 --directory dist
   然后：node test/grid-preview-check.mjs */
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9234';
const PAGE_URL = 'http://localhost:5199/';
const SHOT_DIR = fileURLToPath(new URL('./screens/', import.meta.url));
const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const EDGE_BIN = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE_BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');

mkdirSync(SHOT_DIR, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'cardtree-preview-'));
const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  `--remote-debugging-port=9234`, `--user-data-dir=${profile}`,
  '--window-size=1440,940', 'about:blank',
], { stdio: 'ignore' });

async function waitHttp(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await (await fetch(url)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('CDP 未就绪: ' + url);
}

// 目标文件夹「常用工具」里书签数量与「展开全部」按钮状态
const PROBE = (fid) => `(async () => {
  const nodes = [...document.querySelectorAll('.cascade-node')];
  const target = nodes.find(n => n.querySelector('.cascade-title')?.textContent.includes('常用工具'));
  if (!target) return { err: '找不到 常用工具 文件夹' };
  if (target.classList.contains('is-collapsed')) {
    target.querySelector('.cascade-toggle').click();
    await new Promise(r => setTimeout(r, 400));
  }
  const grid = target.querySelector('.bookmark-grid');
  const more = grid.querySelector('.grid-more');
  const bar = (await window.__bm.getRoots()).find(r => (r.title || '').includes('书签栏'));
  return {
    totalInFolder: bar.children.find(c => c.title === '常用工具').children.length,
    visibleItems: grid.querySelectorAll('.bookmark-item').length,
    hasMoreButton: !!more,
    moreText: more ? more.textContent.trim() : null,
    expandedFlag: window.__store.expandedGrids.has(${JSON.stringify(fid)}),
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
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOT_DIR, `preview-${name}.png`), Buffer.from(data, 'base64'));
  };
  const waitReady = async () => {
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      if (await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false)) return;
    }
    throw new Error('页面未就绪');
  };
  const probe = async () => {
    const fid = await ev(`(async () => { const roots = await window.__bm.getRoots(); const bar = roots.find(r => (r.title||'').includes('书签栏')); return bar.children.find(c => c.title === '常用工具').id })()`);
    return await ev(PROBE(fid));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: PAGE_URL });
  await waitReady();
  await sleep(1200);

  // 造一个"书签很多"的文件夹：往「常用工具」里再加 12 个
  await ev(`(async () => {
    const roots = await window.__bm.getRoots();
    const bar = roots.find(r => (r.title || '').includes('书签栏'));
    const tools = bar.children.find(c => c.title === '常用工具');
    for (let i = 1; i <= 12; i++) {
      await window.__bm.create(tools.id, { title: '额外站点 ' + i, url: 'https://example.com/' + i });
    }
    await new Promise(r => setTimeout(r, 600));
    return true;
  })()`);
  await sleep(900);

  const report = {};
  report.afterAdd = await probe();
  await shot('01-collapsed');

  // 点「展开全部」
  await ev(`(async () => {
    const nodes = [...document.querySelectorAll('.cascade-node')];
    const t = nodes.find(n => n.querySelector('.cascade-title')?.textContent.includes('常用工具'));
    if (t.classList.contains('is-collapsed')) t.querySelector('.cascade-toggle').click();
    await new Promise(r => setTimeout(r, 400));
    t.querySelector('.grid-more')?.click();
    await new Promise(r => setTimeout(r, 400));
    return true;
  })()`);
  await sleep(500);
  report.afterExpand = await probe();
  await shot('02-expanded');

  // 收起
  await ev(`(async () => {
    const nodes = [...document.querySelectorAll('.cascade-node')];
    const t = nodes.find(n => n.querySelector('.cascade-title')?.textContent.includes('常用工具'));
    t.querySelector('.grid-more')?.click();
    await new Promise(r => setTimeout(r, 400));
    return true;
  })()`);
  await sleep(400);
  report.afterCollapse = await probe();

  // 持久化：再展开 → 重载 → 应保持展开
  await ev(`(async () => {
    const nodes = [...document.querySelectorAll('.cascade-node')];
    const t = nodes.find(n => n.querySelector('.cascade-title')?.textContent.includes('常用工具'));
    t.querySelector('.grid-more')?.click();
    await new Promise(r => setTimeout(r, 400));
    return true;
  })()`);
  await sleep(400);
  report.storedExpandedGrids = await ev(`localStorage.getItem('cardtree:expandedGrids')`);
  await send('Page.reload');
  await waitReady();
  await sleep(900);
  report.afterReload = await probe();

  // 拖拽仍可用：把根卡片第一个书签拖到「常用工具」标题上（inside），确认不报错且落点被识别
  report.dragStillWorks = await ev(`(async () => {
    const item = document.querySelector('.root-card > .bookmark-grid .bookmark-item') || document.querySelector('.bookmark-item');
    const nodes = [...document.querySelectorAll('.cascade-node')];
    const t = nodes.find(n => n.querySelector('.cascade-title')?.textContent.includes('常用工具'));
    const card = t.querySelector('.cascade-card');
    const r = card.getBoundingClientRect();
    const dt = new DataTransfer();
    item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    card.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    await new Promise(r => setTimeout(r, 200));
    const target = window.__store.dropTarget ? { type: window.__store.dropTarget.type, folderId: window.__store.dropTarget.folderId } : null;
    item.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }));
    return { target, draggingStopped: !window.__store.dragging };
  })()`);

  console.log(JSON.stringify(report, null, 2));
} finally {
  try { ws && ws.close(); } catch {}
  try { edge.kill('SIGTERM'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
