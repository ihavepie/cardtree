/* 布局切换校验：单列 / 横排多列 / 纵排多列 —— 实际列数、填充方向、拖拽指示线、持久化
   用法：需先有静态服务器 python3 -m http.server 5199 --directory dist
   然后：node test/layout-modes-check.mjs */
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9233';
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
const profile = mkdtempSync(join(tmpdir(), 'cardtree-layout-modes-'));
const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  `--remote-debugging-port=9233`, `--user-data-dir=${profile}`,
  '--window-size=1440,940', 'about:blank',
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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOT_DIR, `layout-${name}.png`), Buffer.from(data, 'base64'));
  };
  const waitReady = async () => {
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      if (await ev(`!!(window.__store && !window.__store.loading && document.querySelectorAll('.bookmark-item').length > 0)`).catch(() => false)) return;
    }
    throw new Error('页面未就绪');
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: PAGE_URL });
  await waitReady();
  await sleep(1500);

  // 一、三档布局：实际列数 / 行数 / 填充方向 / 拖拽指示线
  const report = {};
  for (const mode of ['single', 'row', 'col']) {
    await ev(`(async () => {
      window.__store.layoutMode = '${mode}';
      window.__store.selection.clear(); // 清选中，避免详情抽屉挡住右侧
      await new Promise(r => setTimeout(r, 500));
      return true
    })()`);
    await sleep(600);
    report[mode] = await ev(`(() => {
      const grid = document.querySelector('.bookmark-grid');
      const items = [...grid.querySelectorAll('.bookmark-item')];
      const rects = items.map(e => e.getBoundingClientRect());
      const xs = [...new Set(rects.map(r => Math.round(r.left)))].sort((a,b) => a-b);
      const ys = [...new Set(rects.map(r => Math.round(r.top)))].sort((a,b) => a-b);
      const cs = getComputedStyle(grid);
      return {
        items: items.length,
        gridTemplateColumns: cs.gridTemplateColumns,
        columnCount: cs.columnCount,
        display: cs.display,
        visualColumns: xs.length,
        visualRows: ys.length,
        // 填充方向：前两项同列 = 纵向(列优先)；同排不同列 = 横向(行优先)
        firstTwoShareColumn: Math.round(rects[0].left) === Math.round(rects[1].left),
        firstTwoShareRow: Math.round(rects[0].top) === Math.round(rects[1].top),
      };
    })()`);
    await shot(mode);

    // 拖拽指示线取向（横排应为竖线 v，单列/纵排应为横线 h）
    const line = await ev(`(async () => {
      const items = [...document.querySelectorAll('.bookmark-item')];
      const t = (e) => e.querySelector('.bookmark-title')?.textContent;
      const src = items[0], dst = items[1];
      const r = dst.getBoundingClientRect();
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      await new Promise(r => setTimeout(r, 200));
      const el = document.querySelector('.drop-line');
      const out = el ? { cls: el.className, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }));
      await new Promise(r => setTimeout(r, 200));
      return out;
    })()`);
    report[mode].dropLine = line;
  }

  // 二、顶栏按钮：点击循环一档并给出提示
  const cycle = [];
  for (let i = 0; i < 3; i++) {
    cycle.push(await ev(`(async () => {
      const btn = [...document.querySelectorAll('.header-actions .icon-btn')].find(b => (b.title || '').startsWith('布局'));
      if (!btn) return { err: '顶栏布局按钮不存在' };
      const before = window.__store.layoutMode, titleBefore = btn.title;
      btn.click();
      await new Promise(r => setTimeout(r, 250));
      return { before, after: window.__store.layoutMode, titleBefore, titleAfter: btn.title, toast: window.__store.toast?.msg || null };
    })()`));
  }
  report.topbarCycle = cycle;

  // 三、持久化：切到纵排 → 重新加载页面 → 是否记住
  await ev(`(async () => { window.__store.layoutMode = 'col'; await new Promise(r => setTimeout(r, 400)); return true })()`);
  await sleep(300);
  const stored = await ev(`localStorage.getItem('cardtree:layoutMode')`);
  await send('Page.reload');
  await waitReady();
  await sleep(800);
  report.persistence = {
    writtenToStorage: stored,
    afterReload: await ev(`window.__store.layoutMode`),
    appClass: await ev(`document.querySelector('.app').className`),
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  try { ws && ws.close(); } catch {}
  try { edge.kill('SIGTERM'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
