/* 视觉检查：自启动无头 Edge，截取新标签页首页（折叠 / 展开 / 深色三态）
   用法：node test/shot-home.mjs [文件名前缀] [宽] [高]
   需先有静态服务器：python3 -m http.server 5199 --directory dist */
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = process.argv[2] || 'shot';
const W = Number(process.argv[3] || 1440);
const H = Number(process.argv[4] || 940);
const CDP_HTTP = 'http://127.0.0.1:9231';
const PAGE_URL = 'http://localhost:5199/';
const SHOT_DIR = fileURLToPath(new URL('./screens/', import.meta.url));

// Edge 可能装在 /Applications 或外置卷；用 EDGE_BIN 可覆盖
const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const EDGE_BIN = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE_BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定：\n' + EDGE_CANDIDATES.join('\n'));

mkdirSync(SHOT_DIR, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'cardtree-shot-'));
const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  `--remote-debugging-port=9231`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

async function waitHttp(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { return await (await fetch(url)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('CDP 未就绪: ' + url);
}

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
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: PAGE_URL });
  for (let i = 0; i < 80; i++) { await sleep(250); if (await ev('!!(window.__store && !window.__store.loading)')) break; }
  await sleep(2200); // 等 favicon

  async function shot(name) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(SHOT_DIR, `${PREFIX}-${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('已保存', file);
  }

  await shot('01-collapsed');

  // 展开所有子文件夹
  await ev(`(async () => {
    const toggles = [...document.querySelectorAll('.cascade-toggle')];
    for (const t of toggles) { t.click(); await new Promise(r => setTimeout(r, 120)); }
    await new Promise(r => setTimeout(r, 700));
    return toggles.length;
  })()`);
  await sleep(900);
  await shot('02-expanded');

  // 深色
  await ev(`(async () => { window.__store.theme = 'dark'; await new Promise(r => setTimeout(r, 600)); return true })()`);
  await sleep(700);
  await shot('03-dark');

  // 悬停一个书签 chip，检查 hover 态
  await ev(`(async () => {
    window.__store.theme = 'light'; await new Promise(r => setTimeout(r, 400));
    const item = document.querySelector('.bookmark-item');
    if (!item) return false;
    const r = item.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`).then(async (pos) => {
    if (!pos) return;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    await sleep(500);
    await shot('04-hover');
  });

  // 拖拽插入指示线（多列布局下为竖线）——只做 dragover，不 drop，不改数据
  const dropInfo = await ev(`(async () => {
    const items = [...document.querySelectorAll('.bookmark-item')];
    const title = (e) => e.querySelector('.bookmark-title')?.textContent;
    const src = items.find(e => title(e) === 'YouTube');
    const dst = items.find(e => title(e) === 'Notion') || items[1];
    if (!src || !dst) return { err: 'not found' };
    const r = dst.getBoundingClientRect();
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    window.__store.selection.clear(); // 清掉选中态，避免详情抽屉挡住右侧
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
    await new Promise(r => setTimeout(r, 250));
    const line = document.querySelector('.drop-line');
    return { hasLine: !!line, cls: line ? line.className : null, w: line ? Math.round(line.getBoundingClientRect().width) : 0, h: line ? Math.round(line.getBoundingClientRect().height) : 0 };
  })()`);
  console.log('拖拽指示线:', JSON.stringify(dropInfo));
  if (!dropInfo?.err) await shot('05-dropline');
  await ev(`(async () => {
    const el = [...document.querySelectorAll('.bookmark-item')].find(e => e.querySelector('.bookmark-title')?.textContent === 'YouTube');
    el?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }));
    await new Promise(r => setTimeout(r, 200));
    return true;
  })()`);

  const meta = await ev(`(() => {
    const g = document.querySelector('.bookmark-grid');
    return {
      cols: g ? getComputedStyle(g).gridTemplateColumns : null,
      items: document.querySelectorAll('.bookmark-item').length,
      folders: document.querySelectorAll('.cascade-heading').length,
    };
  })()`);
  console.log('布局:', JSON.stringify(meta));
} finally {
  try { ws && ws.close(); } catch {}
  try { edge.kill('SIGTERM'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
