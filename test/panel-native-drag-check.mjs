/* 侧栏**两个把手**的真实鼠标验证（mock 模式 / localhost:5199）：
 *   H1 宽度把手 `.sidebar-resizer`：按住横拖 → sidebarWidth 变、侧栏真的变宽、落库、越界被夹
 *   H2 高度分隔条 `.sidebar-splitter`：按住竖拖 → panelSplit 变、上面那张卡变高、下面那张卡仍有空间、落库
 *   H3 两个把手都是"平时隐形、悬停浮出"（在 H1/H2 里各断言一次）
 *   H0 面板换位那套（拖拽条 / 幽灵块 / panelOrder）已整体移除，一个入口都不该再有
 *
 * 历史：这个脚本以前测的是"用真实鼠标事件拖标题栏换位"（原生拖拽在扩展里静默失败那件事）。
 * 换位连同拖拽条一起被移除了，只剩宽度把手 + 高度分隔条，于是重写成上面这几条。
 * 真实扩展环境（没有 window.__store）由 panel-drag-extension-check.mjs 覆盖。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9233';
const PAGE_URL = 'http://localhost:5199/';

const EDGE_CANDIDATES = [
  process.env.EDGE_BIN,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Volumes/TiPlus7100s/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const EDGE_BIN = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE_BIN) throw new Error('找不到 Microsoft Edge，可用 EDGE_BIN=... 指定');

const results = {};
const pageErrors = [];
const profile = mkdtempSync(join(tmpdir(), 'cardtree-native-'));

const edge = spawn(EDGE_BIN, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9233`, `--user-data-dir=${profile}`,
  '--window-size=1400,1000', 'about:blank',
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
  const target = list.find((t) => t.type === 'page' && t.url === 'about:blank') || list.find((t) => t.type === 'page');
  if (!target) throw new Error('no page target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async (name, fn) => {
    try { results[name] = await fn(); } catch (e) { results[name] = { ERROR: e.message }; }
  };

  // 手柄坐标：两个把手都取中心（命中区已向两侧撑开，不用精确瞄准那几像素）
  const handleBox = (sel) => ev(`(() => {
    const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const pill = (sel, pseudoState = '') => ev(`(() => {
    const s = getComputedStyle(document.querySelector(${JSON.stringify(sel)}), '::after');
    return { bg: s.backgroundColor, h: s.height };
  })()`);
  // 分步拖动（一步到位不算真实用户，也容易被实现当成跳变）
  async function dragMouse(from, dx, dy, steps = 8) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= steps; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + dx * i / steps),
        y: Math.round(from.y + dy * i / steps),
        button: 'left', buttons: 1,
      });
      await sleep(30);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x + dx, y: from.y + dy, button: 'left', buttons: 0 });
    await sleep(320);
  }
  const geom = () => ev(`(() => {
    const sb = document.querySelector('.sidebar');
    const p = document.querySelector('.panel--workspaces');
    const f = document.querySelector('.panel--folders');
    return {
      width: Math.round(sb.getBoundingClientRect().width),
      sidebarH: Math.round(sb.clientHeight),
      wsH: Math.round(p.getBoundingClientRect().height),
      foldersH: Math.round(f.getBoundingClientRect().height),
      flexBasis: getComputedStyle(p).flexBasis,
      maxHeight: getComputedStyle(p).maxHeight,
      split: window.__store.panelSplit,
    };
  })()`);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE_URL });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const ready = await ev(`!!(window.__store && !window.__store.loading && document.querySelector('.panel--folders'))`).catch(() => false);
    if (ready) break;
  }
  await sleep(600);

  // 起始状态归位，保证断言可重复
  await ev(`(async () => {
    window.__store.sidebarOpen = true;
    window.__store.sidebarWidth = 230;
    window.__store.panelSplit = 0.35;
    await new Promise((r) => setTimeout(r, 400));
    return true;
  })()`);

  await run('H0_reorder_ui_gone', async () => {
    const state = await ev(`({
      拖拽条: document.querySelectorAll('.panel-dragbar').length,
      幽灵块: !!document.querySelector('.panel-ghost'),
      可拖元素: document.querySelectorAll('.sidebar [draggable="true"]').length,
      落点高亮: document.querySelectorAll('.panel.drop-before, .panel.drop-after').length,
      store里还有panelOrder: 'panelOrder' in window.__store,
      storage里还有panelOrder: localStorage.getItem('cardtree:panelOrder'),
      面板顺序: [...document.querySelectorAll('.sidebar .panel')].map((p) => [...p.classList].find((c) => c.startsWith('panel--') && c !== 'panel--fit' && c !== 'panel--fill').replace('panel--', '')),
      宽度把手: !!document.querySelector('.sidebar-resizer'),
      高度分隔条: !!document.querySelector('.sidebar-splitter'),
    })`);
    return {
      ...state,
      无换位入口: state.拖拽条 === 0 && !state.幽灵块 && state.可拖元素 === 0 && !state.store里还有panelOrder,
    };
  });

  await run('H1_width_resizer', async () => {
    const before = await geom();
    const start = await handleBox('.sidebar-resizer');
    const idleCursor = await ev(`getComputedStyle(document.querySelector('.sidebar-resizer')).cursor`);
    const idlePill = await pill('.sidebar-resizer');

    // 悬停：把手才浮出来
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, buttons: 0 });
    await sleep(320);
    const hoverPill = await pill('.sidebar-resizer');

    // 按住往右拖 90px：中途抓一下拖拽反馈
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 45, y: start.y, button: 'left', buttons: 1 });
    await sleep(90);
    const mid = await ev(`({
      bodyClass: document.body.classList.contains('is-resizing-sidebar'),
      cursor: getComputedStyle(document.body).cursor,
      width: window.__store.sidebarWidth,
    })`);
    const midPill = await pill('.sidebar-resizer');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 90, y: start.y, button: 'left', buttons: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + 90, y: start.y, button: 'left', buttons: 0 });
    await sleep(320);
    const after = await geom();
    const storeWidth = await ev(`window.__store.sidebarWidth`);
    const persisted = await ev(`localStorage.getItem('cardtree:sidebarWidth')`);
    const released = await ev(`document.body.classList.contains('is-resizing-sidebar')`);

    // 越界：往左拖 900px 必须被夹在 150
    await dragMouse(await handleBox('.sidebar-resizer'), -900, 0, 6);
    const minWidth = await ev(`window.__store.sidebarWidth`);
    await ev(`(async () => { window.__store.sidebarWidth = 230; await new Promise((r) => setTimeout(r, 350)); return true })()`);

    return {
      before: { width: before.width },
      idleCursor,
      idlePill,
      hoverPill,
      midPill,
      mid,
      after: { width: after.width },
      storeWidth,
      persisted,
      released,
      minWidth,
      拖宽了: storeWidth > 230 && after.width > before.width + 40,
      落库: Number(persisted) === storeWidth,
      拖拽中给反馈: mid.bodyClass === true && mid.cursor === 'col-resize' && midPill.h !== idlePill.h,
      松手清状态: released === false,
      悬停才浮出: idlePill.bg === 'rgba(0, 0, 0, 0)' && hoverPill.bg !== idlePill.bg,
      下限夹住: minWidth === 150,
    };
  });

  await run('H2_height_splitter', async () => {
    // 塞满工作区，让"上限"这件事在像素上真的可见
    await ev(`(async () => {
      const s = window.__store;
      s.workspaces = Array.from({ length: 12 }, (_, i) => ({
        id: 'wsH' + i, name: '工作区 ' + (i + 1), icon: 'briefcase',
        items: [{ id: 'b-youtube', title: 'YouTube', url: 'https://www.youtube.com' }],
      }));
      s.wsExpanded = new Set();
      s.panelSplit = 0.35;
      await new Promise((r) => setTimeout(r, 500));
      return true;
    })()`);
    const before = await geom();
    const start = await handleBox('.sidebar-splitter');
    const idleCursor = await ev(`getComputedStyle(document.querySelector('.sidebar-splitter')).cursor`);
    const idlePill = await pill('.sidebar-splitter');

    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, buttons: 0 });
    await sleep(320);
    const hoverPill = await pill('.sidebar-splitter');

    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y + 60, button: 'left', buttons: 1 });
    await sleep(90);
    const mid = await ev(`({
      bodyClass: document.body.classList.contains('is-resizing-panel'),
      cursor: getComputedStyle(document.body).cursor,
      split: window.__store.panelSplit,
    })`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y + 120, button: 'left', buttons: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x, y: start.y + 120, button: 'left', buttons: 0 });
    await sleep(350);
    const after = await geom();
    const split = await ev(`window.__store.panelSplit`);
    const persisted = await ev(`localStorage.getItem('cardtree:panelSplit')`);
    const released = await ev(`document.body.classList.contains('is-resizing-panel')`);

    // 越界：一直往下拖 → 夹在 0.8
    await dragMouse(await handleBox('.sidebar-splitter'), 0, 900, 6);
    const maxSplit = await ev(`window.__store.panelSplit`);
    await ev(`(async () => {
      window.__store.panelSplit = 0.35;
      window.__store.workspaces = window.__store.workspaces.slice(0, 1);
      await new Promise((r) => setTimeout(r, 350));
      return true;
    })()`);

    return {
      before: { wsH: before.wsH, foldersH: before.foldersH, sidebarH: before.sidebarH, flexBasis: before.flexBasis, maxHeight: before.maxHeight },
      idleCursor,
      idlePill,
      hoverPill,
      mid,
      after: { wsH: after.wsH, foldersH: after.foldersH },
      split,
      persisted,
      released,
      maxSplit,
      分隔条可拖: split > 0.35 && after.wsH > before.wsH + 20,
      // 上面那张卡 = 分隔条比例决定的**固定**高度（不是上限：内容短时也必须跟手）
      固定比例高度: Math.abs(before.wsH - before.split * before.sidebarH) <= 4 && before.maxHeight === 'none',
      文件夹仍有空间: after.foldersH >= 104,
      落库: Number(persisted) === split,
      拖拽中给反馈: mid.bodyClass === true && mid.cursor === 'row-resize' && mid.split > 0.35,
      松手清状态: released === false,
      悬停才浮出: idlePill.bg === 'rgba(0, 0, 0, 0)' && hoverPill.bg !== idlePill.bg,
      上限夹住: maxSplit === 0.8,
    };
  });

  results.pageErrors = pageErrors;
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { edge.kill('SIGTERM'); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
