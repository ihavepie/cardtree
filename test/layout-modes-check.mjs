/* 文件夹排列校验：纵排 / 并排 —— 文件夹列数、网址是否始终横排、拖拽指示线、持久化
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

// 页面内测量：文件夹列数 / 网址列数 / 填充方向
const PROBE = `(() => {
  const rootCard = document.querySelector('.root-card');
  // 顶层文件夹（根卡片里直接那一层 cascade-node）
  const topFolders = [...rootCard.querySelectorAll(':scope > .cascade-children > .cascade-node')];
  const fx = [...new Set(topFolders.map(n => Math.round(n.getBoundingClientRect().left)))].sort((a,b) => a-b);
  const fy = [...new Set(topFolders.map(n => Math.round(n.getBoundingClientRect().top)))].sort((a,b) => a-b);

  // 网址（书签条）：根卡片里第一个网格 + 第一个文件夹内部的网格
  const measureGrid = (grid) => {
    if (!grid) return null;
    const items = [...grid.querySelectorAll('.bookmark-item')];
    const rects = items.map(e => e.getBoundingClientRect());
    const xs = [...new Set(rects.map(r => Math.round(r.left)))].sort((a,b) => a-b);
    const ys = [...new Set(rects.map(r => Math.round(r.top)))].sort((a,b) => a-b);
    const node = grid.closest('.cascade-node');
    const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    return {
      folder: node ? (node.querySelector('.cascade-title-text')?.textContent || '?') : '(根卡片)',
      width: Math.round(grid.getBoundingClientRect().width),
      items: items.length,
      tracks,
      columns: xs.length,
      rows: ys.length,
      rowMajor: items.length > 1 ? Math.round(rects[0].top) === Math.round(rects[1].top) : null,
      css: getComputedStyle(grid).gridTemplateColumns,
    };
  };
  const grid = rootCard.querySelector('.bookmark-grid');
  const insideFolderGrid = rootCard.querySelector('.cascade-node .bookmark-grid');

  return {
    folderCount: topFolders.length,
    folderColumns: fx.length,
    folderRows: fy.length,
    folderLefts: fx.map(x => Math.round(x)),
    folderOrderIsRowMajor: topFolders.length > 1 ? Math.round(topFolders[0].getBoundingClientRect().top) === Math.round(topFolders[1].getBoundingClientRect().top) : null,
    rootGrid: measureGrid(grid),
    insideFolderGrid: measureGrid(insideFolderGrid),
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

  const report = {};
  for (const mode of ['stack', 'columns']) {
    await ev(`(async () => {
      window.__store.layoutMode = '${mode}';
      window.__store.selection.clear();           // 清选中，避免详情抽屉挡住右侧
      document.querySelectorAll('.cascade-node.is-collapsed > .cascade-card .cascade-toggle').forEach(b => b.click());
      await new Promise(r => setTimeout(r, 600));
      return true
    })()`);
    await sleep(800);
    report[mode] = await ev(PROBE);
    await shot(mode);

    // 同级文件夹之间拖拽：指示线取向（并排应为竖线 v，纵排应为横线 h）
    report[mode].folderDropLine = await ev(`(async () => {
      const nodes = [...document.querySelectorAll('.root-card > .cascade-children > .cascade-node')];
      if (nodes.length < 2) return null;
      const src = nodes[0].querySelector('.cascade-heading');
      const dstNode = nodes[1];
      const dst = dstNode.querySelector('.cascade-heading');
      const r = dst.getBoundingClientRect();
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
      await new Promise(r => setTimeout(r, 200));
      const el = document.querySelector('.drop-line');
      const out = el ? { cls: el.className, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }));
      await new Promise(r => setTimeout(r, 200));
      return out;
    })()`);
  }

  // 顶栏选项面板：打开菜单 → 依次选各档 → 量文件夹栏数
  const openMenuProbe = `(async () => {
    const btn = [...document.querySelectorAll('.header-actions .icon-btn')].find(b => (b.title || '').startsWith('文件夹排列'));
    if (!btn) return { err: '找不到布局按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 250));
    const menu = document.querySelector('.context-menu');
    return {
      title: btn.title,
      items: menu ? [...menu.querySelectorAll('.context-menu-item')].map(i => i.textContent.trim()) : null,
    };
  })()`;

  const countFolders = `(() => {
    const nodes = [...document.querySelectorAll('.root-card > .cascade-children > .cascade-node')];
    const lefts = [...new Set(nodes.map(n => Math.round(n.getBoundingClientRect().left)))].sort((a,b) => a-b);
    return { folders: nodes.length, columns: lefts.length, lefts };
  })()`;

  report.menu = await ev(openMenuProbe);
  await ev(`document.querySelector('.context-menu') && document.body.click()`);
  await sleep(200);

  report.presets = {};
  for (const pick of ['文件夹并排 · 2 列', '文件夹并排 · 3 列', '文件夹并排 · 4 列', '文件夹纵排（一条条往下堆）']) {
    await ev(`(async () => {
      const btn = [...document.querySelectorAll('.header-actions .icon-btn')].find(b => (b.title || '').startsWith('文件夹排列'));
      btn.click();
      await new Promise(r => setTimeout(r, 200));
      const it = [...document.querySelectorAll('.context-menu-item')].find(i => i.textContent.trim().replace('✓ ', '').replace('　', '').includes(${JSON.stringify(pick)}));
      if (!it) return { err: '菜单项不存在: ' + ${JSON.stringify(pick)} };
      it.click();
      await new Promise(r => setTimeout(r, 400));
      return true;
    })()`);
    await sleep(500);
    report.presets[pick] = {
      ...(await ev(countFolders)),
      layoutMode: await ev(`window.__store.layoutMode`),
      folderCols: await ev(`window.__store.folderCols`),
      cssVar: await ev(`getComputedStyle(document.querySelector('.app')).getPropertyValue('--folder-cols').trim()`),
    };
  }

  // 持久化：选「并排 · 3 列」→ 重载 → 是否记住
  await ev(`(async () => {
    window.__store.layoutMode = 'columns'; window.__store.folderCols = 3;
    await new Promise(r => setTimeout(r, 400)); return true
  })()`);
  await sleep(300);
  const stored = await ev(`[localStorage.getItem('cardtree:layoutMode'), localStorage.getItem('cardtree:folderCols')]`);
  await send('Page.reload');
  await waitReady();
  await sleep(800);
  report.persistence = {
    writtenToStorage: stored,
    afterReload: [await ev(`window.__store.layoutMode`), await ev(`window.__store.folderCols`)],
    appClass: await ev(`document.querySelector('.app').className`),
    cssVar: await ev(`getComputedStyle(document.querySelector('.app')).getPropertyValue('--folder-cols').trim()`),
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  try { ws && ws.close(); } catch {}
  try { edge.kill('SIGTERM'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
